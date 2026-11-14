import {
  arrayToMap,
  getFeatureFlag,
  getGridPoint,
  invariant,
  isTransparent,
} from "@excalidraw/common";

import {
  PRECISION,
  clamp,
  lineSegment,
  pointDistance,
  pointDistanceSq,
  pointFrom,
  pointFromArray,
  pointFromVector,
  pointRotateRads,
  pointsEqual,
  vectorFromPoint,
  vectorNormalize,
  vectorScale,
  type GlobalPoint,
} from "@excalidraw/math";

import type { LineSegment, LocalPoint, Radians } from "@excalidraw/math";
import type { AppState, NullableGridSize } from "@excalidraw/excalidraw/types";
import type { MapEntry, Mutable } from "@excalidraw/common/utility-types";
import type { Bounds } from "@excalidraw/common";

import { getCenterForBounds } from "./bounds";
import {
  getAllHoveredElementAtPoint,
  getHoveredElementForBinding,
  hitElementItself,
  intersectElementWithLineSegment,
  isBindableElementInsideOtherBindable,
  isPointInBindingArea,
  isPointInElement,
} from "./collision";
import { distanceToElement } from "./distance";
import {
  headingForPointFromElement,
  headingIsHorizontal,
  vectorToHeading,
  type Heading,
} from "./heading";
import { LinearElementEditor } from "./linearElementEditor";
import { mutateElement } from "./mutateElement";
import { getBoundTextElement, handleBindTextResize } from "./textElement";
import {
  isArrowElement,
  isBindableElement,
  isBoundToContainer,
  isElbowArrow,
  isRectangularElement,
  isRectanguloidElement,
  isTextElement,
} from "./typeChecks";

import { aabbForElement, elementCenterPoint } from "./bounds";
import { updateElbowArrowPoints } from "./elbowArrow";
import {
  deconstructDiamondElement,
  deconstructRectanguloidElement,
  getElbowArrowSnapMidPoint,
  projectFixedPointOntoDiagonal,
} from "./utils";

import { isNonDeletedElement } from ".";

import type { RenderEnvironment } from "./renderEnvironment";
import type { Scene } from "./Scene";

import type { ElementUpdate } from "./mutateElement";
import type {
  BindMode,
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawBindableElement,
  ExcalidrawElbowArrowElement,
  ExcalidrawElement,
  ExcalidrawRectanguloidElement,
  ExcalidrawTextElement,
  FixedPoint,
  FixedPointBinding,
  NonDeleted,
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
  Ordered,
  PointsPositionUpdates,
} from "./types";

/**
 * 端点拖拽的“决策结果”，不是最终坐标。
 *
 * - mode 为具体模式（inside/orbit）：要建立绑定，同时带上目标元素与 focusPoint
 *   （focusPoint 是本次拖动希望端点瞄准的全局点）；
 * - mode === null：显式解绑（拖到空白处、或关闭绑定）；
 * - mode === undefined：保持现状，不动这个端点。
 *
 * 用三态而不是 nullable 对象，是为了区分“解绑”和“别管它”两种语义——
 * 两者混用会导致拖一端时误清另一端的绑定。
 */
export type BindingStrategy =
  // Create a new binding with this mode
  | {
      mode: BindMode;
      element: NonDeleted<ExcalidrawBindableElement>;
      focusPoint: GlobalPoint;
    }
  // Break the binding
  | {
      mode: null;
      element?: undefined;
      focusPoint?: undefined;
    }
  // Keep the existing binding
  | {
      mode: undefined;
      element?: undefined;
      focusPoint?: undefined;
    };

/**
 * 箭头绑定（binding）的完整实现。
 *
 * 数据模型：箭头端点保存的是 `FixedPointBinding`——被绑定元素的 id +
 * 相对其包围盒的归一化固定点（0..1）+ 模式。箭头自己的 `points` 只存
 * 几何结果，绑定关系不在 points 里。这样元素移动/缩放后，端点可以按
 * 固定点重新投影到新轮廓上，而不是保存一个会过期的绝对坐标。
 *
 * 一次端点的求解分两步：
 * 1. 选策略（getBindingStrategyForDraggingBindingElementEndpoints）：
 *    指针落在哪个元素、绑定到侧面中点还是自由点、是否保持原绑定；
 * 2. 求端点（updateBoundPoint）：把“固定点 → 全局点”，再与箭头另一端
 *    连线，和绑定元素轮廓求交，决定端点落在轮廓上还是固定点上。
 *    箭头端有箭头尖时通常贴轮廓，无箭头尖时允许落到固定点（inside）。
 *
 * 关键约束：
 * - `points[0]` 恒为 (0,0)，端点 update 用 index 0 / length-1；
 * - 绑定距离随 zoom 调整（maxBindingDistance_simple），保证不同缩放下
 *   手感一致；
 * - 删除元素时要 fixBindingsAfterDeletion，否则箭头会指向一个不存在的 id。
 *
 * gaps exclude element strokeWidth
 *
 * IMPORTANT: currently must be > 0 (this also applies to the computed gap)
 */
/**
 * 补充说明（建议的阅读顺序）。
 *
 * 本模块的使用方分三类：
 * - 编辑交互：拖拽箭头端点时由 App / LinearElementEditor / actionFinalize 调用
 *   `bindOrUnbindBindingElement`，内部先算策略、再写入 binding；
 * - 几何联动：元素移动/缩放/旋转后由各调用方（dragElements、align、distribute、
 *   resizeElements、delta 等）调用 `updateBoundElements` / `updateBoundArrow`，
 *   反向把箭头端点贴回被绑定元素；
 * - 结构维护：删除走 `fixBindingsAfterDeletion`，复制走
 *   `fixDuplicatedBindingsAfterDuplication`，翻转走 `bindOrUnbindBindingElements`。
 *
 * 输入是元素快照（ElementsMap）、指针的场景坐标与 zoom；输出是对元素/箭头的
 * mutation，或算出的局部/全局点。本文件不触发渲染，写入统一走
 * `scene.mutateElement` / `mutateElement`，何时重绘由调用方决定。
 *
 * 关键不变量：
 * - `fixedPoint` 是相对“未旋转包围盒”的归一化坐标（通常 0..1），所有读取路径
 *   都必须先经 `normalizeFixedPoint`，否则越界值会把端点甩到远处；
 * - 恰好 0.5 会被改写成 0.5001，避免箭头朝向在元素正中附近来回跳；
 * - 只有 `isBindableElement` 为真的元素能成为绑定目标；
 * - 删除/复制后 `boundElements` 与 `startBinding/endBinding` 必须双向一致，
 *   单边残留会变成指向不存在元素的“幽灵箭头”。
 */
/**
 * 箭头端点与绑定元素轮廓之间保留的最小视觉间距（像素，不含描边）。
 * 实际间距还要加上目标描边的一半，见 `getBindingGap`；必须 > 0，
 * 否则端点会陷进图形边缘、并且相乘求交时无法用 gap 作为坐标裁剪阈值。
 */
export const BASE_BINDING_GAP = 5;
/**
 * 箭头两端之间的最小长度。短于该值时端点宁可退回固定点，
 * 避免箭头被压扁后朝向反转（见 `updateBoundPoint` 的第 2/3 分支）。
 */
export const BASE_ARROW_MIN_LENGTH = 10;
/** 焦点圆圈的绘制半径（CSS px），仅用于视觉提示，不参与几何计算。 */
export const FOCUS_POINT_SIZE = 10 / 1.5;

// Below this size (in px) a bindable element has no meaningful interior to
// anchor a proportional fixedPoint into
// 中文：宽或高不足 1px 的元素视为“点状元素”。它没有可归一化的内部空间，
// 直接绑定到中心 (0.5, 0.5)，否则固定点比例会被接近 0 的除数放大成随机值。
const MIN_BINDABLE_SIZE = 1;

/**
 * 计算端点离轮廓应留的间距 = 基础间距 + 描边半径。
 *
 * 为什么只要求 `strokeWidth`：调用方有时还没有真元素（例如
 * `getTextBindingForArrowEndpoint` 预判文本绑定），只需要描边信息即可算出
 * 将来的间距；因此这里刻意用结构化最小入参，而不是完整的可绑定元素。
 *
 * @returns 世界坐标下的间距，始终 > 0（BASE_BINDING_GAP 保证下界）。
 */
export const getBindingGap = (
  // only the stroke width is needed, so the gap can also be computed for a
  // bind target that doesn't exist yet (see `getTextBindingForArrowEndpoint`)
  bindTarget: Pick<ExcalidrawBindableElement, "strokeWidth">,
): number => {
  return BASE_BINDING_GAP + bindTarget.strokeWidth / 2;
};

/**
 * 指针距离元素多远仍算“可以绑定”的阈值。
 *
 * 手感约束：
 * - zoom >= 1 时保持基础距离，避免放大后吸附范围缩得太小；
 * - zoom < 1（缩得很小）时按 1/(zoom*1.5) 略微放大吸附范围；
 * - 最终 clamp 在 [BASE, BASE*2]，防止极端缩放下吸附到无关元素。
 *
 * 调用方包括碰撞检测（collision.ts 的 hovered 判定）和本文件的
 * 端点重绑逻辑，两边必须用同一个函数才能保证“看起来能连”和“真的连上”一致。
 */
export const maxBindingDistance_simple = (zoom?: AppState["zoom"]): number => {
  const BASE_BINDING_DISTANCE = Math.max(BASE_BINDING_GAP, 15);
  const zoomValue = zoom?.value && zoom.value < 1 ? zoom.value : 1;
  return clamp(
    // reducing zoom impact so that the diff between binding distance and
    // binding gap is kept to minimum when possible
    BASE_BINDING_DISTANCE / (zoomValue * 1.5),
    BASE_BINDING_DISTANCE,
    BASE_BINDING_DISTANCE * 2,
  );
};

/**
 * 全局绑定开关的读取口。
 *
 * 抽成函数是为了让策略层只依赖“是否启用”这一布尔语义，而不是 AppState 结构；
 * 关闭时拖拽端点会主动解绑（而不是保留旧绑定），见
 * `getBindingStrategyForDraggingBindingElementEndpoints_simple`。
 */
export const isBindingEnabled = (appState: {
  isBindingEnabled: AppState["isBindingEnabled"];
}): boolean => {
  return appState.isBindingEnabled;
};

/**
 * 拖拽箭头端点结束/过程中的绑定入口。
 *
 * 对 start/end 两端各调用一次 `bindOrUnbindBindingElementEdge`：
 * 由策略决定“绑定到谁”，由 edge 函数负责写入/清除 binding。
 * 如果策略要求 focus point 覆盖（例如网格吸附、中点吸附），再把箭头端点
 * 移到 `updateBoundPoint` 算出的位置——注意这里改的是 points，不是
 * binding 本身。
 */
export const bindOrUnbindBindingElement = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  draggingPoints: PointsPositionUpdates,
  scenePointerX: number,
  scenePointerY: number,
  scene: Scene,
  appState: AppState,
  opts?: {
    newArrow?: boolean;
    altKey?: boolean;
    angleLocked?: boolean;
    initialBinding?: boolean;
    gridSize?: NullableGridSize;
  },
) => {
  const { start, end } = getBindingStrategyForDraggingBindingElementEndpoints(
    arrow,
    draggingPoints,
    scenePointerX,
    scenePointerY,
    scene.getNonDeletedElementsMap(),
    scene.getNonDeletedElements(),
    appState,
    {
      ...opts,
      finalize: true,
    },
  );

  // 中点吸附只在没有网格、没有锁角时生效：网格本身已给出确定的落点，
  // 锁角时端点方向不可再被吸附点改写，否则箭头方向会突变。
  const isMidpointSnappingEnabled =
    appState.isMidpointSnappingEnabled &&
    !opts?.angleLocked &&
    !appState.gridModeEnabled;

  // 两端分别写入：start/end 的策略互不覆盖，未拖拽的一端通常是 undefined。
  bindOrUnbindBindingElementEdge(
    arrow,
    start,
    "start",
    scene,
    appState.zoom,
    appState.isBindingEnabled,
    isMidpointSnappingEnabled,
  );
  bindOrUnbindBindingElementEdge(
    arrow,
    end,
    "end",
    scene,
    appState.zoom,
    appState.isBindingEnabled,
    isMidpointSnappingEnabled,
  );
  // 只有策略显式给了 focusPoint 才需要移动 points：binding 写入解决“跟谁绑”，
  // focusPoint 解决“这次拖到哪个具体落点”。两者分开是有意的——绑定本身不存
  // 绝对坐标，点位置由 updateBoundPoint 再推导。
  if (start.focusPoint || end.focusPoint) {
    // If the strategy dictates a focus point override, then
    // update the arrow points to point to the focus point.
    const updates: PointsPositionUpdates = new Map();

    // index 0 恒为起点；updateBoundPoint 返回 null 表示这次无需改点（例如
    // 绑定刚被清除），此时回退到原 point，避免把端点写成 undefined。
    if (start.focusPoint) {
      updates.set(0, {
        point:
          updateBoundPoint(
            arrow,
            "startBinding",
            arrow.startBinding,
            start.element,
            scene.getNonDeletedElementsMap(),
          ) || arrow.points[0],
      });
    }

    if (end.focusPoint) {
      updates.set(arrow.points.length - 1, {
        point:
          updateBoundPoint(
            arrow,
            "endBinding",
            arrow.endBinding,
            end.element,
            scene.getNonDeletedElementsMap(),
          ) || arrow.points[arrow.points.length - 1],
      });
    }

    LinearElementEditor.movePoints(arrow, scene, updates);
  }

  return { start, end };
};

/**
 * 把单个端点的策略落到数据上：解绑、绑定或什么都不做。
 *
 * 三态映射关系必须保持：null → 解绑；有 mode → 绑定；undefined → 跳过。
 * `shouldSnapToOutline` / `isMidpointSnappingEnabled` 只影响固定点如何取，
 * 不影响“是否绑定”。
 */
const bindOrUnbindBindingElementEdge = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  { mode, element, focusPoint }: BindingStrategy,
  startOrEnd: "start" | "end",
  scene: Scene,
  zoom: AppState["zoom"],
  shouldSnapToOutline = true,
  isMidpointSnappingEnabled = true,
): void => {
  if (mode === null) {
    // null means break the binding
    unbindBindingElement(arrow, startOrEnd, scene);
  } else if (mode !== undefined) {
    bindBindingElement(
      arrow,
      element,
      mode,
      startOrEnd,
      scene,
      zoom,
      focusPoint,
      shouldSnapToOutline,
      isMidpointSnappingEnabled,
    );
  }
};

/**
 * 肘形箭头拖拽端点时的策略。
 *
 * 肘形箭头只能“轨道绑定”（orbit）：端点绕着目标元素轮廓走，方向由路由器
 * 决定。因此这里不做 inside/outside 判定，命中就 orbit、没命中就解绑。
 *
 * 约束：只允许拖一个点（`draggingPoints.size === 1`）。肘形箭头的其他折点由
 * 路由算法生成，不能手工拖动，否则固定段与绑定会互相矛盾。
 *
 * `focusPoint` 用拖动点本身的全局坐标（而不是插值点），因为肘形箭头的
 * 端点位置最终由 `updateElbowArrowPoints` 重排，这里只提供方向意图。
 */
const bindingStrategyForElbowArrowEndpointDragging = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  draggingPoints: PointsPositionUpdates,
  elementsMap: NonDeletedSceneElementsMap,
  elements: readonly Ordered<NonDeletedExcalidrawElement>[],
  zoom: AppState["zoom"],
): {
  start: BindingStrategy;
  end: BindingStrategy;
} => {
  invariant(draggingPoints.size === 1, "Bound elbow arrows cannot be moved");

  const update = draggingPoints.entries().next().value;

  invariant(
    update,
    "There should be a position update for dragging an elbow arrow endpoint",
  );

  const [pointIdx, { point }] = update;
  const globalPoint = LinearElementEditor.getPointGlobalCoordinates(
    arrow,
    point,
    elementsMap,
  );
  const hit = getHoveredElementForBinding(
    globalPoint,
    elements,
    elementsMap,
    zoom,
  );

  const current = hit
    ? {
        element: hit,
        mode: "orbit" as const,
        focusPoint: LinearElementEditor.getPointAtIndexGlobalCoordinates(
          arrow,
          pointIdx,
          elementsMap,
        ),
      }
    : {
        mode: null,
      };
  const other = { mode: undefined };

  return pointIdx === 0
    ? { start: current, end: other }
    : { start: other, end: current };
};

/**
 * 新建“普通箭头”过程中的端点策略。
 *
 * 与编辑已有箭头的区别：新箭头通常从起点拉出（startDragged），此时命中就
 * 以 inside 模式绑定并把焦点设成指针点；终点随后连续拖动，需要处理
 * “同一元素内部 → 内部”“嵌套元素”“从内部拖到外部”等多种布局。
 *
 * 这里的 origin 来自 `selectedLinearElement.initialState.origin`，代表按下
 * 时起点落在哪个全局点；用它而不是 arrow.x/y，是因为新箭头在创建过程中
 * x/y 会随手势不断变化，origin 才是稳定的“第一落点”。
 *
 * 返回的 other 表示“非拖拽端”是否也要改绑定（例如两端都绑同一元素时，
 * 需要把起点吸附到中心/原点）。
 */
