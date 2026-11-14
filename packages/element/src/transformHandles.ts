import {
  DEFAULT_TRANSFORM_HANDLE_SPACING,
  type EditorInterface,
} from "@excalidraw/common";

import { pointFrom, pointRotateRads } from "@excalidraw/math";

import type { Radians } from "@excalidraw/math";

import type {
  InteractiveCanvasAppState,
  Zoom,
} from "@excalidraw/excalidraw/types";
import type { Bounds } from "@excalidraw/common";

import { getElementAbsoluteCoords } from "./bounds";
import {
  isElbowArrow,
  isFrameLikeElement,
  isImageElement,
  isLinearElement,
} from "./typeChecks";

import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
  PointerType,
} from "./types";

/**
 * 变换手柄的几何计算（只算位置，不做命中/拖拽）。
 *
 * 手柄尺寸按指针类型分档（鼠标 8 / 笔 16 / 触控 28 CSS px），但代码里
 * 统一除以 zoom，因为手柄是“屏幕固定大小”，不能随画布缩放变大变小。
 * 生成后的坐标是场景坐标，交互画布绘制时再加 scroll/zoom。
 *
 * 注意这里只生成 8 个缩放点 + 1 个旋转点；哪些点被省略由 omitSides 与
 * 元素类型决定（线性元素、frame、小尺寸元素）。
 *
 * 补充：本文件是纯函数集合，不读 store、不发事件。命中检测由调用方
 * （renderer/interactiveScene 与 App 的选择逻辑）按返回的矩形自行判断，
 * 因此这里可以安全地在测试/导出等无 DOM 环境复用。
 *
 * 坐标约定：入参 `[x1,y1,x2,y2,cx,cy]` 必须是“未旋转的绝对包围盒 + 旋转中心”，
 * 旋转由 generateTransformHandle 统一完成；传已旋转坐标会二次旋转。
 */

/**
 * 手柄方向：8 个缩放方向；旋转手柄单独用 "rotation" 表示。
 *
 * 方向名与“被拖动的边”一致（n = 上边），不是“锚点”方向；锚点换算在
 * resizeElements 的 getResizeAnchor 里完成。
 */
export type TransformHandleDirection =
  | "n"
  | "s"
  | "w"
  | "e"
  | "nw"
  | "ne"
  | "sw"
  | "se";

export type TransformHandleType = TransformHandleDirection | "rotation";

/** 手柄矩形 [x, y, width, height]，场景坐标，未考虑 scroll/zoom 偏移。 */
export type TransformHandle = Bounds;
/**
 * 稀疏结果：被省略的手柄是 undefined 而不是缺失键，调用方据此区分
 * “没生成”和“生成了但坐标为空”。
 */
export type TransformHandles = Partial<{
  [T in TransformHandleType]: TransformHandle;
}>;
/** false 表示当前没有拖任何手柄（例如悬停/静止状态）。 */
export type MaybeTransformHandleType = TransformHandleType | false;

/**
 * 手柄边长（CSS px）。分档依据是指针精度：触控最粗、鼠标最细；
 * 使用处一律除以 zoom，保证屏幕上大小恒定。
 */
const transformHandleSizes: { [k in PointerType]: number } = {
  mouse: 8,
  pen: 16,
  touch: 28,
};

/** 旋转手柄与上边框之间的固定间隙（CSS px），同样要除以 zoom。 */
const ROTATION_RESIZE_HANDLE_GAP = 16;

/**
 * 默认省略四条边手柄（保留四角 + 旋转）。
 * 只有在元素足够大时 getTransformHandlesFromCoords 才会补出边手柄，
 * 小元素上 8 个点会互相遮挡、难以点中。
 */
export const DEFAULT_OMIT_SIDES = {
  e: true,
  s: true,
  n: true,
  w: true,
};

/**
 * 多选时的省略规则：与默认相同（四边省略），但多选包围盒通常很大，
 * 边缘手柄容易与单个元素的手柄混淆，因此保持保守。
 */
export const OMIT_SIDES_FOR_MULTIPLE_ELEMENTS = {
  e: true,
  s: true,
  n: true,
  w: true,
};

