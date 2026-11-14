/**
 * 文件位置：excalidraw-app 的数据契约层，被 Collab（实时同步）、firebase
 * （持久化）与分享链接（导入/导出）三条链路共同依赖。
 *
 * 本文件只做三件事，不持有状态：
 * - 定义“哪些元素可以同步/持久化”（墓碑过滤口径，见 isSyncableElement）；
 * - 定义 socket 消息的判别联合类型（SocketUpdateDataSource）与房间链接格式；
 * - 分享链接的加密导入/导出。
 *
 * 约束：roomKey 只存在于 URL 的 hash 中（hash 不会发往服务端），
 * 因此所有后端请求的 body 都是密文，本文件不得把 key 写进 query。
 */
import {
  compressData,
  decompressData,
} from "@excalidraw/excalidraw/data/encode";
import {
  decryptData,
  generateEncryptionKey,
  IV_LENGTH_BYTES,
} from "@excalidraw/excalidraw/data/encryption";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { isInvisiblySmallElement } from "@excalidraw/element";
import { isInitializedImageElement } from "@excalidraw/element";
import { t } from "@excalidraw/excalidraw/i18n";
import { bytesToHexString } from "@excalidraw/common";

import type { UserIdleState } from "@excalidraw/common";
import type { ImportedDataState } from "@excalidraw/excalidraw/data/types";
import type { SceneBounds } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  SocketId,
} from "@excalidraw/excalidraw/types";
import type { MakeBrand } from "@excalidraw/common/utility-types";

import {
  DELETED_ELEMENT_TIMEOUT,
  FILE_UPLOAD_MAX_BYTES,
  ROOM_ID_BYTES,
} from "../app_constants";

import { encodeFilesForUpload } from "./FileManager";
import { saveFilesToFirebase } from "./firebase";

import type { WS_SUBTYPES } from "../app_constants";

/**
 * 经过过滤、确认可以参与同步与持久化的元素。
 * 用 brand 而不是普通别名：一旦某处忘了先过滤，类型系统会报错，
 * 避免把墓碑/不可见元素直接塞进广播或写库。
 */
export type SyncableExcalidrawElement = OrderedExcalidrawElement &
  MakeBrand<"SyncableExcalidrawElement">;

/**
 * “删除墓碑”的存活判定——协作同步与持久化的共同过滤口径。
 *
 * Excalidraw 不硬删除元素，而是把 `isDeleted` 置 true 并推进 version，
 * 让这条删除像普通更新一样参与冲突裁决。但墓碑不能永久留在文件里，
 * 否则文档会无限膨胀。这里的规则：
 * - 删除元素在 `DELETED_ELEMENT_TIMEOUT`（app_constants.ts 定义为 24h）
 *   内仍然可同步/可持久化，保证离线 peer 回来时能收到删除；
 * - 超过 24h 的墓碑被过滤掉，之后新加入的 peer 不会再看到它；
 * - 未删除但小到不可见的元素（isInvisiblySmallElement）也不同步，
 *   避免误触产生的零面积元素污染文件。
 *
 * 注意判据用的是 `updated`（本地墙钟），不是服务端时间；因此墓碑过期
 * 判断依赖各端时钟大致正确，这是已知取舍。
 */
export const isSyncableElement = (
  element: OrderedExcalidrawElement,
): element is SyncableExcalidrawElement => {
  if (element.isDeleted) {
    if (element.updated > Date.now() - DELETED_ELEMENT_TIMEOUT) {
      return true;
    }
    return false;
  }
  return !isInvisiblySmallElement(element);
};

/**
 * 批量过滤入口。所有发送/写入路径（Portal 广播、saveToFirebase、
 * beforeUnload 比对）都应经过这里，保证“同步口径”只有一处定义。
 * 保持原数组顺序：reconcile 与渲染都依赖元素顺序。
 */
