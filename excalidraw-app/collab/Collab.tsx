/**
 * 文件位置：excalidraw-app 协作层的中枢，把「本地 Scene」接到「远端 room」。
 *
 * 三条链路在这里汇合：
 * - 本地 → 远端：App.tsx 的 onChange 在 isCollaborating() 为真时调用
 *   syncElements，由 broadcastElements 做版本粗判后广播，并节流落 Firebase；
 * - 远端 → 本地：socket 的 INIT/UPDATE 消息解密后依次走
 *   _reconcileElements → handleRemoteSceneUpdate，以 NEVER 写入 Store；
 * - 生命周期：startCollaboration 建立 Portal socket，destroySocketClient
 *   在离开房间/卸载时统一收尾。
 *
 * 约束：本类不持有元素真值，任何时刻都通过 excalidrawAPI 读写 Scene，
 * 否则会和 Store 快照、undo 栈、协同广播形成三份互相打架的状态。
 * 不要在 render 中做同步，副作用全部收敛到上面三条链路里。
 */
import {
  CaptureUpdateAction,
  getSceneVersion,
  restoreElements,
  zoomToFitBounds,
  reconcileElements,
} from "@excalidraw/excalidraw";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { APP_NAME, cloneJSON, EVENT, toBrandedType } from "@excalidraw/common";
import {
  IDLE_THRESHOLD,
  ACTIVE_THRESHOLD,
  UserIdleState,
  assertNever,
  debounce,
  isDevEnv,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  throttleRAF,
} from "@excalidraw/common";
import { decryptData } from "@excalidraw/excalidraw/data/encryption";
import { getVisibleSceneBounds } from "@excalidraw/element";
import { newElementWith } from "@excalidraw/element";
import { isImageElement, isInitializedImageElement } from "@excalidraw/element";
import { AbortError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";
import { withBatchedUpdates } from "@excalidraw/excalidraw/reactUtils";

import throttle from "lodash.throttle";
import { PureComponent } from "react";

import { bumpElementVersions } from "@excalidraw/excalidraw/data/restore";

import type {
  ReconciledExcalidrawElement,
  RemoteExcalidrawElement,
} from "@excalidraw/excalidraw/data/reconcile";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  BinaryFileData,
  ExcalidrawImperativeAPI,
  SocketId,
  Collaborator,
  Gesture,
  UserToFollow,
} from "@excalidraw/excalidraw/types";
import type { Mutable, ValueOf } from "@excalidraw/common/utility-types";

import { appJotaiStore, atom } from "../app-jotai";
import {
  CURSOR_SYNC_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  WS_SUBTYPES,
  SYNC_FULL_SCENE_INTERVAL_MS,
  WS_EVENTS,
} from "../app_constants";
import {
  generateCollaborationLinkData,
  getCollaborationLink,
  getSyncableElements,
} from "../data";
import {
  encodeFilesForUpload,
  FileManager,
  updateStaleImageStatuses,
} from "../data/FileManager";
import { FileStatusStore } from "../data/fileStatusStore";
import { LocalData } from "../data/LocalData";
import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "../data/firebase";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
} from "../data/localStorage";
import { resetBrowserStateVersions } from "../data/tabSync";

import { collabErrorIndicatorAtom } from "./CollabError";
import Portal from "./Portal";

import type {
  SocketUpdateDataSource,
  SyncableExcalidrawElement,
} from "../data";

/**
 * 协作相关的全局 atom。
 * - collabAPIAtom：App 级单例引用，供组件/回调在任意位置拿到 Collab
 *   实例方法（例如 App.tsx 的 onChange 需要 syncElements）；
 * - isCollaboratingAtom：唯一权威的“是否在房间内”标记，用 atom 而非
 *   state 是为了让非 React 的节流回调也能同步读到最新值；
 * - isOfflineAtom：初始值直接读 navigator.onLine，避免首帧闪烁，后续
 *   由 onOfflineStatusToggle（防抖 1s）更新。
 */
export const collabAPIAtom = atom<CollabAPI | null>(null);
export const isCollaboratingAtom = atom(false);
export const isOfflineAtom = atom(
  typeof navigator !== "undefined" && !navigator.onLine,
);

/** 网络抖动在 1s 内来回切换时不值得提示用户，统一防抖到稳定态再更新。 */
const OFFLINE_STATUS_DEBOUNCE_TIMEOUT = 1000;

/**
 * 只放“需要触发 React 重渲染”的协作状态；高频数据（版本号、协作者表）
 * 刻意保留为实例字段，避免每次指针移动都 setState。
 */
interface CollabState {
  errorMessage: string | null;
  /** errors related to saving */
  dialogNotifiedErrors: Record<string, boolean>;
  username: string;
  activeRoomLink: string | null;
}

export const activeRoomLinkAtom = atom<string | null>(null);
export const userToFollowAtom = atom<UserToFollow | null>(null);

type CollabInstance = InstanceType<typeof Collab>;

/**
 * 暴露给宿主（App.tsx）的窄接口：只给方法，不给实例字段，App 无法绕过
 * syncElements 直接改协作内部状态。isCollaborating 被特意声明成函数而非
 * 布尔值，是因为节流/防抖回调里闭包捕获的旧值会过期，必须每次读 atom。
 */
