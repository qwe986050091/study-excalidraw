/**
 * 文件位置：协作持久化层。socket 负责“在线即时”，本文件负责“离线兜底”：
 * 房间场景与图片文件都加密后写到 Firebase，供后进房/掉线的 peer 拉取。
 *
 * 两条写入路径：
 * - saveToFirebase：房间场景，走 Firestore 事务（读→解密→restore→reconcile
 *   →写回），因此并发保存不会互相覆盖；
 * - saveFilesToFirebase：二进制文件，走 Storage，逐个上传、逐个报错。
 *
 * 与实时同步的关系：reconcile 规则与 Collab._reconcileElements 完全同源
 * （version 大者胜，同 version 时 versionNonce 小者胜），区别只在触发时机
 * 与“先解出库里旧场景再合并”这一步。
 *
 * 加密约束：元素与文件都用 roomKey 加密，roomKey 只存在于 URL hash，
 * 绝不随请求发送；Firebase 侧看到的始终是密文。
 */
import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";
import type { Bytes } from "firebase/firestore";
import type { UploadMetadata } from "firebase/storage";

// private
// -----------------------------------------------------------------------------

let FIREBASE_CONFIG: Record<string, any>;
// 配置来自构建期环境变量；解析失败降级为空对象，让应用能起来并给出警告，
// 而不是因为一个配置拼写错误直接白屏。
try {
  FIREBASE_CONFIG = JSON.parse(import.meta.env.VITE_APP_FIREBASE_CONFIG);
} catch (error: any) {
  console.warn(
    `Error JSON parsing firebase config. Supplied value: ${
      import.meta.env.VITE_APP_FIREBASE_CONFIG
    }`,
  );
  FIREBASE_CONFIG = {};
}

/**
 * 惰性单例加载器：只在第一次真正需要 Firebase 时加载 SDK 并初始化。
 * 失败时把缓存的 promise 清空，允许下次调用重试——否则一次网络抖动
 * 会让整个会话永久处于“SDK 加载失败”状态。
 */
const lazy = <T>(load: () => Promise<T>) => {
  let promise: Promise<T> | null = null;
  return () =>
    (promise ??= load().catch((error) => {
      promise = null;
      throw error;
    }));
};

/** 只初始化一次 Firebase App；并发调用共享同一个 promise。 */
const _initializeFirebase = lazy(async () => {
  const sdk = await import("./firebaseSDK");
  return { sdk, app: sdk.initializeApp(FIREBASE_CONFIG) };
});

/** 解构出用到的 Firestore API，避免每个调用点重复 await SDK 模块。 */
const _loadFirestore = lazy(async () => {
  const { sdk, app } = await _initializeFirebase();
  const { getFirestore, doc, getDoc, runTransaction, Bytes } = sdk;
  return { firestore: getFirestore(app), doc, getDoc, runTransaction, Bytes };
});

/** 同上，但只服务 Storage（图片/文件上传），与 Firestore 分开按需加载。 */
const _loadStorage = lazy(async () => {
  const { sdk, app } = await _initializeFirebase();
  const { getStorage, ref, uploadBytes } = sdk;
  return { storage: getStorage(app), ref, uploadBytes };
});

// -----------------------------------------------------------------------------

/**
 * 上传任意二进制到 Storage。
 * 参数 path 是完整对象路径（已含前缀），由调用方决定目录结构；
 * 失败直接抛给调用方，由它决定是整批失败还是按文件标记 errored。
 */
export const uploadBytesToFirebase = async (
  path: string,
  data: Blob | Uint8Array,
  metadata?: UploadMetadata,
) => {
  const { storage, ref, uploadBytes } = await _loadStorage();
  return uploadBytes(ref(storage, path), data, metadata);
};

/**
 * Firestore 里的房间文档结构。三个字段必须同一次事务写入：
 * sceneVersion 既用于快速比较，也用于排查“库里场景为何比内存旧”。
 * iv 必须与 ciphertext 一起存，否则无法解密。
 */
type FirebaseStoredScene = {
  sceneVersion: number;
  iv: Bytes;
  ciphertext: Bytes;
};

/** 序列化并加密元素数组；iv 由加密库随机生成，每次写入都不同。 */
const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

/**
 * 解密房间文档，返回未 restore 的原始元素数组。
 * 这里刻意不做 restore/getSyncableElements：调用方需要在 restore 前后
 * 各自插入过滤逻辑（读旧场景时、写回时口径不同）。
 */
