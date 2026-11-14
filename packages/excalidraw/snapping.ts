import {
  pointFrom,
  pointRotateRads,
  rangeInclusive,
  rangeIntersection,
  rangesOverlap,
  type GlobalPoint,
} from "@excalidraw/math";

import { TOOL_TYPE, KEYS } from "@excalidraw/common";
import {
  getCommonBounds,
  getDraggedElementsBounds,
  getElementAbsoluteCoords,
} from "@excalidraw/element";
import { isBoundToContainer } from "@excalidraw/element";

import { getMaximumGroups } from "@excalidraw/element";

import {
  getSelectedElements,
  getVisibleAndNonSelectedElements,
} from "@excalidraw/element";

import type { InclusiveRange } from "@excalidraw/math";

import type { Bounds } from "@excalidraw/common";
import type { MaybeTransformHandleType } from "@excalidraw/element";
import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import type {
  AppClassProperties,
  AppState,
  KeyboardModifiersObject,
} from "./types";

/**
 * 吸附系统。
 *
 * 两类吸附：
 * - point snap：元素的边/角/中点与参照元素的对齐点重合；
 * - gap snap：拖拽元素与参照元素之间的“间距”等于场景里已有间距。
 * 两者都只影响“显示位置”（返回 snapOffset 与 snapLines），不直接写元素；
 * 由 App 在 pointermove 里把 offset 合进拖拽位移。
 *
 * 坐标系是 GlobalPoint（场景坐标，不含 scroll/zoom）。阈值
 * `SNAP_DISTANCE / zoom` 会随缩放变化，保证屏幕上始终是 8px 的手感。
 *
 * SnapCache 是跨帧缓存：参照点集合与可见间距在一次手势内不变，缓存起来
 * 避免每帧 O(n²) 重算。destroy 必须在手势结束/场景切换时调用。
 */

const SNAP_DISTANCE = 8;

// do not comput more gaps per axis than this limit
// TODO increase or remove once we optimize
const VISIBLE_GAPS_LIMIT_PER_AXIS = 99999;

// snap distance with zoom value taken into consideration
/**
 * 吸附距离（场景单位）。
 *
 * 设计稿定义的是“屏幕上 8px”，所以必须除以 zoom 得到场景距离：放大后
 * 场景单位变小，同样的 8px 对应更小的位移，手感才能保持一致。
 * 被所有 snap* 入口用作 minOffset 初值，也是缩放/拖拽两遍计算的阈值来源。
 */
export const getSnapDistance = (zoomValue: number) => {
  return SNAP_DISTANCE / zoomValue;
};

type Vector2D = {
  x: number;
  y: number;
};

type PointPair = [GlobalPoint, GlobalPoint];

/**
 * 一次 point snap 的结果。
 *
 * points 是 [被拖拽方参考点, 参照元素对齐点]，两者在同一轴上的差值即
 * offset（场景单位）。offset 的正负表示需要往哪个方向移动被拖拽元素。
 * 同一轴可能收集到多个候选，调用方只取数组第一个（最近的）。
 */
export type PointSnap = {
  type: "point";
  points: PointPair;
  offset: number;
};

/**
 * 一段“可见间距”：两个参照元素之间横向或纵向的空白。
 *
 * startSide / endSide 是间距两侧的线段端点（用于画参考线），overlap 是
 * 两元素在垂直方向（或水平方向）上的重叠区间，length 是间距长度。
 * 只有 start 在左/上、end 在右/下且投影有重叠时才会生成，保证间距在
 * 视觉上“看起来是连通的”。
 */
export type Gap = {
  //  start side ↓     length
  // ┌───────────┐◄───────────────►
  // │           │-----------------┌───────────┐
  // │  start    │       ↑         │           │
  // │  element  │    overlap      │  end      │
  // │           │       ↓         │  element  │
  // └───────────┘-----------------│           │
  //                               └───────────┘
  //                               ↑ end side
  startBounds: Bounds;
  endBounds: Bounds;
  startSide: [GlobalPoint, GlobalPoint];
  endSide: [GlobalPoint, GlobalPoint];
  overlap: InclusiveRange;
  length: number;
};

/**
 * 一次 gap snap 的结果。
 *
 * direction 描述“被拖拽元素相对该间距的位置”：
 *   - center_*：元素中心落在间距中线上（间距必须比元素更大）；
 *   - side_left / side_right / side_top / side_bottom：元素与该间距的
 *     某一侧保持相同间距。
 * offset 是使该关系成立所需的位移，直接加到拖拽位移上。
 */
export type GapSnap = {
  type: "gap";
  direction:
    | "center_horizontal"
    | "center_vertical"
    | "side_left"
    | "side_right"
    | "side_top"
    | "side_bottom";
  gap: Gap;
  offset: number;
};

export type GapSnaps = GapSnap[];

/**
 * 吸附结果的联合类型：调用方只关心 offset 与 type，具体形态用于生成参考线。
 * 使用可辨识联合（type 字段）而不是可选字段，便于在过滤时收窄类型。
 */
export type Snap = GapSnap | PointSnap;
export type Snaps = Snap[];

/**
 * 吸附参考线的三种形态：
 *   - points：一条贯穿多个对齐点的直线（point snap 产生）；
 *   - pointer：从指针指向某个元素角的短线段（新建元素时的辅助线）；
 *   - gap：两段等长线，表示“这里应该保持同样的间距”（gap snap 产生）。
 * 最终由 renderSnaps 按场景坐标绘制，因此全部使用 GlobalPoint。
 */
export type PointSnapLine = {
  type: "points";
  points: GlobalPoint[];
};

export type PointerSnapLine = {
  type: "pointer";
  points: PointPair;
  direction: "horizontal" | "vertical";
};

export type GapSnapLine = {
  type: "gap";
  direction: "horizontal" | "vertical";
  points: PointPair;
};

export type SnapLine = PointSnapLine | GapSnapLine | PointerSnapLine;

// -----------------------------------------------------------------------------

/**
 * 手势级缓存。放在静态字段而不是 App 实例上，是因为吸附函数是纯函数、
 * 被多个入口共用；生命周期由显式的 set/destroy 控制，不依赖 React。
 */
export class SnapCache {
  private static referenceSnapPoints: GlobalPoint[] | null = null;

  private static visibleGaps: {
    verticalGaps: Gap[];
    horizontalGaps: Gap[];
  } | null = null;

  /**
   * 写入本次手势的参照对齐点集合。
   * 传 null 表示显式失效（场景变化后必须重算），而不是“空集合”。
   */
  public static setReferenceSnapPoints = (snapPoints: GlobalPoint[] | null) => {
    SnapCache.referenceSnapPoints = snapPoints;
  };

  public static getReferenceSnapPoints = () => {
    return SnapCache.referenceSnapPoints;
  };

  /**
   * 写入本次手势的可见间距。
   * 与参照点一样，null 表示“需要重算”，避免把“没有间距”与“尚未计算”
   * 混为一谈。
   */
  public static setVisibleGaps = (
    gaps: {
      verticalGaps: Gap[];
      horizontalGaps: Gap[];
    } | null,
  ) => {
    SnapCache.visibleGaps = gaps;
  };