export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  startCollaboration: CollabInstance["startCollaboration"];
  stopCollaboration: CollabInstance["stopCollaboration"];
  syncElements: CollabInstance["syncElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
  setUsername: CollabInstance["setUsername"];
  getUsername: CollabInstance["getUsername"];
  getActiveRoomLink: CollabInstance["getActiveRoomLink"];
  setCollabError: CollabInstance["setErrorDialog"];
  setUserToFollow: CollabInstance["setUserToFollow"];
}

/** 唯一依赖：宿主传入的 imperative API；本类不接任何 React context。 */
interface CollabProps {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

/**
 * 协作同步的客户端编排层（仅 excalidraw-app 使用，不在 @excalidraw/excalidraw
 * 包内）。
 *
 * 与元素模型的关系：
 * - 它不拥有元素，只从 `excalidrawAPI` 读写 Scene；
 * - 远端更新必须先 restore → reconcile → bumpElementVersions，再以
 *   `CaptureUpdateAction.NEVER` 写入，避免把远端改动记进本地 undo 栈；
 * - 本地更新通过 `syncElements` 回调进来，由 `broadcastElements` 按
 *   `getSceneVersion`（所有元素 version 之和）判断是否真的有新内容要发。
 *
 * 传输分两条：
 * - 实时：Portal 的加密 socket（INIT/UPDATE/MOUSE_LOCATION/…）；
 * - 持久化：Firebase 事务写入，作为不在线 peer 的兜底。
 * 两条路径都复用同一套 reconcile 规则，区别只在触发时机。
 *
 * `lastBroadcastedOrReceivedSceneVersion` 是回声抑制的核心：收到远端场景
 * 后先把版本记成对方的值，随后本地 Store 触发的 syncElements 就不会把
 * 刚收到的内容再广播回去。
 */
class Collab extends PureComponent<CollabProps, CollabState> {
  portal: Portal;
  fileManager: FileManager;
  excalidrawAPI: CollabProps["excalidrawAPI"];
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<SocketId, Collaborator>();
  /** the socket ids of the users following the current user */
  private followedBy = new Set<SocketId>();

