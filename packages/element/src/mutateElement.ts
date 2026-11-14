import {
  getSizeFromPoints,
  randomInteger,
  getUpdatedTimestamp,
} from "@excalidraw/common";

import type { Radians } from "@excalidraw/math";

import type { Mutable } from "@excalidraw/common/utility-types";

import { ShapeCache } from "./shape";

import { updateElbowArrowPoints } from "./elbowArrow";

import { isElbowArrow } from "./typeChecks";

import type {
  ElementsMap,
  ExcalidrawElbowArrowElement,
  ExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "./types";

/**
 * 元素更新的唯一入口定义。
 *
 * 刻意排除三个字段：
 * - `id`：元素身份不可改；
 * - `updated` / `created`：时间戳由本文件统一维护，调用方不能伪造。
 * `created` 是“生命周期元数据”，只在构造/复制时写一次，撤销重做也保留；
 * 需要修复它时必须新建元素对象，而不是走 update。
 */
// `created` is lifetime metadata: it is set once when an element instance is
// constructed (or duplicated) and never updated, so it is not part of an
// element update. An explicit repair must construct a new element object.
export type ElementUpdate<TElement extends ExcalidrawElement> = Omit<
  Partial<TElement>,
  "id" | "updated" | "created"
>;

/**
 * 就地更新元素，并推进协作版本号。
 *
 * 这是“元素会被 mutate”这一事实的源头：虽然类型是 Readonly，运行时这里
 * 直接给字段赋值。所有调用方共享同一个对象引用，因此本函数不会触发
 * 重新渲染；需要渲染时走同包的 `Scene.mutateElement`。
 *
 * 版本推进规则（协作冲突裁决的全部依据）：
 * - `version = updates.version ?? element.version + 1`：正常本地修改 +1；
 *   撤销/重做会显式传入 version，走别的路径；
 * - `versionNonce = updates.versionNonce ?? randomInteger()`：每次修改都换
 *   随机数，用于 version 相同时的确定性裁决；
 * - `updated = getUpdatedTimestamp()`：本地墙钟，仅供墓碑过期等判断。
 *
 * 返回同一个元素对象；`didChange === false` 时原样返回且不推进版本，
 * 这是“无变化不产生历史记录”的基础。
 */
export const mutateElement = <TElement extends Mutable<ExcalidrawElement>>(
  element: TElement,
  elementsMap: ElementsMap,
  updates: ElementUpdate<TElement>,
  options?: {
    isDragging?: boolean;
    isBindingEnabled?: boolean;
    isMidpointSnappingEnabled?: boolean;
  },
) => {
  let didChange = false;

  // casting to any because can't use `in` operator
  // (see https://github.com/microsoft/TypeScript/issues/21732)
  const { points, fixedSegments, fileId } = updates as any;

  if (
    isElbowArrow(element) &&
    (Object.keys(updates).length === 0 || // normalization case
      typeof points !== "undefined" || // repositioning
      typeof fixedSegments !== "undefined") // segment fixing
  ) {
    updates = {
      ...updates,
      angle: 0 as Radians,
      ...updateElbowArrowPoints(
        {
          ...(element as ExcalidrawElbowArrowElement),
          x: updates.x ?? element.x,
          y: updates.y ?? element.y,
        },
        elementsMap as NonDeletedSceneElementsMap,
        updates as ElementUpdate<ExcalidrawElbowArrowElement>,
        options,
      ),
    };
  } else if (typeof points !== "undefined") {
    updates = { ...getSizeFromPoints(points), ...updates };
  }

  for (const key in updates) {
    const value = (updates as any)[key];
    if (typeof value !== "undefined") {
      if (
        (element as any)[key] === value &&
        // if object, always update because its attrs could have changed
        // (except for specific keys we handle below)
        (typeof value !== "object" ||
          value === null ||
          key === "groupIds" ||
          key === "scale")
      ) {
        continue;
      }

      if (key === "scale") {
        const prevScale = (element as any)[key];
        const nextScale = value;
        if (prevScale[0] === nextScale[0] && prevScale[1] === nextScale[1]) {
          continue;
        }
      } else if (key === "points") {
        const prevPoints = (element as any)[key];
        const nextPoints = value;
        if (prevPoints.length === nextPoints.length) {
          let didChangePoints = false;
          let index = prevPoints.length;
          while (--index) {
            const prevPoint = prevPoints[index];
            const nextPoint = nextPoints[index];
            if (
              prevPoint[0] !== nextPoint[0] ||
              prevPoint[1] !== nextPoint[1]
            ) {
              didChangePoints = true;
              break;
            }
          }
          if (!didChangePoints) {
            continue;
          }
        }
      }

      (element as any)[key] = value;
      didChange = true;
    }
  }

  if (!didChange) {
    return element;
  }

  if (
    typeof updates.height !== "undefined" ||
    typeof updates.width !== "undefined" ||
    typeof fileId != "undefined" ||
    typeof points !== "undefined"
  ) {
    ShapeCache.delete(element);
  }

  element.version = updates.version ?? element.version + 1;
  element.versionNonce = updates.versionNonce ?? randomInteger();
  element.updated = getUpdatedTimestamp();

  return element;
};

/**
 * `mutateElement` 的不可变版本：返回新对象，不碰入参。
 *
 * 用途区分：
 * - 拖拽/缩放等高频交互走 mutateElement（就地改，省分配）；
 * - Store 快照、历史 delta、协作应用走 newElementWith（复制，保证旧快照
 *   不被后续 mutate 污染）。
 * `force` 用于“值看起来没变但必须产生新版本”的场景（例如重新绑定后需要
 * 让远端感知）。
 */
export const newElementWith = <TElement extends ExcalidrawElement>(
  element: TElement,
  updates: ElementUpdate<TElement>,
  /** pass `true` to always regenerate */
  force = false,
): TElement => {
  let didChange = false;
  for (const key in updates) {
    const value = (updates as any)[key];
    if (typeof value !== "undefined") {
      if (
        (element as any)[key] === value &&
        // if object, always update because its attrs could have changed
        (typeof value !== "object" || value === null)
      ) {
        continue;
      }
      didChange = true;
    }
  }

  if (!didChange && !force) {
    return element;
  }

  return {
    ...element,
    ...updates,
    version: updates.version ?? element.version + 1,
    versionNonce: updates.versionNonce ?? randomInteger(),
    updated: getUpdatedTimestamp(),
  };
};

/**
 * 只推进版本、不改业务字段。
 *
 * 典型调用点：restore.ts 的 bumpElementVersions——把外部导入的元素版本
 * 抬到“本地版本 + 1”，否则导入后第一次编辑会被远端判为旧版本而丢弃。
 * 同样不触发重渲染。
 */
export const bumpVersion = <T extends Mutable<ExcalidrawElement>>(
  element: T,
  version?: ExcalidrawElement["version"],
) => {
  element.version = (version ?? element.version) + 1;
  element.versionNonce = randomInteger();
  element.updated = getUpdatedTimestamp();
  return element;
};