  public static getVisibleGaps = () => {
    return SnapCache.visibleGaps;
  };

  /**
   * 清空缓存。
   *
   * 必须在手势结束、场景切换或元素集合变化时调用（App 在卸载/重置路径里
   * 调用），否则下一次手势会读到上一个场景的参照点，表现为“吸附到不存在的
   * 位置”。缓存是静态的，泄漏不会报错，只会造成难以复现的错位。
   */
  public static destroy = () => {
    SnapCache.referenceSnapPoints = null;
    SnapCache.visibleGaps = null;
  };
}

// -----------------------------------------------------------------------------

/**
 * 判断网格吸附是否开启。
 *
 * 优先读嵌入方传入的 props.gridModeEnabled（允许宿主强制覆盖），否则回落到
 * 内部 appState。这个优先级在 isSnappingEnabled 里也用于“网格模式下不启用
 * 对象吸附”的判断，两处必须保持一致。
 */
export const isGridModeEnabled = (app: AppClassProperties): boolean =>
  app.props.gridModeEnabled ?? app.state.gridModeEnabled;

/**
 * 判断当前是否应启用对象吸附（point / gap snap）。
 *
 * 两个入口语义不同：
 *   1. 有 event（pointermove 等实时事件）时，修饰键决定“临时反转”：
 *      - 默认开启对象吸附（objectsSnapModeEnabled）时，按住 Ctrl/Cmd 临时关闭；
 *      - 默认关闭时，按住 Ctrl/Cmd 临时开启，但网格模式除外（网格优先）。
 *      套索工具只有“已在拖拽选中元素”时才算移动，框选阶段不吸附。
 *   2. 无 event（如初始化/键盘路径）时，只按偏好判断；单选箭头不吸附，
 *      把机会让给绑定（绑定与吸附的交互语义冲突，同时出现会抢目标）。
 *
 * @returns true 表示本次移动应计算吸附
 */
export const isSnappingEnabled = ({
  event,
  app,
  selectedElements,
}: {
  app: AppClassProperties;
  event: KeyboardModifiersObject;
  selectedElements: readonly NonDeletedExcalidrawElement[];
}) => {
  if (event) {
    // Allow snapping for lasso tool when dragging selected elements
    // but not during lasso selection phase
    // 套索工具的两种阶段必须区分：框选阶段（未拖拽选中元素）不吸附，
    // 否则套索本身的轨迹会被吸到元素上；拖动已选元素时才按普通移动处理。
    const isLassoDragging =
      app.state.activeTool.type === "lasso" &&
      app.state.selectedElementsAreBeingDragged;

    return (
      (app.state.activeTool.type !== "lasso" || isLassoDragging) &&
      ((app.state.objectsSnapModeEnabled && !event[KEYS.CTRL_OR_CMD]) ||
        (!app.state.objectsSnapModeEnabled &&
          event[KEYS.CTRL_OR_CMD] &&
          !isGridModeEnabled(app)))
    );
  }

  // do not suggest snaps for an arrow to give way to binding
  if (selectedElements.length === 1 && selectedElements[0].type === "arrow") {
    return false;
  }
  return app.state.objectsSnapModeEnabled;
};

/**
 * 浮点近似相等判断，默认容差 0.01。
 *
 * 用于缩放吸附里判断元素角度是否近似为 0：角度经过旋转矩阵反复计算后
 * 不会精确为 0，直接用 === 0 会把几乎所有旋转元素误判为“已旋转”。
 */
export const areRoughlyEqual = (a: number, b: number, precision = 0.01) => {
  return Math.abs(a - b) <= precision;
};

/**
 * 计算“参与吸附的参考点”列表（场景坐标）。
 *
 * 规则随元素数量分两类：
 *   - 单个元素：用 getElementAbsoluteCoords 取旋转后的外接矩形，再按元素角度
 *     把 4 个角（菱形/椭圆则用 4 个边中点）旋转到真实位置。diamond 与 ellipse
 *     在视觉上没有“角”，用边中点更符合用户直觉；boundingBoxCorners 为 true
 *     时强制使用包围盒角（新建元素时用）。
 *   - 多个元素：用 getDraggedElementsBounds 求整体包围盒，只取 4 角 + 中心，
 *     不再考虑个体旋转（多选时整体按轴对齐处理）。
 * 所有坐标四舍五入到 6 位小数：吸附是像素级操作，浮点尾差会让“看似对齐”的
 * 两点算不出 0 偏移，参考线随之抖动。
 *
 * @param omitCenter 省略中心点（中心点会使参考线数量明显增加）
 * @param boundingBoxCorners 单元素时强制使用包围盒角点
 * @param dragOffset 附加到元素当前位置上的位移，未传表示不偏移
 */