/**
 * frame 的省略规则：额外禁用 rotation。
 * frame 的语义是固定画布/容器边界，旋转会破坏内部坐标与导出结果。
 */
export const OMIT_SIDES_FOR_FRAME = {
  e: true,
  s: true,
  n: true,
  w: true,
  rotation: true,
};

/**
 * 两点直线（"/" 方向）的省略规则：四边之外再省略 nw/se，
 * 只保留与线段方向一致的 ne/sw 两个角，减少手柄与线体重叠。
 */
const OMIT_SIDES_FOR_LINE_SLASH = {
  e: true,
  s: true,
  n: true,
  w: true,
  nw: true,
  se: true,
};

/**
 * 两点直线（"\" 方向）的省略规则：只省略四边，四个角全部保留。
 * 注意它与 slash 不对称，这是既有交互设计，不是笔误。
 */
const OMIT_SIDES_FOR_LINE_BACKSLASH = {
  e: true,
  s: true,
  n: true,
  w: true,
};

/**
 * 生成单个手柄矩形。
 *
 * 关键点：先按“未旋转”的左上角 + 宽高求出中心，再让中心绕 `(cx, cy)` 旋转，
 * 最后用旋转后的中心反推左上角。这样手柄自身始终保持正立（不随元素转），
 * 只有位置绕元素中心旋转。
 *
 * 如果直接旋转左上角，手柄会绕错误的支点转，元素旋转后手柄会偏离边框。
 *
 * @returns [x, y, width, height]，场景坐标。
 */
const generateTransformHandle = (
  x: number,
  y: number,
  width: number,
  height: number,
  cx: number,
  cy: number,
  angle: Radians,
): TransformHandle => {
  const [xx, yy] = pointRotateRads(
    pointFrom(x + width / 2, y + height / 2),
    pointFrom(cx, cy),
    angle,
  );
  return [xx - width / 2, yy - height / 2, width, height];
};

/**
 * 手机 + 移动端 UA 时禁用“从边缩放”，只保留四角。
 *
 * 原因：小屏上边手柄的命中区与滚动/手势区域重叠，容易误触；
 * 返回值供 getOmitSidesForEditorInterface 转成 omitSides。
 */
export const canResizeFromSides = (editorInterface: EditorInterface) => {
  if (
    editorInterface.formFactor === "phone" &&
    editorInterface.userAgent.isMobileDevice
  ) {
    return false;
  }

  return true;
};

/**
 * 把“能否从边缩放”翻译成 omitSides。
 *
 * 能 → 返回 DEFAULT_OMIT_SIDES（四边省略，四角+旋转可用）；
 * 不能 → 返回空对象，表示不做额外省略；边手柄最终是否出现仍由
 * getTransformHandlesFromCoords 的尺寸阈值决定。
 */
export const getOmitSidesForEditorInterface = (
  editorInterface: EditorInterface,
) => {
  if (canResizeFromSides(editorInterface)) {
    return DEFAULT_OMIT_SIDES;
  }

  return {};
};

/**
 * 从绝对坐标包围盒生成手柄。
 *
 * 步骤：先算未旋转的角点，再绕包围盒中心 `(cx, cy)` 旋转 `angle`。所以
 * 调用方必须传入“未旋转的 x1/y1/x2/y2 + 旋转中心 + 角度”，不能传已旋转
 * 的坐标，否则会二次旋转。
 *
 * 四角手柄始终生成；四边手柄只有在元素尺寸大于约 5 个鼠标手柄宽/高时
 * 才出现，避免小元素上 8 个点糊成一团。
 */