export const getSyncableElements = (
  elements: readonly OrderedExcalidrawElement[],
) =>
  elements.filter((element) =>
    isSyncableElement(element),
  ) as SyncableExcalidrawElement[];

// 分享链接后端（/api/v2/...）。构建期注入；缺省时导入/导出会直接失败，
// 但协作功能不依赖它（协作走 Firebase 与 socket）。
const BACKEND_V2_GET = import.meta.env.VITE_APP_BACKEND_V2_GET_URL;
const BACKEND_V2_POST = import.meta.env.VITE_APP_BACKEND_V2_POST_URL;

/**
 * roomId 用 CSPRNG 生成十六进制串。它只是“房间的公开标识”，
 * 真正的保密性来自 roomKey；但 id 仍需足够随机，防止被枚举进别人的房间。
 */
const generateRoomId = async () => {
  const buffer = new Uint8Array(ROOM_ID_BYTES);
  window.crypto.getRandomValues(buffer);
  return bytesToHexString(buffer);
};

/**
 * 加密负载的通用形状。iv 必须与 data 成对传输，缺一不可解密；
 * 这里只描述内存态，写库时会被转成 Firebase Bytes。
 */
export type EncryptedData = {
  data: ArrayBuffer;
  iv: Uint8Array;
};

/**
 * socket 消息的判别联合：以 type 字段区分。新增子类型时，
 * Collab 的 switch 会因 assertNever 在编译期报错，避免漏处理。
 * 所有 payload 都是加密前的明文结构，解密后直接断言成该类型。
 */