const bindingStrategyForNewSimpleArrowEndpointDragging = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  draggingPoints: PointsPositionUpdates,
  elementsMap: NonDeletedSceneElementsMap,
  elements: readonly Ordered<NonDeletedExcalidrawElement>[],
  startDragged: boolean,
  endDragged: boolean,
  startIdx: number,
  endIdx: number,
  appState: AppState,
  globalBindMode?: AppState["bindMode"],
  shiftKey?: boolean,
): {
  start: BindingStrategy;
  end: BindingStrategy;
} => {
  let start: BindingStrategy = { mode: undefined };
  let end: BindingStrategy = { mode: undefined };

  const isMultiPoint = arrow.points.length > 2;
  const point = LinearElementEditor.getPointGlobalCoordinates(
    arrow,
    draggingPoints.get(startDragged ? startIdx : endIdx)!.point,
    elementsMap,
  );
  const hit = getHoveredElementForBinding(
    point,
    elements,
    elementsMap,
    appState.zoom,
  );

  // With new arrows this handles the binding at arrow creation
  if (startDragged) {
    if (hit) {
      start = {
        element: hit,
        mode: "inside",
        focusPoint: point,
      };
    } else {
      start = { mode: null };
    }

    return { start, end };
  }

  // With new arrows it represents the continuous dragging of the end point
  if (endDragged) {
    const origin = appState?.selectedLinearElement?.initialState.origin;

    // Inside -> inside binding
    if (hit && arrow.startBinding?.elementId === hit.id) {
      const center = pointFrom<GlobalPoint>(
        hit.x + hit.width / 2,
        hit.y + hit.height / 2,
      );

      return {
        start: isMultiPoint
          ? { mode: undefined }
          : {
              mode: "inside",
              element: hit,
              focusPoint: origin ?? center,
            },
        end: isMultiPoint
          ? { mode: "orbit", element: hit, focusPoint: point }
          : { mode: "inside", element: hit, focusPoint: point },
      };
    }

    // Check and handle nested shapes
    if (hit && arrow.startBinding) {
      const startBinding = arrow.startBinding;
      const allHits = getAllHoveredElementAtPoint(
        point,
        elements,
        elementsMap,
        appState.zoom,
      );

      if (allHits.find((el) => el.id === startBinding.elementId)) {
        const otherElement = elementsMap.get(
          arrow.startBinding.elementId,
        ) as NonDeleted<ExcalidrawBindableElement>;

        invariant(otherElement, "Other element must be in the elements map");

        return {
          start: isMultiPoint
            ? { mode: undefined }
            : {
                mode: otherElement.id !== hit.id ? "orbit" : "inside",
                element: otherElement,
                focusPoint: origin ?? pointFrom<GlobalPoint>(arrow.x, arrow.y),
              },
          end: {
            mode: "orbit",
            element: hit,
            focusPoint: point,
          },
        };
      }
    }

    // Inside -> outside binding
    if (arrow.startBinding && arrow.startBinding.elementId !== hit?.id) {
      const otherElement = elementsMap.get(
        arrow.startBinding.elementId,
      ) as NonDeleted<ExcalidrawBindableElement>;
      invariant(otherElement, "Other element must be in the elements map");

      const otherIsInsideBinding =
        !!appState.selectedLinearElement?.initialState.arrowStartIsInside;
      const other: BindingStrategy = {
        mode: otherIsInsideBinding ? "inside" : "orbit",
        element: otherElement,
        focusPoint: shiftKey
          ? elementCenterPoint(otherElement, elementsMap)
          : origin ?? pointFrom<GlobalPoint>(arrow.x, arrow.y),
      };

      // We are hovering another element with the end point
      const isNested =
        hit &&
        isBindableElementInsideOtherBindable(otherElement, hit, elementsMap);
      let current: BindingStrategy;
      if (hit) {
        const isInsideBinding =
          globalBindMode === "inside" || globalBindMode === "skip";
        current = {
          mode: isInsideBinding && !isNested ? "inside" : "orbit",
          element: hit,
          focusPoint: isInsideBinding || isNested ? point : point,
        };
      } else {
        current = { mode: null };
      }

      return {
        start: isMultiPoint ? { mode: undefined } : other,
        end: current,
      };
    }

    // No start binding
    if (!arrow.startBinding) {
      if (hit) {
        const isInsideBinding =
          globalBindMode === "inside" || globalBindMode === "skip";

        end = {
          mode: isInsideBinding ? "inside" : "orbit",
          element: hit,
          focusPoint: point,
        };
      } else {
        end = { mode: null };
      }

      return { start, end };
    }
  }

  invariant(false, "New arrow creation should not reach here");
};

/**
 * 编辑已有两段箭头时，单个端点的通用策略（COMPLEX_BINDINGS 分支使用）。
 *
 * 分层判断顺序（顺序不能换，否则会覆盖更具体的语义）：
 * 1. 自由/跳过绑定模式：直接在指针处 inside 绑定，另一端的策略一般不动；
 * 2. 指针不在任何可绑定元素上：清掉当前端的绑定；
 * 3. 指针仍在原绑定元素内部：保持 inside；
 * 4. 另一端也有绑定：按“同一元素 / 不同元素 / 嵌套 / 透明背景穿透”细分；
 * 5. 另一端无绑定：默认 orbit。
 *
 * `finalize` 决定“另一端是否解绑”：拖动过程中保留旧绑定以便回拖，抬手时才
 * 真正清掉，避免拖动中反复解绑/重绑造成抖动。
 */
const bindingStrategyForSimpleArrowEndpointDragging_complex = (
  point: GlobalPoint,
  currentBinding: FixedPointBinding | null,
  oppositeBinding: FixedPointBinding | null,
  elementsMap: NonDeletedSceneElementsMap,
  elements: readonly Ordered<NonDeletedExcalidrawElement>[],
  globalBindMode: AppState["bindMode"],
  arrow: NonDeleted<ExcalidrawArrowElement>,
  zoom: AppState["zoom"],
  finalize?: boolean,
): { current: BindingStrategy; other: BindingStrategy } => {
  let current: BindingStrategy = { mode: undefined };
  let other: BindingStrategy = { mode: undefined };

  const isMultiPoint = arrow.points.length > 2;
  const hit = getHoveredElementForBinding(point, elements, elementsMap, zoom);
  const isOverlapping = oppositeBinding
    ? getAllHoveredElementAtPoint(point, elements, elementsMap, zoom).some(
        (el) => el.id === oppositeBinding.elementId,
      )
    : false;
  const oppositeElement = oppositeBinding
    ? (elementsMap.get(
        oppositeBinding.elementId,
      ) as NonDeleted<ExcalidrawBindableElement>)
    : null;
  const otherIsTransparent =
    isOverlapping && oppositeElement
      ? isTransparent(oppositeElement.backgroundColor)
      : false;
  const isNested =
    hit &&
    oppositeElement &&
    isBindableElementInsideOtherBindable(oppositeElement, hit, elementsMap);

  // If the global bind mode is in free binding mode, just bind
  // where the pointer is and keep the other end intact
  if (globalBindMode === "inside" || globalBindMode === "skip") {
    current = hit
      ? {
          element:
            !isOverlapping || !oppositeElement || otherIsTransparent
              ? hit
              : oppositeElement,
          focusPoint: point,
          mode: "inside",
        }
      : { mode: null };
    other =
      finalize && hit && hit.id === oppositeBinding?.elementId
        ? { mode: null }
        : other;

    return { current, other };
  }

  // Dragged point is outside of any bindable element
  // so we break any existing binding
  if (!hit) {
    return { current: { mode: null }, other };
  }

  // Already inside binding over the same hit element should remain inside bound
  if (
    hit.id === currentBinding?.elementId &&
    currentBinding.mode === "inside"
  ) {
    return {
      current: { mode: "inside", focusPoint: point, element: hit },
      other,
    };
  }

  // The dragged point is inside the hovered bindable element
  if (oppositeBinding) {
    // The opposite binding is on the same element
    if (oppositeBinding.elementId === hit.id) {
      // The opposite binding is on the binding gap of the same element
      if (oppositeBinding.mode === "orbit") {
        current = { element: hit, mode: "orbit", focusPoint: point };
        other = { mode: finalize ? null : undefined };

        return { current, other: isMultiPoint ? { mode: undefined } : other };
      }
      // The opposite binding is inside the same element
      // eslint-disable-next-line no-else-return
      else {
        current = { element: hit, mode: "inside", focusPoint: point };

        return { current, other: isMultiPoint ? { mode: undefined } : other };
      }
    }
    // The opposite binding is on a different element (or nested)
    // eslint-disable-next-line no-else-return
    else {
      // Handle the nested element case
      if (isOverlapping && oppositeElement && !otherIsTransparent) {
        current = {
          element: oppositeElement,
          mode: "inside",
          focusPoint: point,
        };
      } else {
        current = {
          element: hit,
          mode: "orbit",
          focusPoint: isNested ? point : point,
        };
      }

      return { current, other: isMultiPoint ? { mode: undefined } : other };
    }
  }
  // The opposite binding is on a different element or no binding
  else {
    current = {
      element: hit,
      mode: "orbit",
      focusPoint: point,
    };
  }

  // Must return as only one endpoint is dragged, therefore
  // the end binding strategy might accidentally gets overriden
  return { current, other: isMultiPoint ? { mode: undefined } : other };
};

/**
 * 策略选择的总入口。
 *
 * 用 feature flag `COMPLEX_BINDINGS` 在运行时切换两套实现：旧版_simple 基于
 * “指针是否在元素内 + 网格/锁角”，新版_complex 基于 bindMode 与嵌套关系。
 * 两套实现共用同一个返回结构，调用方无需感知差异。
 *
 * 传参同时包含屏幕坐标与 scene 坐标：_simple 在锁角/网格模式下要用屏幕指针
 * 位置做吸附，_complex 只用点集，因此把两者都传入以避免在内部再换算。
 */
export const getBindingStrategyForDraggingBindingElementEndpoints = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  draggingPoints: PointsPositionUpdates,
  screenPointerX: number,
  screenPointerY: number,
  elementsMap: NonDeletedSceneElementsMap,
  elements: readonly Ordered<NonDeletedExcalidrawElement>[],
  appState: AppState,
  opts?: {
    newArrow?: boolean;
    angleLocked?: boolean;
    altKey?: boolean;
    finalize?: boolean;
    initialBinding?: boolean;
    gridSize?: NullableGridSize;
  },
): { start: BindingStrategy; end: BindingStrategy } => {
  if (getFeatureFlag("COMPLEX_BINDINGS")) {
    return getBindingStrategyForDraggingBindingElementEndpoints_complex(
      arrow,
      draggingPoints,
      elementsMap,
      elements,
      appState,
      opts,
    );
  }

  return getBindingStrategyForDraggingBindingElementEndpoints_simple(
    arrow,
    draggingPoints,
    screenPointerX,
    screenPointerY,
    elementsMap,
    elements,
    appState,
    opts,
  );
};

/**
 * 旧版（默认）端点策略实现。
 *
 * 判定步骤：
 * 1. 找到被拖的端点索引（0 或 length-1），两端都没拖 / 两端都拖直接短路；
 * 2. 绑定被关闭时，把被拖端显式设为 null（保留另一端）；
 * 3. 肘形箭头交给专用策略；
 * 4. 用指针命中的可绑定元素 + 指针是否在元素内部，决定 inside 还是 orbit；
 * 5. 再检查“另一端”是否需要被一起调整（初始 inside、altFocusPoint、锁角）。
 *
 * 对“另一端”的处理有两个防误伤条件：
 * - `otherNeverOverride`：另一端创建时就是 inside，或新箭头起点本就在内部，
 *   说明用户意图是两端都贴住，不允许被本次拖拽改写；
 * - `pointIsCloseToOtherElement`：当前指针已经贴近另一端的元素，说明用户
 *   可能想把两端拉到同一元素上，避免把另一端抢走。
 *
 * 所有几何判定用全局坐标（getPointGlobalCoordinates 转换），因为元素可能被
 * 旋转/移动，局部坐标之间不可直接比较。
 */
const getBindingStrategyForDraggingBindingElementEndpoints_simple = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  draggingPoints: PointsPositionUpdates,
  scenePointerX: number,
  scenePointerY: number,
  elementsMap: NonDeletedSceneElementsMap,
  elements: readonly Ordered<NonDeletedExcalidrawElement>[],
  appState: AppState,
  opts?: {
    newArrow?: boolean;
    angleLocked?: boolean;
    altKey?: boolean;
    finalize?: boolean;
    initialBinding?: boolean;
    gridSize?: NullableGridSize;
  },
): { start: BindingStrategy; end: BindingStrategy } => {
  const startIdx = 0;
  const endIdx = arrow.points.length - 1;
  const startDragged = draggingPoints.has(startIdx);
  const endDragged = draggingPoints.has(endIdx);

  let start: BindingStrategy = { mode: undefined };
  let end: BindingStrategy = { mode: undefined };

  if (arrow.points.length < 2) {
    console.error(
      "Attempting to bind a linear element with less than 2 points",
    );
    // a single-point can't be bound -> cancel
    return { start: { mode: undefined }, end: { mode: undefined } };
  }

  // If none of the ends are dragged, we don't change anything
  if (!startDragged && !endDragged) {
    return { start, end };
  }

  // If both ends are dragged, we don't bind to anything
  // and break existing bindings
  if (startDragged && endDragged) {
    return { start: { mode: null }, end: { mode: null } };
  }

  // If binding is disabled and an endpoint is dragged,
  // we actively break the end binding
  if (!isBindingEnabled(appState)) {
    start = startDragged ? { mode: null } : start;
    end = endDragged ? { mode: null } : end;

    return { start, end };
  }

  // Handle simpler elbow arrow binding
  if (isElbowArrow(arrow)) {
    return bindingStrategyForElbowArrowEndpointDragging(
      arrow,
      draggingPoints,
      elementsMap,
      elements,
      appState.zoom,
    );
  }

  const otherBinding = startDragged ? arrow.endBinding : arrow.startBinding;
  const localPoint = draggingPoints.get(
    startDragged ? startIdx : endIdx,
  )?.point;
  invariant(
    localPoint,
    `Local point must be defined for ${
      startDragged ? "start" : "end"
    } dragging`,
  );
  const globalPoint = LinearElementEditor.getPointGlobalCoordinates(
    arrow,
    localPoint,
    elementsMap,
  );
  // 命中判定点：锁角/网格模式下用屏幕指针（吸附点可能不在元素上），
  // 否则用拖动点的全局坐标。两种情况下 `pointInElement` 也必须用同一坐标系，
  // 否则会出现“命中了元素但判定为在外部”的矛盾。
  const hit = getHoveredElementForBinding(
    opts?.angleLocked || appState.gridModeEnabled
      ? pointFrom<GlobalPoint>(scenePointerX, scenePointerY)
      : globalPoint,
    elements,
    elementsMap,
    appState.zoom,
  );
  const pointInElement =
    hit &&
    (opts?.angleLocked
      ? isPointInElement(
          pointFrom<GlobalPoint>(scenePointerX, scenePointerY),
          hit,
          elementsMap,
        )
      : isPointInElement(globalPoint, hit, elementsMap));
  const otherBindableElement = otherBinding
    ? (elementsMap.get(
        otherBinding.elementId,
      ) as NonDeleted<ExcalidrawBindableElement>)
    : undefined;
  // 另一端若已绑定，先算它的全局固定点，用来判断“另一端是否还贴在它的目标上”
  // 以及锁角时该往哪个方向投影。注意这里只是读取，不写入。
  const otherFocusPoint =
    otherBinding &&
    otherBindableElement &&
    getGlobalFixedPointForBindableElement(
      otherBinding.fixedPoint,
      otherBindableElement,
      elementsMap,
    );
  const otherFocusPointIsInElement =
    otherBindableElement &&
    otherFocusPoint &&
    hitElementItself({
      point: otherFocusPoint,
      element: otherBindableElement,
      elementsMap,
      threshold: 0,
      overrideShouldTestInside: true,
    });
  const otherEndpointInitialBinding =
    appState.selectedLinearElement?.initialState
      .arrowOtherEndpointInitialBinding;

  // 两端绑到同一元素：保持 inside，并把“落点”显式给成 globalPoint / 固定点。
  // 注意新箭头只能拖终点，所以起点要么用网格吸附后的 origin，要么回退到
  // 固定点或第 0 个点的全局坐标——三者都失败时仍要给出合法坐标。
  // Handle outside-outside binding to the same element
  if (
    otherBinding &&
    otherBinding.elementId === hit?.id &&
    (!opts?.newArrow || appState.selectedLinearElement?.initialState.origin)
  ) {
    return {
      start: {
        mode: "inside",
        element: hit,
        focusPoint: startDragged
          ? globalPoint
          : // NOTE: Can only affect the start point because new arrows always drag the end point
          opts?.newArrow
          ? pointFromArray<GlobalPoint>(
              getGridPoint(
                appState.selectedLinearElement!.initialState.origin![0],
                appState.selectedLinearElement!.initialState.origin![1],
                opts.gridSize as NullableGridSize,
              ),
            )!
          : otherBindableElement
          ? getGlobalFixedPointForBindableElement(
              otherBinding.fixedPoint,
              otherBindableElement,
              elementsMap,
            )
          : LinearElementEditor.getPointAtIndexGlobalCoordinates(
              arrow,
              0,
              elementsMap,
            ), // startFixedPoint,
      },
      end: {
        mode: "inside",
        element: hit,
        focusPoint: endDragged
          ? globalPoint
          : otherBindableElement
          ? getGlobalFixedPointForBindableElement(
              otherBinding.fixedPoint,
              otherBindableElement,
              elementsMap,
            )
          : LinearElementEditor.getPointAtIndexGlobalCoordinates(
              arrow,
              -1,
              elementsMap,
            ), // endFixedPoint
      },
    };
  }

  // Alt 键是“强制 inside 绑定”的逃生口：无论指针在轮廓内还是外，
  // 都按 inside 记录，便于用户把端点插进图形内部；未拖拽的一端保持原策略。
  // Handle special alt key case to inside bind no matter what
  if (opts?.altKey) {
    return {
      start: startDragged
        ? hit
          ? {
              mode: "inside",
              element: hit,
              focusPoint: globalPoint,
            }
          : { mode: null }
        : start,
      end: endDragged
        ? hit
          ? {
              mode: "inside",
              element: hit,
              focusPoint: globalPoint,
            }
          : { mode: null }
        : end,
    };
  }

  // 常规情况：命中元素时，按指针是否落在轮廓内部选择 inside；落在外部则用
  // orbit，并把落点投影到“对角线”上（projectFixedPointOntoDiagonal），这样
  // 端点会贴住最近的边而不是悬在角点。网格吸附时还要先把指针吸到网格线，
  // 再与轮廓求交，保证端点始终落在元素的边上。
  // Handle normal cases
  const current: BindingStrategy = hit
    ? pointInElement
      ? {
          mode: "inside",
          element: hit,
          focusPoint: globalPoint,
        }
      : {
          mode: "orbit",
          element: hit,
          focusPoint:
            projectFixedPointOntoDiagonal(
              arrow,
              opts?.angleLocked
                ? globalPoint
                : appState.gridModeEnabled
                ? snapBoundPointToGrid(
                    pointFrom<GlobalPoint>(scenePointerX, scenePointerY),
                    hit,
                    elementsMap,
                    appState.gridSize as NullableGridSize,
                    arrow,
                    LinearElementEditor.getPointAtIndexGlobalCoordinates(
                      arrow,
                      startDragged ? 1 : -2,
                      elementsMap,
                    ),
                  )
                : globalPoint,
              hit,
              startDragged ? "start" : "end",
              elementsMap,
              appState.zoom,
              appState.isMidpointSnappingEnabled &&
                !opts?.angleLocked &&
                !appState.gridModeEnabled,
            ) || globalPoint,
        }
    : { mode: null };

  const otherEndpoint = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    arrow,
    startDragged ? -1 : 0,
    elementsMap,
  );
  const pointIsCloseToOtherElement =
    otherFocusPoint &&
    otherBindableElement &&
    hitElementItself({
      point: globalPoint,
      element: otherBindableElement,
      elementsMap,
      threshold: maxBindingDistance_simple(appState.zoom),
      overrideShouldTestInside: true,
    });
  const otherPointWasInsideAtStart =
    otherEndpointInitialBinding?.mode === "inside";
  // otherNeverOverride 为真时，说明另一端在本次手势开始时就“钉”在元素内部，
  // 本次拖拽不应把它的绑定降级成 orbit 或清除，否则用户只是在拖一端，
  // 另一端却会突然弹到轮廓上。
  const otherNeverOverride = opts?.newArrow
    ? appState.selectedLinearElement?.initialState.arrowStartIsInside
    : otherBinding?.mode === "inside" && otherPointWasInsideAtStart;

  let other: BindingStrategy = { mode: undefined };
  if (!otherNeverOverride) {
    if (
      otherBinding?.mode === "inside" &&
      !otherPointWasInsideAtStart &&
      otherBindableElement &&
      !opts?.newArrow
    ) {
      other = {
        mode: "orbit",
        element: otherBindableElement,
        focusPoint: otherFocusPoint || otherEndpoint,
      };
    } else if (
      otherBindableElement &&
      !otherFocusPointIsInElement &&
      !pointIsCloseToOtherElement &&
      appState.selectedLinearElement?.initialState.altFocusPoint
    ) {
      other = {
        mode: "orbit",
        element: otherBindableElement,
        focusPoint: appState.selectedLinearElement.initialState.altFocusPoint,
      };
    } else if (opts?.angleLocked && otherBindableElement) {
      other = {
        mode: "orbit",
        element: otherBindableElement,
        focusPoint:
          projectFixedPointOntoDiagonal(
            arrow,
            otherEndpoint,
            otherBindableElement,
            startDragged ? "end" : "start",
            elementsMap,
            appState.zoom,
            appState.isMidpointSnappingEnabled,
          ) || otherEndpoint,
      };
    }
  }

  return {
    start: startDragged ? current : other,
    end: endDragged ? current : other,
  };
};