export const getTransformHandlesFromCoords = (
  [x1, y1, x2, y2, cx, cy]: [number, number, number, number, number, number],
  angle: Radians,
  zoom: Zoom,
  pointerType: PointerType,
  omitSides: { [T in TransformHandleType]?: boolean } = {},
  margin = 4,
  spacing = DEFAULT_TRANSFORM_HANDLE_SPACING,
): TransformHandles => {
  const size = transformHandleSizes[pointerType];
  // 所有长度都除以 zoom：手柄要在屏幕上保持恒定像素大小，
  // 因此在场景坐标里它的尺寸与 zoom 成反比。
  const handleWidth = size / zoom.value;
  const handleHeight = size / zoom.value;

  const handleMarginX = size / zoom.value;
  const handleMarginY = size / zoom.value;

  const width = x2 - x1;
  const height = y2 - y1;
  // dashedLineMargin 是选择框虚线到包围盒的距离；centeringOffset 用于让
  // 手柄中心对齐虚线端点，而不是左上角对齐。
  const dashedLineMargin = margin / zoom.value;
  const centeringOffset = (size - spacing * 2) / (2 * zoom.value);

  const transformHandles: TransformHandles = {
    nw: omitSides.nw
      ? undefined
      : generateTransformHandle(
          x1 - dashedLineMargin - handleMarginX + centeringOffset,
          y1 - dashedLineMargin - handleMarginY + centeringOffset,
          handleWidth,
          handleHeight,
          cx,
          cy,
          angle,
        ),
    ne: omitSides.ne
      ? undefined
      : generateTransformHandle(
          x2 + dashedLineMargin - centeringOffset,
          y1 - dashedLineMargin - handleMarginY + centeringOffset,
          handleWidth,
          handleHeight,
          cx,
          cy,
          angle,
        ),
    sw: omitSides.sw
      ? undefined
      : generateTransformHandle(
          x1 - dashedLineMargin - handleMarginX + centeringOffset,
          y2 + dashedLineMargin - centeringOffset,
          handleWidth,
          handleHeight,
          cx,
          cy,
          angle,
        ),
    se: omitSides.se
      ? undefined
      : generateTransformHandle(
          x2 + dashedLineMargin - centeringOffset,
          y2 + dashedLineMargin - centeringOffset,
          handleWidth,
          handleHeight,
          cx,
          cy,
          angle,
        ),
    rotation: omitSides.rotation
      ? undefined
      : generateTransformHandle(
          x1 + width / 2 - handleWidth / 2,
          y1 -
            dashedLineMargin -
            handleMarginY +
            centeringOffset -
            ROTATION_RESIZE_HANDLE_GAP / zoom.value,
          handleWidth,
          handleHeight,
          cx,
          cy,
          angle,
        ),
  };

  // We only want to show height handles (all cardinal directions)  above a certain size
  // Note: we render using "mouse" size so we should also use "mouse" size for this check
  // 中文：阈值固定用 mouse 尺寸，而不是当前 pointerType；否则触控笔会因
  // 阈值变大而更早隐藏边手柄，同一元素在不同设备上表现不一致。
  const minimumSizeForEightHandles =
    (5 * transformHandleSizes.mouse) / zoom.value;
  // 注意四角与旋转手柄在上面无条件（除非 omitSides）生成，边手柄才受尺寸
  // 阈值限制；这样即使元素很小，仍能通过四角缩放。
  if (Math.abs(width) > minimumSizeForEightHandles) {
    if (!omitSides.n) {
      transformHandles.n = generateTransformHandle(
        x1 + width / 2 - handleWidth / 2,
        y1 - dashedLineMargin - handleMarginY + centeringOffset,
        handleWidth,
        handleHeight,
        cx,
        cy,
        angle,
      );
    }
    if (!omitSides.s) {
      transformHandles.s = generateTransformHandle(
        x1 + width / 2 - handleWidth / 2,
        y2 + dashedLineMargin - centeringOffset,
        handleWidth,
        handleHeight,
        cx,
        cy,
        angle,
      );
    }
  }
  if (Math.abs(height) > minimumSizeForEightHandles) {
    if (!omitSides.w) {
      transformHandles.w = generateTransformHandle(
        x1 - dashedLineMargin - handleMarginX + centeringOffset,
        y1 + height / 2 - handleHeight / 2,
        handleWidth,
        handleHeight,
        cx,
        cy,
        angle,
      );
    }
    if (!omitSides.e) {
      transformHandles.e = generateTransformHandle(
        x2 + dashedLineMargin - centeringOffset,
        y1 + height / 2 - handleHeight / 2,
        handleWidth,
        handleHeight,
        cx,
        cy,
        angle,
      );
    }
  }

  return transformHandles;
};