export type SocketUpdateDataSource = {
  /** 解密失败/格式不合法时的哨兵，接收方应静默丢弃。 */
  INVALID_RESPONSE: {
    type: WS_SUBTYPES.INVALID_RESPONSE;
  };
  /** 房间首帧：先进入房间的人把整份场景交给后来者。 */
  SCENE_INIT: {
    type: WS_SUBTYPES.INIT;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  /** 增量更新：本地每次提交都会广播，接收方仍需 reconcile 而非直接覆盖。 */
  SCENE_UPDATE: {
    type: WS_SUBTYPES.UPDATE;
    payload: {
      elements: readonly OrderedExcalidrawElement[];
    };
  };
  /** 光标位置；携带 selectedElementIds 让对端能高亮同一批元素。 */
  MOUSE_LOCATION: {
    type: WS_SUBTYPES.MOUSE_LOCATION;
    payload: {
      socketId: SocketId;
      pointer: { x: number; y: number; tool: "pointer" | "laser" };
      button: "down" | "up";
      selectedElementIds: AppState["selectedElementIds"];
      username: string;
    };
  };
  /** 被跟随者的可见视口边界，用于自动跟随平移。 */
  USER_VISIBLE_SCENE_BOUNDS: {
    type: WS_SUBTYPES.USER_VISIBLE_SCENE_BOUNDS;
    payload: {
      socketId: SocketId;
      username: string;
      sceneBounds: SceneBounds;
    };
  };
  /** 空闲状态（active/idle/away），只影响协作者状态点。 */
  IDLE_STATUS: {
    type: WS_SUBTYPES.IDLE_STATUS;
    payload: {
      socketId: SocketId;
      userState: UserIdleState;
      username: string;
    };
  };
};

/** 从 socket 收到的原始消息（未加 brand）。 */
export type SocketUpdateDataIncoming =
  SocketUpdateDataSource[keyof SocketUpdateDataSource];

/** 即将发往 socket 的消息：brand 用来在编译期区分“可信来源”与任意对象。 */
export type SocketUpdateData =
  SocketUpdateDataSource[keyof SocketUpdateDataSource] & {
    _brand: "socketUpdateData";
  };

// 房间链接格式固定为 `#room=<roomId>,<roomKey>`。
// 用 hash 而非 query 是硬约束：hash 不会进入 HTTP 请求，
// 避免密钥被写进服务端日志或被 Referer 泄漏。
const RE_COLLAB_LINK = /^#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/;

/** 判断当前 URL 是否为协作链接（只读 hash，不发起网络请求）。 */
export const isCollaborationLink = (link: string) => {
  const hash = new URL(link).hash;
  return RE_COLLAB_LINK.test(hash);
};

/**
 * 从链接解析出房间凭据；格式不符返回 null。
 * roomKey 长度必须是 22（base64url 编码的 128bit 密钥）：长度不对说明链接
 * 被截断或伪造，提前弹窗比让用户面对“解密失败”更清晰。
 */
export const getCollaborationLinkData = (link: string) => {
  const hash = new URL(link).hash;
  const match = hash.match(RE_COLLAB_LINK);
  if (match && match[2].length !== 22) {
    window.alert(t("alerts.invalidEncryptionKey"));
    return null;
  }
  return match ? { roomId: match[1], roomKey: match[2] } : null;
};

/**
 * 生成新房间凭据。roomId 与 roomKey 都必须由 CSPRNG 产生：
 * 前者决定“房间地址”，后者是唯一解密凭据；两者缺一不可。
 * roomKey 生成失败直接抛错，绝不降级为空 key（那等于明文广播）。
 */
export const generateCollaborationLinkData = async () => {
  const roomId = await generateRoomId();
  const roomKey = await generateEncryptionKey();

  if (!roomKey) {
    throw new Error("Couldn't generate room key");
  }

  return { roomId, roomKey };
};

/**
 * 拼出可分享的房间链接。origin + pathname 保留部署子路径，
 * 凭据固定在 hash 里；不要改成 URLSearchParams，否则密钥会进请求行。
 */
export const getCollaborationLink = (data: {
  roomId: string;
  roomKey: string;
}) => {
  return `${window.location.origin}${window.location.pathname}#room=${data.roomId},${data.roomKey}`;
};

/**
 * Decodes shareLink data using the legacy buffer format.
 * @deprecated
 * 旧格式把 IV 直接拼在密文前面（或使用全零固定 IV）。
 * 只有新格式解密失败时才回退到这里，属于兼容路径，不要在新代码中使用。
 */
const legacy_decodeFromBackend = async ({
  buffer,
  decryptionKey,
}: {
  buffer: ArrayBuffer;
  decryptionKey: string;
}) => {
  let decrypted: ArrayBuffer;

  try {
    // Buffer should contain both the IV (fixed length) and encrypted data
    const iv = buffer.slice(0, IV_LENGTH_BYTES);
    const encrypted = buffer.slice(IV_LENGTH_BYTES, buffer.byteLength);
    decrypted = await decryptData(new Uint8Array(iv), encrypted, decryptionKey);
  } catch (error: any) {
    // Fixed IV (old format, backward compatibility)
    const fixedIv = new Uint8Array(IV_LENGTH_BYTES);
    decrypted = await decryptData(fixedIv, buffer, decryptionKey);
  }

  // We need to convert the decrypted array buffer to a string
  const string = new window.TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  const data: ImportedDataState = JSON.parse(string);

  return {
    elements: data.elements || null,
    appState: data.appState || null,
  };
};

/**
 * 拉取分享链接指向的场景并解密。
 *
 * 两级容错：HTTP 层失败弹窗并返回空对象；解压/解密失败则回退旧格式。
 * 返回 {} 而不是抛错，是为了让调用方（App 初始化）继续以空场景启动，
 * 而不是整页崩溃。注意 ID 只会拼到 GET 路径里，密钥不参与请求。
 */
export const importFromBackend = async (
  id: string,
  decryptionKey: string,
): Promise<ImportedDataState> => {
  try {
    const response = await fetch(`${BACKEND_V2_GET}${id}`);

    if (!response.ok) {
      window.alert(t("alerts.importBackendFailed"));
      return {};
    }
    const buffer = await response.arrayBuffer();

    try {
      const { data: decodedBuffer } = await decompressData(
        new Uint8Array(buffer),
        {
          decryptionKey,
        },
      );
      const data: ImportedDataState = JSON.parse(
        new TextDecoder().decode(decodedBuffer),
      );

      return {
        elements: data.elements || null,
        appState: data.appState || null,
      };
    } catch (error: any) {
      console.warn(
        "error when decoding shareLink data using the new format:",
        error,
      );
      return legacy_decodeFromBackend({ buffer, decryptionKey });
    }
  } catch (error: any) {
    window.alert(t("alerts.importBackendFailed"));
    console.error(error);
    return {};
  }
};

/** 导出结果用判别联合表达：要么有 url，要么有 errorMessage，二者互斥。 */
type ExportToBackendResult =
  | { url: null; errorMessage: string }
  | { url: string; errorMessage: null };

/**
 * 把场景加密后上传到分享后端，返回带密钥 hash 的 URL。
 *
 * 步骤：生成一次性 key → 压缩+加密（serializeAsJSON 产出 database 格式）
 * → POST 密文 → 拿到 id 后把 `json=<id>,<key>` 写入 hash → 上传引用的图片。
 * 图片上传失败不影响链接本身（图片会在打开时按需重试），
 * 因此这里不检查 saveFilesToFirebase 的返回值。
 *
 * 失败条件：后端返回错误（含 RequestTooLargeError，需单独文案）、
 * 网络异常、或 JSON 解析失败；统一返回 { url: null, errorMessage }。
 */
export const exportToBackend = async (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): Promise<ExportToBackendResult> => {
  const encryptionKey = await generateEncryptionKey("string");

  const payload = await compressData(
    new TextEncoder().encode(
      serializeAsJSON(elements, appState, files, "database"),
    ),
    { encryptionKey },
  );

  try {
    const filesMap = new Map<FileId, BinaryFileData>();
    for (const element of elements) {
      // 只收集“已初始化且本地确实有二进制”的图片：
      // pending/errored 的图片没有 dataURL，传上去只会得到一个坏文件。
      if (isInitializedImageElement(element) && files[element.fileId]) {
        filesMap.set(element.fileId, files[element.fileId]);
      }
    }

    const filesToUpload = await encodeFilesForUpload({
      files: filesMap,
      encryptionKey,
      maxBytes: FILE_UPLOAD_MAX_BYTES,
    });

    const response = await fetch(BACKEND_V2_POST, {
      method: "POST",
      body: payload.buffer,
    });
    const json = await response.json();
    if (json.id) {
      // 先取当前 URL 再改写 hash：保留 origin/path/已有 query，
      // 只替换 hash 部分，确保部署在子路径下也能正确分享。
      const url = new URL(window.location.href);
      // We need to store the key (and less importantly the id) as hash instead
      // of queryParam in order to never send it to the server
      url.hash = `json=${json.id},${encryptionKey}`;
      const urlString = url.toString();

      await saveFilesToFirebase({
        prefix: `/files/shareLinks/${json.id}`,
        files: filesToUpload,
      });

      return { url: urlString, errorMessage: null };
    } else if (json.error_class === "RequestTooLargeError") {
      // 体积超限是最常见的失败，必须给出可执行的文案（提示删减内容），
      // 而不是笼统的“生成失败”。
      return {
        url: null,
        errorMessage: t("alerts.couldNotCreateShareableLinkTooBig"),
      };
    }

    return { url: null, errorMessage: t("alerts.couldNotCreateShareableLink") };
  } catch (error: any) {
    // 兜底：网络异常/JSON 解析失败/图片上传抛错都归为同一类，
    // 只记日志并返回通用错误，避免把底层异常文本暴露给用户。
    console.error(error);

    return { url: null, errorMessage: t("alerts.couldNotCreateShareableLink") };
  }
};