/**
 * COMPLEX_BINDINGS 版本的总分派。
 *
 * 与 _simple 的差别：
 * - 新箭头有独立实现，因为创建过程中点集与 origin 语义特殊；
 * - 已有箭头只处理被拖的那一端，另一端由 complex 子函数决定；
 * - 通过 `appState.bindMode` 支持 inside/skip 等显式模式。
 *
 * 早退条件与 _simple 一致：点数不足、两端都拖、绑定关闭。保持两套实现
 * 在这些“结构性”判断上同步，避免开关切换时行为突变。
 */
const getBindingStrategyForDraggingBindingElementEndpoints_complex = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  draggingPoints: PointsPositionUpdates,
  elementsMap: NonDeletedSceneElementsMap,
  elements: readonly Ordered<NonDeletedExcalidrawElement>[],
  appState: AppState,
  opts?: {
    newArrow?: boolean;
    shiftKey?: boolean;
    finalize?: boolean;
    initialBinding?: boolean;
  },
): { start: BindingStrategy; end: BindingStrategy } => {
  const globalBindMode = appState.bindMode || "orbit";
  const startIdx = 0;
  const endIdx = arrow.points.length - 1;
  const startDragged = draggingPoints.has(startIdx);
  const endDragged = draggingPoints.has(endIdx);

  let start: BindingStrategy = { mode: undefined };
  let end: BindingStrategy = { mode: undefined };

  if (arrow.points.length < 2) {
    console.error(
      "Attempting to bind a linear element with less than 2 points",
    );
    // a single-point can't be bound -> cancel
    return { start: { mode: undefined }, end: { mode: undefined } };
  }

  // If none of the ends are dragged, we don't change anything
  if (!startDragged && !endDragged) {
    return { start, end };
  }

  // If both ends are dragged, we don't bind to anything
  // and break existing bindings
  if (startDragged && endDragged) {
    return { start: { mode: null }, end: { mode: null } };
  }

  // If binding is disabled and an endpoint is dragged,
  // we actively break the end binding
  if (!isBindingEnabled(appState)) {
    start = startDragged ? { mode: null } : start;
    end = endDragged ? { mode: null } : end;

    return { start, end };
  }

  // Handle simpler elbow arrow binding
  if (isElbowArrow(arrow)) {
    return bindingStrategyForElbowArrowEndpointDragging(
      arrow,
      draggingPoints,
      elementsMap,
      elements,
      appState.zoom,
    );
  }

  // Handle new arrow creation separately, as it is special
  if (opts?.newArrow) {
    const { start, end } = bindingStrategyForNewSimpleArrowEndpointDragging(
      arrow,
      draggingPoints,
      elementsMap,
      elements,
      startDragged,
      endDragged,
      startIdx,
      endIdx,
      appState,
      globalBindMode,
      opts?.shiftKey,
    );

    return { start, end };
  }

  // Only the start point is dragged
  if (startDragged) {
    const localPoint = draggingPoints.get(startIdx)?.point;
    invariant(localPoint, "Local point must be defined for start dragging");
    const globalPoint = LinearElementEditor.getPointGlobalCoordinates(
      arrow,
      localPoint,
      elementsMap,
    );

    const { current, other } =
      bindingStrategyForSimpleArrowEndpointDragging_complex(
        globalPoint,
        arrow.startBinding,
        arrow.endBinding,
        elementsMap,
        elements,
        globalBindMode,
        arrow,
        appState.zoom,
        opts?.finalize,
      );

    return { start: current, end: other };
  }

  // Only the end point is dragged
  if (endDragged) {
    const localPoint = draggingPoints.get(endIdx)?.point;
    invariant(localPoint, "Local point must be defined for end dragging");
    const globalPoint = LinearElementEditor.getPointGlobalCoordinates(
      arrow,
      localPoint,
      elementsMap,
    );
    const { current, other } =
      bindingStrategyForSimpleArrowEndpointDragging_complex(
        globalPoint,
        arrow.endBinding,
        arrow.startBinding,
        elementsMap,
        elements,
        globalBindMode,
        arrow,
        appState.zoom,
        opts?.finalize,
      );

    return { start: other, end: current };
  }

  return { start, end };
};

/**
 * 对一批箭头重新计算绑定（不改点位置）。
 *
 * 传入空的 draggingPoints 与 Infinity 指针坐标，等价于“没有正在拖的端点”：
 * 策略层会基于箭头当前端点与绑定距离重新判定，因此在翻转、批量操作后
 * 可以一次性修正所有箭头。Infinity 不会命中任何元素，避免误吸附。
 *
 * 调用点：actionFlip 与 App 的批量翻转路径。
 */
export const bindOrUnbindBindingElements = (
  selectedArrows: NonDeleted<ExcalidrawArrowElement>[],
  scene: Scene,
  appState: AppState,
): void => {
  selectedArrows.forEach((arrow) => {
    bindOrUnbindBindingElement(
      arrow,
      new Map(), // No dragging points in this case
      Infinity,
      Infinity,
      scene,
      appState,
    );
  });
};

/**
 * Writes a binding onto the arrow and records the arrow on the bind target,
 * keeping the two sides of the relationship in step.
 *
 * 写入绑定的唯一落点：箭头侧写 startBinding/endBinding，目标侧把箭头登记进
 * boundElements，保证双向引用一致。
 *
 * 幂等处理：boundElements 里已存在该箭头 id 时不重复追加。否则反复拖拽
 * 同一端点会在目标元素上堆出重复项，删除时也只清掉一份，留下悬空引用。
 *
 * 注意这里用“计算属性名”一次写入对应字段，避免 if/else 复制两份逻辑。
 */
const applyBinding = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  bindableElement: NonDeleted<ExcalidrawBindableElement>,
  binding: FixedPointBinding,
  startOrEnd: "start" | "end",
  scene: Scene,
): void => {
  scene.mutateElement(arrow, {
    [startOrEnd === "start" ? "startBinding" : "endBinding"]: binding,
  });

  const boundElementsMap = arrayToMap(bindableElement.boundElements || []);
  if (!boundElementsMap.has(arrow.id)) {
    scene.mutateElement(bindableElement, {
      boundElements: (bindableElement.boundElements || []).concat({
        id: arrow.id,
        type: "arrow",
      }),
    });
  }
};

/**
 * 建立“箭头端点 → 可绑定元素”的绑定。
 *
 * 固定点的来源按箭头类型分叉：
 * - 肘形箭头：必须先吸附到轮廓（或中点），再换算归一化比例，因此走
 *   `calculateFixedPointForElbowArrowBinding`（支持锁角/中点吸附）；
 * - 普通箭头：若调用方给了 focusPoint 就用它，否则用端点当前全局坐标，
 *   走 `calculateFixedPointForNonElbowArrowBinding`。
 *
 * @param mode 绑定模式，普通箭头可为 inside/orbit；肘形箭头强制 orbit，
 *   因为它必须沿轮廓走线，inside 会破坏路由。
 * @param shouldSnapToOutline 肘形箭头专用：false 时直接用端点位置，不再与轮廓求交。
 * @returns 无返回值；结果通过 scene.mutateElement 写入。
 */
export const bindBindingElement = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  hoveredElement: NonDeleted<ExcalidrawBindableElement>,
  mode: BindMode,
  startOrEnd: "start" | "end",
  scene: Scene,
  zoom: AppState["zoom"],
  focusPoint?: GlobalPoint,
  shouldSnapToOutline = true,
  isMidpointSnappingEnabled = true,
): void => {
  const elementsMap = scene.getNonDeletedElementsMap();

  let binding: FixedPointBinding;

  if (isElbowArrow(arrow)) {
    binding = {
      elementId: hoveredElement.id,
      mode: "orbit",
      ...calculateFixedPointForElbowArrowBinding(
        arrow,
        hoveredElement,
        startOrEnd,
        elementsMap,
        zoom,
        shouldSnapToOutline,
        isMidpointSnappingEnabled,
      ),
    };
  } else {
    binding = {
      elementId: hoveredElement.id,
      mode,
      ...calculateFixedPointForNonElbowArrowBinding(
        arrow,
        hoveredElement,
        startOrEnd,
        elementsMap,
        focusPoint,
      ),
    };
  }

  applyBinding(arrow, hoveredElement, binding, startOrEnd, scene);
};

/**
 * Whether the arrow's end is bound to an element it's beyond the binding area
 * of, i.e. that it couldn't be bound to in the editor (e.g. a participant's
 * header in a sequence diagram, as laid out by mermaid)
 */
/**
 * 判断已绑定的端点在几何上是否已落在绑定区域之外。
 *
 * 典型场景：元素由布局算法（如 mermaid 生成的时序图）摆好位置后再建立绑定，
 * 绑定关系存在但端点实际离元素很远。此时不能按“正常拖拽”的轮廓吸附去重算，
 * 否则箭头会被拉回元素边上、破坏外部布局。
 *
 * @returns true 表示端点已在绑定区域外，调用方应保留绑定但跳过吸附。
 */
export const isEndBoundBeyondBindingArea = (
  arrow: ExcalidrawArrowElement,
  startOrEnd: "start" | "end",
  elementsMap: NonDeletedSceneElementsMap,
  zoom: AppState["zoom"],
): boolean => {
  const binding =
    startOrEnd === "start" ? arrow.startBinding : arrow.endBinding;
  const bindableElement = binding && elementsMap.get(binding.elementId);
  return (
    !!bindableElement &&
    isBindableElement(bindableElement) &&
    !isPointInBindingArea(
      LinearElementEditor.getPointAtIndexGlobalCoordinates(
        arrow,
        startOrEnd === "start" ? 0 : -1,
        elementsMap,
      ),
      bindableElement,
      elementsMap,
      zoom,
    )
  );
};

// how far at least to extend an arrow's end segment looking for what it's
// bound to (see `getBoundEndExtension`)
const MIN_BOUND_END_EXTENSION = 100;

/**
 * Extends the arrow's bound end along its end segment, by the segment's length
 * (at least MIN_BOUND_END_EXTENSION), to find where it would reach the element
 * it's bound to, off the element by the binding gap. Moving the end there
 * restores bindings given to arrows that just fall short of their elements.
 *
 * @returns where to move the end to, or null if it doesn't reach the element
 */
/**
 * 把“差一点就够到元素”的绑定端点延长到元素轮廓上。
 *
 * 为什么需要：导入的数据或程序化布局可能让端点刚好停在绑定间隙之外，
 * 虽然绑定了却视觉上没贴上。这里沿最后一段的方向延长该段长度（至少
 * MIN_BOUND_END_EXTENSION），与元素求交，取离端点最近的交点。
 *
 * 跳过条件：没有绑定/目标不可绑定/点数不足/末段退化（长度 < PRECISION）。
 * @returns 新的全局端点；够不到元素时返回 null。
 */
export const getBoundEndExtension = (
  arrow: ExcalidrawArrowElement,
  startOrEnd: "start" | "end",
  elementsMap: NonDeletedSceneElementsMap,
): GlobalPoint | null => {
  const binding =
    startOrEnd === "start" ? arrow.startBinding : arrow.endBinding;
  const bindableElement = binding && elementsMap.get(binding.elementId);
  if (
    !bindableElement ||
    !isBindableElement(bindableElement) ||
    arrow.points.length < 2
  ) {
    return null;
  }

  const end = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    arrow,
    startOrEnd === "start" ? 0 : -1,
    elementsMap,
  );
  const adjacent = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    arrow,
    startOrEnd === "start" ? 1 : -2,
    elementsMap,
  );
  const segmentLength = pointDistance(adjacent, end);
  if (segmentLength < PRECISION) {
    return null;
  }

  const extension = lineSegment(
    end,
    pointFromVector(
      vectorScale(
        vectorNormalize(vectorFromPoint(end, adjacent)),
        Math.max(segmentLength, MIN_BOUND_END_EXTENSION),
      ),
      end,
    ),
  );
  return (
    intersectElementWithLineSegment(
      bindableElement,
      elementsMap,
      extension,
      getBindingGap(bindableElement),
    ).sort((a, b) => pointDistanceSq(a, end) - pointDistanceSq(b, end))[0] ??
    null
  );
};

/**
 * 解除某一端的绑定，并同步清理绑定目标上的反向引用。
 *
 * 细节：如果箭头两端绑的是同一个元素，只清箭头这一端、不删目标元素的
 * boundElements 记录——另一端还指着它。否则先判断“另一端不是同一元素”，
 * 再把箭头从目标的 boundElements 里过滤掉。
 *
 * @returns 被解绑的元素 id；本来就没有绑定时返回 null。
 */
export const unbindBindingElement = (
  arrow: ExcalidrawArrowElement,
  startOrEnd: "start" | "end",
  scene: Scene,
): ExcalidrawBindableElement["id"] | null => {
  const field = startOrEnd === "start" ? "startBinding" : "endBinding";
  const binding = arrow[field];

  if (binding == null) {
    return null;
  }

  const oppositeBinding =
    arrow[startOrEnd === "start" ? "endBinding" : "startBinding"];
  if (!oppositeBinding || oppositeBinding.elementId !== binding.elementId) {
    // Only remove the record on the bound element if the other
    // end is not bound to the same element
    // 中文：淡入淡出元素（boundElements 可能为 undefined）时 filter 仍安全，
    // 但这里假设元素仍在场景中；调用方应在删除前/后保证 elementsMap 一致。
    const boundElement = scene
      .getNonDeletedElementsMap()
      .get(binding.elementId) as NonDeleted<ExcalidrawBindableElement>;
    scene.mutateElement(boundElement, {
      boundElements: boundElement.boundElements?.filter(
        (element) => element.id !== arrow.id,
      ),
    });
  }

  scene.mutateElement(arrow, { [field]: null });

  return binding.elementId;
};