export const getElementsCorners = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  {
    omitCenter,
    boundingBoxCorners,
    dragOffset,
  }: {
    omitCenter?: boolean;
    boundingBoxCorners?: boolean;
    dragOffset?: Vector2D;
  } = {
    omitCenter: false,
    boundingBoxCorners: false,
  },
): GlobalPoint[] => {
  let result: GlobalPoint[] = [];

  if (elements.length === 1) {
    const element = elements[0];

    let [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(
      element,
      elementsMap,
    );

    // 拖拽位移必须先叠加到包围盒再取角：否则会用元素“原位”的角去吸附，
    // 参考线与元素实际落点错开。
    if (dragOffset) {
      x1 += dragOffset.x;
      x2 += dragOffset.x;
      cx += dragOffset.x;

      y1 += dragOffset.y;
      y2 += dragOffset.y;
      cy += dragOffset.y;
    }

    const halfWidth = (x2 - x1) / 2;
    const halfHeight = (y2 - y1) / 2;

    if (
      (element.type === "diamond" || element.type === "ellipse") &&
      !boundingBoxCorners
    ) {
      // 菱形/椭圆的“角”在视觉上并不存在，用四条边的中点作为吸附参照，
      // 再把每个中点绕包围盒中心旋转到元素真实角度。
      const leftMid = pointRotateRads<GlobalPoint>(
        pointFrom(x1, y1 + halfHeight),
        pointFrom(cx, cy),
        element.angle,
      );
      const topMid = pointRotateRads<GlobalPoint>(
        pointFrom(x1 + halfWidth, y1),
        pointFrom(cx, cy),
        element.angle,
      );
      const rightMid = pointRotateRads<GlobalPoint>(
        pointFrom(x2, y1 + halfHeight),
        pointFrom(cx, cy),
        element.angle,
      );
      const bottomMid = pointRotateRads<GlobalPoint>(
        pointFrom(x1 + halfWidth, y2),
        pointFrom(cx, cy),
        element.angle,
      );
      const center = pointFrom<GlobalPoint>(cx, cy);

      result = omitCenter
        ? [leftMid, topMid, rightMid, bottomMid]
        : [leftMid, topMid, rightMid, bottomMid, center];
    } else {
      const topLeft = pointRotateRads<GlobalPoint>(
        pointFrom(x1, y1),
        pointFrom(cx, cy),
        element.angle,
      );
      const topRight = pointRotateRads<GlobalPoint>(
        pointFrom(x2, y1),
        pointFrom(cx, cy),
        element.angle,
      );
      const bottomLeft = pointRotateRads<GlobalPoint>(
        pointFrom(x1, y2),
        pointFrom(cx, cy),
        element.angle,
      );
      const bottomRight = pointRotateRads<GlobalPoint>(
        pointFrom(x2, y2),
        pointFrom(cx, cy),
        element.angle,
      );
      const center = pointFrom<GlobalPoint>(cx, cy);

      result = omitCenter
        ? [topLeft, topRight, bottomLeft, bottomRight]
        : [topLeft, topRight, bottomLeft, bottomRight, center];
    }
  } else if (elements.length > 1) {
    // 多选时统一用“整体包围盒”，不再展开单个元素的旋转角点：
    // 多选拖拽的语义就是整体位移，轴对齐的框更符合预期。
    const [minX, minY, maxX, maxY] = getDraggedElementsBounds(
      elements,
      dragOffset ?? { x: 0, y: 0 },
    );
    const width = maxX - minX;
    const height = maxY - minY;

    const topLeft = pointFrom<GlobalPoint>(minX, minY);
    const topRight = pointFrom<GlobalPoint>(maxX, minY);
    const bottomLeft = pointFrom<GlobalPoint>(minX, maxY);
    const bottomRight = pointFrom<GlobalPoint>(maxX, maxY);
    const center = pointFrom<GlobalPoint>(minX + width / 2, minY + height / 2);

    result = omitCenter
      ? [topLeft, topRight, bottomLeft, bottomRight]
      : [topLeft, topRight, bottomLeft, bottomRight, center];
  }

  return result.map((p) => pointFrom(round(p[0]), round(p[1])));
};

/**
 * 取“参照元素”：可见且未被选中的元素。
 *
 * 被选中的元素正在移动，不能作为自己的吸附目标；不可见元素（被折叠 frame
 * 隐藏、被视口裁剪）也不参与，否则会吸附到用户看不见的位置。
 */
const getReferenceElements = (
  elements: readonly NonDeletedExcalidrawElement[],
  selectedElements: readonly ExcalidrawElement[],
  appState: AppState,
  elementsMap: ElementsMap,
) =>
  getVisibleAndNonSelectedElements(
    elements,
    selectedElements,
    appState,
    elementsMap,
  );

/**
 * 预计算场景中所有“可见间距”（一次手势内复用）。
 *
 * 步骤：
 *   1. 参照元素按最大组（getMaximumGroups）合并成块，并过滤掉绑在容器上的
 *      子元素——它们的位置由容器决定，单独计算会产生无意义间距；
 *   2. 每个块取公共包围盒并四舍五入，得到矩形列表；
 *   3. 按左边界排序后两两配对：只有 startMaxX < endMinX（不重叠）且 Y 轴投影
 *      有交集，才构成水平间距；垂直方向同理。
 *
 * 复杂度 O(n²)，但有 VISIBLE_GAPS_LIMIT_PER_AXIS 兜底，且结果通过 SnapCache
 * 在手势期间复用，不会每帧重算。
 *
 * @returns 水平/垂直两组间距，坐标为场景坐标
 */
export const getVisibleGaps = (
  elements: readonly NonDeletedExcalidrawElement[],
  selectedElements: readonly NonDeletedExcalidrawElement[],
  appState: AppState,
  elementsMap: ElementsMap,
) => {
  // 参照元素与 getReferenceSnapPoints / getVisibleGaps 用的是同一套过滤逻辑，
  // 三处必须一致，否则“能吸附到”的位置与“画出参考线”的位置会对不上。
  const referenceElements: ExcalidrawElement[] = getReferenceElements(
    elements,
    selectedElements,
    appState,
    elementsMap,
  );

  // 组归一化：一个组只贡献一个包围盒，避免组内元素之间互相产生间距。
  // 绑在容器上的文本被排除，否则它会与容器自身形成一个“0 宽”的假间距。
  const referenceBounds = getMaximumGroups(referenceElements, elementsMap)
    .filter(
      (elementsGroup) =>
        !(elementsGroup.length === 1 && isBoundToContainer(elementsGroup[0])),
    )
    .map(
      (group) =>
        getCommonBounds(group).map((bound) =>
          round(bound),
        ) as unknown as Bounds,
    );

  // 水平间距的成立条件：两个块在 X 上分离（start 的右边 < end 的左边），
  // 且在 Y 上有投影交集；否则视觉上是“斜对着”，不构成可感知的间距。
  const horizontallySorted = referenceBounds.sort((a, b) => a[0] - b[0]);

  const horizontalGaps: Gap[] = [];

  let c = 0;

  // 按左边界升序后只需向后配对：若 start 的右边界已经越过后面的元素，
  // 那么后续元素也不可能与 start 形成“分离的间距”，内层循环可提前结束。
  // 用 c 计数兜底极端场景（大量重叠元素会退化成 O(n²)）。
  horizontal: for (let i = 0; i < horizontallySorted.length; i++) {
    const startBounds = horizontallySorted[i];

    for (let j = i + 1; j < horizontallySorted.length; j++) {
      if (++c > VISIBLE_GAPS_LIMIT_PER_AXIS) {
        break horizontal;
      }

      const endBounds = horizontallySorted[j];

      const [, startMinY, startMaxX, startMaxY] = startBounds;
      const [endMinX, endMinY, , endMaxY] = endBounds;

      // 只有“完全分离且投影相交”才算一个间距；相交或错开的块属于包含/
      // 斜对角关系，拿来做等距复制会产生误导。
      if (
        startMaxX < endMinX &&
        rangesOverlap(
          rangeInclusive(startMinY, startMaxY),
          rangeInclusive(endMinY, endMaxY),
        )
      ) {
        horizontalGaps.push({
          startBounds,
          endBounds,
          startSide: [
            pointFrom(startMaxX, startMinY),
            pointFrom(startMaxX, startMaxY),
          ],
          endSide: [pointFrom(endMinX, endMinY), pointFrom(endMinX, endMaxY)],
          length: endMinX - startMaxX,
          overlap: rangeIntersection(
            rangeInclusive(startMinY, startMaxY),
            rangeInclusive(endMinY, endMaxY),
          )!,
        });
      }
    }
  }

  // 垂直方向同理；注意复用同一个 referenceBounds 数组，sort 会就地修改，
  // 但水平方向已经消费完毕，因此不影响结果。
  const verticallySorted = referenceBounds.sort((a, b) => a[1] - b[1]);

  const verticalGaps: Gap[] = [];

  c = 0;

  vertical: for (let i = 0; i < verticallySorted.length; i++) {
    const startBounds = verticallySorted[i];

    for (let j = i + 1; j < verticallySorted.length; j++) {
      if (++c > VISIBLE_GAPS_LIMIT_PER_AXIS) {
        break vertical;
      }
      const endBounds = verticallySorted[j];

      const [startMinX, , startMaxX, startMaxY] = startBounds;
      const [endMinX, endMinY, endMaxX] = endBounds;

      // 垂直方向与水平方向同构：X 轴投影重叠 + Y 轴分离，才构成上下间距。
      if (
        startMaxY < endMinY &&
        rangesOverlap(
          rangeInclusive(startMinX, startMaxX),
          rangeInclusive(endMinX, endMaxX),
        )
      ) {
        verticalGaps.push({
          startBounds,
          endBounds,
          startSide: [
            pointFrom(startMinX, startMaxY),
            pointFrom(startMaxX, startMaxY),
          ],
          endSide: [pointFrom(endMinX, endMinY), pointFrom(endMaxX, endMinY)],
          length: endMinY - startMaxY,
          overlap: rangeIntersection(
            rangeInclusive(startMinX, startMaxX),
            rangeInclusive(endMinX, endMaxX),
          )!,
        });
      }
    }
  }

  // 返回两组间距而不做合并：调用方按方向分别匹配，水平间距只参与 X 轴
  // 计算，垂直间距只参与 Y 轴，混在一起会引入跨轴的错误候选。
  return {
    horizontalGaps,
    verticalGaps,
  };
};

/**
 * 收集 gap snap 候选，写入 nearestSnapsX / nearestSnapsY。
 *
 * 每个间距最多尝试三种关系（中心、从右/左贴边、从上/下贴边），且同一轴内
 * 一旦中心关系成立就 continue，不再叠加 side 关系，避免同一间距产生互相
 * 矛盾的偏移。
 *
 * minOffset 通过引用传入并就地更新，语义是“当前已知的最小位移”：
 *   - 更小的位移先清空该轴数组再 push（最终只保留最优解）；
 *   - 相等的位移追加（对称位置同时成立时，参考线需要全部画出）。
 * 因此调用方必须先把 minOffset 初始化为 getSnapDistance(zoom)。
 *
 * 只在 SnapCache 已有 visibleGaps 时工作：缓存缺失说明本次手势尚未预计算，
 * 直接跳过而不是就地计算，避免拖拽首帧卡顿。
 */
const getGapSnaps = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  dragOffset: Vector2D,
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  nearestSnapsX: Snaps,
  nearestSnapsY: Snaps,
  minOffset: Vector2D,
) => {
  if (!isSnappingEnabled({ app, event, selectedElements })) {
    return [];
  }

  if (selectedElements.length === 0) {
    // 没有选中元素就没有“被拖拽方”，gap 关系无从定义；这里与 point snap
    // 的判空保持一致，避免调用方传空数组时白跑一遍 O(n²)。
    return [];
  }

  const visibleGaps = SnapCache.getVisibleGaps();

  if (visibleGaps) {
    // 被拖拽元素的包围盒（含位移）同样要取整，才能与预计算时取整过的
    // 间距端点做精确比较，否则会产生 1e-6 级的假候选。
    const { horizontalGaps, verticalGaps } = visibleGaps;

    const [minX, minY, maxX, maxY] = getDraggedElementsBounds(
      selectedElements,
      dragOffset,
    ).map((bound) => round(bound));
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // 每个 gap 的 overlap 与元素在垂直方向必须有交集，否则“等距”只发生
    // 在错开的位置上，线也画不到元素附近。
    for (const gap of horizontalGaps) {
      if (!rangesOverlap(rangeInclusive(minY, maxY), gap.overlap)) {
        continue;
      }

      // center gap
      // 居中吸附要求间距比元素本身更宽，否则元素中心落在间距中线上时，
      // 两侧必然溢出，视觉上不是“放进间距里”。
      const gapMidX = gap.startSide[0][0] + gap.length / 2;
      const centerOffset = round(gapMidX - centerX);
      const gapIsLargerThanSelection = gap.length > maxX - minX;

      if (gapIsLargerThanSelection && Math.abs(centerOffset) <= minOffset.x) {
        if (Math.abs(centerOffset) < minOffset.x) {
          nearestSnapsX.length = 0;
        }
        minOffset.x = Math.abs(centerOffset);

        const snap: GapSnap = {
          type: "gap",
          direction: "center_horizontal",
          gap,
          offset: centerOffset,
        };

        nearestSnapsX.push(snap);
        continue;
      }

      // side gap, from the right
      // “元素左边距 = 间距长度”：吸附后元素会贴在 end 元素右侧，与 start
      // 元素保持与该间距相同的距离。
      const [, , endMaxX] = gap.endBounds;
      const distanceToEndElementX = minX - endMaxX;
      const sideOffsetRight = round(gap.length - distanceToEndElementX);

      if (Math.abs(sideOffsetRight) <= minOffset.x) {
        if (Math.abs(sideOffsetRight) < minOffset.x) {
          nearestSnapsX.length = 0;
        }
        minOffset.x = Math.abs(sideOffsetRight);

        const snap: GapSnap = {
          type: "gap",
          direction: "side_right",
          gap,
          offset: sideOffsetRight,
        };
        nearestSnapsX.push(snap);
        continue;
      }

      // side gap, from the left
      const [startMinX, , ,] = gap.startBounds;
      const distanceToStartElementX = startMinX - maxX;
      const sideOffsetLeft = round(distanceToStartElementX - gap.length);

      if (Math.abs(sideOffsetLeft) <= minOffset.x) {
        if (Math.abs(sideOffsetLeft) < minOffset.x) {
          nearestSnapsX.length = 0;
        }
        minOffset.x = Math.abs(sideOffsetLeft);

        const snap: GapSnap = {
          type: "gap",
          direction: "side_left",
          gap,
          offset: sideOffsetLeft,
        };
        nearestSnapsX.push(snap);
        continue;
      }
    }
    // 垂直间距的三种关系与水平方向镜像：center_vertical 要求间距高于元素，
    // side_top / side_bottom 分别把元素放到间距下方 / 上方并保持等距。
    for (const gap of verticalGaps) {
      if (!rangesOverlap(rangeInclusive(minX, maxX), gap.overlap)) {
        continue;
      }

      // center gap
      const gapMidY = gap.startSide[0][1] + gap.length / 2;
      const centerOffset = round(gapMidY - centerY);
      const gapIsLargerThanSelection = gap.length > maxY - minY;

      if (gapIsLargerThanSelection && Math.abs(centerOffset) <= minOffset.y) {
        if (Math.abs(centerOffset) < minOffset.y) {
          nearestSnapsY.length = 0;
        }
        minOffset.y = Math.abs(centerOffset);

        const snap: GapSnap = {
          type: "gap",
          direction: "center_vertical",
          gap,
          offset: centerOffset,
        };

        nearestSnapsY.push(snap);
        continue;
      }

      // side gap, from the top
      const [, startMinY, ,] = gap.startBounds;
      const distanceToStartElementY = startMinY - maxY;
      const sideOffsetTop = round(distanceToStartElementY - gap.length);

      if (Math.abs(sideOffsetTop) <= minOffset.y) {
        if (Math.abs(sideOffsetTop) < minOffset.y) {
          nearestSnapsY.length = 0;
        }
        minOffset.y = Math.abs(sideOffsetTop);

        const snap: GapSnap = {
          type: "gap",
          direction: "side_top",
          gap,
          offset: sideOffsetTop,
        };
        nearestSnapsY.push(snap);
        continue;
      }

      // side gap, from the bottom
      const [, , , endMaxY] = gap.endBounds;
      const distanceToEndElementY = round(minY - endMaxY);
      const sideOffsetBottom = gap.length - distanceToEndElementY;

      if (Math.abs(sideOffsetBottom) <= minOffset.y) {
        if (Math.abs(sideOffsetBottom) < minOffset.y) {
          nearestSnapsY.length = 0;
        }
        minOffset.y = Math.abs(sideOffsetBottom);

        const snap: GapSnap = {
          type: "gap",
          direction: "side_bottom",
          gap,
          offset: sideOffsetBottom,
        };
        nearestSnapsY.push(snap);
        continue;
      }
    }
  }
};