const decryptElements = async (
  data: FirebaseStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext.toUint8Array() as Uint8Array<ArrayBuffer>;
  const iv = data.iv.toUint8Array() as Uint8Array<ArrayBuffer>;

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

/**
 * 以 socket 为 key 记住“库里最新的场景版本”，用于 isSavedToFirebase 的
 * 快速判定。用 WeakMap 而非 Map：socket 断开后条目可被 GC，避免长会话
 * 中不断累积已失效的连接引用。
 */
class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

/**
 * 判断场景是否已经落库：比较缓存的库版本与当前场景版本（version 之和）。
 *
 * 版本相同即视为已保存，因为 getSceneVersion 对所有元素 version 求和，
 * 任何一次编辑都会让它单调增加。没有房间时返回 true——此时无库可写，
 * 返回 false 只会让 beforeUnload 无意义地阻挠用户离开。
 */
export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

/**
 * 批量上传图片文件到 Storage，逐个文件独立成败。
 *
 * 返回 { savedFiles, erroredFiles }：调用方据此只把成功项标记为 saved，
 * 失败项保留 pending 以便重试。注意 SDK 加载失败在函数入口就抛出
 * （不进入 per-file catch），因为此时不是“某个文件坏了”，而是整体不可用。
 */
export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  // failing to load the SDK must fail the whole save rather than be reported
  // per file as `erroredFiles` (which share links ignore, and collab never
  // retries)
  const { storage, ref, uploadBytes } = await _loadStorage();

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const storageRef = ref(storage, `${prefix}/${id}`);
        await uploadBytes(storageRef, buffer, {
          cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
        });
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

/**
 * 把一个场景快照加密成可直接写入 Firestore 的文档对象。
 * sceneVersion 在加密前用明文元素算出，解密方无需先解密就能比较新旧。
 */
const createFirebaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  const { Bytes } = await _loadFirestore();
  return {
    sceneVersion,
    ciphertext: Bytes.fromUint8Array(new Uint8Array(ciphertext)),
    iv: Bytes.fromUint8Array(iv),
  } as FirebaseStoredScene;
};

/**
 * 保存房间场景，返回库里的最终权威元素。
 *
 * 并发安全靠 Firestore 事务：两个 peer 同时保存时，事务串行执行，
 * 后执行者会先读到前者写入的密文，再与自己的内存场景 reconcile。
 * 返回值是“写完后再读出来”的结果，调用方 Collab.saveCollabRoomToFirebase
 * 会用它回灌本地，弥合提交期间别人写入的差异。
 *
 * 以下任一条件成立直接返回 null（无事可做）：无房间、无 socket、
 * 或当前场景版本已与库一致（isSavedToFirebase）。
 */
export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  const { firestore, doc, runTransaction } = await _loadFirestore();
  const docRef = doc(firestore, "scenes", roomId);

  const storedScene = await runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(docRef);

    if (!snapshot.exists()) {
      // 首次写入：没有历史可合并，直接建文档。仍在事务内，
      // 保证“两个 peer 同时发现文档不存在”时只有一个 set 成功。
      const storedScene = await createFirebaseSceneDocument(elements, roomKey);

      transaction.set(docRef, storedScene);

      return storedScene;
    }

    // 写入走事务：先读出库里已有场景，解密/restore 后与内存场景做
    // reconcile，再把合并结果写回。这样两个 peer 同时保存时不会互相覆盖。
    // reconcile 的入参顺序被刻意反过来：内存元素作为 “local”，库里的
    // 历史元素作为 “remote”，于是冲突裁决仍按 version/versionNonce 走，
    // 与实时 socket 路径完全同一条规则。
    const prevStoredScene = snapshot.data() as FirebaseStoredScene;
    const prevStoredElements = getSyncableElements(
      restoreElements(await decryptElements(prevStoredScene, roomKey), null),
    );
    const reconciledElements = getSyncableElements(
      reconcileElements(
        elements,
        prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
        appState,
      ),
    );

    const storedScene = await createFirebaseSceneDocument(
      reconciledElements,
      roomKey,
    );

    transaction.update(docRef, storedScene);

    // Return the stored elements as the in memory `reconciledElements` could have mutated in the meantime
    return storedScene;
  });

  // 解密并 restore 库里的结果，作为写库成功的权威版本；不能用内存里的
  // reconciledElements，因为事务提交期间别的 peer 可能又写了新内容。
  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return toBrandedType<RemoteExcalidrawElement[]>(storedElements);
};

/**
 * 读取房间场景（首次进房/兜底路径）。
 *
 * 返回 null 表示库里还没有这个房间，调用方应视为“空场景”而不是错误。
 * deleteInvisibleElements=true 只在这一条路径开启：读取时顺手清理不可见
 * 小元素，避免它们从库里被重新灌回新会话；实时广播路径不做此清理，
 * 因为对端内存里的元素需要保持原样参与 reconcile。
 * 传入 socket 时同步刷新版本缓存，供 isSavedToFirebase 使用。
 */
export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  const { firestore, doc, getDoc } = await _loadFirestore();
  const docRef = doc(firestore, "scenes", roomId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    return null;
  }
  const storedScene = docSnap.data() as FirebaseStoredScene;
  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return elements;
};

/**
 * 下载并解密房间/分享链接引用的图片文件。
 *
 * 不用 Storage SDK 而直接拼 REST URL：一次拿多个文件时省去逐文件
 * getDownloadURL 的往返，且响应体就是密文，解密逻辑与上传对称。
 * 单个文件失败只记入 erroredFiles，不影响同批其他文件；
 * 状态码 <400 才算成功（404 常见于“文件从未上传成功”，需要重试）。
 */
export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      // 去重是必须的：多个元素可能引用同一 fileId，
      // 重复请求既浪费带宽，也会让 savedFiles 出现重复项。
      try {
        const url = `https://firebasestorage.googleapis.com/v0/b/${
          FIREBASE_CONFIG.storageBucket
        }/o/${encodeURIComponent(prefix.replace(/^\//, ""))}%2F${id}`;
        const response = await fetch(`${url}?alt=media`);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