/**
 * 元素“换形/换尺寸后形状变了”时，把落在新轮廓之外的绑定重新锚到轮廓上。
 *
 * 使用场景：把矩形转成菱形、椭圆等（转换类型），原 fixedPoint 仍指向旧包围盒
 * 内的相对位置，但新形状在该位置可能已经没有实体。做法：
 * 1. 用 fixedPoint 求出全局焦点；
 * 2. 焦点仍落在新元素（含 gap 容差）内 → 不动；
 * 3. 否则从元素中心朝焦点方向发射线，取与轮廓最近交点，反算新的 fixedPoint。
 *
 * 注意 reach 取 max(width,height)*2，足够穿过旋转后的包围盒，避免射线太短
 * 求不到交点。
 */
export const reanchorBindingsToOutline = (
  changedElement: NonDeleted<ExcalidrawBindableElement>,
  scene: Scene,
  zoom: AppState["zoom"],
) => {
  const elementsMap = scene.getNonDeletedElementsMap();
  const center = elementCenterPoint(changedElement, elementsMap);
  const reach = Math.max(changedElement.width, changedElement.height) * 2;

  boundElementsVisitor(elementsMap, changedElement, (element) => {
    if (!isArrowElement(element) || !isNonDeletedElement(element)) {
      return;
    }

    const updates: {
      startBinding?: FixedPointBinding;
      endBinding?: FixedPointBinding;
    } = {};

    for (const startOrEnd of ["startBinding", "endBinding"] as const) {
      const binding = element[startOrEnd];
      if (binding?.elementId !== changedElement.id) {
        continue;
      }

      const startOrEndName = startOrEnd === "startBinding" ? "start" : "end";

      if (isElbowArrow(element)) {
        updates[startOrEnd] = {
          ...binding,
          ...calculateFixedPointForElbowArrowBinding(
            element,
            changedElement,
            startOrEndName,
            elementsMap,
            zoom,
          ),
        };
        continue;
      }

      const focusPoint = getGlobalFixedPointForBindableElement(
        binding.fixedPoint,
        changedElement,
        elementsMap,
      );

      if (
        hitElementItself({
          element: changedElement,
          point: focusPoint,
          elementsMap,
          threshold: getBindingGap(changedElement),
          overrideShouldTestInside: true,
        })
      ) {
        continue;
      }

      const direction = vectorFromPoint(focusPoint, center);
      if (direction[0] === 0 && direction[1] === 0) {
        continue;
      }
      const outlinePoint = intersectElementWithLineSegment(
        changedElement,
        elementsMap,
        lineSegment(
          center,
          pointFromVector(
            vectorScale(vectorNormalize(direction), reach),
            center,
          ),
        ),
      ).sort(
        (a, b) =>
          pointDistanceSq(a, focusPoint) - pointDistanceSq(b, focusPoint),
      )[0];

      if (!outlinePoint) {
        continue;
      }

      updates[startOrEnd] = {
        ...binding,
        ...calculateFixedPointForNonElbowArrowBinding(
          element,
          changedElement,
          startOrEndName,
          elementsMap,
          outlinePoint,
        ),
      };
    }

    if (updates.startBinding || updates.endBinding) {
      mutateElement(element, elementsMap, updates);
    }
  });
};

/**
 * Places both bound ends of `arrow` where its bindings put them on the elements
 * in `elementsMap` they're bound to, and rewraps its label along it as placed.
 * Leaves the label's x/y as they were (the editor derives arrow labels' x/y as
 * it renders them), so callers returning the elements as data must store them
 * (see `LinearElementEditor.getBoundTextElementPosition`).
 */
/**
 * 按绑定关系重新落位箭头的两个端点，并重排箭头标签。
 *
 * 性能细节：两端绑定同一元素时复用 startBindingElement，省一次 map 查询。
 * 当 `boundElementMoved` 为真且两端同元素时，中间点也跟随平移
 * （moveMidPointsWithElement），让箭头整体随元素移动，而不是只在端点处拉伸。
 *
 * 入参 elementsMap 可以与 scene 的不同（例如批量手势中的临时快照），
 * 这样调用方能在一次事务里先把多个元素的新位置放进 map，再统一重算。
 */
export const updateBoundArrow = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  scene: Scene,
  elementsMap: ElementsMap,
  /** measures the arrow's label */
  renderEnvironment?: RenderEnvironment,
  /**
   * whether it's placed as what it's bound to moved: an arrow bound to one
   * element at both ends then moves with it whole (its midpoints with its
   * start), rather than only at its ends
   */
  boundElementMoved = true,
) => {
  const startBindingElement = arrow.startBinding
    ? elementsMap.get(arrow.startBinding.elementId)
    : null;
  const endBindingElement = arrow.endBinding
    ? // PERF: If the arrow is bound to the same element on both ends.
      startBindingElement?.id === arrow.endBinding.elementId
      ? startBindingElement
      : elementsMap.get(arrow.endBinding.elementId)
    : null;

  LinearElementEditor.movePoints(
    arrow,
    scene,
    getBoundPointUpdates(arrow, elementsMap),
    undefined,
    {
      moveMidPointsWithElement:
        boundElementMoved &&
        !!startBindingElement &&
        startBindingElement?.id === endBindingElement?.id,
    },
  );

  updateArrowLabel(arrow, scene, elementsMap, renderEnvironment);
};

/**
 * Where `arrow`'s bindings put its bound ends on the elements in `elementsMap`
 * they're bound to.
 */
/**
 * 把箭头的绑定翻译成“点索引 → 新局部点”的更新表。
 *
 * 用 `bindableElementsVisitor` 遍历 startBinding/endBinding，而不是手写两次
 * 分支，保证新增绑定类型时只改 visitor。索引固定为 0 与 length-1，因为
 * `points[0]` 恒为 (0,0)、端点由 binding 决定。
 *
 * updateBoundPoint 返回 null 表示该端不需要更新，直接过滤掉；空 Map 是合法
 * 结果（箭头没有任何绑定）。
 */
const getBoundPointUpdates = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  elementsMap: ElementsMap,
): PointsPositionUpdates =>
  new Map(
    bindableElementsVisitor(
      elementsMap,
      arrow,
      (bindableElement, bindingProp) => {
        if (
          bindableElement &&
          isBindableElement(bindableElement) &&
          (bindingProp === "startBinding" || bindingProp === "endBinding")
        ) {
          const point = updateBoundPoint(
            arrow,
            bindingProp,
            arrow[bindingProp],
            bindableElement,
            elementsMap,
          );

          if (point) {
            return [
              bindingProp === "startBinding" ? 0 : arrow.points.length - 1,
              { point },
            ] as MapEntry<PointsPositionUpdates>;
          }
        }

        return null;
      },
    ).filter(
      (update): update is MapEntry<PointsPositionUpdates> => update !== null,
    ),
  );

/**
 * 箭头标签重排的薄封装。
 *
 * 只在标签存在且未删除时调用 handleBindTextResize；四个布尔参数全为 false
 * 表示“不按手柄方向推算、不按比例、不从中心、不翻转”，仅按箭头当前几何
 * 重新居中/换行。箭头标签的位置由渲染路径推导，这里只保证文本内容与尺寸
 * 跟得上箭头变化。
 */
/** Rewraps `arrow`'s label (if any) along it as placed. */
const updateArrowLabel = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  scene: Scene,
  elementsMap: ElementsMap,
  renderEnvironment?: RenderEnvironment,
) => {
  const boundText = getBoundTextElement(arrow, elementsMap);
  if (boundText && !boundText.isDeleted) {
    handleBindTextResize(
      arrow,
      scene,
      false,
      false,
      false,
      false,
      renderEnvironment,
    );
  }
};

/**
 * 判断箭头是否有任一端绑到了集合之外的元素。
 *
 * 用于框选/整体移动时区分“整条箭头都在操作集合内”和“箭头有一部分牵着外部
 * 元素”。后者不能简单平移，否则会破坏绑定或让箭头被扯变形。
 *
 * O(1)，只查两次 Set；不校验元素是否存在（id 存在即可）。
 */
/** Whether `arrow` is bound to an element not in `elementIds`. */
export const isBoundToElementNotIn = (
  arrow: ExcalidrawArrowElement,
  elementIds: ReadonlySet<ExcalidrawElement["id"]>,
) =>
  (!!arrow.startBinding && !elementIds.has(arrow.startBinding.elementId)) ||
  (!!arrow.endBinding && !elementIds.has(arrow.endBinding.elementId));

/**
 * The arrows that move with a frame being moved (with `movedElements`) but are
 * bound to elements that don't (e.g. in other frames). They must neither be
 * unbound, nor be left for what they're bound to to move: move everything
 * else without them, and then them, with `moveFrameArrows()`.
 *
 * @param movedElements all the elements moving, frames included
 */
/**
 * 找出“跟着 frame 移动、但绑到了 frame 外元素”的箭头 id。
 *
 * 为什么单独挑出来：这类箭头既不能直接解绑（用户没让解绑），也不能交给
 * 被绑定元素的更新流程（目标没动）。必须先让其他元素移动，再用
 * `moveFrameArrows` 把它们按偏移量先搬走、再把绑定端点贴回去。
 *
 * 筛选条件三者缺一不可：是箭头、frameId 指向本次移动的 frame、
 * 且至少一端绑到集合外。返回 Set 便于后续 O(1) 查找。
 */
export const getFrameArrowIdsToReattach = (
  movedElements: readonly ExcalidrawElement[],
): ReadonlySet<ExcalidrawElement["id"]> => {
  const movedElementIds = getSimultaneouslyUpdatedElementIds(movedElements);
  const ids = new Set<ExcalidrawElement["id"]>();
  for (const element of movedElements) {
    if (
      isArrowElement(element) &&
      element.frameId &&
      movedElementIds.has(element.frameId) &&
      isBoundToElementNotIn(element, movedElementIds)
    ) {
      ids.add(element.id);
    }
  }
  return ids;
};

/**
 * Moves the arrows (see `getFrameArrowIdsToReattach()`) by `offset` from where
 * they were in `originalElements` (from where they are, without it), and puts
 * their bound ends on what they're bound to: an end bound to a moved element
 * thus follows it, and one bound to an unmoved element stays. Call it once
 * everything else has moved.
 */
/**
 * 按“原始位置 + 偏移”移动被挑出的 frame 箭头，并把绑定端重新贴回目标。
 *
 * 关键点：起点必须取自 originalElements（手势开始前的快照），不能用当前位置，
 * 否则同一次拖拽里会被重复叠加偏移。移动后分两种收尾：
 * - 肘形箭头：先恢复 fixedSegments（固定段是相对旧路由的），再把绑定端点写进
 *   points 后一次性路由，避免路由两次产生分叉；
 * - 普通箭头：先 mutate 位置，再 updateBoundArrow 重算端点。
 *
 * `boundElementMoved = false` 表示“箭头自己动了、被绑定元素没动”，
 * 因此两端同元素时不平移中间点，保持箭头原有形状。
 */
export const moveFrameArrows = (
  arrowIds: ReadonlySet<ExcalidrawElement["id"]>,
  offset: { x: number; y: number },
  scene: Scene,
  opts?: {
    originalElements?: ElementsMap;
    /** measures the arrows' labels */
    renderEnvironment?: RenderEnvironment;
  },
) => {
  const elementsMap = scene.getNonDeletedElementsMap();
  for (const id of arrowIds) {
    const arrow = elementsMap.get(id);
    if (!isArrowElement(arrow)) {
      continue;
    }
    const original =
      (opts?.originalElements?.get(id) as typeof arrow | undefined) ?? arrow;
    // its points too, as putting its ends on what they're bound to (which
    // moving it from where it was undoes) changes them
    const moved = {
      x: original.x + offset.x,
      y: original.y + offset.y,
      points: original.points,
    };
    if (isElbowArrow(arrow)) {
      if (isElbowArrow(original) && original.fixedSegments?.length) {
        // routing it keeps its fixed segments, as placed relative to its
        // route where it is, so first put its route where it was, moved (which
        // doesn't route it, its fixed segments being given)
        scene.mutateElement(arrow, {
          ...moved,
          fixedSegments: original.fixedSegments,
          startIsSpecial: original.startIsSpecial,
          endIsSpecial: original.endIsSpecial,
        });
      }
      // updating its points routes it, so route it once, with its bound ends
      // already on what they're bound to (where its route heads off)
      const points = moved.points.slice();
      getBoundPointUpdates({ ...arrow, ...moved }, elementsMap).forEach(
        ({ point }, index) => {
          points[index] = point;
        },
      );
      scene.mutateElement(arrow, { ...moved, points });
      updateArrowLabel(arrow, scene, elementsMap, opts?.renderEnvironment);
    } else {
      scene.mutateElement(arrow, moved);
      updateBoundArrow(
        arrow,
        scene,
        elementsMap,
        opts?.renderEnvironment,
        // it moved, not what it's bound to: an arrow bound to one element at
        // both ends thus keeps its midpoints moved with the frame too
        false,
      );
    }
  }
};

// Supports translating, rotating and scaling `changedElement` with bound
// linear elements.
/**
 * 元素变化后，批量修正所有“绑定到它”的箭头。
 *
 * 触发点：元素移动/缩放/旋转后，或绑定结构变化后。遍历该元素的
 * boundElements（只包含箭头/文本引用），对每个箭头调用
 * `updateBoundArrow`，后者再按端点的 binding 重算 points。
 *
 * 注意这不是“箭头跟随”的唯一路径：拖拽箭头自身端点时走
 * bindOrUnbindBindingElement；本函数处理的是“被绑定元素先动”的方向。
 */
export const updateBoundElements = (
  changedElement: NonDeletedExcalidrawElement,
  scene: Scene,
  options?: {
    /** see `getSimultaneouslyUpdatedElementIds` for how to pass it */
    simultaneouslyUpdated?: readonly NonDeletedExcalidrawElement[];
    changedElements?: Map<string, ExcalidrawElement>;
    /** measures the labels of the arrows it updates (the host's, in the editor) */
    renderEnvironment?: RenderEnvironment;
  },
) => {
  // 只有可绑定元素（矩形/菱形/椭圆等）才可能被别人绑定；文本、图像等直接返回。
  if (!isBindableElement(changedElement)) {
    return;
  }

  const { simultaneouslyUpdated } = options ?? {};
  const simultaneouslyUpdatedElementIds = getSimultaneouslyUpdatedElementIds(
    simultaneouslyUpdated,
  );

  // changedElements 用于“元素还没写回 scene 的中间态”：先复制一份 map 再覆盖，
  // 这样 updateBoundPoint 读到的是本次操作后的最新几何，而不是旧的 scene 值。
  let elementsMap: ElementsMap = scene.getNonDeletedElementsMap();
  if (options?.changedElements) {
    elementsMap = new Map(elementsMap) as typeof elementsMap;
    options.changedElements.forEach((element) => {
      elementsMap.set(element.id, element);
    });
  }

  const visitor = (element: ExcalidrawElement | undefined) => {
    // SAFETY: This should never happen, but log it just in case
    // 中文：boundElements 里出现已删除元素的 id 属于数据不一致，打印出来便于定位
    // 复制/删除流程中的漏清；这里不抛错，避免整次手势失败。
    if (element && !isNonDeletedElement(element)) {
      console.error(
        "[NONDELETED][INVARIANT] updateBoundElements(): `isDeleted: true` in visitor",
      );
    }

    if (!isArrowElement(element) || !isNonDeletedElement(element)) {
      return;
    }

    // In case the boundElements are stale
    // 中文：boundElements 可能是旧数据（例如撤销后），以 binding 字段为准再校验一次。
    if (!doesNeedUpdate(element, changedElement)) {
      return;
    }

    // `linearElement` is being moved/scaled already, just update the binding
    // 中文：本次操作里已经一起变换过的箭头，其点集已由主流程处理；这里再更新
    // 会重复位移。
    if (simultaneouslyUpdatedElementIds.has(element.id)) {
      return;
    }

    updateBoundArrow(element, scene, elementsMap, options?.renderEnvironment);
  };

  boundElementsVisitor(elementsMap, changedElement, visitor);
};

/**
 * 修复单个箭头端点的“隐式绑定”（箭头位置变了，但绑定关系可能失效/新增）。
 *
 * 流程是“先解绑、再按策略重绑”，而不是直接改 binding：这样能复用手柄拖拽
 * 的全套命中判定（距离阈值、inside/outside），保证程序化移动后的结果与
 * 手工拖拽一致。
 *
 * 仅支持普通箭头；肘形箭头必须走路由流程，此处用 invariant 明确拒绝，
 * 避免产生非法 fixedPoint。
 */
const updateArrowBindings = (
  latestElement: NonDeleted<ExcalidrawArrowElement>,
  startOrEnd: "startBinding" | "endBinding",
  elementsMap: NonDeletedSceneElementsMap,
  scene: Scene,
  appState: AppState,
) => {
  invariant(
    !isElbowArrow(latestElement),
    "Elbow arrows not supported for indirect updates",
  );

  const binding = latestElement[startOrEnd];
  const bindableElement =
    binding &&
    (elementsMap.get(
      binding.elementId,
    ) as NonDeleted<ExcalidrawBindableElement>);
  const point = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    latestElement,
    startOrEnd === "startBinding" ? 0 : -1,
    elementsMap,
  );
  const hit =
    bindableElement &&
    hitElementItself({
      element: bindableElement,
      point,
      elementsMap,
      threshold: maxBindingDistance_simple(appState.zoom),
    });
  const strategyName = startOrEnd === "startBinding" ? "start" : "end";
  unbindBindingElement(latestElement, strategyName, scene);
  if (hit) {
    const pointIdx =
      startOrEnd === "startBinding" ? 0 : latestElement.points.length - 1;
    const localPoint = latestElement.points[pointIdx];
    const strategy =
      getBindingStrategyForDraggingBindingElementEndpoints_simple(
        latestElement,
        new Map([[pointIdx, { point: localPoint }]]),
        point[0],
        point[1],
        elementsMap,
        scene.getNonDeletedElements(),
        appState,
      );
    if (
      strategy[strategyName] &&
      strategy[strategyName].element?.id === bindableElement.id &&
      strategy[strategyName].mode
    ) {
      bindBindingElement(
        latestElement,
        bindableElement,
        strategy[strategyName].mode,
        strategyName,
        scene,
        appState.zoom,
        strategy[strategyName].focusPoint,
      );
    }
  }
};