/**
 * 预计算参照元素的对齐点集合，供 SnapCache 缓存。
 *
 * 与 getVisibleGaps 相同的组归一化策略：按最大组合并、排除容器内文本，再对
 * 每个组调用 getElementsCorners（默认包含中心点）。用组的公共包围盒取角点，
 * 比逐个元素取角更符合“整体对齐”的直觉，也显著减少候选数量。
 *
 * @returns GlobalPoint[]，场景坐标；由调用方写入 SnapCache
 */
export const getReferenceSnapPoints = (
  elements: readonly NonDeletedExcalidrawElement[],
  selectedElements: readonly NonDeletedExcalidrawElement[],
  appState: AppState,
  elementsMap: ElementsMap,
) => {
  const referenceElements = getReferenceElements(
    elements,
    selectedElements,
    appState,
    elementsMap,
  );
  return getMaximumGroups(referenceElements, elementsMap)
    .filter(
      (elementsGroup) =>
        !(elementsGroup.length === 1 && isBoundToContainer(elementsGroup[0])),
    )
    .flatMap((elementGroup) => getElementsCorners(elementGroup, elementsMap));
};

/**
 * 收集 point snap 候选：把被拖拽方的参考点与所有参照点两两比较。
 *
 * 对每个点对分别计算 X/Y 位移，只要绝对值不超过当前 minOffset 就视为候选。
 * 与 gap snap 共用 minOffset 引用：更小的位移会清空该轴已有候选，相等的
 * 位移保留（对称对齐时需要画出多条参考线）。
 *
 * 跳过条件：吸附未开启，或既没有选中元素也没有提供参考点。
 * selectedElements 只用于 isSnappingEnabled 的箭头/套索判断；真正的“被拖拽
 * 点”由 selectionSnapPoints 传入——缩放与新建场景传入的点集与选中元素不同。
 */