/**
 * 按元素类型决定手柄集合。
 *
 * 特殊规则都集中在这里：
 * - 锁定元素 / 肘形箭头：不显示任何手柄（不可缩放/旋转）；
 * - 线性元素：根据首段方向省略四个角或四边，避免手柄落在箭头延长线上；
 * - frame：不能旋转，只保留缩放；
 * - 图片：margin 为 0，手柄贴边。
 */
export const getTransformHandles = (
  element: ExcalidrawElement,
  zoom: Zoom,
  elementsMap: ElementsMap,
  pointerType: PointerType = "mouse",
  omitSides: { [T in TransformHandleType]?: boolean } = DEFAULT_OMIT_SIDES,
): TransformHandles => {
  // so that when locked element is selected (especially when you toggle lock
  // via keyboard) the locked element is visually distinct, indicating
  // you can't move/resize
  // 中文：锁定元素返回空对象而不是 undefined，调用方可以直接 Object.keys
  // 判断“有没有手柄”；肘形箭头同理（旋转会破坏路由）。
  if (
    element.locked ||
    // Elbow arrows cannot be rotated
    isElbowArrow(element)
  ) {
    return {};
  }

  if (element.type === "freedraw" || isLinearElement(element)) {
    if (element.points.length === 2) {
      // only check the last point because starting point is always (0,0)
      // 中文：两点直线的方向由 points[1] 的符号决定；按四个象限映射到
      // slash/backslash 两套省略规则，避免手柄落在不合适的角上。
      const [, p1] = element.points;
      if (p1[0] === 0 || p1[1] === 0) {
        omitSides = OMIT_SIDES_FOR_LINE_BACKSLASH;
      } else if (p1[0] > 0 && p1[1] < 0) {
        omitSides = OMIT_SIDES_FOR_LINE_SLASH;
      } else if (p1[0] > 0 && p1[1] > 0) {
        omitSides = OMIT_SIDES_FOR_LINE_BACKSLASH;
      } else if (p1[0] < 0 && p1[1] > 0) {
        omitSides = OMIT_SIDES_FOR_LINE_SLASH;
      } else if (p1[0] < 0 && p1[1] < 0) {
        omitSides = OMIT_SIDES_FOR_LINE_BACKSLASH;
      }
    }
  } else if (isFrameLikeElement(element)) {
    // frame 只禁用旋转，缩放照常；不要整个清空 omitSides，
    // 否则四边手柄会全部出现，与默认交互不一致。
    omitSides = {
      ...omitSides,
      rotation: true,
    };
  }
  // margin 决定手柄离包围盒多远：线性元素留更大空间避免遮挡线体；
  // 图片紧贴边框（margin=0），因为图片本身没有描边需要避开。
  const margin = isLinearElement(element)
    ? DEFAULT_TRANSFORM_HANDLE_SPACING + 8
    : isImageElement(element)
    ? 0
    : DEFAULT_TRANSFORM_HANDLE_SPACING;
  return getTransformHandlesFromCoords(
    getElementAbsoluteCoords(element, elementsMap, true),
    element.angle,
    zoom,
    pointerType,
    omitSides,
    margin,
    isImageElement(element) ? 0 : undefined,
  );
};

/**
 * 是否绘制选择边框（不等于是否显示手柄）。
 *
 * 编辑/拖拽线性元素时不画整体包围盒；肘形箭头单独选中不画；移动端的
 * 线性元素不画（缩放交互在小屏上不可靠）。多选时始终画。
 */
export const hasBoundingBox = (
  elements: readonly NonDeletedExcalidrawElement[],
  appState: InteractiveCanvasAppState,
  editorInterface: EditorInterface,
) => {
  if (
    appState.selectedLinearElement?.isEditing ||
    appState.selectedLinearElement?.isDragging
  ) {
    return false;
  }
  if (elements.length > 1) {
    return true;
  }
  const element = elements[0];
  if (isElbowArrow(element)) {
    // Elbow arrows cannot be resized as single selected elements
    return false;
  }
  if (!isLinearElement(element)) {
    return true;
  }

  // on mobile/tablet we currently don't show bbox because of resize issues
  // (also prob best for simplicity's sake)
  return element.points.length > 2 && !editorInterface.userAgent.isMobileDevice;
};