/**
 * “元素被修改后”的统一绑定修复入口。
 *
 * 分两种情况：
 * - 改的是箭头自己：检查它两端是否还够得着目标（updateArrowBindings）；
 * - 改的是别的元素：它可能被箭头绑定，调用 updateBoundElements 反向更新箭头。
 *
 * 非箭头分支把 latestElement 塞进 changedElements，是因为它还没写回 scene，
 * 必须让下游读到新几何。
 */
export const updateBindings = (
  latestElement: NonDeletedExcalidrawElement,
  scene: Scene,
  appState: AppState,
  options?: {
    simultaneouslyUpdated?: readonly NonDeletedExcalidrawElement[];
    newSize?: { width: number; height: number };
    /** measures the labels of the bound arrows it updates */
    renderEnvironment?: RenderEnvironment;
  },
) => {
  if (isArrowElement(latestElement)) {
    const elementsMap = scene.getNonDeletedElementsMap();

    if (latestElement.startBinding) {
      updateArrowBindings(
        latestElement,
        "startBinding",
        elementsMap,
        scene,
        appState,
      );
    }

    if (latestElement.endBinding) {
      updateArrowBindings(
        latestElement,
        "endBinding",
        elementsMap,
        scene,
        appState,
      );
    }
  } else {
    updateBoundElements(latestElement, scene, {
      ...options,
      changedElements: new Map([[latestElement.id, latestElement]]),
    });
  }
};

/**
 * 校验 boundElements 的反向引用是否真的对应该元素。
 *
 * boundElements 是“目标侧缓存”，可能因撤销/协作合并不一致；以箭头自身的
 * startBinding/endBinding 为准，可避免误更新无关箭头。
 */
const doesNeedUpdate = (
  boundElement: NonDeleted<ExcalidrawArrowElement>,
  changedElement: ExcalidrawBindableElement,
) => {
  return (
    boundElement.startBinding?.elementId === changedElement.id ||
    boundElement.endBinding?.elementId === changedElement.id
  );
};

// PERF: callers updating many elements invoke `updateBoundElements()` for each
// of them with the same `simultaneouslyUpdated` array, so cache the id set
// per array to avoid rebuilding it on every call (O(n^2) on multi-element
// transforms)
const simultaneouslyUpdatedElementIdsCache = new WeakMap<
  readonly ExcalidrawElement[],
  ReadonlySet<ExcalidrawElement["id"]>
>();

/**
 * The id set of `simultaneouslyUpdated`, shared by every `updateBoundElements()`
 * call given the same array. Pass one array instance for all elements of an
 * operation, and don't change its membership after the first lookup, or the
 * cached ids go stale.
 */
/**
 * 批量变换时复用的 id 集合。
 *
 * 多选缩放/拖拽会对每个元素各调一次 updateBoundElements，每次都需要判断
 * “这个箭头是否也在同时更新”。若每次重建 Set，就是 O(n²)。这里用 WeakMap
 * 以数组实例为 key 缓存结果。
 *
 * 调用约束：同一次操作必须传同一个数组实例，且首次查询后不要再增删元素，
 * 否则缓存里的 id 与数组内容不一致。
 *
 * @returns 无 simultaneouslyUpdated 时返回空 Set（不缓存，避免共享可变状态）。
 */
export const getSimultaneouslyUpdatedElementIds = (
  simultaneouslyUpdated: readonly ExcalidrawElement[] | undefined,
): ReadonlySet<ExcalidrawElement["id"]> => {
  if (!simultaneouslyUpdated) {
    return new Set();
  }
  let ids = simultaneouslyUpdatedElementIdsCache.get(simultaneouslyUpdated);
  if (!ids) {
    ids = new Set(simultaneouslyUpdated.map((element) => element.id));
    simultaneouslyUpdatedElementIdsCache.set(simultaneouslyUpdated, ids);
  }
  return ids;
};

/**
 * 为肘形箭头选择“出线方向”（heading）。
 *
 * 默认沿指向上一点的方向；如果存在绑定元素且点在吸附距离内，则改用元素轮廓
 * 在该处的法线方向，让线段垂直出入边框——这是肘形箭头看起来“规整”的关键。
 *
 * `distance` 为 null 表示超出绑定距离：此时退化为“指向元素中心”，
 * 让方向仍朝目标，但不假设端点已贴边。
 *
 * 调用方：elbowArrow.ts 的路由器。
 */
export const getHeadingForElbowArrowSnap = (
  p: Readonly<GlobalPoint>,
  otherPoint: Readonly<GlobalPoint>,
  bindableElement: ExcalidrawBindableElement | undefined | null,
  aabb: Bounds | undefined | null,
  origPoint: GlobalPoint,
  elementsMap: ElementsMap,
  zoom?: AppState["zoom"],
): Heading => {
  const otherPointHeading = vectorToHeading(vectorFromPoint(otherPoint, p));

  if (!bindableElement || !aabb) {
    return otherPointHeading;
  }

  const distance = getDistanceForBinding(
    origPoint,
    bindableElement,
    elementsMap,
    zoom,
  );

  if (!distance) {
    return vectorToHeading(
      vectorFromPoint(p, elementCenterPoint(bindableElement, elementsMap)),
    );
  }

  return headingForPointFromElement(bindableElement, aabb, p);
};

/**
 * 点到元素的距离，超过绑定距离则视为“没吸附”。
 *
 * 返回 null 而不是 Infinity，便于调用方用 falsy 判断；距离计算交给
 * distanceToElement，兼容旋转与圆角。
 */
const getDistanceForBinding = (
  point: Readonly<GlobalPoint>,
  bindableElement: ExcalidrawBindableElement,
  elementsMap: ElementsMap,
  zoom?: AppState["zoom"],
) => {
  const distance = distanceToElement(bindableElement, elementsMap, point);
  const bindDistance = maxBindingDistance_simple(zoom);

  return distance > bindDistance ? null : distance;
};

/**
 * 求端点应落在绑定元素轮廓上的哪个点（吸附核心）。
 *
 * 两条路径：
 * - 矩形状元素 + 肘形箭头：先 avoidRectangularCorner 把点从角上推开，再用
 *   经过中心的射线求交，保证线段从边中点附近出入；
 * - 普通箭头：沿“边缘点 → 相邻点”的延长线求交，取离相邻点最近的交点，
 *   这样端点贴合箭头来向，不会跳到背面。
 *
 * 两个易错点：
 * - 交点可能有两个（细长旋转菱形），必须按距离排序取最近的；
 * - 求不到交点时返回 edgePoint（原端点），而不是 null，保持调用方无分支。
 *
 * @param customIntersector 允许调用方指定求交线（例如网格吸附后的水平/垂直线）。
 * @param isMidpointSnappingEnabled 关闭时跳过中点吸附，避免导入数据被移动。
 */
export const bindPointToSnapToElementOutline = (
  arrowElement: ExcalidrawArrowElement,
  bindableElement: ExcalidrawBindableElement,
  startOrEnd: "start" | "end",
  elementsMap: ElementsMap,
  zoom: AppState["zoom"],
  customIntersector?: LineSegment<GlobalPoint>,
  isMidpointSnappingEnabled = true,
): GlobalPoint => {
  const elbowed = isElbowArrow(arrowElement);
  const point = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    arrowElement,
    startOrEnd === "start" ? 0 : -1,
    elementsMap,
  );

  if (arrowElement.points.length < 2) {
    // New arrow creation, so no snapping
    return point;
  }

  const edgePoint =
    isRectanguloidElement(bindableElement) && elbowed
      ? avoidRectangularCorner(
          arrowElement,
          bindableElement,
          elementsMap,
          point,
        )
      : point;
  const adjacentPoint =
    customIntersector && !elbowed
      ? customIntersector[1]
      : LinearElementEditor.getPointAtIndexGlobalCoordinates(
          arrowElement,
          startOrEnd === "start" ? 1 : -2,
          elementsMap,
        );
  const bindingGap = getBindingGap(bindableElement);
  const aabb = aabbForElement(bindableElement, elementsMap);
  const bindableCenter = getCenterForBounds(aabb);

  let intersection: GlobalPoint | null = null;
  if (elbowed) {
    const snap = isMidpointSnappingEnabled
      ? getElbowArrowSnapMidPoint(edgePoint, bindableElement, elementsMap, zoom)
      : undefined;
    const resolved = snap?.point ?? point;
    // A midpoint on the element's axes fixes the side to bind to. The pointer
    // can report another side, e.g. horizontal when slightly inside a
    // diamond's top vertex, which would bind next to the vertex.
    const isHorizontal = headingIsHorizontal(
      snap?.onAxis
        ? vectorToHeading(vectorFromPoint(snap.point, bindableCenter))
        : headingForPointFromElement(bindableElement, aabb, point),
    );
    const otherPoint = pointFrom<GlobalPoint>(
      isHorizontal ? bindableCenter[0] : resolved[0],
      !isHorizontal ? bindableCenter[1] : resolved[1],
    );
    const intersector =
      customIntersector ??
      lineSegment(
        otherPoint,
        pointFromVector(
          vectorScale(
            vectorNormalize(vectorFromPoint(resolved, otherPoint)),
            Math.max(bindableElement.width, bindableElement.height) * 2,
          ),
          otherPoint,
        ),
      );
    // The ray can cross the outline twice (e.g. a thin rotated diamond), so
    // take the crossing nearest to the point we aim at
    const byDistanceToResolved = (a: GlobalPoint, b: GlobalPoint) =>
      pointDistanceSq(a, resolved) - pointDistanceSq(b, resolved);
    intersection = intersectElementWithLineSegment(
      bindableElement,
      elementsMap,
      intersector,
      bindingGap,
    ).sort(byDistanceToResolved)[0];

    if (!intersection) {
      const anotherPoint = pointFrom<GlobalPoint>(
        !isHorizontal ? bindableCenter[0] : resolved[0],
        isHorizontal ? bindableCenter[1] : resolved[1],
      );
      const anotherIntersector = lineSegment(
        anotherPoint,
        pointFromVector(
          vectorScale(
            vectorNormalize(vectorFromPoint(resolved, anotherPoint)),
            Math.max(bindableElement.width, bindableElement.height) * 2,
          ),
          anotherPoint,
        ),
      );
      intersection = intersectElementWithLineSegment(
        bindableElement,
        elementsMap,
        anotherIntersector,
        BASE_BINDING_GAP,
      ).sort(byDistanceToResolved)[0];
    }
  } else {
    let intersector = customIntersector;
    if (!intersector) {
      const halfVector = vectorScale(
        vectorNormalize(vectorFromPoint(edgePoint, adjacentPoint)),
        pointDistance(edgePoint, adjacentPoint) +
          Math.max(bindableElement.width, bindableElement.height) +
          bindingGap * 2,
      );
      intersector =
        customIntersector ??
        lineSegment(
          pointFromVector(halfVector, adjacentPoint),
          pointFromVector(vectorScale(halfVector, -1), adjacentPoint),
        );
    }

    intersection =
      pointDistance(edgePoint, adjacentPoint) < 1
        ? edgePoint
        : intersectElementWithLineSegment(
            bindableElement,
            elementsMap,
            intersector,
            bindingGap,
          ).sort(
            (g, h) =>
              pointDistanceSq(g, adjacentPoint) -
              pointDistanceSq(h, adjacentPoint),
          )[0];
  }

  if (
    !intersection ||
    // Too close to determine vector from intersection to edgePoint
    pointDistanceSq(edgePoint, intersection) < PRECISION
  ) {
    return edgePoint;
  }

  return intersection;
};

/**
 * 把落在矩形四角附近的点沿最近的边推出 bindingGap，避免端点卡在角点。
 *
 * 先在元素本地坐标系（反向旋转）里判断点在哪个角的象限，再分“更靠近竖直边
 * 还是水平边”决定推到哪条边，最后旋转回全局坐标。只处理四个角，
 * 边中点由正常求交处理。
 *
 * @returns 调整后的全局点；点不在任何角区时原样返回。
 */
export const avoidRectangularCorner = (
  arrowElement: ExcalidrawArrowElement,
  bindTarget: ExcalidrawBindableElement,
  elementsMap: ElementsMap,
  p: GlobalPoint,
): GlobalPoint => {
  const center = elementCenterPoint(bindTarget, elementsMap);
  const nonRotatedPoint = pointRotateRads(
    p,
    center,
    -bindTarget.angle as Radians,
  );

  const bindingGap = getBindingGap(bindTarget);

  if (nonRotatedPoint[0] < bindTarget.x && nonRotatedPoint[1] < bindTarget.y) {
    // Top left
    if (nonRotatedPoint[1] - bindTarget.y > -bindingGap) {
      return pointRotateRads<GlobalPoint>(
        pointFrom(bindTarget.x - bindingGap, bindTarget.y),
        center,
        bindTarget.angle,
      );
    }
    return pointRotateRads(
      pointFrom(bindTarget.x, bindTarget.y - bindingGap),
      center,
      bindTarget.angle,
    );
  } else if (
    nonRotatedPoint[0] < bindTarget.x &&
    nonRotatedPoint[1] > bindTarget.y + bindTarget.height
  ) {
    // Bottom left
    if (nonRotatedPoint[0] - bindTarget.x > -bindingGap) {
      return pointRotateRads(
        pointFrom(bindTarget.x, bindTarget.y + bindTarget.height + bindingGap),
        center,
        bindTarget.angle,
      );
    }
    return pointRotateRads(
      pointFrom(bindTarget.x - bindingGap, bindTarget.y + bindTarget.height),
      center,
      bindTarget.angle,
    );
  } else if (
    nonRotatedPoint[0] > bindTarget.x + bindTarget.width &&
    nonRotatedPoint[1] > bindTarget.y + bindTarget.height
  ) {
    // Bottom right
    if (nonRotatedPoint[0] - bindTarget.x < bindTarget.width + bindingGap) {
      return pointRotateRads(
        pointFrom(
          bindTarget.x + bindTarget.width,
          bindTarget.y + bindTarget.height + bindingGap,
        ),
        center,
        bindTarget.angle,
      );
    }
    return pointRotateRads(
      pointFrom(
        bindTarget.x + bindTarget.width + bindingGap,
        bindTarget.y + bindTarget.height,
      ),
      center,
      bindTarget.angle,
    );
  } else if (
    nonRotatedPoint[0] > bindTarget.x + bindTarget.width &&
    nonRotatedPoint[1] < bindTarget.y
  ) {
    // Top right
    if (nonRotatedPoint[0] - bindTarget.x < bindTarget.width + bindingGap) {
      return pointRotateRads(
        pointFrom(bindTarget.x + bindTarget.width, bindTarget.y - bindingGap),
        center,
        bindTarget.angle,
      );
    }
    return pointRotateRads(
      pointFrom(bindTarget.x + bindTarget.width + bindingGap, bindTarget.y),
      center,
      bindTarget.angle,
    );
  }

  return p;
};

/**
 * 读取某一端的绑定快照：目标元素、原始 fixedPoint、归一化后的全局焦点。
 *
 * 特意把 `binding` 原样一起返回：调用方常需要判断“是否存在绑定”以及 mode，
 * 而 element 可能已从 map 中消失（返回 undefined）。所有字段都可能为 null，
 * 由调用方决定如何降级。
 */
const extractBinding = (
  arrow: ExcalidrawArrowElement,
  startOrEnd: "startBinding" | "endBinding",
  elementsMap: ElementsMap,
) => {
  const binding = arrow[startOrEnd];
  if (!binding) {
    return {
      element: null,
      fixedPoint: null,
      focusPoint: null,
      binding,
      mode: null,
    };
  }

  const element = elementsMap.get(
    binding.elementId,
  ) as NonDeleted<ExcalidrawBindableElement>;

  return {
    element,
    fixedPoint: binding.fixedPoint,
    focusPoint: getGlobalFixedPointForBindableElement(
      normalizeFixedPoint(binding.fixedPoint),
      element,
      elementsMap,
    ),
    binding,
    mode: binding.mode,
  };
};

/**
 * Snaps a bound arrow endpoint to the grid on the axis parallel to the
 * bindable element's side, while preserving the binding gap distance on the
 * perpendicular axis. In other words, the grid axis closest to the side's
 * perpendicular (normal) is used as the snap axis and the other axis is kept at
 * the binding gap distance.
 */