const getPointSnaps = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  selectionSnapPoints: GlobalPoint[],
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  nearestSnapsX: Snaps,
  nearestSnapsY: Snaps,
  minOffset: Vector2D,
) => {
  if (
    !isSnappingEnabled({ app, event, selectedElements }) ||
    (selectedElements.length === 0 && selectionSnapPoints.length === 0)
  ) {
    return [];
  }

  const referenceSnapPoints = SnapCache.getReferenceSnapPoints();

  if (referenceSnapPoints) {
    for (const thisSnapPoint of selectionSnapPoints) {
      for (const otherSnapPoint of referenceSnapPoints) {
        const offsetX = otherSnapPoint[0] - thisSnapPoint[0];
        const offsetY = otherSnapPoint[1] - thisSnapPoint[1];

        if (Math.abs(offsetX) <= minOffset.x) {
          if (Math.abs(offsetX) < minOffset.x) {
            nearestSnapsX.length = 0;
          }

          nearestSnapsX.push({
            type: "point",
            points: [thisSnapPoint, otherSnapPoint],
            offset: offsetX,
          });

          minOffset.x = Math.abs(offsetX);
        }

        if (Math.abs(offsetY) <= minOffset.y) {
          if (Math.abs(offsetY) < minOffset.y) {
            nearestSnapsY.length = 0;
          }

          nearestSnapsY.push({
            type: "point",
            points: [thisSnapPoint, otherSnapPoint],
            offset: offsetY,
          });

          minOffset.y = Math.abs(offsetY);
        }
      }
    }
  }
};

/**
 * 拖拽吸附主流程（两遍计算）。
 *
 * 第一遍：用“未吸附的拖拽位置”找最近的 point/gap snap，得到 snapOffset。
 * 第二遍：把 snapOffset 合进拖拽位置后重新找 snap，此时偏移量应为 0，
 *         目的不是再吸附，而是生成“画在正确位置”的吸附参考线。
 * 如果只做一遍，参考线会画在吸附前的旧位置上，视觉上会跳一下。
 *
 * 返回的 snapOffset 是场景单位位移，调用方负责加到元素坐标上。
 */
