import throttle from "lodash.throttle";

import { arrayToMap, isDevEnv, isTestEnv } from "@excalidraw/common";

import {
  orderByFractionalIndex,
  syncInvalidIndices,
  validateFractionalIndices,
} from "@excalidraw/element";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import type { MakeBrand } from "@excalidraw/common/utility-types";

import type { AppState } from "../types";

export type ReconciledExcalidrawElement = OrderedExcalidrawElement &
  MakeBrand<"ReconciledElement">;

export type RemoteExcalidrawElement = OrderedExcalidrawElement &
  MakeBrand<"RemoteExcalidrawElement">;

/**
 * 协作冲突裁决——纯函数，不读写任何全局状态。
 *
 * 返回 true 表示“保留本地、丢弃远端”。四类理由，按优先级：
 * 1. 本端正在编辑该元素（文本编辑/缩放/新建）：任何远端覆盖都会打断
 *    当前手势，所以无条件保留本地；
 * 2. 本地 version 更大：本地更新；
 * 3. version 相同但本地 versionNonce 更小：确定性 tie-break。
 *
 * tie-break 选“更小”而不是“更大”只是约定，关键是所有 peer 用同一个
 * 比较方向；否则两端会各自保留自己的版本，永久分叉。
 */
export const shouldDiscardRemoteElement = (
  localAppState: AppState,
  local: OrderedExcalidrawElement | undefined,
  remote: RemoteExcalidrawElement,
): boolean => {
  if (
    local &&
    // local element is being edited
    (local.id === localAppState.editingTextElement?.id ||
      local.id === localAppState.resizingElement?.id ||
      local.id === localAppState.newElement?.id ||
      // local element is newer
      local.version > remote.version ||
      // resolve conflicting edits deterministically by taking the one with
      // the lowest versionNonce
      (local.version === remote.version &&
        local.versionNonce <= remote.versionNonce))
  ) {
    return true;
  }
  return false;
};

const validateIndicesThrottled = throttle(
  (
    orderedElements: readonly OrderedExcalidrawElement[],
    localElements: readonly OrderedExcalidrawElement[],
    remoteElements: readonly RemoteExcalidrawElement[],
  ) => {
    if (isDevEnv() || isTestEnv() || window?.DEBUG_FRACTIONAL_INDICES) {
      // create new instances due to the mutation
      const elements = syncInvalidIndices(
        orderedElements.map((x) => ({ ...x })),
      );

      validateFractionalIndices(elements, {
        // throw in dev & test only, to remain functional on `DEBUG_FRACTIONAL_INDICES`
        shouldThrow: isTestEnv() || isDevEnv(),
        includeBoundTextValidation: true,
        reconciliationContext: {
          localElements,
          remoteElements,
        },
      });
    }
  },
  1000 * 60,
  { leading: true, trailing: false },
);

/**
 * 把远端元素合并进本地场景。
 *
 * 合并单位是“元素”，不是“场景”：每个 id 独立裁决，因此两端可以同时
 * 编辑不同元素而互不覆盖。步骤：
 * 1. 以远端顺序遍历，逐 id 用 shouldDiscardRemoteElement 裁决；
 * 2. 补上本地独有的元素（远端还没见过的新元素）；
 * 3. 按 fractional index 重排——两端数组顺序可能不同，排序必须由
 *    `index` 决定，不能信传输顺序；
 * 4. `syncInvalidIndices` 去重/修复 index 冲突。
 *
 * 注意：这里不 bump version。调用方 `Collab._reconcileElements` 会在
 * reconcile 之后调用 bumpElementVersions，把结果抬到本地版本之上，
 * 否则下一次本地编辑会被自己的旧版本压住。
 */
export const reconcileElements = (
  localElements: readonly OrderedExcalidrawElement[],
  remoteElements: readonly RemoteExcalidrawElement[],
  localAppState: AppState,
): ReconciledExcalidrawElement[] => {
  const localElementsMap = arrayToMap(localElements);
  const reconciledElements: OrderedExcalidrawElement[] = [];
  const added = new Set<string>();

  // 先处理远端：远端数组代表“对方认为的最新顺序”，本地裁决只决定
  // 取哪个版本，不改变它出现的位置；added 集合同时用于去重（同一 id
  // 在远端数组里可能出现多次）。
  // process remote elements
  for (const remoteElement of remoteElements) {
    if (!added.has(remoteElement.id)) {
      const localElement = localElementsMap.get(remoteElement.id);
      const discardRemoteElement = shouldDiscardRemoteElement(
        localAppState,
        localElement,
        remoteElement,
      );

      if (localElement && discardRemoteElement) {
        reconciledElements.push(localElement);
        added.add(localElement.id);
      } else {
        reconciledElements.push(remoteElement);
        added.add(remoteElement.id);
      }
    }
  }

  // 再补充本地独有元素：远端还没收到的新元素不能被这次合并吞掉。
  // process remaining local elements
  for (const localElement of localElements) {
    if (!added.has(localElement.id)) {
      reconciledElements.push(localElement);
      added.add(localElement.id);
    }
  }

  // 排序只看 index，不看数组顺序；两端对同一组 index 会得到相同结果。
  const orderedElements = orderByFractionalIndex(reconciledElements);

  validateIndicesThrottled(orderedElements, localElements, remoteElements);

  // 两端可能各自生成相同 index（同时在同一位置插入），重新分配冲突项。
  // de-duplicate indices
  syncInvalidIndices(orderedElements);

  return orderedElements as ReconciledExcalidrawElement[];
};