const snapBoundPointToGrid = (
  outlinePoint: GlobalPoint,
  bindableElement: ExcalidrawBindableElement,
  elementsMap: ElementsMap,
  gridSize: NullableGridSize,
  arrowElement: ExcalidrawArrowElement,
  adjacentPoint?: GlobalPoint,
): GlobalPoint => {
  if (!gridSize) {
    return outlinePoint;
  }

  const aabb = aabbForElement(bindableElement, elementsMap);
  // For ellipses and diamonds use the arrow's incoming direction instead of
  // the position-based heading, which can give the wrong axis when the
  // outline point is near a cardinal zone or an angled diamond face.
  const heading =
    adjacentPoint &&
    (bindableElement.type === "ellipse" || bindableElement.type === "diamond")
      ? vectorToHeading(vectorFromPoint(adjacentPoint, outlinePoint))
      : headingForPointFromElement(bindableElement, aabb, outlinePoint);

  const bindingGap = getBindingGap(bindableElement);
  const extent =
    Math.max(bindableElement.width, bindableElement.height) + bindingGap * 2;
  const center = getCenterForBounds(aabb);

  // Both heading strategies above return global-axis directions.
  const absNX = Math.abs(heading[0]);
  const absNY = Math.abs(heading[1]);
  if (absNX >= absNY) {
    // Global X is closest to the perpendicular so snap Y, intersect horizontal line
    const [, snappedY] = getGridPoint(
      outlinePoint[0],
      outlinePoint[1],
      gridSize,
    );
    const intersector = lineSegment<GlobalPoint>(
      pointFrom<GlobalPoint>(center[0] - extent, snappedY),
      pointFrom<GlobalPoint>(center[0] + extent, snappedY),
    );
    const intersection = intersectElementWithLineSegment(
      bindableElement,
      elementsMap,
      intersector,
      bindingGap,
    ).sort(
      (a, b) =>
        pointDistanceSq(a, outlinePoint) - pointDistanceSq(b, outlinePoint),
    )[0];

    return intersection ?? pointFrom<GlobalPoint>(outlinePoint[0], snappedY);
  }

  // Global Y is closest to the perpendicular so snap X, intersect vertical line
  const [snappedX] = getGridPoint(outlinePoint[0], outlinePoint[1], gridSize);
  const intersector = lineSegment<GlobalPoint>(
    pointFrom<GlobalPoint>(snappedX, center[1] - extent),
    pointFrom<GlobalPoint>(snappedX, center[1] + extent),
  );
  const intersection = intersectElementWithLineSegment(
    bindableElement,
    elementsMap,
    intersector,
    bindingGap,
  ).sort(
    (a, b) =>
      pointDistanceSq(a, outlinePoint) - pointDistanceSq(b, outlinePoint),
  )[0];

  return intersection ?? pointFrom<GlobalPoint>(snappedX, outlinePoint[1]);
};

/**
 * 元素面积，用于“小图形被大图形包住”时的防反转判断。
 *
 * 只比较相对大小（见 updateBoundPoint 中 < 2 倍阈值），不追求精确面积；
 * 用 width*height 足够，且对旋转不敏感（包围盒面积）。
 */
const elementArea = (element: ExcalidrawBindableElement) =>
  element.width * element.height;

/**
 * 根据绑定关系重算箭头某个端点的局部坐标。
 *
 * 算法：
 * 1. 把 fixedPoint 归一化后映射到绑定元素的全局固定点 focusPoint；
 * 2. `inside` 模式直接落在焦点，不做轮廓求交；
 * 3. 否则取箭头另一端（若也绑定了则取它的固定点，否则取另一个端点）作为
 *    视线终点，与绑定元素轮廓求交，得到 outlinePoint；
 * 4. 按箭头尖配置选择 outlinePoint 还是 focusPoint：有箭头尖时贴轮廓，
 *    否则允许贴焦点，避免箭头尖穿进形状里。
 *
 * 返回 null 表示“这次不需要更新”（绑定为空、绑定目标不是传入元素、
 * 或箭头仍是 pointerdown 的退化状态）。调用方据此跳过写入。
 */
export const updateBoundPoint = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  startOrEnd: "startBinding" | "endBinding",
  binding: FixedPointBinding | null | undefined,
  bindableElement: ExcalidrawBindableElement,
  elementsMap: ElementsMap,
  dragging?: boolean,
): LocalPoint | null => {
  if (
    binding == null ||
    // We only need to update the other end if this is a 2 point line element
    (binding.elementId !== bindableElement.id && arrow.points.length > 2) ||
    // Initial arrow created on pointer down needs to not update the points
    pointsEqual(
      arrow.points[arrow.points.length - 1],
      pointFrom<LocalPoint>(0, 0),
    )
  ) {
    return null;
  }

  const focusPoint = getGlobalFixedPointForBindableElement(
    normalizeFixedPoint(binding.fixedPoint),
    bindableElement,
    elementsMap,
  );

  // inside 模式不参与轮廓求交：它表示“端点就在元素内部”，任何吸附都会
  // 把用户刻意放进去的点拉回边上，因此直接返回焦点。
  // 0. Short-circuit for inside binding as it doesn't require any
  // calculations and is not affected by other bindings
  if (binding.mode === "inside") {
    return LinearElementEditor.createPointAt(
      arrow,
      elementsMap,
      focusPoint[0],
      focusPoint[1],
      null,
    );
  }

  const { element: otherBindable, focusPoint: otherFocusPoint } =
    extractBinding(
      arrow,
      startOrEnd === "startBinding" ? "endBinding" : "startBinding",
      elementsMap,
    );
  const otherArrowPoint = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    arrow,
    startOrEnd === "startBinding" ? 1 : -2,
    elementsMap,
  );
  const otherFocusPointOrArrowPoint =
    arrow.points.length === 2
      ? otherFocusPoint || otherArrowPoint
      : otherArrowPoint;
  const intersector =
    otherFocusPointOrArrowPoint &&
    lineSegment(focusPoint, otherFocusPointOrArrowPoint);
  const otherOutlinePoint =
    otherBindable &&
    intersector &&
    intersectElementWithLineSegment(
      otherBindable,
      elementsMap,
      intersector,
      getBindingGap(otherBindable),
    ).sort(
      (a, b) => pointDistanceSq(a, focusPoint) - pointDistanceSq(b, focusPoint),
    )[0];
  const outlinePoint =
    intersector &&
    intersectElementWithLineSegment(
      bindableElement,
      elementsMap,
      intersector,
      getBindingGap(bindableElement),
    ).sort(
      (a, b) =>
        pointDistanceSq(a, otherFocusPointOrArrowPoint) -
        pointDistanceSq(b, otherFocusPointOrArrowPoint),
    )[0];
  // resolvedTarget 决定“短箭头退化时优先用哪个点”：
  // - 两端都没有箭头尖：用 focusPoint（线头本来就可以停在内部）；
  // - 本端有箭头尖：也用 focusPoint，让箭头尖锚在固定点上；
  // - 只有“另一端有尖、本端无尖”时才优先 outlinePoint，让无尖的线头贴边。
  // 这里的取舍只影响下面的防反转/过短分支；正常路径仍优先 outlinePoint。
  const startHasArrowhead = arrow.startArrowhead !== null;
  const endHasArrowhead = arrow.endArrowhead !== null;
  const resolvedTarget =
    (!startHasArrowhead && !endHasArrowhead) ||
    (startOrEnd === "startBinding" && startHasArrowhead) ||
    (startOrEnd === "endBinding" && endHasArrowhead)
      ? focusPoint
      : outlinePoint || focusPoint;

  // 1. Handle case when the outline point (or focus point) is inside
  // the other shape by short-circuiting to the focus point, otherwise
  // the arrow would invert
  // 中文：当两端互相“套住”（小元素在大元素内）时，轮廓交点可能落进另一个
  // 图形内部，继续用它会让箭头方向翻转。elementArea 的 2 倍阈值是对
  // “线框图/嵌套容器”场景的折中；拖拽中（dragging）不做该回退，避免手感跳变。
  if (
    otherBindable &&
    outlinePoint &&
    !dragging &&
    // Arbitrary threshold to handle wireframing use cases
    elementArea(otherBindable) < elementArea(bindableElement) * 2 &&
    hitElementItself({
      element: otherBindable,
      point: outlinePoint,
      elementsMap,
      threshold: getBindingGap(otherBindable),
      overrideShouldTestInside: true,
    })
  ) {
    return LinearElementEditor.createPointAt(
      arrow,
      elementsMap,
      resolvedTarget[0],
      resolvedTarget[1],
      null,
    );
  }

  const otherTargetPoint = otherBindable
    ? otherOutlinePoint || otherFocusPoint || otherArrowPoint
    : otherArrowPoint;
  const arrowTooShort =
    pointDistance(otherTargetPoint, outlinePoint || focusPoint) <=
    BASE_ARROW_MIN_LENGTH;

  // 2. If the arrow is unconnected at the other end, just check arrow size
  // and short-circuit to the focus point if the arrow is too short to
  // avoid inversion
  // 中文：另一端没有绑定，就没有“被另一个轮廓夹住”的问题，只需防止过短：
  // 过短时退回 focusPoint，否则用轮廓交点。
  if (!otherBindable) {
    return LinearElementEditor.createPointAt(
      arrow,
      elementsMap,
      arrowTooShort ? focusPoint[0] : outlinePoint?.[0] ?? focusPoint[0],
      arrowTooShort ? focusPoint[1] : outlinePoint?.[1] ?? focusPoint[1],
      null,
    );
  }

  // 3. If the arrow is too short while connected on both ends and
  // the other arrow endpoint will not be inside the bindable, just
  // check the arrow size and make a decision based on that
  // 中文：两端都绑定且距离过近时，轮廓交点会让两个箭头尖互相顶住；
  // 用 resolvedTarget（见上）选一个更稳定的落点。
  if (arrowTooShort) {
    return LinearElementEditor.createPointAt(
      arrow,
      elementsMap,
      resolvedTarget?.[0] || focusPoint[0],
      resolvedTarget?.[1] || focusPoint[1],
      null,
    );
  }

  // 4. In the general case, snap to the outline if possible
  return LinearElementEditor.createPointAt(
    arrow,
    elementsMap,
    outlinePoint?.[0] || focusPoint[0],
    outlinePoint?.[1] || focusPoint[1],
    null,
  );
};

/**
 * 肘形箭头：由端点全局位置反算归一化固定点。
 *
 * 步骤：
 * 1. 需要吸附时先 `bindPointToSnapToElementOutline` 把端点贴到轮廓；
 * 2. 用元素中心把点反向旋转到本地坐标系；
 * 3. 除以元素宽高得到 0..1 比例（点状元素直接给中心 0.5）。
 *
 * 除以宽高时把除数下限设为 bindingGap：小元素或点状元素若直接用接近 0 的
 * 宽高做除数，比例会被放大成极端值，之后 resize 时端点会飞出屏幕。
 *
 * @returns 只含 fixedPoint；elementId/mode 由 bindBindingElement 补齐。
 */
export const calculateFixedPointForElbowArrowBinding = (
  linearElement: NonDeleted<ExcalidrawElbowArrowElement>,
  hoveredElement: ExcalidrawBindableElement,
  startOrEnd: "start" | "end",
  elementsMap: ElementsMap,
  zoom: AppState["zoom"],
  shouldSnapToOutline = true,
  isMidpointSnappingEnabled = true,
): { fixedPoint: FixedPoint } => {
  const bounds = [
    hoveredElement.x,
    hoveredElement.y,
    hoveredElement.x + hoveredElement.width,
    hoveredElement.y + hoveredElement.height,
  ] as Bounds;
  const snappedPoint = shouldSnapToOutline
    ? bindPointToSnapToElementOutline(
        linearElement,
        hoveredElement,
        startOrEnd,
        elementsMap,
        zoom,
        undefined,
        isMidpointSnappingEnabled,
      )
    : LinearElementEditor.getPointAtIndexGlobalCoordinates(
        linearElement,
        startOrEnd === "start" ? 0 : -1,
        elementsMap,
      );
  const globalMidPoint = pointFrom(
    bounds[0] + (bounds[2] - bounds[0]) / 2,
    bounds[1] + (bounds[3] - bounds[1]) / 2,
  );
  const nonRotatedSnappedGlobalPoint = pointRotateRads(
    snappedPoint,
    globalMidPoint,
    -hoveredElement.angle as Radians,
  );

  // A point-like element has no interior to anchor a proportional point into,
  // and outline snapping above can fall back to an unrelated point; bind to
  // the center so the arrow stays put when the element is later resized.
  if (
    hoveredElement.width < MIN_BINDABLE_SIZE ||
    hoveredElement.height < MIN_BINDABLE_SIZE
  ) {
    return { fixedPoint: normalizeFixedPoint([0.5, 0.5]) };
  }

  // Floor the divisor at the binding gap (rather than at ~0) so that
  // elements smaller than the gap don't blow up the ratio: the snapped
  // point sits at most one gap-width outside the outline, so this keeps
  // the resulting fixedPoint bounded even for zero/near-zero-size elements.
  const sizeFloor = getBindingGap(hoveredElement);

  return {
    fixedPoint: normalizeFixedPoint([
      (nonRotatedSnappedGlobalPoint[0] - hoveredElement.x) /
        Math.max(hoveredElement.width, sizeFloor),
      (nonRotatedSnappedGlobalPoint[1] - hoveredElement.y) /
        Math.max(hoveredElement.height, sizeFloor),
    ]),
  };
};

/**
 * 普通箭头：由端点（或调用方给的 focusPoint）反算归一化固定点。
 *
 * 与肘形版本的区别：不做轮廓吸附，直接用点位置；因此 inside 绑定可以保留
 * “点落在元素内部”的原始位置。同样先反向旋转到本地坐标，再除以
 * max(宽/高, bindingGap) 防止比例爆炸。
 *
 * @param focusPoint 传入时优先使用（例如拖拽中已经算好的落点），否则读端点。
 */
export const calculateFixedPointForNonElbowArrowBinding = (
  linearElement: NonDeleted<ExcalidrawArrowElement>,
  hoveredElement: NonDeleted<ExcalidrawBindableElement>,
  startOrEnd: "start" | "end",
  elementsMap: ElementsMap,
  focusPoint?: GlobalPoint,
): { fixedPoint: FixedPoint } => {
  const edgePoint: GlobalPoint = focusPoint
    ? focusPoint
    : LinearElementEditor.getPointAtIndexGlobalCoordinates(
        linearElement,
        startOrEnd === "start" ? 0 : -1,
        elementsMap,
      );

  const elementCenter = elementCenterPoint(hoveredElement, elementsMap);

  // Rotate the point to account for element rotation
  const nonRotatedPoint = pointRotateRads(
    edgePoint,
    elementCenter,
    -hoveredElement.angle as Radians,
  );

  // A point-like element has no interior to anchor a proportional point into;
  // bind to the center so the arrow stays put when the element is later
  // resized.
  if (
    hoveredElement.width < MIN_BINDABLE_SIZE ||
    hoveredElement.height < MIN_BINDABLE_SIZE
  ) {
    return { fixedPoint: normalizeFixedPoint([0.5, 0.5]) };
  }

  // Floor the divisor at the binding gap (rather than at ~0) so that
  // elements smaller than the gap don't blow up the ratio: the bound
  // point sits at most one gap-width outside the outline, so this keeps
  // the resulting fixedPoint bounded even for zero/near-zero-size elements.
  const sizeFloor = getBindingGap(hoveredElement);

  // Calculate the ratio relative to the element's bounds
  const fixedPointX =
    (nonRotatedPoint[0] - hoveredElement.x) /
    Math.max(hoveredElement.width, sizeFloor);
  const fixedPointY =
    (nonRotatedPoint[1] - hoveredElement.y) /
    Math.max(hoveredElement.height, sizeFloor);

  return {
    fixedPoint: normalizeFixedPoint([fixedPointX, fixedPointY]),
  };
};

/**
 * 复制元素后，把新副本内部的绑定 id 重映射到副本自己的 id。
 *
 * 四类引用都要处理：
 * - boundElements：指向“绑到本元素上的箭头/文本”，换成对应副本；
 * - containerId：文本所属容器的副本；
 * - startBinding/endBinding：箭头端点的目标副本；找不到映射说明目标没被复制，
 *   必须置 null，否则副本会指向原元素，删除原元素时连带出错。
 *
 * 肘形箭头最后重算 points：固定段索引依赖点集，id 重映射后路由可能变，
 * 这里用首尾点重建一次保证几何自洽。
 *
 * 直接 Object.assign 修改入参元素（调用方传的是尚未写入 scene 的副本）。
 */
export const fixDuplicatedBindingsAfterDuplication = (
  duplicatedElements: ExcalidrawElement[],
  origIdToDuplicateId: Map<ExcalidrawElement["id"], ExcalidrawElement["id"]>,
  duplicateElementsMap: NonDeletedSceneElementsMap,
) => {
  for (const duplicateElement of duplicatedElements) {
    if ("boundElements" in duplicateElement && duplicateElement.boundElements) {
      Object.assign(duplicateElement, {
        boundElements: duplicateElement.boundElements.reduce(
          (
            acc: Mutable<NonNullable<ExcalidrawElement["boundElements"]>>,
            binding,
          ) => {
            const newBindingId = origIdToDuplicateId.get(binding.id);
            if (newBindingId) {
              acc.push({ ...binding, id: newBindingId });
            }
            return acc;
          },
          [],
        ),
      });
    }

    if ("containerId" in duplicateElement && duplicateElement.containerId) {
      Object.assign(duplicateElement, {
        containerId:
          origIdToDuplicateId.get(duplicateElement.containerId) ?? null,
      });
    }

    if ("endBinding" in duplicateElement && duplicateElement.endBinding) {
      const newEndBindingId = origIdToDuplicateId.get(
        duplicateElement.endBinding.elementId,
      );
      Object.assign(duplicateElement, {
        endBinding: newEndBindingId
          ? {
              ...duplicateElement.endBinding,
              elementId: newEndBindingId,
            }
          : null,
      });
    }
    if ("startBinding" in duplicateElement && duplicateElement.startBinding) {
      const newEndBindingId = origIdToDuplicateId.get(
        duplicateElement.startBinding.elementId,
      );
      Object.assign(duplicateElement, {
        startBinding: newEndBindingId
          ? {
              ...duplicateElement.startBinding,
              elementId: newEndBindingId,
            }
          : null,
      });
    }

    if (isElbowArrow(duplicateElement)) {
      Object.assign(
        duplicateElement,
        updateElbowArrowPoints(duplicateElement, duplicateElementsMap, {
          points: [
            duplicateElement.points[0],
            duplicateElement.points[duplicateElement.points.length - 1],
          ],
        }),
      );
    }
  }
};