export const snapDraggedElements = (
  elements: ExcalidrawElement[],
  dragOffset: Vector2D,
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  elementsMap: ElementsMap,
) => {
  const appState = app.state;
  // 从完整元素表里现场解析选中元素：调用方传入的 elements 可能包含刚更新
  // 的拖拽结果，直接用 appState.selectedElementIds 查表能拿到最新版本。
  const selectedElements = getSelectedElements(elements, appState);
  if (
    !isSnappingEnabled({ app, event, selectedElements }) ||
    selectedElements.length === 0
  ) {
    return {
      snapOffset: {
        x: 0,
        y: 0,
      },
      snapLines: [],
    };
  }
  // 位移先取整：画布是像素栅格，亚像素位移会让元素边缘发虚，也让下面
  // 两遍计算的“0 偏移”永远差一点点，参考线无法稳定命中。
  dragOffset.x = round(dragOffset.x);
  dragOffset.y = round(dragOffset.y);
  // 两个轴的候选与阈值完全独立：横向吸附不影响纵向，因此可以同时各取一个
  // 最优解（表现为元素贴住两条参考线的交点）。
  const nearestSnapsX: Snaps = [];
  const nearestSnapsY: Snaps = [];
  const snapDistance = getSnapDistance(appState.zoom.value);
  const minOffset = {
    x: snapDistance,
    y: snapDistance,
  };

  // 第一遍：用未吸附的位置求 offset。minOffset 初值为屏幕 8px 对应的场景
  // 距离，两个轴独立竞争，最终各取一个最近候选。
  const selectionPoints = getElementsCorners(selectedElements, elementsMap, {
    dragOffset,
  });

  // get the nearest horizontal and vertical point and gap snaps
  getPointSnaps(
    selectedElements,
    selectionPoints,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  getGapSnaps(
    selectedElements,
    dragOffset,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  // using the nearest snaps to figure out how
  // much the elements need to be offset to be snapped
  // to some reference elements
  // 每轴取第一个候选：数组内是“同样最近”的多个解，取第一个即可；只有该轴
  // 完全没有候选时才退化为 0（不做吸附）。
  const snapOffset = {
    x: nearestSnapsX[0]?.offset ?? 0,
    y: nearestSnapsY[0]?.offset ?? 0,
  };

  // once the elements are snapped
  // and moved to the snapped position
  // we want to use the element's snapped position
  // to update nearest snaps so that we can create
  // point and gap snap lines correctly without any shifting

  // 第二遍前必须把阈值归零并清空候选：此时位置已经吸附过，目标偏移理应为
  // 0；用 0 作阈值才能只保留“真正对齐”的关系，据此画出的参考线不会偏移。
  minOffset.x = 0;
  minOffset.y = 0;
  nearestSnapsX.length = 0;
  nearestSnapsY.length = 0;
  const newDragOffset = {
    x: round(dragOffset.x + snapOffset.x),
    y: round(dragOffset.y + snapOffset.y),
  };

  getPointSnaps(
    selectedElements,
    getElementsCorners(selectedElements, elementsMap, {
      dragOffset: newDragOffset,
    }),
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  getGapSnaps(
    selectedElements,
    newDragOffset,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  // 第二遍：把 snapOffset 合进 dragOffset 后重算，此时偏移应接近 0，目的
  // 是拿到“吸附后位置”的参考线，避免参考线画在吸附前的旧位置而跳一下。
  const pointSnapLines = createPointSnapLines(nearestSnapsX, nearestSnapsY);

  const gapSnapLines = createGapSnapLines(
    selectedElements,
    newDragOffset,
    [...nearestSnapsX, ...nearestSnapsY].filter(
      (snap) => snap.type === "gap",
    ) as GapSnap[],
  );

  return {
    snapOffset,
    snapLines: [...pointSnapLines, ...gapSnapLines],
  };
};

/**
 * 四舍五入到 6 位小数。
 *
 * 吸附坐标要参与相等比较与 Map key 拼接；浮点尾差会让“同一个点”生成不同的
 * key，导致参考线重复或去重失败。
 */
const round = (x: number) => {
  const decimalPlaces = 6;
  return Math.round(x * 10 ** decimalPlaces) / 10 ** decimalPlaces;
};

/**
 * 按 "x,y" 去重参考点。
 *
 * 用 Map 而不是 Set：保留首次出现的顺序，使参考线的点序稳定（渲染时还会
 * 再按坐标排序，但稳定输入能减少视觉跳动）。
 */
const dedupePoints = (points: GlobalPoint[]): GlobalPoint[] => {
  const map = new Map<string, GlobalPoint>();

  for (const point of points) {
    const key = point.join(",");

    if (!map.has(key)) {
      map.set(key, point);
    }
  }

  return Array.from(map.values());
};

/**
 * 把 point snap 候选转换成参考线。
 *
 * 同一轴上的候选按“被拖拽点坐标”分组：X 轴用 points[0][0] 作 key，Y 轴用
 * points[0][1]。同一条竖线上的所有点会被压成一条 type=points 的线（横坐标
 * 统一成 key，只保留纵坐标差异），随后排序去重。这样多个对齐点共享一条
 * 参考线，而不是每个点各画一条短线段。
 */
const createPointSnapLines = (
  nearestSnapsX: Snaps,
  nearestSnapsY: Snaps,
): PointSnapLine[] => {
  const snapsX = {} as { [key: string]: GlobalPoint[] };
  const snapsY = {} as { [key: string]: GlobalPoint[] };

  // X 轴候选按“被拖拽点的 x”聚合：同一条竖线上的点共享一条参考线，
  // 因此只保留纵坐标差异，横坐标统一取 key。
  if (nearestSnapsX.length > 0) {
    for (const snap of nearestSnapsX) {
      if (snap.type === "point") {
        // key = thisPoint.x
        const key = round(snap.points[0][0]);
        if (!snapsX[key]) {
          snapsX[key] = [];
        }
        snapsX[key].push(
          ...snap.points.map((p) =>
            pointFrom<GlobalPoint>(round(p[0]), round(p[1])),
          ),
        );
      }
    }
  }

  if (nearestSnapsY.length > 0) {
    for (const snap of nearestSnapsY) {
      if (snap.type === "point") {
        // key = thisPoint.y
        const key = round(snap.points[0][1]);
        if (!snapsY[key]) {
          snapsY[key] = [];
        }
        snapsY[key].push(
          ...snap.points.map((p) =>
            pointFrom<GlobalPoint>(round(p[0]), round(p[1])),
          ),
        );
      }
    }
  }

  // X 线与 Y 线合并输出：渲染层不区分两者，都按 points 型线段绘制。
  return Object.entries(snapsX)
    .map(([key, points]) => {
      return {
        type: "points",
        points: dedupePoints(
          points
            .map((p) => {
              return pointFrom<GlobalPoint>(Number(key), p[1]);
            })
            .sort((a, b) => a[1] - b[1]),
        ),
      } as PointSnapLine;
    })
    .concat(
      Object.entries(snapsY).map(([key, points]) => {
        return {
          type: "points",
          points: dedupePoints(
            points
              .map((p) => {
                return pointFrom<GlobalPoint>(p[0], Number(key));
              })
              .sort((a, b) => a[0] - b[0]),
          ),
        } as PointSnapLine;
      }),
    );
};

/**
 * 按两端点坐标拼接 key 去重 gap 参考线。
 *
 * gap snap 可能被多个间距同时命中，产生几何完全相同的线段（例如两条参考线
 * 恰好重合）；去重后避免在同一位置叠加绘制，导致线条颜色变深。
 */
const dedupeGapSnapLines = (gapSnapLines: GapSnapLine[]) => {
  const map = new Map<string, GapSnapLine>();

  for (const gapSnapLine of gapSnapLines) {
    const key = gapSnapLine.points
      .flat()
      .map((point) => [round(point)])
      .join(",");

    if (!map.has(key)) {
      map.set(key, gapSnapLine);
    }
  }

  return Array.from(map.values());
};

/**
 * 把 gap snap 候选转换成“两段式”参考线。
 *
 * 每种 direction 都画两条线段：一条表示“已有间距”，另一条表示“被拖拽元素
 * 到间距的距离”，两者等长才说明间距被成功复制。线段位置取 overlap 区间的
 * 中点，保证参考线落在两个元素视觉上重叠的那一段，而不是随意选一条边。
 *
 * 所有端点最后统一四舍五入并去重，避免浮点尾差产生重复线段。
 */
const createGapSnapLines = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  dragOffset: Vector2D,
  gapSnaps: GapSnap[],
): GapSnapLine[] => {
  const [minX, minY, maxX, maxY] = getDraggedElementsBounds(
    selectedElements,
    dragOffset,
  );

  // 每个 gapSnap 生成 2 条线段，且线段端点必须严格落在“间距两侧的元素边”
  // 与被拖拽元素边之间；坐标系为场景坐标，渲染层不再做换算。
  const gapSnapLines: GapSnapLine[] = [];

  for (const gapSnap of gapSnaps) {
    const [startMinX, startMinY, startMaxX, startMaxY] =
      gapSnap.gap.startBounds;
    const [endMinX, endMinY, endMaxX, endMaxY] = gapSnap.gap.endBounds;

    // 两个方向的交集分别缓存：水平参考线需要 Y 交集，垂直参考线需要 X 交集；
    // 无交集说明元素已经移出该间距的可视范围，对应方向不画线。
    const verticalIntersection = rangeIntersection(
      rangeInclusive(minY, maxY),
      gapSnap.gap.overlap,
    );

    const horizontalGapIntersection = rangeIntersection(
      rangeInclusive(minX, maxX),
      gapSnap.gap.overlap,
    );

    // direction 决定两条线的相对位置，但都以 overlap 中点作为公共纵/横坐标，
    // 这样参考线始终画在两个元素视觉重叠的区间内，而不是落在空白处。
    switch (gapSnap.direction) {
      case "center_horizontal": {
        if (verticalIntersection) {
          const gapLineY =
            (verticalIntersection[0] + verticalIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(gapSnap.gap.startSide[0][0], gapLineY),
                pointFrom(minX, gapLineY),
              ],
            },
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(maxX, gapLineY),
                pointFrom(gapSnap.gap.endSide[0][0], gapLineY),
              ],
            },
          );
        }
        break;
      }
      case "center_vertical": {
        if (horizontalGapIntersection) {
          const gapLineX =
            (horizontalGapIntersection[0] + horizontalGapIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, gapSnap.gap.startSide[0][1]),
                pointFrom(gapLineX, minY),
              ],
            },
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, maxY),
                pointFrom(gapLineX, gapSnap.gap.endSide[0][1]),
              ],
            },
          );
        }
        break;
      }
      case "side_right": {
        if (verticalIntersection) {
          const gapLineY =
            (verticalIntersection[0] + verticalIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(startMaxX, gapLineY),
                pointFrom(endMinX, gapLineY),
              ],
            },
            {
              type: "gap",
              direction: "horizontal",
              points: [pointFrom(endMaxX, gapLineY), pointFrom(minX, gapLineY)],
            },
          );
        }
        break;
      }
      case "side_left": {
        if (verticalIntersection) {
          const gapLineY =
            (verticalIntersection[0] + verticalIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(maxX, gapLineY),
                pointFrom(startMinX, gapLineY),
              ],
            },
            {
              type: "gap",
              direction: "horizontal",
              points: [
                pointFrom(startMaxX, gapLineY),
                pointFrom(endMinX, gapLineY),
              ],
            },
          );
        }
        break;
      }
      case "side_top": {
        if (horizontalGapIntersection) {
          const gapLineX =
            (horizontalGapIntersection[0] + horizontalGapIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, maxY),
                pointFrom(gapLineX, startMinY),
              ],
            },
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, startMaxY),
                pointFrom(gapLineX, endMinY),
              ],
            },
          );
        }
        break;
      }
      case "side_bottom": {
        if (horizontalGapIntersection) {
          const gapLineX =
            (horizontalGapIntersection[0] + horizontalGapIntersection[1]) / 2;

          gapSnapLines.push(
            {
              type: "gap",
              direction: "vertical",
              points: [
                pointFrom(gapLineX, startMaxY),
                pointFrom(gapLineX, endMinY),
              ],
            },
            {
              type: "gap",
              direction: "vertical",
              points: [pointFrom(gapLineX, endMaxY), pointFrom(gapLineX, minY)],
            },
          );
        }
        break;
      }
    }
  }

  return dedupeGapSnapLines(
    gapSnapLines.map((gapSnapLine) => {
      return {
        ...gapSnapLine,
        points: gapSnapLine.points.map((p) =>
          pointFrom(round(p[0]), round(p[1])),
        ) as PointPair,
      };
    }),
  );
};