  constructor(props: CollabProps) {
    super(props);
    this.state = {
      errorMessage: null,
      dialogNotifiedErrors: {},
      username: importUsernameFromLocalStorage() || "",
      activeRoomLink: null,
    };
    // Portal 负责 socket/加密通道，FileManager 负责二进制文件的上传下载；
    // 两者都依赖构造时传入的 portal 引用，且必须在挂载前就绪——否则第一帧
    // 收到 INIT 消息时拿不到 roomKey，无法解密。
    this.portal = new Portal(this);
    this.fileManager = new FileManager({
      onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
      // 读：按当前 roomId/roomKey 去 Firebase Storage 解密下载。
      // 房间信息缺失时抛 AbortError（FileManager 把它当作可忽略的取消，
      // 而不是计入 erroredFiles），避免离开房间后刷出一片错误提示。
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds);
      },
      // 写：先在内存里加密+压缩（encodeFilesForUpload），再交给 Firebase；
      // 返回的 saved/errored 用 Map 而不是数组，调用方可按 fileId 直接查。
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        const { savedFiles, erroredFiles } = await saveFilesToFirebase({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          files: await encodeFilesForUpload({
            files: addedFiles,
            encryptionKey: roomKey,
            maxBytes: FILE_UPLOAD_MAX_BYTES,
          }),
        });

        return {
          savedFiles: savedFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
          erroredFiles: erroredFiles.reduce(
            (acc: Map<FileId, BinaryFileData>, id) => {
              const fileData = addedFiles.get(id);
              if (fileData) {
                acc.set(id, fileData);
              }
              return acc;
            },
            new Map(),
          ),
        };
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  /** 收集 componentDidMount 中注册的订阅取消函数（字段名拼写为历史遗留）。 */
  private onUmmount: (() => void) | null = null;

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener("online", this.onOfflineStatusChange);
    window.addEventListener("offline", this.onOfflineStatusChange);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    // 跟随视口只订阅一次：onUserFollow 决定跟随谁，onScrollChange 触发
    // 节流后的可见区域上报；两者都必须在卸载时取消，否则切房间后会
    // 继续向旧 socket 发消息。
    const unsubOnUserFollow = this.excalidrawAPI.onUserFollow((payload) => {
      this.setUserToFollow(
        payload.action === "FOLLOW" ? payload.userToFollow : null,
      );
    });
    const throttledRelayUserViewportBounds = throttleRAF(
      this.relayVisibleSceneBounds,
    );
    const unsubOnScrollChange = this.excalidrawAPI.onScrollChange(() =>
      throttledRelayUserViewportBounds(),
    );
    this.onUmmount = () => {
      unsubOnUserFollow();
      unsubOnScrollChange();
    };

    this.onOfflineStatusToggle();

    // 把方法逐个映射成对象，而不是直接暴露 this：宿主拿到的是稳定引用，
    // 内部实现换绑时不会破坏 App 侧已保存的引用。
    const collabAPI: CollabAPI = {
      isCollaborating: this.isCollaborating,
      onPointerUpdate: this.onPointerUpdate,
      startCollaboration: this.startCollaboration,
      syncElements: this.syncElements,
      fetchImageFilesFromFirebase: this.fetchImageFilesFromFirebase,
      stopCollaboration: this.stopCollaboration,
      setUsername: this.setUsername,
      getUsername: this.getUsername,
      getActiveRoomLink: this.getActiveRoomLink,
      setCollabError: this.setErrorDialog,
      setUserToFollow: this.setUserToFollow,
    };

    appJotaiStore.set(collabAPIAtom, collabAPI);

    // 仅调试/测试环境挂到 window，方便 e2e 断言与人工排查；
    // 生产构建中常量折叠会移除该分支。
    if (isTestEnv() || isDevEnv()) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  /** 把浏览器在线状态同步进 atom；由下面的 debounce 包装后调用。 */
  onOfflineStatusToggle = () => {
    appJotaiStore.set(isOfflineAtom, !window.navigator.onLine);
  };

  /**
   * online/offline 事件在切换网络时会连续触发，防抖 1s 保证 UI 只跳一次。
   * 卸载时必须 cancel，否则组件已销毁仍会写 atom。
   */
  onOfflineStatusChange = debounce(
    this.onOfflineStatusToggle,
    OFFLINE_STATUS_DEBOUNCE_TIMEOUT,
  );

  componentWillUnmount() {
    // 卸载要覆盖“事件 + 定时器 + 订阅”三类清理：定时器不清会在卸载后
    // 继续上报 ACTIVE 心跳，指向一个已关闭的 socket。
    window.removeEventListener("online", this.onOfflineStatusChange);
    window.removeEventListener("offline", this.onOfflineStatusChange);
    this.onOfflineStatusChange.cancel();
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.onUmmount?.();
  }

  /**
   * 读 atom 而不是 this.state：调用方包括节流回调与 beforeUnload，
   * 这些位置拿到的 this 可能是旧闭包，必须每次取最新值。
   */
  isCollaborating = () => appJotaiStore.get(isCollaboratingAtom)!;

  private setIsCollaborating = (isCollaborating: boolean) => {
    appJotaiStore.set(isCollaboratingAtom, isCollaborating);
  };

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    // 只处理“可同步元素”子集：墓碑与不可见小元素本来就不会进库，
    // 拿全量去比较会永远判定为“未保存”，导致误报离开提醒。
    const syncableElements = getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating() &&
      (this.fileManager.shouldPreventUnload(syncableElements) ||
        !isSavedToFirebase(this.portal, syncableElements))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoomToFirebase(syncableElements);

      if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
        // 保存是异步的，用户真离开时多半来不及完成；调用保存的真实目的
        // 是“用户取消离开后立即补一次落库”，而不是阻止离开本身。
        preventUnload(event);
      } else {
        console.warn(
          "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
        );
      }
    }
  });

  /**
   * 把可同步元素写入 Firebase，并把写入后的权威结果回灌到本地场景。
   *
   * 参数必须先经 getSyncableElements 过滤（墓碑/不可见），否则库里会
   * 塞进永远不该持久化的元素。失败只做提示：弹窗按 errorMessage 去重，
   * 避免节流保存反复失败时叠满同一个对话框。
   */
  saveCollabRoomToFirebase = async (
    syncableElements: readonly SyncableExcalidrawElement[],
  ) => {
    // 深拷贝：saveToFirebase 内部会 reconcile 并可能改写数组内容，
    // 直接传 Store 的元素引用会污染本地快照。
    syncableElements = cloneJSON(syncableElements);
    try {
      const storedElements = await saveToFirebase(
        this.portal,
        syncableElements,
        this.excalidrawAPI.getAppState(),
      );

      this.resetErrorIndicator();

      if (this.isCollaborating() && storedElements) {
        this.handleRemoteSceneUpdate(this._reconcileElements(storedElements));
      }
    } catch (error: any) {
      const errorMessage = /is longer than.*?bytes/.test(error.message)
        ? t("errors.collabSaveFailed_sizeExceeded")
        : t("errors.collabSaveFailed");

      // 同一个错误只弹一次窗；退出协作后允许重新弹，避免“上一会话的
      // 旧错误”把新会话的提示吞掉。
      if (
        !this.state.dialogNotifiedErrors[errorMessage] ||
        !this.isCollaborating()
      ) {
        this.setErrorDialog(errorMessage);
        this.setState({
          dialogNotifiedErrors: {
            ...this.state.dialogNotifiedErrors,
            [errorMessage]: true,
          },
        });
      }

      if (this.isCollaborating()) {
        this.setErrorIndicator(errorMessage);
      }

      console.error(error);
    }
  };

  /**
   * 主动离开房间。
   *
   * keepRemoteState=true（默认）表示“保留远端内容继续单人编辑”，需要用户
   * 二次确认；false 表示丢弃远端状态回到本地历史（切换房间/链接时使用）。
   * 两个分支都先取消排队中的节流任务，否则关闭 socket 后它们仍会拿着
   * 旧 roomId 发起请求。
   */
  stopCollaboration = (keepRemoteState = true) => {
    this.queueBroadcastAllElements.cancel();
    this.queueSaveToFirebase.cancel();
    this.loadImageFiles.cancel();
    this.resetErrorIndicator(true);

    this.saveCollabRoomToFirebase(
      getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
    );

    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }

    if (!keepRemoteState) {
      LocalData.fileStorage.reset();
      this.destroySocketClient();
    } else if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      // hack to ensure that we prefer we disregard any new browser state
      // that could have been saved in other tabs while we were collaborating
      resetBrowserStateVersions();

      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();

      LocalData.fileStorage.reset();

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status === "saved") {
            return newElementWith(element, { status: "pending" });
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };

  /**
   * 关闭 socket 并把协作态归零。isUnload 分支跳过 UI 更新：页面卸载时
   * 再 setState/updateScene 没有意义，还可能触发额外渲染。
   * 版本号重置为 -1 很关键——下次进房时任何非空场景都会被判定为新内容。
   */
  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileManager.reset();
    this.followedBy = new Set();
    if (!opts?.isUnload) {
      this.setIsCollaborating(false);
      this.setActiveRoomLink(null);
      appJotaiStore.set(userToFollowAtom, null);
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      LocalData.resumeSave("collaboration");
    }
  };

  /**
   * 拉取尚未在本地登记过的图片文件。
   *
   * 过滤条件的三重含义：
   * - 已删除元素不拉（墓碑不需要图片）；
   * - FileManager 已在跟踪的跳过，避免重复下载；
   * - forceFetchFiles 是兜底开关：把超过 10s 仍未完成的 pending/error
   *   也重试，否则一次状态更新丢失就会让图片永久停在占位状态。
   */
  private fetchImageFilesFromFirebase = async (opts: {
    elements: readonly ExcalidrawElement[];
    /**
     * Indicates whether to fetch files that are errored or pending and older
     * than 10 seconds.
     *
     * Use this as a mechanism to fetch files which may be ok but for some
     * reason their status was not updated correctly.
     */
    forceFetchFiles?: boolean;
  }) => {
    const unfetchedImages = opts.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileManager.isFileTracked(element.fileId) &&
          !element.isDeleted &&
          (opts.forceFetchFiles
            ? element.status !== "pending" ||
              Date.now() - element.updated > 10000
            : element.status === "saved")
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    return await this.fileManager.getFiles(unfetchedImages);
  };

  /**
   * 解密 socket 负载。
   *
   * 失败不抛异常而是返回 INVALID_RESPONSE：socket 回调里抛错会变成未处理
   * 的 rejection，且无法与“对端用了错误的 roomKey”区分。交给调用方的
   * switch 静默丢弃即可，房间里的错误密钥不影响其他消息。
   */
  private decryptPayload = async (
    iv: Uint8Array<ArrayBuffer>,
    encryptedData: ArrayBuffer,
    decryptionKey: string,
  ): Promise<ValueOf<SocketUpdateDataSource>> => {
    try {
      const decrypted = await decryptData(iv, encryptedData, decryptionKey);

      const decodedData = new TextDecoder("utf-8").decode(
        new Uint8Array(decrypted),
      );
      return JSON.parse(decodedData);
    } catch (error) {
      window.alert(t("alerts.decryptFailed"));
      console.error(error);
      return {
        type: WS_SUBTYPES.INVALID_RESPONSE,
      };
    }
  };

  private fallbackInitializationHandler: null | (() => any) = null;

  /**
   * 建立协作会话。
   *
   * 参数 existingRoomLinkData：从 URL hash 解析出的既有房间；为 null 时
   * 生成新的 roomId/roomKey 并写入地址栏（只用 hash，避免密钥进服务端日志）。
   * 返回值：解析为初始场景的 Promise。首次进房时 INIT 消息与 Firebase
   * 回填都可能触发，先到者生效，另一条因 promise 已 resolve 而 noop；
   * 若 socket 已存在则返回 null，表示“已经在房间里”。
   */
  startCollaboration = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
  ) => {
    if (!this.state.username) {
      // 没有昵称时异步补一个随机名，不阻塞建连：昵称只影响光标标签，
      // 晚一点同步没有任何副作用。
      import("@excalidraw/random-username").then(({ getRandomUsername }) => {
        const username = getRandomUsername();
        this.setUsername(username);
      });
    }

    if (this.portal.socket) {
      return null;
    }

    let roomId;
    let roomKey;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
    }

    // 场景结果的“一次性闸门”：INIT、Firebase 回填、first-in-room 三个
    // 来源都可能 resolve，resolvablePromise 保证只有第一个生效。
    // TODO: `ImportedDataState` type here seems abused
    const scenePromise = resolvablePromise<
      | (ImportedDataState & { elements: readonly OrderedExcalidrawElement[] })
      | null
    >();

    this.setIsCollaborating(true);
    // 进房即暂停 LocalData 的本地自动保存，防止同一份内容同时写
    // localStorage 与 Firebase，刷新后两份历史会互相覆盖。
    LocalData.pauseSave("collaboration");

    // socket.io 体积大且非首屏必需，动态导入拆包；webpackChunkName
    // 让产物文件名稳定，便于部署缓存。
    const { default: socketIOClient } = await import(
      /* webpackChunkName: "socketIoClient" */ "socket.io-client"
    );

    // 兜底初始化：连不上 socket（防火墙/服务端异常）时直接读 Firebase，
    // 让用户至少能拿到一份可编辑的场景，而不是停在空白页。
    const fallbackInitializationHandler = () => {
      this.initializeRoom({
        roomLinkData: existingRoomLinkData,
        fetchScene: true,
      }).then((scene) => {
        scenePromise.resolve(scene);
      });
    };
    this.fallbackInitializationHandler = fallbackInitializationHandler;

    try {
      this.portal.socket = this.portal.open(
        socketIOClient(import.meta.env.VITE_APP_WS_SERVER_URL, {
          transports: ["websocket", "polling"],
        }),
        roomId,
        roomKey,
      );

      this.portal.socket.once("connect_error", fallbackInitializationHandler);
    } catch (error: any) {
      console.error(error);
      this.setErrorDialog(error.message);
      return null;
    }

    if (existingRoomLinkData) {
      // 加入既有房间必须 resetScene：否则会把当前本地场景当成“已有内容”
      // 合并进别人的房间，等于把私有画布泄漏给房间内所有人。
      // when joining existing room, don't merge it with current scene data
      this.excalidrawAPI.resetScene();
    } else {
      const elements = this.excalidrawAPI.getSceneElements().map((element) => {
        if (isImageElement(element) && element.status === "saved") {
          return newElementWith(element, { status: "pending" });
        }
        return element;
      });
      // remove deleted elements from elements array to ensure we don't
      // expose potentially sensitive user data in case user manually deletes
      // existing elements (or clears scene), which would otherwise be persisted
      // to database even if deleted before creating the room.
      this.excalidrawAPI.updateScene({
        elements,
        captureUpdate: CaptureUpdateAction.NEVER,
      });

      this.saveCollabRoomToFirebase(getSyncableElements(elements));
    }

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_INIT message
    // 服务端迟迟不发 SCENE_INIT 的看门狗；超时后走 Firebase 兜底。
    // 定时器在 initializeRoom 里被 clearTimeout，两条路径互斥。
    this.socketInitializationTimer = window.setTimeout(
      fallbackInitializationHandler,
      INITIAL_SCENE_UPDATE_TIMEOUT,
    );

    // All socket listeners are moving to Portal
    this.portal.socket.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array<ArrayBuffer>) => {
        if (!this.portal.roomKey) {
          // roomKey 在 destroySocketClient 中会被清空；此时到达的迟到消息
          // 无法解密，直接丢弃即可，属于正常竞态而非错误。
          return;
        }

        const decryptedData = await this.decryptPayload(
          iv,
          encryptedData,
          this.portal.roomKey,
        );

        switch (decryptedData.type) {
          case WS_SUBTYPES.INVALID_RESPONSE:
            return;
          case WS_SUBTYPES.INIT: {
            // INIT 是“房间首帧”：只有首次收到才初始化。socketInitialized
            // 判断防止重复 INIT 覆盖用户已经开始的编辑。
            if (!this.portal.socketInitialized) {
              this.initializeRoom({ fetchScene: false });
              const remoteElements = toBrandedType<
                readonly RemoteExcalidrawElement[]
              >(decryptedData.payload.elements);
              const reconciledElements =
                this._reconcileElements(remoteElements);
              this.handleRemoteSceneUpdate(reconciledElements);
              // noop if already resolved via init from firebase
              scenePromise.resolve({
                elements: reconciledElements,
                scrollToContent: true,
              });
            }
            break;
          }
          case WS_SUBTYPES.UPDATE:
            // UPDATE 是增量广播，无条件 reconcile：本地可能比对方新，
            // reconcile 会逐元素裁决，不会整体覆盖本地未同步的改动。
            this.handleRemoteSceneUpdate(
              this._reconcileElements(
                toBrandedType<readonly RemoteExcalidrawElement[]>(
                  decryptedData.payload.elements,
                ),
              ),
            );
            break;
          case WS_SUBTYPES.MOUSE_LOCATION: {
            // 光标消息频率最高，只更新协作者指针，绝不触碰场景与历史。
            // socketId 的兼容分支是为老版本客户端的字段拼写（#2094）。
            const { pointer, button, username, selectedElementIds } =
              decryptedData.payload;

            const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
              decryptedData.payload.socketId ||
              // @ts-ignore legacy, see #2094 (#2097)
              decryptedData.payload.socketID;

            this.updateCollaborator(socketId, {
              pointer,
              button,
              selectedElementIds,
              username,
            });

            break;
          }

          case WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS: {
            // 跟随视口消息。两种“不该处理”的情况必须显式 return：
            // 1) 已取消跟随但消息在途（丢弃，而不是弹错）；
            // 2) 互相关注（cross-follow）——两边同时跟随会形成视口
            //    互相拉扯的正反馈抖动，必须由 followedBy 切断。
            const { sceneBounds, socketId } = decryptedData.payload;

            const userToFollow = appJotaiStore.get(userToFollowAtom);

            // we're not following the user
            // (shouldn't happen, but could be late message or bug upstream)
            if (userToFollow?.socketId !== socketId) {
              console.warn(
                `receiving remote client's (from ${socketId}) viewport bounds even though we're not subscribed to it!`,
              );
              return;
            }

            // cross-follow case, ignore updates in this case
            if (this.followedBy.has(userToFollow.socketId)) {
              return;
            }

            const appState = this.excalidrawAPI.getAppState();

            this.excalidrawAPI.updateScene({
              appState: zoomToFitBounds({
                appState,
                bounds: sceneBounds,
                fit: "contain",
              }).appState,
            });

            break;
          }

          case WS_SUBTYPES.IDLE_STATUS: {
            // 空闲状态只影响协作者列表里的状态点，不参与场景合并。
            const { userState, socketId, username } = decryptedData.payload;
            this.updateCollaborator(socketId, {
              userState,
              username,
            });
            break;
          }

          default: {
            // assertNever 让新增子类型在编译期报错，防止忘记处理而静默丢消息。
            assertNever(decryptedData, null);
          }
        }
      },
    );

    // first-in-room：服务端告知“你是房间里第一个/唯一的人”。此时主动
    // 拉一次 Firebase 场景，避免空房间永远等不到 INIT 而卡住。
    this.portal.socket.on("first-in-room", async () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      const sceneData = await this.initializeRoom({
        fetchScene: true,
        roomLinkData: existingRoomLinkData,
      });
      scenePromise.resolve(sceneData);
    });

    // 关注关系变化：更新谁在看我，并强制广播一次视口，
    // 让新关注者立刻拿到边界，而不是等下一次滚动。
    this.portal.socket.on(
      WS_EVENTS.USER_FOLLOW_ROOM_CHANGE,
      (followedBy: SocketId[]) => {
        this.followedBy = new Set(followedBy);

        this.relayVisibleSceneBounds({ force: true });
      },
    );

    // 心跳与空闲检测依赖 document 级事件，放在最后注册：确保前面的
    // socket 监听全部绑定成功，失败路径已在 try/catch 中提前 return。
    this.initializeIdleDetector();

    this.setActiveRoomLink(window.location.href);

    return scenePromise;
  };

  /**
   * 房间初始化（幂等）。
   *
   * fetchScene=true：需要主动从 Firebase 拉场景（首次进房/兜底路径）；
   * fetchScene=false：仅标记 socketInitialized，等 INIT 消息自己到。
   * 无论哪条路径都会清掉看门狗定时器并解绑 connect_error，避免二次触发。
   * 读取失败只记日志、返回 null：其他 peer 的广播会把场景补给我们。
   */
  private initializeRoom = async ({
    fetchScene,
    roomLinkData,
  }:
    | {
        fetchScene: true;
        roomLinkData: { roomId: string; roomKey: string } | null;
      }
    | { fetchScene: false; roomLinkData?: null }) => {
    clearTimeout(this.socketInitializationTimer!);
    if (this.portal.socket && this.fallbackInitializationHandler) {
      this.portal.socket.off(
        "connect_error",
        this.fallbackInitializationHandler,
      );
    }
    if (fetchScene && roomLinkData && this.portal.socket) {
      this.excalidrawAPI.resetScene();

      try {
        const elements = await loadFromFirebase(
          roomLinkData.roomId,
          roomLinkData.roomKey,
          this.portal.socket,
        );
        if (elements) {
          // 从库里读到的场景等价于“已收到”，先记账再返回，否则 Store
          // 应用后触发的 onChange 会被当成新内容再广播回去。
          this.setLastBroadcastedOrReceivedSceneVersion(
            getSceneVersion(elements),
          );

          return {
            elements,
            scrollToContent: true,
          };
        }
      } catch (error: any) {
        // log the error and move on. other peers will sync us the scene.
        console.error(error);
      } finally {
        this.portal.socketInitialized = true;
      }
    } else {
      this.portal.socketInitialized = true;
    }
    return null;
  };

  /**
   * 远端元素进入本地场景前的三步处理，顺序不可换：
   *
   * 1. `restoreElements`：补默认值/迁移旧字段。必须在 reconcile 之前做，
   *    因为后面的版本比较依赖 restore 后的 version；注释也说明不能反过来，
   *    否则会重新生成 appState.newElement 这类临时元素，破坏本地状态。
   * 2. `reconcileElements`：按 version / versionNonce 逐元素裁决。
   * 3. `bumpElementVersions`：把结果抬到本地版本之上。若不抬，下一次本地
   *    编辑（version+1）可能仍小于远端已见过的版本，导致自己的修改被丢弃。
   *    这是 issue #3795 的修复点。
   *
   * 最后把“刚收到的场景版本”记为已广播版本，抑制回声。
   */
  private _reconcileElements = (
    remoteElements: readonly RemoteExcalidrawElement[],
  ): ReconciledExcalidrawElement[] => {
    const appState = this.excalidrawAPI.getAppState();

    const existingElements = this.getSceneElementsIncludingDeleted();

    // NOTE ideally we restore _after_ reconciliation but we can't do that
    // as we'd regenerate even elements such as appState.newElement which would
    // break the state
    remoteElements = restoreElements(remoteElements, existingElements);

    let reconciledElements = reconcileElements(
      existingElements,
      remoteElements,
      appState,
    );

    reconciledElements = bumpElementVersions(
      reconciledElements,
      existingElements,
    );

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(
      getSceneVersion(reconciledElements),
    );

    return reconciledElements;
  };

  /**
   * 节流版的图片补拉：场景里出现新的 fileId 时触发。
   * 必须在远端元素写入 Store 之后调用，保证“缺失文件”的判定基于新场景。
   */
  private loadImageFiles = throttle(async () => {
    const { loadedFiles, erroredFiles } =
      await this.fetchImageFilesFromFirebase({
        elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      });

    this.excalidrawAPI.addFiles(loadedFiles);

    updateStaleImageStatuses({
      excalidrawAPI: this.excalidrawAPI,
      erroredFiles,
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    });
  }, LOAD_IMAGES_TIMEOUT);

  /**
   * 远端场景写入本地。
   *
   * `CaptureUpdateAction.NEVER` 是关键：它让 Store 前进基线但不进 undo 栈，
   * 所以用户按 Ctrl+Z 不会“撤销别人的修改”。这也是本地历史与协作历史
   * 的边界。
   */
  private handleRemoteSceneUpdate = (
    elements: ReconciledExcalidrawElement[],
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      captureUpdate: CaptureUpdateAction.NEVER,
    });

    this.loadImageFiles();
  };

  /**
   * 指针移动即视为“活跃”：重置 idle 定时器，并保证 ACTIVE 心跳存在。
   * 这里刻意不用 throttle——清/建定时器本身很便宜，而节流会让空闲判定
   * 延迟，导致协作者看到的状态与实际不符。
   */
  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }

    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);

    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  /**
   * 切到后台后不再有 pointermove，必须手动把状态切到 AWAY 并停掉心跳，
   * 否则后台标签页会被其他协作者看成“一直在画”。回到前台则重建定时器。
   */
  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  /** 超过 IDLE_THRESHOLD 无输入：上报 IDLE 并停掉 ACTIVE 心跳以省电。 */
  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  /** ACTIVE 心跳回调；只在存在活动时由 interval 周期触发。 */
  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  /** 注册 document 级监听；只应调用一次，重复调用会产生重复监听。 */
  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  /**
   * 用服务端下发的 socketId 列表重建协作者表。
   * 选择重建而非增量修改：服务端列表是权威，增量会残留已离线的幽灵用户。
   * 本地用户的条目需要手动补 username，因为我们永远收不到自己的广播。
   */
  setCollaborators(sockets: SocketId[]) {
    const collaborators: InstanceType<typeof Collab>["collaborators"] =
      new Map();
    for (const socketId of sockets) {
      const isCurrentUser = socketId === this.portal.socket?.id;
      collaborators.set(
        socketId,
        Object.assign(
          // we never receive our own broadcasts, so we need to seed
          // our own collaborator entry with the local username
          isCurrentUser ? { username: this.state.username } : {},
          this.collaborators.get(socketId),
          { isCurrentUser },
        ),
      );
    }
    this.collaborators = collaborators;
    this.excalidrawAPI.updateScene({ collaborators });

    // unfollow if the followed user left the room
    // 被跟随者离开房间时自动取消跟随，否则视口会停在一个无人维护的位置。
    const userToFollow = appJotaiStore.get(userToFollowAtom);
    if (userToFollow && !collaborators.has(userToFollow.socketId)) {
      this.setUserToFollow(null);
    }
  }

  /**
   * 局部更新单个协作者（光标/空闲状态/昵称）。
   * 必须新建 Map：updateScene 靠引用比较判断是否变化，原地改 Map
   * 不会让渲染层感知到更新。
   */
  updateCollaborator = (socketId: SocketId, updates: Partial<Collaborator>) => {
    const isCurrentUser = socketId === this.portal.socket?.id;
    const collaborators = new Map(this.collaborators);
    const user: Mutable<Collaborator> = Object.assign(
      // we never receive our own broadcasts, so we need to seed
      // our own collaborator entry with the local username
      isCurrentUser ? { username: this.state.username } : {},
      collaborators.get(socketId),
      updates,
      { isCurrentUser },
    );
    collaborators.set(socketId, user);
    this.collaborators = collaborators;

    this.excalidrawAPI.updateScene({
      collaborators,
    });
  };

  /**
   * 回声抑制账本：记录“最近一次广播或接收到的场景版本”。
   * 除销毁时重置为 -1 外只增不减，因此用 version > last 的严格比较
   * 就能判断是否真有新内容。
   */
  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  /**
   * 协作必须拿“含已删除元素”的场景：墓碑要参与 reconcile 与版本计算；
   * getSceneElements 会把 isDeleted 过滤掉，导致删除无法同步给对端。
   */
  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  /**
   * 光标广播。多指针（≥2）时跳过：缩放/双指手势下坐标语义不稳定，
   * 发出去只会让对端画出一堆抖动光标；节流间隔为 CURSOR_SYNC_TIMEOUT。
   */
  onPointerUpdate = throttle(
    (payload: {
      pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
      button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
      pointersMap: Gesture["pointers"];
    }) => {
      payload.pointersMap.size < 2 &&
        this.portal.socket &&
        this.portal.broadcastMouseLocation(payload);
    },
    CURSOR_SYNC_TIMEOUT,
  );

  /**
   * 上报当前视口边界，仅当有人跟随我（followedBy 非空）或显式强制时。
   * 无人跟随时跳过，避免每次滚动都产生无意义的加密广播。
   */
  relayVisibleSceneBounds = (props?: { force: boolean }) => {
    if (this.portal.socket && (this.followedBy.size > 0 || props?.force)) {
      this.portal.broadcastVisibleSceneBounds(
        {
          sceneBounds: getVisibleSceneBounds(this.excalidrawAPI.getAppState()),
        },
        `follow@${this.portal.socket.id}`,
      );
    }
  };

  /** 通过 Portal 广播空闲状态；未进房时 Portal 内部会自行 noop。 */
  onIdleStateChange = (userState: UserIdleState) => {
    this.portal.broadcastIdleChange(userState);
  };

  /**
   * 本地变更出口，由 excalidraw-app/App.tsx 的 onChange 回调调用
   * （仅当 isCollaborating() 为真）。
   *
   * 版本判定用 `getSceneVersion`（所有元素 version 之和）而不是深比较：
   * 它单调、便宜，适合做“有没有新东西”的粗判。真正的精确合并交给对端
   * reconcile。发送后再排队一次全量广播（节流），用于修复丢包。
   */
  broadcastElements = (elements: readonly OrderedExcalidrawElement[]) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(WS_SUBTYPES.UPDATE, elements, false);
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  /**
   * 一次本地提交同时驱动“实时广播”和“Firebase 持久化”。
   * 持久化是节流的（SYNC_FULL_SCENE_INTERVAL_MS），实时广播按版本变化触发。
   */
  syncElements = (elements: readonly OrderedExcalidrawElement[]) => {
    this.broadcastElements(elements);
    this.queueSaveToFirebase();
  };

  /**
   * 全量广播（force=true），按 SYNC_FULL_SCENE_INTERVAL_MS 节流。
   * 与增量广播并存的原因：socket 丢包后靠周期性全量把场景重新对齐；
   * 版本取 max 而不是直接覆盖，避免把已发出的更高版本回退。
   */
  queueBroadcastAllElements = throttle(() => {
    this.portal.broadcastScene(
      WS_SUBTYPES.UPDATE,
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  /**
   * 节流写 Firebase。leading:false 表示首次调用不立即写：用户刚开始画的
   * 瞬间不必落库，等窗口结束再合并写入，显著降低请求量。
   * socketInitialized 之前不写——此时 roomId 可能尚未确认。
   */
  queueSaveToFirebase = throttle(
    () => {
      if (this.portal.socketInitialized) {
        this.saveCollabRoomToFirebase(
          getSyncableElements(
            this.excalidrawAPI.getSceneElementsIncludingDeleted(),
          ),
        );
      }
    },
    SYNC_FULL_SCENE_INTERVAL_MS,
    { leading: false },
  );

  /**
   * 切换跟随目标。先 UNFOLLOW 旧的再 FOLLOW 新的，顺序不能反：
   * 服务端按房间维护关注关系，反向操作会让旧房间残留订阅。
   */
  setUserToFollow = (userToFollow: UserToFollow | null) => {
    const prev = appJotaiStore.get(userToFollowAtom) ?? null;

    if (prev?.socketId !== userToFollow?.socketId && this.portal.socket) {
      // leave the previous user's follow room before joining the next one
      if (prev) {
        this.portal.broadcastUserFollowed({
          userToFollow: prev,
          action: "UNFOLLOW",
        });
      }
      if (userToFollow) {
        this.portal.broadcastUserFollowed({
          userToFollow,
          action: "FOLLOW",
        });
      }
    }

    appJotaiStore.set(userToFollowAtom, userToFollow);
  };

  /** 昵称同时写 localStorage（下次打开沿用）与协作者表（本端实时生效）。 */
  setUsername = (username: string) => {
    this.setState({ username });
    saveUsernameToLocalStorage(username);

    // keep our own collaborator entry in sync
    const socketId = this.portal.socket?.id as SocketId | undefined;
    if (socketId && this.collaborators.has(socketId)) {
      this.updateCollaborator(socketId, { username });
    }
  };

  getUsername = () => this.state.username;

  setActiveRoomLink = (activeRoomLink: string | null) => {
    this.setState({ activeRoomLink });
    appJotaiStore.set(activeRoomLinkAtom, activeRoomLink);
  };

  getActiveRoomLink = () => this.state.activeRoomLink;

  /**
   * 错误指示器走 atom + nonce：相同 message 再次设置时 nonce 变化，
   * 组件才能感知到“又来了一次”并重新播放提示动画。
   */
  setErrorIndicator = (errorMessage: string | null) => {
    appJotaiStore.set(collabErrorIndicatorAtom, {
      message: errorMessage,
      nonce: Date.now(),
    });
  };

  /** 清空指示器；resetDialogNotifiedErrors 为真时允许同类弹窗再次出现。 */
  resetErrorIndicator = (resetDialogNotifiedErrors = false) => {
    appJotaiStore.set(collabErrorIndicatorAtom, { message: null, nonce: 0 });
    if (resetDialogNotifiedErrors) {
      this.setState({
        dialogNotifiedErrors: {},
      });
    }
  };

  setErrorDialog = (errorMessage: string | null) => {
    this.setState({
      errorMessage,
    });
  };

  /** 只渲染阻塞式错误弹窗，其余协作 UI（光标/头像）由宿主渲染。 */
  render() {
    const { errorMessage } = this.state;

    return (
      <>
        {errorMessage != null && (
          <ErrorDialog onClose={() => this.setErrorDialog(null)}>
            {errorMessage}
          </ErrorDialog>
        )}
      </>
    );
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof Collab>;
  }
}

/** 供 e2e 与调试脚本通过 window.collab 访问实例（仅 dev/test 生效）。 */
if (isTestEnv() || isDevEnv()) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default Collab;

export type TCollabClass = Collab;