/**
 * 删除元素后的绑定清理。
 *
 * 两个方向都要清：
 * - 被删元素是绑定目标：所有指向它的箭头端点解除绑定，避免留下悬空 id；
 * - 被删元素自己持有 boundElements（例如带标签的箭头）：把它的引用从
 *   对端元素上摘掉。
 * 只处理“目标真的不在场景里”的情况；软删除（isDeleted）仍保留 id，
 * 是否清理由调用方在删除动作里决定。
 */
export const fixBindingsAfterDeletion = (
  sceneElements: readonly ExcalidrawElement[],
  deletedElements: readonly ExcalidrawElement[],
): void => {
  const elements = arrayToMap(sceneElements);

  // 被删元素可能同时是“绑定目标”（别人指向它）和“绑定源”（它指向别人），
  // 两个方向必须各扫一遍，顺序无所谓，但都要做。
  for (const element of deletedElements) {
    BoundElement.unbindAffected(elements, element, (element, updates) =>
      mutateElement(element, elements, updates),
    );
    BindableElement.unbindAffected(elements, element, (element, updates) =>
      mutateElement(element, elements, updates),
    );
  }
};

/**
 * 构造新的 boundElements 数组：先按 id 过滤掉要移除的，再追加新引用。
 *
 * 返回 null 表示原数组不存在——保持“没有绑定就是 null”的语义，避免下游把
 * 空数组当成“有绑定但为空”而走错分支。
 */
const newBoundElements = (
  boundElements: ExcalidrawElement["boundElements"],
  idsToRemove: Set<ExcalidrawElement["id"]>,
  elementsToAdd: Array<ExcalidrawElement> = [],
) => {
  if (!boundElements) {
    return null;
  }

  const nextBoundElements = boundElements.filter(
    (boundElement) => !idsToRemove.has(boundElement.id),
  );

  nextBoundElements.push(
    ...elementsToAdd.map(
      (x) =>
        ({ id: x.id, type: x.type } as
          | ExcalidrawArrowElement
          | ExcalidrawTextElement),
    ),
  );

  return nextBoundElements;
};

/**
 * 所有“引用型”属性的白名单。
 *
 * 把 frameId/containerId/startBinding/endBinding/boundElements 归为一类，
 * 是为了在删除、撤销、协作合并时能统一判断“哪些字段需要重映射/清理”，
 * 不必到处散落字段名。
 */
export const bindingProperties: Set<BindableProp | BindingProp> = new Set([
  "boundElements",
  "frameId",
  "containerId",
  "startBinding",
  "endBinding",
]);

export type BindableProp = "boundElements";

export type BindingProp =
  | "frameId"
  | "containerId"
  | "startBinding"
  | "endBinding";

type BoundElementsVisitingFunc = (
  boundElement: ExcalidrawElement | undefined,
  bindingProp: BindableProp,
  bindingId: string,
) => void;

type BindableElementVisitingFunc<T> = (
  bindableElement: ExcalidrawElement | undefined,
  bindingProp: BindingProp,
  bindingId: string,
) => T;

/**
 * Tries to visit each bound element (does not have to be found).
 */
/**
 * 遍历“绑定到本元素上”的引用（boundElements）。
 *
 * 先 slice 再遍历：访问者可能 mutate 元素，直接迭代原数组会在删除时跳过
 * 下一个元素。
 *
 * boundElements 里理论上可能残留重复文本（历史数据），这里不做去重，
 * 去重由 rebindAffected 处理。
 */
const boundElementsVisitor = (
  elements: ElementsMap,
  element: ExcalidrawElement,
  visit: BoundElementsVisitingFunc,
) => {
  if (isBindableElement(element)) {
    // create new instance so that possible mutations won't play a role in visiting order
    const boundElements = element.boundElements?.slice() ?? [];

    // last added text should be the one we keep (~previous are duplicates)
    boundElements.forEach(({ id }) => {
      visit(elements.get(id), "boundElements", id);
    });
  }
};

/**
 * Tries to visit each bindable element (does not have to be found).
 */
/**
 * 遍历“本元素指向”的所有绑定目标：frame、容器、箭头两端。
 *
 * 返回访问结果数组（而不是 void），因为同一套遍历既用于“清理/重建”，
 * 也用于“求点更新”（getBoundPointUpdates），后者需要收集返回值。
 *
 * 引用目标可能已被删除/不存在，因此传入 visitor 的 element 可能是 undefined；
 * visitor 必须自己处理。
 */
const bindableElementsVisitor = <T>(
  elements: ElementsMap,
  element: ExcalidrawElement,
  visit: BindableElementVisitingFunc<T>,
): T[] => {
  const result: T[] = [];

  if (element.frameId) {
    const id = element.frameId;
    result.push(visit(elements.get(id), "frameId", id));
  }

  if (isBoundToContainer(element)) {
    const id = element.containerId;
    result.push(visit(elements.get(id), "containerId", id));
  }

  if (isArrowElement(element)) {
    if (element.startBinding) {
      const id = element.startBinding.elementId;
      result.push(visit(elements.get(id), "startBinding", id));
    }

    if (element.endBinding) {
      const id = element.endBinding.elementId;
      result.push(visit(elements.get(id), "endBinding", id));
    }
  }

  return result;
};

/**
 * Bound element containing bindings to `frameId`, `containerId`, `startBinding` or `endBinding`.
 */
/**
 * “绑定源”视角的清理工具：本元素引用了别人（frame/容器/箭头两端）。
 *
 * unbindAffected 用于删除本元素时，把它从各个目标的 boundElements 里摘掉；
 * rebindAffected 用于撤销/恢复时，重新把本元素登记回目标。
 *
 * 两者都只做“单向修复”：目标不存在（已删除）时，rebind 会把本元素对应
 * 的绑定字段置 null，保证不会指向已删除元素。
 */