/**
 * 缩放吸附：只吸附“正在拖动的那个手柄/边”，不是整个包围盒。
 *
 * 与拖拽吸附的差别：拖拽移动整体，所有边都可能吸附；缩放只有被拖的边
 * 可动，因此参照点筛选与偏移应用都只作用于该方向，避免把对边也拉走。
 */
export const snapResizingElements = (
  // use the latest elements to create snap lines
  selectedElements: readonly NonDeletedExcalidrawElement[],
  // while using the original elements to appy dragOffset to calculate snaps
  selectedOriginalElements: readonly NonDeletedExcalidrawElement[],
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  dragOffset: Vector2D,
  transformHandle: MaybeTransformHandleType,
) => {
  if (
    !isSnappingEnabled({ event, selectedElements, app }) ||
    selectedElements.length === 0 ||
    (selectedElements.length === 1 &&
      !areRoughlyEqual(selectedElements[0].angle, 0))
  ) {
    return {
      snapOffset: { x: 0, y: 0 },
      snapLines: [],
    };
  }

  // 用“原始元素 + 拖拽位移”重建包围盒：selectedElements 是缩放后的结果，
  // 直接用它会把缩放量重复叠加一次。只有带方向的手柄才移动对应的边，
  // 这保证对边始终固定。
  let [minX, minY, maxX, maxY] = getCommonBounds(selectedOriginalElements);

  if (transformHandle) {
    if (transformHandle.includes("e")) {
      maxX += dragOffset.x;
    } else if (transformHandle.includes("w")) {
      minX += dragOffset.x;
    }

    if (transformHandle.includes("n")) {
      minY += dragOffset.y;
    } else if (transformHandle.includes("s")) {
      maxY += dragOffset.y;
    }
  }

  // 只把“被拖动的边/角”加入候选点：缩放时对边不可动，若把它们也拿去吸附，
  // 会算出无法执行的 offset（需要移动对边），表现为手柄“黏住”不动。
  const selectionSnapPoints: GlobalPoint[] = [];

  if (transformHandle) {
    switch (transformHandle) {
      case "e": {
        selectionSnapPoints.push(pointFrom(maxX, minY), pointFrom(maxX, maxY));
        break;
      }
      case "w": {
        selectionSnapPoints.push(pointFrom(minX, minY), pointFrom(minX, maxY));
        break;
      }
      case "n": {
        selectionSnapPoints.push(pointFrom(minX, minY), pointFrom(maxX, minY));
        break;
      }
      case "s": {
        selectionSnapPoints.push(pointFrom(minX, maxY), pointFrom(maxX, maxY));
        break;
      }
      case "ne": {
        selectionSnapPoints.push(pointFrom(maxX, minY));
        break;
      }
      case "nw": {
        selectionSnapPoints.push(pointFrom(minX, minY));
        break;
      }
      case "se": {
        selectionSnapPoints.push(pointFrom(maxX, maxY));
        break;
      }
      case "sw": {
        selectionSnapPoints.push(pointFrom(minX, maxY));
        break;
      }
    }
  }

  const snapDistance = getSnapDistance(app.state.zoom.value);

  const minOffset = {
    x: snapDistance,
    y: snapDistance,
  };

  const nearestSnapsX: Snaps = [];
  const nearestSnapsY: Snaps = [];

  getPointSnaps(
    selectedOriginalElements,
    selectionSnapPoints,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  const snapOffset = {
    x: nearestSnapsX[0]?.offset ?? 0,
    y: nearestSnapsY[0]?.offset ?? 0,
  };

  // again, once snap offset is calculated
  // reset to recompute for creating snap lines to be rendered
  minOffset.x = 0;
  minOffset.y = 0;
  nearestSnapsX.length = 0;
  nearestSnapsY.length = 0;

  // 第二遍用“缩放后”的元素取角点来生成参考线：这样线画在元素最终落点上，
  // 而不是缩放前的旧位置。
  const [x1, y1, x2, y2] = getCommonBounds(selectedElements).map((bound) =>
    round(bound),
  );

  const corners: GlobalPoint[] = [
    pointFrom(x1, y1),
    pointFrom(x1, y2),
    pointFrom(x2, y1),
    pointFrom(x2, y2),
  ];

  getPointSnaps(
    selectedElements,
    corners,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  const pointSnapLines = createPointSnapLines(nearestSnapsX, nearestSnapsY);

  // 缩放吸附只返回 point 参考线：缩放时元素的边在动，gap 关系每帧都在变，
  // 画等距线会持续闪烁，反而干扰判断。
  return {
    snapOffset,
    snapLines: pointSnapLines,
  };
};

/**
 * 新建元素时的吸附：元素还没进 Scene，不能走 getSelectedElements。
 *
 * 这里直接把 newElement 当作唯一被拖拽对象，用它的当前包围盒找参照点。
 * 因此它只支持 point/gap snap，不涉及多选或 frame 归属。
 */
export const snapNewElement = (
  newElement: NonDeletedExcalidrawElement,
  app: AppClassProperties,
  event: KeyboardModifiersObject,
  origin: Vector2D,
  dragOffset: Vector2D,
  elementsMap: ElementsMap,
) => {
  if (!isSnappingEnabled({ event, selectedElements: [newElement], app })) {
    return {
      snapOffset: { x: 0, y: 0 },
      snapLines: [],
    };
  }

  // 新建元素的位置由 origin + dragOffset 决定，元素尚未进入 Scene，
  // 因此直接用它作为唯一“被拖拽点”，只做 point snap、不做 gap snap。
  const selectionSnapPoints: GlobalPoint[] = [
    pointFrom(origin.x + dragOffset.x, origin.y + dragOffset.y),
  ];

  const snapDistance = getSnapDistance(app.state.zoom.value);

  const minOffset = {
    x: snapDistance,
    y: snapDistance,
  };

  const nearestSnapsX: Snaps = [];
  const nearestSnapsY: Snaps = [];

  getPointSnaps(
    [newElement],
    selectionSnapPoints,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  const snapOffset = {
    x: nearestSnapsX[0]?.offset ?? 0,
    y: nearestSnapsY[0]?.offset ?? 0,
  };

  minOffset.x = 0;
  minOffset.y = 0;
  nearestSnapsX.length = 0;
  nearestSnapsY.length = 0;

  // 新建元素用包围盒 4 角且省略中心：拖拽创建时用户关注的是“框边对齐”，
  // 中心点对齐在创建阶段几乎不会被感知，反而增加候选与参考线噪音。
  const corners = getElementsCorners([newElement], elementsMap, {
    boundingBoxCorners: true,
    omitCenter: true,
  });

  getPointSnaps(
    [newElement],
    corners,
    app,
    event,
    nearestSnapsX,
    nearestSnapsY,
    minOffset,
  );

  const pointSnapLines = createPointSnapLines(nearestSnapsX, nearestSnapsY);

  return {
    snapOffset,
    snapLines: pointSnapLines,
  };
};

/**
 * 指针级吸附：只生成参考线，不修改任何元素位置。
 *
 * 用于“还没按下、只是移动指针”的预览（App 在 pointermove 的非拖拽路径调用）。
 * 对每个可见参照元素的 4 角 + 中心分别比较指针坐标，取绝对位移最小的水平/
 * 垂直候选。
 *
 * 与拖拽吸附的差别：这里不需要两遍计算——指针本身就是最终位置，不存在
 * “先吸附再重画参考线”的错位问题。selectedElements 传空数组，避免把当前
 * 选中元素当成参照。
 *
 * @returns originOffset 指针到最近对齐点的位移；snapLines 为 pointer 型线段
 */
export const getSnapLinesAtPointer = (
  elements: readonly NonDeletedExcalidrawElement[],
  app: AppClassProperties,
  pointer: Vector2D,
  event: KeyboardModifiersObject,
  elementsMap: ElementsMap,
) => {
  if (!isSnappingEnabled({ event, selectedElements: [], app })) {
    return {
      originOffset: { x: 0, y: 0 },
      snapLines: [],
    };
  }

  const referenceElements = getVisibleAndNonSelectedElements(
    elements,
    [],
    app.state,
    elementsMap,
  );

  const snapDistance = getSnapDistance(app.state.zoom.value);

  const minOffset = {
    x: snapDistance,
    y: snapDistance,
  };

  const horizontalSnapLines: PointerSnapLine[] = [];
  const verticalSnapLines: PointerSnapLine[] = [];

  // 指针吸附只画参考线，因此不需要分两遍：每个参照元素取角点后立即比较，
  // 用「先清空再 push」的规则保证每轴只保留最近距离的那一批线段。
  for (const referenceElement of referenceElements) {
    // 单元素取角点时默认包含中心：指针吸附没有“被拖拽元素”的包围盒概念，
    // 中心点能覆盖“指针停在元素正中”的常见情形。
    const corners = getElementsCorners([referenceElement], elementsMap);

    for (const corner of corners) {
      // 先比 X 再比 Y，两个轴独立；用绝对值比较才能同时处理左右/上下两侧。
      const offsetX = corner[0] - pointer.x;

      if (Math.abs(offsetX) <= Math.abs(minOffset.x)) {
        if (Math.abs(offsetX) < Math.abs(minOffset.x)) {
          verticalSnapLines.length = 0;
        }

        verticalSnapLines.push({
          type: "pointer",
          points: [corner, pointFrom(corner[0], pointer.y)],
          direction: "vertical",
        });

        minOffset.x = offsetX;
      }

      const offsetY = corner[1] - pointer.y;

      if (Math.abs(offsetY) <= Math.abs(minOffset.y)) {
        if (Math.abs(offsetY) < Math.abs(minOffset.y)) {
          horizontalSnapLines.length = 0;
        }

        horizontalSnapLines.push({
          type: "pointer",
          points: [corner, pointFrom(pointer.x, corner[1])],
          direction: "horizontal",
        });

        minOffset.y = offsetY;
      }
    }
  }

  return {
    originOffset: {
      x:
        verticalSnapLines.length > 0
          ? verticalSnapLines[0].points[0][0] - pointer.x
          : 0,
      y:
        horizontalSnapLines.length > 0
          ? horizontalSnapLines[0].points[0][1] - pointer.y
          : 0,
    },
    snapLines: [...verticalSnapLines, ...horizontalSnapLines],
  };
};

/**
 * 判断当前工具创建的元素是否属于“非线性的可吸附形状”。
 *
 * 线性工具（arrow/line/freedraw）走绑定或自由绘制，不参与 point snap；
 * 矩形/椭圆/菱形/frame/image/text 这类拖拽创建的元素才在创建过程中吸附。
 * 该判断与 snapNewElement 的调用方配合，决定是否计算吸附。
 */
export const isActiveToolNonLinearSnappable = (
  activeToolType: AppState["activeTool"]["type"],
) => {
  return (
    activeToolType === TOOL_TYPE.rectangle ||
    activeToolType === TOOL_TYPE.ellipse ||
    activeToolType === TOOL_TYPE.diamond ||
    activeToolType === TOOL_TYPE.frame ||
    activeToolType === TOOL_TYPE.magicframe ||
    activeToolType === TOOL_TYPE.image ||
    activeToolType === TOOL_TYPE.text
  );
};