export class BoundElement {
  /**
   * Unbind the affected non deleted bindable elements (removing element from `boundElements`).
   * - iterates non deleted bindable elements (`containerId` | `startBinding.elementId` | `endBinding.elementId`) of the current element
   * - prepares updates to unbind each bindable element's `boundElements` from the current element
   */
  public static unbindAffected(
    elements: ElementsMap,
    boundElement: ExcalidrawElement | undefined,
    updateElementWith: (
      affected: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) {
    if (!boundElement) {
      return;
    }

    bindableElementsVisitor(elements, boundElement, (bindableElement) => {
      // bindable element is deleted, this is fine
      if (!bindableElement || bindableElement.isDeleted) {
        return;
      }

      boundElementsVisitor(
        elements,
        bindableElement,
        (_, __, boundElementId) => {
          if (boundElementId === boundElement.id) {
            updateElementWith(bindableElement, {
              boundElements: newBoundElements(
                bindableElement.boundElements,
                new Set([boundElementId]),
              ),
            });
          }
        },
      );
    });
  }

  /**
   * Rebind the next affected non deleted bindable elements (adding element to `boundElements`).
   * - iterates non deleted bindable elements (`containerId` | `startBinding.elementId` | `endBinding.elementId`) of the current element
   * - prepares updates to rebind each bindable element's `boundElements` to the current element
   *
   * NOTE: rebind expects that affected elements were previously unbound with `BoundElement.unbindAffected`
   */
  public static rebindAffected = (
    elements: ElementsMap,
    boundElement: ExcalidrawElement | undefined,
    updateElementWith: (
      affected: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) => {
    // don't try to rebind element that is deleted
    if (!boundElement || boundElement.isDeleted) {
      return;
    }

    bindableElementsVisitor(
      elements,
      boundElement,
      (bindableElement, bindingProp) => {
        // unbind from bindable elements, as bindings from non deleted elements into deleted elements are incorrect
        if (!bindableElement || bindableElement.isDeleted) {
          updateElementWith(boundElement, { [bindingProp]: null });
          return;
        }

        // frame bindings are unidirectional, there is nothing to rebind
        // 中文：frameId 只由子元素指向 frame，frame 的 boundElements 不记录子元素，
        // 因此这里没有反向登记需要补。
        if (bindingProp === "frameId") {
          return;
        }

        if (
          bindableElement.boundElements?.find((x) => x.id === boundElement.id)
        ) {
          return;
        }

        if (isArrowElement(boundElement)) {
          // rebind if not found!
          updateElementWith(bindableElement, {
            boundElements: newBoundElements(
              bindableElement.boundElements,
              new Set(),
              new Array(boundElement),
            ),
          });
        }

        if (isTextElement(boundElement)) {
          if (!bindableElement.boundElements?.find((x) => x.type === "text")) {
            // rebind only if there is no other text bound already
            updateElementWith(bindableElement, {
              boundElements: newBoundElements(
                bindableElement.boundElements,
                new Set(),
                new Array(boundElement),
              ),
            });
          } else {
            // unbind otherwise
            updateElementWith(boundElement, { [bindingProp]: null });
          }
        }
      },
    );
  };
}

/**
 * Bindable element containing bindings to `boundElements`.
 */
/**
 * “绑定目标”视角的清理工具：别人引用了本元素（本元素的 boundElements）。
 *
 * unbindAffected 用于删除本元素时，把所有 boundElements 指向本元素的
 * containerId/startBinding/endBinding 清空；
 * rebindAffected 用于恢复时重新登记，并对文本做“一个容器只能有一个标签”的
 * 冲突处理：保留最后一个 text，其他解绑。
 */
export class BindableElement {
  /**
   * Unbind the affected non deleted bound elements (resetting `containerId`, `startBinding`, `endBinding` to `null`).
   * - iterates through non deleted `boundElements` of the current element
   * - prepares updates to unbind each bound element from the current element
   */
  public static unbindAffected(
    elements: ElementsMap,
    bindableElement: ExcalidrawElement | undefined,
    updateElementWith: (
      affected: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) {
    if (!bindableElement) {
      return;
    }

    boundElementsVisitor(elements, bindableElement, (boundElement) => {
      // bound element is deleted, this is fine
      if (!boundElement || boundElement.isDeleted) {
        return;
      }

      bindableElementsVisitor(
        elements,
        boundElement,
        (_, bindingProp, bindableElementId) => {
          // making sure there is an element to be unbound
          if (bindableElementId === bindableElement.id) {
            updateElementWith(boundElement, { [bindingProp]: null });
          }
        },
      );
    });
  }

  /**
   * Rebind the affected non deleted bound elements (for now setting only `containerId`, as we cannot rebind arrows atm).
   * - iterates through non deleted `boundElements` of the current element
   * - prepares updates to rebind each bound element to the current element or unbind it from `boundElements` in case of conflicts
   *
   * NOTE: rebind expects that affected elements were previously unbound with `BindaleElement.unbindAffected`
   */
  public static rebindAffected = (
    elements: ElementsMap,
    bindableElement: ExcalidrawElement | undefined,
    updateElementWith: (
      affected: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) => {
    // don't try to rebind element that is deleted (i.e. updated as deleted)
    if (!bindableElement || bindableElement.isDeleted) {
      return;
    }

    boundElementsVisitor(
      elements,
      bindableElement,
      (boundElement, _, boundElementId) => {
        // unbind from bindable elements, as bindings from non deleted elements into deleted elements are incorrect
        if (!boundElement || boundElement.isDeleted) {
          updateElementWith(bindableElement, {
            boundElements: newBoundElements(
              bindableElement.boundElements,
              new Set([boundElementId]),
            ),
          });
          return;
        }

        if (isTextElement(boundElement)) {
          const boundElements = bindableElement.boundElements?.slice() ?? [];
          // check if this is the last element in the array, if not, there is an previously bound text which should be unbound
          // 中文：reverse() 后 find 得到的是“数组里最靠后”的 text，即最后绑定的那个；
          // 只有它保留 containerId，其余（历史重复）都解绑，避免一个容器挂多个标签。
          if (
            boundElements.reverse().find((x) => x.type === "text")?.id ===
            boundElement.id
          ) {
            if (boundElement.containerId !== bindableElement.id) {
              // rebind if not bound already!
              updateElementWith(boundElement, {
                containerId: bindableElement.id,
              } as ElementUpdate<ExcalidrawTextElement>);
            }
          } else {
            if (boundElement.containerId !== null) {
              // unbind if not unbound already
              updateElementWith(boundElement, {
                containerId: null,
              } as ElementUpdate<ExcalidrawTextElement>);
            }

            // unbind from boundElements as the element got bound to some other element in the meantime
            updateElementWith(bindableElement, {
              boundElements: newBoundElements(
                bindableElement.boundElements,
                new Set([boundElement.id]),
              ),
            });
          }
        }
      },
    );
  };
}

/**
 * 把归一化固定点映射回全局坐标。
 *
 * 顺序不可颠倒：先按未旋转包围盒算 x/width、y/height，再绕元素中心旋转角度。
 * 如果先旋转再乘比例，fixedPoint 的含义会随旋转变化，元素旋转后端点会漂移。
 *
 * 传入的 fixedPointRatio 会先 normalize，兼容历史数据里的越界值。
 */
export const getGlobalFixedPointForBindableElement = (
  fixedPointRatio: FixedPoint,
  element: ExcalidrawBindableElement,
  elementsMap: ElementsMap,
): GlobalPoint => {
  const [fixedX, fixedY] = normalizeFixedPoint(fixedPointRatio);

  return pointRotateRads(
    pointFrom(
      element.x + element.width * fixedX,
      element.y + element.height * fixedY,
    ),
    elementCenterPoint(element, elementsMap),
    element.angle,
  );
};

/**
 * 求箭头两端的全局固定点；未绑定的端用 points 直接换算。
 *
 * 为什么未绑定端也要算：调用方（例如路由/翻转）需要统一的两端坐标表示，
 * 不关心它是否来自绑定。注意未绑定端用 arrow.x + points[i]，而不是绑定元素的
 * 固定点，因为此时没有目标元素可用。
 */
export const getGlobalFixedPoints = (
  arrow: ExcalidrawArrowElement,
  elementsMap: ElementsMap,
): [GlobalPoint, GlobalPoint] => {
  const startElement =
    arrow.startBinding &&
    (elementsMap.get(arrow.startBinding.elementId) as
      | ExcalidrawBindableElement
      | undefined);
  const endElement =
    arrow.endBinding &&
    (elementsMap.get(arrow.endBinding.elementId) as
      | ExcalidrawBindableElement
      | undefined);
  const startPoint =
    startElement && arrow.startBinding
      ? getGlobalFixedPointForBindableElement(
          arrow.startBinding.fixedPoint,
          startElement as ExcalidrawBindableElement,
          elementsMap,
        )
      : pointFrom<GlobalPoint>(
          arrow.x + arrow.points[0][0],
          arrow.y + arrow.points[0][1],
        );
  const endPoint =
    endElement && arrow.endBinding
      ? getGlobalFixedPointForBindableElement(
          arrow.endBinding.fixedPoint,
          endElement as ExcalidrawBindableElement,
          elementsMap,
        )
      : pointFrom<GlobalPoint>(
          arrow.x + arrow.points[arrow.points.length - 1][0],
          arrow.y + arrow.points[arrow.points.length - 1][1],
        );

  return [startPoint, endPoint];
};

/**
 * 把两端固定点转成箭头局部坐标，供 points 重写。
 *
 * 肘形箭头重排路由前需要“首尾点的局部坐标”；pointFromAbsoluteCoords 会把
 * 全局点减去 arrow.x/y 并反向旋转，因此不会再受元素旋转影响。
 *
 * @returns [起点局部坐标, 终点局部坐标]。
 */
export const getArrowLocalFixedPoints = (
  arrow: ExcalidrawElbowArrowElement,
  elementsMap: ElementsMap,
) => {
  const [startPoint, endPoint] = getGlobalFixedPoints(arrow, elementsMap);

  return [
    LinearElementEditor.pointFromAbsoluteCoords(arrow, startPoint, elementsMap),
    LinearElementEditor.pointFromAbsoluteCoords(arrow, endPoint, elementsMap),
  ];
};

/**
 * 运行时校验 fixedPoint 形状：必须是长度 2、两个有限数字的数组。
 *
 * 用 `any` 入参是因为要处理来自持久化/协作的不可信数据；NaN、字符串、
 * 长度不符都会走 normalizeFixedPoint 的兜底分支（中心点）。
 */
export const isFixedPoint = (
  fixedPoint: any,
): fixedPoint is FixedPointBinding["fixedPoint"] => {
  return (
    Array.isArray(fixedPoint) &&
    fixedPoint.length === 2 &&
    fixedPoint.every((coord) => Number.isFinite(coord))
  );
};

// Fixed point ratios should stay close to the 0.0-1.0 range.
const FIXED_POINT_BOUND = 10;

/**
 * fixedPoint 的清洗与兜底。
 *
 * 两条约束：
 * 1. 值域 clamp 到 ±10：正常比例是 0..1，外围绑定允许略微超出（gaps），
 *    但历史/异常数据可能给到几十，会算出极远端点；
 * 2. 恰好 0.5 改成 0.5001：端点正对元素中心时，headingForPoint 的方向判断
 *    在浮点误差下会来回翻，箭头朝向因而抖动。给一个极小偏移即可稳定。
 *
 * 非法输入（非数组、含 NaN）返回中心 [0.5001, 0.5001]，而不是抛错，
 * 保证打开旧文件时不会崩。
 */
export const normalizeFixedPoint = <T extends FixedPoint>(
  fixedPoint: T,
): FixedPoint => {
  if (!isFixedPoint(fixedPoint)) {
    return [0.5001, 0.5001];
  }

  const EPSILON = 0.0001;

  const clamped = fixedPoint.map((ratio) =>
    clamp(ratio, -FIXED_POINT_BOUND, FIXED_POINT_BOUND),
  ) as FixedPoint;

  // Do not allow a precise 0.5 for fixed point ratio
  // to avoid jumping arrow heading due to floating point imprecision
  if (
    Math.abs(clamped[0] - 0.5) < EPSILON ||
    Math.abs(clamped[1] - 0.5) < EPSILON
  ) {
    return clamped.map((ratio) =>
      Math.abs(ratio - 0.5) < EPSILON ? 0.5001 : ratio,
    ) as FixedPoint;
  }

  return clamped;
};

type Side =
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left"
  | "top-left";
type ShapeType = "rectangle" | "ellipse" | "diamond";
/**
 * 把可绑定元素归成三种几何族，供“取侧面中点”使用。
 *
 * 只分 ellipse/diamond，其余一律 rectangle：矩形、圆角矩形、文本容器等
 * 都用矩形状的边中点算法，避免为每种新形状写分支。
 */
const getShapeType = (element: ExcalidrawBindableElement): ShapeType => {
  if (element.type === "ellipse" || element.type === "diamond") {
    return element.type;
  }
  return "rectangle";
};

interface SectorConfig {
  // center angle of the sector in degrees
  centerAngle: number;
  // width of the sector in degrees
  sectorWidth: number;
  side: Side;
}

/**
 * 每种形状的“扇区 → 侧面”映射表，角度以元素中心为原点、度数制。
 *
 * 宽度刻意不对称：矩形把 75° 给四条边、15° 给四个角；菱形/椭圆反过来，
 * 把 15° 给顶点/正方向。原因是菱形与椭圆的顶点曲率变化快，若给宽扇区，
 * 稍微偏离顶点就会被判成“上边/左边”，端点会突然跳边。
 *
 * 表必须覆盖整个 360°（相邻扇区首尾相接），否则 getShapeSideAdaptive 落到
 * 兜底的“最近中心”分支，虽然能用但会失去上面这些几何意图。
 */
// Define sector configurations for different shape types
const SHAPE_CONFIGS: Record<ShapeType, SectorConfig[]> = {
  // rectangle: 15° corners, 75° edges
  rectangle: [
    { centerAngle: 0, sectorWidth: 75, side: "right" },
    { centerAngle: 45, sectorWidth: 15, side: "bottom-right" },
    { centerAngle: 90, sectorWidth: 75, side: "bottom" },
    { centerAngle: 135, sectorWidth: 15, side: "bottom-left" },
    { centerAngle: 180, sectorWidth: 75, side: "left" },
    { centerAngle: 225, sectorWidth: 15, side: "top-left" },
    { centerAngle: 270, sectorWidth: 75, side: "top" },
    { centerAngle: 315, sectorWidth: 15, side: "top-right" },
  ],

  // diamond: 15° vertices, 75° edges
  diamond: [
    { centerAngle: 0, sectorWidth: 15, side: "right" },
    { centerAngle: 45, sectorWidth: 75, side: "bottom-right" },
    { centerAngle: 90, sectorWidth: 15, side: "bottom" },
    { centerAngle: 135, sectorWidth: 75, side: "bottom-left" },
    { centerAngle: 180, sectorWidth: 15, side: "left" },
    { centerAngle: 225, sectorWidth: 75, side: "top-left" },
    { centerAngle: 270, sectorWidth: 15, side: "top" },
    { centerAngle: 315, sectorWidth: 75, side: "top-right" },
  ],

  // ellipse: 15° cardinal points, 75° diagonals
  ellipse: [
    { centerAngle: 0, sectorWidth: 15, side: "right" },
    { centerAngle: 45, sectorWidth: 75, side: "bottom-right" },
    { centerAngle: 90, sectorWidth: 15, side: "bottom" },
    { centerAngle: 135, sectorWidth: 75, side: "bottom-left" },
    { centerAngle: 180, sectorWidth: 15, side: "left" },
    { centerAngle: 225, sectorWidth: 75, side: "top-left" },
    { centerAngle: 270, sectorWidth: 15, side: "top" },
    { centerAngle: 315, sectorWidth: 75, side: "top-right" },
  ],
};

/**
 * 把扇区配置展开成 [start, end] 区间，并把角度归一到 [0,360)。
 *
 * 归一化后会出现 start > end 的“跨 0°”区间，这是调用方必须特殊处理的：
 * 判断条件要从 `start <= a <= end` 改成 `a >= start || a <= end`。
 */
const getSectorBoundaries = (
  config: SectorConfig[],
): Array<{ start: number; end: number; side: Side }> => {
  return config.map((sector, index) => {
    const halfWidth = sector.sectorWidth / 2;
    let start = sector.centerAngle - halfWidth;
    let end = sector.centerAngle + halfWidth;

    // normalize angles to [0, 360) range
    start = ((start % 360) + 360) % 360;
    end = ((end % 360) + 360) % 360;

    return { start, end, side: sector.side };
  });
};

/**
 * 按 fixedPoint 相对中心的方向角，判断它属于哪个侧面/角点。
 *
 * 输入是归一化比例，先减 0.5 转成“以中心为原点”的偏移，再 atan2 得角度。
 * 注意这里用的是比例而非真实宽高，因此对非正方形元素有轻微角度畸变——
 * 只用于选择“哪条边”，后续取中点仍按真实几何，影响可忽略。
 *
 * 两个分支对应跨 0° 与非跨 0° 区间；都不命中时退化为“角度最近的扇区中心”，
 * 保证任何输入都有确定结果。
 */
// determine which side a point falls into using adaptive sectors
const getShapeSideAdaptive = (
  fixedPoint: FixedPoint,
  shapeType: ShapeType,
): Side => {
  const [x, y] = fixedPoint;

  // convert to centered coordinates
  const centerX = x - 0.5;
  const centerY = y - 0.5;

  // calculate angle
  let angle = Math.atan2(centerY, centerX);
  if (angle < 0) {
    angle += 2 * Math.PI;
  }
  const degrees = (angle * 180) / Math.PI;

  // get sector configuration for this shape type
  const config = SHAPE_CONFIGS[shapeType];
  const boundaries = getSectorBoundaries(config);

  // find which sector the angle falls into
  for (const boundary of boundaries) {
    if (boundary.start <= boundary.end) {
      // Normal case: sector doesn't cross 0°
      if (degrees >= boundary.start && degrees <= boundary.end) {
        return boundary.side;
      }
    } else if (degrees >= boundary.start || degrees <= boundary.end) {
      return boundary.side;
    }
  }

  // fallback - find nearest sector center
  let minDiff = Infinity;
  let nearestSide = config[0].side;

  for (const sector of config) {
    let diff = Math.abs(degrees - sector.centerAngle);
    // handle wraparound
    if (diff > 180) {
      diff = 360 - diff;
    }

    if (diff < minDiff) {
      minDiff = diff;
      nearestSide = sector.side;
    }
  }

  return nearestSide;
};

/**
 * 根据绑定固定点求出“该侧面的中点”，供肘形箭头路由吸附使用。
 *
 * 为什么需要：肘形箭头希望从边的中点出入，而不是从任意 fixedPoint 位置。
 * 这里先按 fixedPoint 判定属于哪条边/哪个角，再按形状取几何中点：
 * - 菱形：优先用解析后的边/圆角中点，圆角缺失时用两个顶点求中；
 * - 椭圆：四条正方向用半径端点，四角用 45° 参数点；
 * - 矩形状：用 deconstructRectanguloidElement 得到的边/角点。
 *
 * 计算都在“未旋转”坐标里完成，最后统一 pointRotateRads 回全局。
 * OFFSET=0.01 是为了把点轻轻推出轮廓，避免路由判定落在边界上时归类不稳。
 *
 * @returns null 表示目标不存在、已删除或不可绑定。
 */
export const getBindingSideMidPoint = (
  binding: FixedPointBinding,
  elementsMap: ElementsMap,
) => {
  const bindableElement = elementsMap.get(binding.elementId);
  if (
    !bindableElement ||
    bindableElement.isDeleted ||
    !isBindableElement(bindableElement)
  ) {
    return null;
  }

  const center = elementCenterPoint(bindableElement, elementsMap);
  const shapeType = getShapeType(bindableElement);
  const side = getShapeSideAdaptive(
    normalizeFixedPoint(binding.fixedPoint),
    shapeType,
  );

  // small offset to avoid precision issues in elbow
  const OFFSET = 0.01;

  if (bindableElement.type === "diamond") {
    const [sides, corners] = deconstructDiamondElement(bindableElement);
    const [bottomRight, bottomLeft, topLeft, topRight] = sides;

    let x: number;
    let y: number;
    switch (side) {
      case "left": {
        // left vertex - use the center of the left corner curve
        if (corners.length >= 3) {
          const leftCorner = corners[2];
          const midPoint = leftCorner[1];
          x = midPoint[0] - OFFSET;
          y = midPoint[1];
        } else {
          // fallback for non-rounded diamond
          const midPoint = getMidPoint(bottomLeft[1], topLeft[0]);
          x = midPoint[0] - OFFSET;
          y = midPoint[1];
        }
        break;
      }
      case "right": {
        if (corners.length >= 1) {
          const rightCorner = corners[0];
          const midPoint = rightCorner[1];
          x = midPoint[0] + OFFSET;
          y = midPoint[1];
        } else {
          const midPoint = getMidPoint(topRight[1], bottomRight[0]);
          x = midPoint[0] + OFFSET;
          y = midPoint[1];
        }
        break;
      }
      case "top": {
        if (corners.length >= 4) {
          const topCorner = corners[3];
          const midPoint = topCorner[1];
          x = midPoint[0];
          y = midPoint[1] - OFFSET;
        } else {
          const midPoint = getMidPoint(topLeft[1], topRight[0]);
          x = midPoint[0];
          y = midPoint[1] - OFFSET;
        }
        break;
      }
      case "bottom": {
        if (corners.length >= 2) {
          const bottomCorner = corners[1];
          const midPoint = bottomCorner[1];
          x = midPoint[0];
          y = midPoint[1] + OFFSET;
        } else {
          const midPoint = getMidPoint(bottomRight[1], bottomLeft[0]);
          x = midPoint[0];
          y = midPoint[1] + OFFSET;
        }
        break;
      }
      case "top-right": {
        const midPoint = getMidPoint(topRight[0], topRight[1]);

        x = midPoint[0] + OFFSET * 0.707;
        y = midPoint[1] - OFFSET * 0.707;
        break;
      }
      case "bottom-right": {
        const midPoint = getMidPoint(bottomRight[0], bottomRight[1]);

        x = midPoint[0] + OFFSET * 0.707;
        y = midPoint[1] + OFFSET * 0.707;
        break;
      }
      case "bottom-left": {
        const midPoint = getMidPoint(bottomLeft[0], bottomLeft[1]);
        x = midPoint[0] - OFFSET * 0.707;
        y = midPoint[1] + OFFSET * 0.707;
        break;
      }
      case "top-left": {
        const midPoint = getMidPoint(topLeft[0], topLeft[1]);
        x = midPoint[0] - OFFSET * 0.707;
        y = midPoint[1] - OFFSET * 0.707;
        break;
      }
      default: {
        return null;
      }
    }

    return pointRotateRads(pointFrom(x, y), center, bindableElement.angle);
  }

  if (bindableElement.type === "ellipse") {
    const ellipseCenterX = bindableElement.x + bindableElement.width / 2;
    const ellipseCenterY = bindableElement.y + bindableElement.height / 2;
    const radiusX = bindableElement.width / 2;
    const radiusY = bindableElement.height / 2;

    let x: number;
    let y: number;

    switch (side) {
      case "top": {
        x = ellipseCenterX;
        y = ellipseCenterY - radiusY - OFFSET;
        break;
      }
      case "right": {
        x = ellipseCenterX + radiusX + OFFSET;
        y = ellipseCenterY;
        break;
      }
      case "bottom": {
        x = ellipseCenterX;
        y = ellipseCenterY + radiusY + OFFSET;
        break;
      }
      case "left": {
        x = ellipseCenterX - radiusX - OFFSET;
        y = ellipseCenterY;
        break;
      }
      case "top-right": {
        const angle = -Math.PI / 4;
        const ellipseX = radiusX * Math.cos(angle);
        const ellipseY = radiusY * Math.sin(angle);
        x = ellipseCenterX + ellipseX + OFFSET * 0.707;
        y = ellipseCenterY + ellipseY - OFFSET * 0.707;
        break;
      }
      case "bottom-right": {
        const angle = Math.PI / 4;
        const ellipseX = radiusX * Math.cos(angle);
        const ellipseY = radiusY * Math.sin(angle);
        x = ellipseCenterX + ellipseX + OFFSET * 0.707;
        y = ellipseCenterY + ellipseY + OFFSET * 0.707;
        break;
      }
      case "bottom-left": {
        const angle = (3 * Math.PI) / 4;
        const ellipseX = radiusX * Math.cos(angle);
        const ellipseY = radiusY * Math.sin(angle);
        x = ellipseCenterX + ellipseX - OFFSET * 0.707;
        y = ellipseCenterY + ellipseY + OFFSET * 0.707;
        break;
      }
      case "top-left": {
        const angle = (-3 * Math.PI) / 4;
        const ellipseX = radiusX * Math.cos(angle);
        const ellipseY = radiusY * Math.sin(angle);
        x = ellipseCenterX + ellipseX - OFFSET * 0.707;
        y = ellipseCenterY + ellipseY - OFFSET * 0.707;
        break;
      }
      default: {
        return null;
      }
    }

    return pointRotateRads(pointFrom(x, y), center, bindableElement.angle);
  }

  if (isRectangularElement(bindableElement)) {
    const [sides, corners] = deconstructRectanguloidElement(
      bindableElement as ExcalidrawRectanguloidElement,
    );
    const [top, right, bottom, left] = sides;

    let x: number;
    let y: number;
    switch (side) {
      case "top": {
        const midPoint = getMidPoint(top[0], top[1]);
        x = midPoint[0];
        y = midPoint[1] - OFFSET;
        break;
      }
      case "right": {
        const midPoint = getMidPoint(right[0], right[1]);
        x = midPoint[0] + OFFSET;
        y = midPoint[1];
        break;
      }
      case "bottom": {
        const midPoint = getMidPoint(bottom[0], bottom[1]);
        x = midPoint[0];
        y = midPoint[1] + OFFSET;
        break;
      }
      case "left": {
        const midPoint = getMidPoint(left[0], left[1]);
        x = midPoint[0] - OFFSET;
        y = midPoint[1];
        break;
      }
      case "top-left": {
        if (corners.length >= 1) {
          const corner = corners[0];

          const p1 = corner[0];
          const p2 = corner[3];
          const midPoint = getMidPoint(p1, p2);

          x = midPoint[0] - OFFSET * 0.707;
          y = midPoint[1] - OFFSET * 0.707;
        } else {
          x = bindableElement.x - OFFSET;
          y = bindableElement.y - OFFSET;
        }
        break;
      }
      case "top-right": {
        if (corners.length >= 2) {
          const corner = corners[1];
          const p1 = corner[0];
          const p2 = corner[3];
          const midPoint = getMidPoint(p1, p2);

          x = midPoint[0] + OFFSET * 0.707;
          y = midPoint[1] - OFFSET * 0.707;
        } else {
          x = bindableElement.x + bindableElement.width + OFFSET;
          y = bindableElement.y - OFFSET;
        }
        break;
      }
      case "bottom-right": {
        if (corners.length >= 3) {
          const corner = corners[2];
          const p1 = corner[0];
          const p2 = corner[3];
          const midPoint = getMidPoint(p1, p2);

          x = midPoint[0] + OFFSET * 0.707;
          y = midPoint[1] + OFFSET * 0.707;
        } else {
          x = bindableElement.x + bindableElement.width + OFFSET;
          y = bindableElement.y + bindableElement.height + OFFSET;
        }
        break;
      }
      case "bottom-left": {
        if (corners.length >= 4) {
          const corner = corners[3];
          const p1 = corner[0];
          const p2 = corner[3];
          const midPoint = getMidPoint(p1, p2);

          x = midPoint[0] - OFFSET * 0.707;
          y = midPoint[1] + OFFSET * 0.707;
        } else {
          x = bindableElement.x - OFFSET;
          y = bindableElement.y + bindableElement.height + OFFSET;
        }
        break;
      }
      default: {
        return null;
      }
    }

    return pointRotateRads(pointFrom(x, y), center, bindableElement.angle);
  }

  return null;
};

/** 两点的算术中点；不处理旋转，调用方负责坐标系一致。 */
const getMidPoint = (p1: GlobalPoint, p2: GlobalPoint): GlobalPoint => {
  return pointFrom((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2);
};

/**
 * Binds an arrow endpoint to an explicit fixed point on a bindable element,
 * bypassing the "derive the ratio from where the endpoint currently is"
 * strategy used when dragging. Needed when the binding target is placed to fit
 * the arrow rather than the other way round.
 */
/**
 * 直接把箭头端点绑定到“已知的”固定点，而不从端点位置反推比例。
 *
 * 适用场景：先有箭头、后有目标元素；目标元素是按箭头位置摆好的（例如给箭头
 * 端点创建文本标签），此时用固定点比用端点反推更精确，且不受 gap 影响。
 *
 * 模式固定为 orbit：调用方给的是轮廓上的点，inside 会破坏“贴边”语义。
 * 写入仍走 applyBinding，因此双向引用与幂等性都得到保证。
 *
 * 调用点：App.arrowText.ts 创建端点文本时。
 */
export const bindBindingElementToFixedPoint = (
  arrow: NonDeleted<ExcalidrawArrowElement>,
  bindableElement: NonDeleted<ExcalidrawBindableElement>,
  startOrEnd: "start" | "end",
  fixedPoint: FixedPoint,
  scene: Scene,
): void => {
  applyBinding(
    arrow,
    bindableElement,
    {
      elementId: bindableElement.id,
      fixedPoint: normalizeFixedPoint(fixedPoint),
      mode: "orbit",
    },
    startOrEnd,
    scene,
  );
};
