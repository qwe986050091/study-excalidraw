/**
 * 交互层渲染器（interactive scene）。
 *
 * 在渲染链路中的位置：
 *   App（React）→ InteractiveCanvas（每帧由 AnimationController 驱动）→
 *   renderInteractiveScene → _renderInteractiveScene → 本文件内的各个
 *   render* 片段函数 → canvas 2d context。
 * 它和 StaticCanvas 是两层独立的 canvas：静态层画文档内容，本层只画
 * “不是文档内容”的 UI 覆盖物（选择框、手柄、绑定高亮、吸附线、协作
 * 光标、滚动条、裁剪框等），因此这些内容不会被导出，也不会进入 shape 缓存。
 *
 * 输入：InteractiveSceneRenderConfig（见 scene/types.ts）：
 *   - elementsMap / visibleElements：经过视口过滤的可见元素，用于绘制；
 *   - allElementsMap：未过滤全集，绑定目标、锁定元素可能不在可见集里；
 *   - selectedElements：当前选中元素，决定选择框与变换手柄；
 *   - appState：已裁剪为 InteractiveCanvasAppState 的只读快照；
 *   - renderConfig：选择色、协作光标反向索引、是否画滚动条等渲染参数；
 *   - animationState / deltaTime：上一帧遗留的动画状态与帧间隔毫秒数。
 * 输出：{ scrollBars?, animationState? }，并通过 renderConfig.callback 回传
 * 给 App（滚动条几何与动画状态）。
 *
 * 关键不变量：
 *   1. 只读元素，绝不修改 scene；所有几何都先在场景坐标（GlobalPoint）里
 *      算完，最后才叠加 scrollX/scrollY。
 *   2. 缩放只应用一次（context.scale(zoom)），之后所有尺寸常量都要除以
 *      zoom 才能保持屏幕像素恒定；漏除会让手柄在放大后跟着变大。
 *   3. 每个绘制片段自行 save/restore：translate/rotate/fillStyle/clip 都会
 *      串到下一个片段，绑定高亮的 frame clip 尤其容易泄漏。
 *   4. 绘制顺序即层级，后画的覆盖先画的，顺序见 _renderInteractiveScene。
 */
import {
  clamp,
  pointDistance,
  pointFrom,
  pointsEqual,
  type GlobalPoint,
  type LocalPoint,
  type Radians,
  bezierEquation,
  pointRotateRads,
} from "@excalidraw/math";

import {
  arrayToMap,
  BIND_MODE_TIMEOUT,
  DEFAULT_TRANSFORM_HANDLE_SPACING,
  FRAME_STYLE,
  getFeatureFlag,
  invariant,
  shouldRotateWithDiscreteAngle,
  THEME,
  applyDarkModeFilter,
} from "@excalidraw/common";

import {
  deconstructDiamondElement,
  deconstructRectanguloidElement,
  elementCenterPoint,
  getAllMidpoints,
  FOCUS_POINT_SIZE,
  getOmitSidesForEditorInterface,
  getTransformHandles,
  getTransformHandlesFromCoords,
  hasBoundingBox,
  hitElementItself,
  isArrowElement,
  isBindableElement,
  isElbowArrow,
  isFrameLikeElement,
  isImageElement,
  isLinearElement,
  isLineElement,
  isTextElement,
  getTextElementWithAccuratePosition,
  LinearElementEditor,
  maxBindingDistance_simple,
  getActiveTextElement,
  getElementsInGroup,
  getSelectedGroupIds,
  isSelectedViaGroup,
  selectGroupsFromGivenElements,
} from "@excalidraw/element";

import { renderSelectionElement } from "@excalidraw/element";

import { getCommonBounds, getElementAbsoluteCoords } from "@excalidraw/element";
import {
  getGlobalFixedPointForBindableElement,
  isFocusPointVisible,
} from "@excalidraw/element";

import type { EditorInterface } from "@excalidraw/common";

import type {
  TransformHandles,
  TransformHandleType,
} from "@excalidraw/element";

import type {
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawBindableElement,
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  ExcalidrawImageElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  GroupId,
  NonDeleted,
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import { renderSnaps } from "../renderer/renderSnaps";
import { roundRect } from "../renderer/roundRect";
import {
  getScrollBars,
  SCROLLBAR_COLOR,
  SCROLLBAR_WIDTH,
} from "../scene/scrollbars";

import { getClientColor, renderRemoteCursors } from "../clients";
import {
  getTextAutoResizeHandle,
  getTextBoxPadding,
} from "../textAutoResizeHandle";

import {
  bootstrapCanvas,
  fillCircle,
  getNormalizedCanvasDimensions,
  strokeRectWithRotation_simple,
  snapScrollToDevicePixels,
} from "./helpers";

import type {
  AppState,
  AppClassProperties,
  InteractiveCanvasAppState,
} from "../types";
import type {
  InteractiveCanvasRenderConfig,
  InteractiveSceneRenderConfig,
  RenderableElementsMap,
} from "../scene/types";

// The interactive canvas used to be inverted in dark mode via a CSS filter
// (`invert(93%) hue-rotate(180deg)`), which is prohibitively slow in browsers
// that composite in software (e.g. Firefox on software WebRender). We now map
// the colors in JS instead (see `applyDarkModeFilter`), so the dark-mode
// values below are the post-filter equivalents of the previous ones.
// ---------------------------------------------------------------------------

const BINDING_HIGHLIGHT_RGB = {
  [THEME.LIGHT]: "106, 189, 252",
  [THEME.DARK]: "104, 182, 240",
} as const;

const BINDING_MIDPOINT_COLOR = {
  [THEME.LIGHT]: "rgba(65, 65, 65, 0.5)",
  [THEME.DARK]: "rgba(237, 237, 237, 0.8)",
} as const;

const SEARCH_MATCH_COLOR = {
  [THEME.LIGHT]: {
    focus: "rgba(255, 124, 0, 0.4)",
    match: "rgba(255, 226, 0, 0.4)",
  },
  [THEME.DARK]: {
    focus: "rgba(250, 123, 53, 0.4)",
    match: "rgba(221, 181, 136, 0.4)",
  },
} as const;

/** maps a light-mode UI color to its dark-mode counterpart when in dark mode */
/**
 * 交互层绘制：所有“不是文档内容”的东西。
 *
 * 包括选择框、变换手柄、线性元素端点、绑定高亮、focus point 指示、frame
 * 高亮、裁剪手柄、文本编辑框、吸附线、协作光标与滚动条。它们被刻意放在
 * 独立 canvas，避免和静态内容一起被缓存/导出。
 *
 * 坐标约定：
 * - 与 StaticCanvas 一样先 `scale(zoom)`，再每个绘制片段自己加 scroll；
 * - 手柄尺寸按 `size / zoom` 反算，保证屏幕上恒定；
 * - scroll 同样做设备像素吸附，否则覆盖层会和内容错开半个像素。
 *
 * 这个文件只画“当前帧的状态”，不修改元素。动画（绑定高亮呼吸）通过
 * `animationState` 在帧之间传递，由 AnimationController 驱动重入。
 */
/**
 * 把设计稿里的“浅色主题颜色”映射为当前主题下的等价色。
 *
 * 交互层没有 CSS filter 兜底（历史上的 invert+hue-rotate 在软件合成下极慢），
 * 所以每个颜色都必须逐个经过这里换算。只有 DARK 才走 applyDarkModeFilter，
 * LIGHT 原样返回，保证两套主题下对比度一致。
 *
 * @returns 可直接赋给 strokeStyle / fillStyle 的 rgb 或 rgba 字符串。
 */
const getThemedColor = (
  color: string,
  theme: InteractiveCanvasAppState["theme"],
) => applyDarkModeFilter(color, theme === THEME.DARK);

/**
 * 画“肘形箭头线段中点被 hover 时”的高亮圆点。
 *
 * 调用方（_renderInteractiveScene 的 hover 分支）已确认
 * selectedLinearElement.segmentMidPointHoveredCoords 存在；这里再用
 * invariant 断言一次，把“调用方漏判”从静默画错位置变成显式报错。
 * 传入的坐标已是场景坐标，highlightPoint 内部会自行叠加 scroll。
 */
const renderElbowArrowMidPointHighlight = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  invariant(appState.selectedLinearElement, "selectedLinearElement is null");

  const { segmentMidPointHoveredCoords } = appState.selectedLinearElement;

  invariant(segmentMidPointHoveredCoords, "midPointCoords is null");

  highlightPoint(segmentMidPointHoveredCoords, context, appState);
};

/**
 * 画线性元素某个端点被 hover 时的提示圆点。
 *
 * 三类跳过条件：
 *   1. 正在编辑且该端点已被选中——选中态本身已有实心点，再叠一层会发糊；
 *   2. 正在拖拽——点位跟着指针走，额外重画会造成抖动；
 *   3. 元素已不存在（例如协作方刚删除），此时 getElement 返回 null。
 * hoverPointIndex 由 pointermove 的命中测试写入，调用方已过滤 -1 的情况。
 */
const renderLinearElementPointHighlight = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: ElementsMap,
) => {
  const { elementId, hoverPointIndex } = appState.selectedLinearElement!;
  if (
    appState.selectedLinearElement?.isEditing &&
    appState.selectedLinearElement?.selectedPointsIndices?.includes(
      hoverPointIndex,
    )
  ) {
    return;
  }
  if (appState.selectedLinearElement?.isDragging) {
    return;
  }
  const element = LinearElementEditor.getElement(elementId, elementsMap);

  if (!element) {
    return;
  }
  // hoverPointIndex 可能为负、也可能在编辑过程中变化；用
  // getPointAtIndexGlobalCoordinates 按“当前绑定后的真实几何”求点，不能
  // 直接 points[index] 取，否则绑定元素移动后圆点会滞后。
  const point = LinearElementEditor.getPointAtIndexGlobalCoordinates(
    element,
    hoverPointIndex,
    elementsMap,
  );
  highlightPoint(point, context, appState);
};

/** draws the point marker in scene coordinates */
/**
 * 在场景坐标处画一个半透明圆点（hover / 聚焦反馈）。
 *
 * 半径 POINT_HANDLE_SIZE 是设计稿里的屏幕尺寸，必须除以 zoom，否则放大后
 * 圆点会跟着变大。第三个参数 false 表示只填充不描边；自行 translate scroll，
 * 使调用方可以直接传 GlobalPoint。
 *
 * @param point 场景坐标（不是视口坐标）
 */
const highlightPoint = <Point extends LocalPoint | GlobalPoint>(
  point: Point,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
) => {
  context.save();
  context.translate(appState.scrollX, appState.scrollY);

  context.fillStyle = getThemedColor(
    "rgba(105, 101, 219, 0.4)",
    appState.theme,
  );

  fillCircle(
    context,
    point[0],
    point[1],
    LinearElementEditor.POINT_HANDLE_SIZE / appState.zoom.value,
    false,
  );

  context.restore();
};

/**
 * 画线性元素的一个可拖拽端点。
 *
 * 三种视觉状态，优先级从高到低：
 *   - isSelected：实心紫，表示端点已被选中（可整体平移）；
 *   - isPhantomPoint：半透明紫，表示“中点/可插入点”这类虚拟手柄；
 *   - 默认：白底蓝边，表示可拖拽但未选中。
 * isOverlappingPoint 让重叠端点（闭合线首尾重合）放大 1.5~2 倍，否则两个点
 * 完全重叠时用户看不出这里可以拖拽；半径同样按 zoom 反算。
 *
 * @param radius 逻辑半径（未除 zoom）
 */
const renderSingleLinearPoint = <Point extends GlobalPoint | LocalPoint>(
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  point: Point,
  radius: number,
  isSelected: boolean,
  isPhantomPoint: boolean,
  isOverlappingPoint: boolean,
) => {
  context.strokeStyle = getThemedColor("#5e5ad8", appState.theme);
  context.setLineDash([]);
  context.fillStyle = getThemedColor(
    "rgba(255, 255, 255, 0.9)",
    appState.theme,
  );
  if (isSelected) {
    context.fillStyle = getThemedColor(
      "rgba(134, 131, 226, 0.9)",
      appState.theme,
    );
  } else if (isPhantomPoint) {
    context.fillStyle = getThemedColor(
      "rgba(177, 151, 252, 0.7)",
      appState.theme,
    );
  }

  fillCircle(
    context,
    point[0],
    point[1],
    (isOverlappingPoint
      ? radius * (appState.selectedLinearElement?.isEditing ? 1.5 : 2)
      : radius) / appState.zoom.value,
    !isPhantomPoint,
    !isOverlappingPoint || isSelected,
  );
};

/**
 * 简版绑定高亮：画目标元素外轮廓 +（可选）中点提示。
 *
 * 调用前提：调用方已 translate(scrollX, scrollY)，因此这里全部使用场景坐标。
 * 若目标元素属于某个 frame，先按 frame 矩形 clip，避免高亮溢出到 frame 外
 * ——frame 语义上就是裁剪容器，交互反馈也应该遵守同样的边界。
 *
 * 轮廓分派规则：
 *   - frame / magicframe：矩形，有 roundRect 就用圆角，线宽走 FRAME_STYLE；
 *   - ellipse：椭圆路径；
 *   - diamond：deconstructDiamondElement 拆成“线段 + 圆角贝塞尔”；
 *   - 其余（矩形/文本/图片等）：deconstructRectanguloidElement 同理。
 * 逐段 stroke 而不是拼成一条路径，是因为直线与圆角曲线必须在交接处断开，
 * 否则圆角会被直线端点“拉尖”。
 *
 * 中点提示的条件：开启中点吸附、非网格模式、未锁定离散角度、且目标可绑定。
 * 简单箭头只在指针位于元素外部时显示最近的一个中点（内部让位给绑定），
 * 肘形箭头则始终显示全部中点。
 *
 * @param pointerCoords 指针场景坐标，可为 null（无指针时不显示中点）
 * @param angleLocked 是否按住 shift 等离散角度修饰键
 */
const renderBindingHighlightForBindableElement_simple = (
  context: CanvasRenderingContext2D,
  suggestedBinding: NonNullable<AppState["suggestedBinding"]>,
  elementsMap: ElementsMap,
  appState: InteractiveCanvasAppState,
  pointerCoords: GlobalPoint | null,
  angleLocked = false,
) => {
  // frame 内的元素做 clip：先平移到 frame 原点裁剪，再把坐标平移回去，
  // 这样后续的分支仍然可以使用绝对场景坐标，不必逐个换算。
  const enclosingFrame =
    suggestedBinding.element.frameId &&
    elementsMap.get(suggestedBinding.element.frameId);
  if (enclosingFrame && isFrameLikeElement(enclosingFrame)) {
    context.translate(enclosingFrame.x, enclosingFrame.y);

    context.beginPath();

    if (FRAME_STYLE.radius && context.roundRect) {
      context.roundRect(
        -1,
        -1,
        enclosingFrame.width + 1,
        enclosingFrame.height + 1,
        FRAME_STYLE.radius / appState.zoom.value,
      );
    } else {
      context.rect(-1, -1, enclosingFrame.width + 1, enclosingFrame.height + 1);
    }

    context.clip();

    context.translate(-enclosingFrame.x, -enclosingFrame.y);
  }

  // frame 类元素按矩形画（frame 的语义就是矩形容器），其余类型按真实
  // 几何形状描边，保证高亮贴合视觉轮廓而不是包围盒。
  switch (suggestedBinding.element.type) {
    case "magicframe":
    case "frame":
      context.save();

      context.translate(suggestedBinding.element.x, suggestedBinding.element.y);

      context.lineWidth = FRAME_STYLE.strokeWidth / appState.zoom.value;
      context.strokeStyle = `rgba(${BINDING_HIGHLIGHT_RGB[appState.theme]}, 1)`;

      if (FRAME_STYLE.radius && context.roundRect) {
        context.beginPath();
        context.roundRect(
          0,
          0,
          suggestedBinding.element.width,
          suggestedBinding.element.height,
          FRAME_STYLE.radius / appState.zoom.value,
        );
        context.stroke();
        context.closePath();
      } else {
        context.strokeRect(
          0,
          0,
          suggestedBinding.element.width,
          suggestedBinding.element.height,
        );
      }

      context.restore();
      break;
    default:
      context.save();

      // 绕元素中心旋转后再平移到元素原点，使下面的几何都以“元素本地坐标”
      // 表达；旋转必须围绕 center 而不是原点，否则旋转后轮廓会整体偏移。
      const center = elementCenterPoint(suggestedBinding.element, elementsMap);

      context.translate(center[0], center[1]);
      context.rotate(suggestedBinding.element.angle as Radians);
      context.translate(-center[0], -center[1]);

      context.translate(suggestedBinding.element.x, suggestedBinding.element.y);

      context.lineWidth =
        clamp(1.75, suggestedBinding.element.strokeWidth, 4) /
        Math.max(0.25, appState.zoom.value);
      context.strokeStyle = `rgba(${BINDING_HIGHLIGHT_RGB[appState.theme]}, 1)`;

      switch (suggestedBinding.element.type) {
        case "ellipse":
          context.beginPath();
          context.ellipse(
            suggestedBinding.element.width / 2,
            suggestedBinding.element.height / 2,
            suggestedBinding.element.width / 2,
            suggestedBinding.element.height / 2,
            0,
            0,
            2 * Math.PI,
          );
          context.closePath();
          context.stroke();
          break;
        case "diamond":
          {
            const [segments, curves] = deconstructDiamondElement(
              suggestedBinding.element,
            );

            // Draw each line segment individually
            segments.forEach((segment) => {
              context.beginPath();
              context.moveTo(
                segment[0][0] - suggestedBinding.element.x,
                segment[0][1] - suggestedBinding.element.y,
              );
              context.lineTo(
                segment[1][0] - suggestedBinding.element.x,
                segment[1][1] - suggestedBinding.element.y,
              );
              context.stroke();
            });

            // Draw each curve individually (for rounded corners)
            curves.forEach((curve) => {
              const [start, control1, control2, end] = curve;
              context.beginPath();
              context.moveTo(
                start[0] - suggestedBinding.element.x,
                start[1] - suggestedBinding.element.y,
              );
              context.bezierCurveTo(
                control1[0] - suggestedBinding.element.x,
                control1[1] - suggestedBinding.element.y,
                control2[0] - suggestedBinding.element.x,
                control2[1] - suggestedBinding.element.y,
                end[0] - suggestedBinding.element.x,
                end[1] - suggestedBinding.element.y,
              );
              context.stroke();
            });
          }

          break;
        default:
          {
            const [segments, curves] = deconstructRectanguloidElement(
              suggestedBinding.element,
            );

            // Draw each line segment individually
            segments.forEach((segment) => {
              context.beginPath();
              context.moveTo(
                segment[0][0] - suggestedBinding.element.x,
                segment[0][1] - suggestedBinding.element.y,
              );
              context.lineTo(
                segment[1][0] - suggestedBinding.element.x,
                segment[1][1] - suggestedBinding.element.y,
              );
              context.stroke();
            });

            // Draw each curve individually (for rounded corners)
            curves.forEach((curve) => {
              const [start, control1, control2, end] = curve;
              context.beginPath();
              context.moveTo(
                start[0] - suggestedBinding.element.x,
                start[1] - suggestedBinding.element.y,
              );
              context.bezierCurveTo(
                control1[0] - suggestedBinding.element.x,
                control1[1] - suggestedBinding.element.y,
                control2[0] - suggestedBinding.element.x,
                control2[1] - suggestedBinding.element.y,
                end[0] - suggestedBinding.element.x,
                end[1] - suggestedBinding.element.y,
              );
              context.stroke();
            });
          }

          break;
      }

      context.restore();

      break;
  }

  // 中点提示：只在中点吸附开启时出现。网格模式下吸附以网格为准，画中点会
  // 产生两套互相矛盾的参考；角度锁定（shift）时用户明确要直线/固定角度，
  // 也不应再提示中点。
  // Draw midpoint indicators
  if (
    appState.isMidpointSnappingEnabled &&
    !appState.gridModeEnabled &&
    !angleLocked &&
    (isFrameLikeElement(suggestedBinding.element) ||
      isBindableElement(suggestedBinding.element))
  ) {
    const linearElement = appState.selectedLinearElement;
    const arrow =
      linearElement?.elementId &&
      LinearElementEditor.getElement(linearElement.elementId, elementsMap);
    // 肘形箭头的拐点由路由算法生成，用户不能把端点吸附到“某条直边的中点”
    // 然后期待它保持直线，因此两类箭头的中点展示策略不同。
    const isElbow =
      (arrow && isElbowArrow(arrow)) ||
      (appState.activeTool.type === "arrow" &&
        appState.currentItemArrowType === "elbow");
    const cursorIsInsideBindable =
      pointerCoords &&
      hitElementItself({
        point: pointerCoords,
        element: suggestedBinding.element,
        elementsMap,
        threshold: 0,
        overrideShouldTestInside: true,
      });

    // Simple arrows only snap to midpoints from outside the element
    if (!cursorIsInsideBindable || isElbow) {
      context.save();

      const midpointRadius = 4 / appState.zoom.value;
      const highlightedMidpoint = suggestedBinding.midPoint;
      const midpoints = getAllMidpoints(suggestedBinding.element, elementsMap);

      // Elbow arrows show all midpoints, simple arrows only the one closest to
      // the pointer, once the pointer gets near it
      // 简单箭头只在指针接近某中点（阈值 2 倍绑定距离）时才显示该中点，
      // 其余情况一个都不画，避免大元素上布满圆点。
      let shownMidpoints = midpoints;
      if (!isElbow) {
        // 阈值取“绑定距离 + 半个描边宽”：粗描边元素的视觉边界比几何边界
        // 更靠外，不加描边宽会出现指针已压到中点却仍不显示的情况。
        const threshold =
          maxBindingDistance_simple(appState.zoom) +
          suggestedBinding.element.strokeWidth / 2;
        const closest =
          pointerCoords &&
          midpoints.reduce((a, b) =>
            pointDistance(a, pointerCoords) <= pointDistance(b, pointerCoords)
              ? a
              : b,
          );
        shownMidpoints =
          closest && pointDistance(closest, pointerCoords) <= threshold * 2
            ? [closest]
            : [];
      }

      context.fillStyle = BINDING_MIDPOINT_COLOR[appState.theme];
      for (const midpoint of shownMidpoints) {
        if (highlightedMidpoint && pointsEqual(midpoint, highlightedMidpoint)) {
          continue;
        }
        context.beginPath();
        context.arc(midpoint[0], midpoint[1], midpointRadius, 0, 2 * Math.PI);
        context.fill();
      }

      if (highlightedMidpoint) {
        context.fillStyle = `rgba(${BINDING_HIGHLIGHT_RGB[appState.theme]}, 1)`;
        context.beginPath();
        context.arc(
          highlightedMidpoint[0],
          highlightedMidpoint[1],
          midpointRadius,
          0,
          2 * Math.PI,
        );
        context.fill();
      }

      context.restore();
    }
  }
};

/**
 * 打开 COMPLEX_BINDINGS 时使用的完整版绑定高亮。
 *
 * 与 simple 版的差异：
 *   1. 带“绑定倒计时”呼吸效果：remainingTime 随 deltaTime 递减，opacity 由
 *      1 衰减到 0；因此必须返回 runtime，让 AnimationController 继续驱动
 *      下一帧。runtime 超过 BIND_MODE_TIMEOUT 后中心指示器停止绘制。
 *   2. 轮廓整体外扩 strokeWidth / 2，视觉上“包住”目标而不是压在描边上。
 *   3. 额外绘制中心吸附区（虚线圆 + 进度环）与旋转后的四个中点，并用
 *      clearRect 在中点处挖洞，避免半透明覆盖层糊住圆点。
 *
 * 坐标注意：此函数未由调用方预先 translate scroll，所以这里 translate 时
 * 显式加了 appState.scrollX/scrollY。clip frame → rotate → translate 的顺序
 * 不能改，否则旋转中心会偏移。
 *
 * @param state 上一帧留下的 { runtime }，undefined 表示动画刚开始
 * @returns { runtime } 该绑定已持续的毫秒数，供下一帧继续推进
 */
const renderBindingHighlightForBindableElement_complex = (
  app: AppClassProperties,
  context: CanvasRenderingContext2D,
  element: ExcalidrawBindableElement,
  allElementsMap: NonDeletedSceneElementsMap,
  appState: InteractiveCanvasAppState,
  deltaTime: number,
  state?: { runtime: number },
) => {
  // 只有“orbit 绑定模式已激活且处理器就绪”才处于倒计时中；其余情况直接
  // 视为倒计时已结束（remainingTime 取 0 之外的初值），保证第一次进入时
  // 透明度从满值开始而不是从 0 淡入。
  const countdownInProgress =
    app.state.bindMode === "orbit" && app.bindModeHandler !== null;

  const remainingTime =
    BIND_MODE_TIMEOUT -
    (state?.runtime ?? (countdownInProgress ? 0 : BIND_MODE_TIMEOUT));
  // 透明度与剩余时间线性相关；下界用 0.0001 而不是 0，避免个别浏览器在
  // 完全透明时仍保留描边，产生“看不见但占位”的伪影。
  const opacity = clamp((1 / BIND_MODE_TIMEOUT) * remainingTime, 0.0001, 1);
  const offset = element.strokeWidth / 2;

  const enclosingFrame = element.frameId && allElementsMap.get(element.frameId);
  if (enclosingFrame && isFrameLikeElement(enclosingFrame)) {
    context.translate(enclosingFrame.x, enclosingFrame.y);

    context.beginPath();

    if (FRAME_STYLE.radius && context.roundRect) {
      context.roundRect(
        -1,
        -1,
        enclosingFrame.width + 1,
        enclosingFrame.height + 1,
        FRAME_STYLE.radius / appState.zoom.value,
      );
    } else {
      context.rect(-1, -1, enclosingFrame.width + 1, enclosingFrame.height + 1);
    }

    context.clip();

    context.translate(-enclosingFrame.x, -enclosingFrame.y);
  }

  switch (element.type) {
    case "magicframe":
    case "frame":
      context.save();

      context.translate(element.x, element.y);

      context.lineWidth = FRAME_STYLE.strokeWidth / appState.zoom.value;
      context.strokeStyle = `rgba(${
        BINDING_HIGHLIGHT_RGB[appState.theme]
      }, ${opacity})`;

      if (FRAME_STYLE.radius && context.roundRect) {
        context.beginPath();
        context.roundRect(
          0,
          0,
          element.width,
          element.height,
          FRAME_STYLE.radius / appState.zoom.value,
        );
        context.stroke();
        context.closePath();
      } else {
        context.strokeRect(0, 0, element.width, element.height);
      }

      context.restore();
      break;
    default:
      context.save();

      const center = elementCenterPoint(element, allElementsMap);
      const cx = center[0] + appState.scrollX;
      const cy = center[1] + appState.scrollY;

      context.translate(cx, cy);
      context.rotate(element.angle as Radians);
      context.translate(-cx, -cy);

      context.translate(
        element.x + appState.scrollX - offset,
        element.y + appState.scrollY - offset,
      );

      context.lineWidth =
        clamp(2.5, element.strokeWidth * 1.75, 4) /
        Math.max(0.25, appState.zoom.value);
      context.strokeStyle = `rgba(${BINDING_HIGHLIGHT_RGB[appState.theme]}, ${
        opacity / 2
      })`;

      switch (element.type) {
        case "ellipse":
          context.beginPath();
          context.ellipse(
            (element.width + offset * 2) / 2,
            (element.height + offset * 2) / 2,
            (element.width + offset * 2) / 2,
            (element.height + offset * 2) / 2,
            0,
            0,
            2 * Math.PI,
          );
          context.closePath();
          context.stroke();
          break;
        case "diamond":
          {
            const [segments, curves] = deconstructDiamondElement(
              element,
              offset,
            );

            // Draw each line segment individually
            segments.forEach((segment) => {
              context.beginPath();
              context.moveTo(
                segment[0][0] - element.x + offset,
                segment[0][1] - element.y + offset,
              );
              context.lineTo(
                segment[1][0] - element.x + offset,
                segment[1][1] - element.y + offset,
              );
              context.stroke();
            });

            // Draw each curve individually (for rounded corners)
            curves.forEach((curve) => {
              const [start, control1, control2, end] = curve;
              context.beginPath();
              context.moveTo(
                start[0] - element.x + offset,
                start[1] - element.y + offset,
              );
              context.bezierCurveTo(
                control1[0] - element.x + offset,
                control1[1] - element.y + offset,
                control2[0] - element.x + offset,
                control2[1] - element.y + offset,
                end[0] - element.x + offset,
                end[1] - element.y + offset,
              );
              context.stroke();
            });
          }

          break;
        default:
          {
            const [segments, curves] = deconstructRectanguloidElement(
              element,
              offset,
            );

            // Draw each line segment individually
            segments.forEach((segment) => {
              context.beginPath();
              context.moveTo(
                segment[0][0] - element.x + offset,
                segment[0][1] - element.y + offset,
              );
              context.lineTo(
                segment[1][0] - element.x + offset,
                segment[1][1] - element.y + offset,
              );
              context.stroke();
            });

            // Draw each curve individually (for rounded corners)
            curves.forEach((curve) => {
              const [start, control1, control2, end] = curve;
              context.beginPath();
              context.moveTo(
                start[0] - element.x + offset,
                start[1] - element.y + offset,
              );
              context.bezierCurveTo(
                control1[0] - element.x + offset,
                control1[1] - element.y + offset,
                control2[0] - element.x + offset,
                control2[1] - element.y + offset,
                end[0] - element.x + offset,
                end[1] - element.y + offset,
              );
              context.stroke();
            });
          }

          break;
      }

      context.restore();

      break;
  }

  // Middle indicator is not rendered after it expired
  // 超时后直接 return，跳过中心吸附区与中点绘制——但仍然保留了上面的轮廓，
  // 因为“已绑定”的视觉反馈需要持续存在。
  if (!countdownInProgress || (state?.runtime ?? 0) > BIND_MODE_TIMEOUT) {
    return;
  }

  const radius = 0.5 * (Math.min(element.width, element.height) / 2);

  // Draw center snap area
  if (!isFrameLikeElement(element)) {
    context.save();
    context.translate(
      element.x + appState.scrollX,
      element.y + appState.scrollY,
    );

    const PROGRESS_RATIO = (1 / BIND_MODE_TIMEOUT) * remainingTime;

    context.strokeStyle = getThemedColor("rgba(0, 0, 0, 0.2)", appState.theme);
    context.lineWidth = 1 / appState.zoom.value;
    context.setLineDash([4 / appState.zoom.value, 4 / appState.zoom.value]);
    context.lineDashOffset = (-PROGRESS_RATIO * 10) / appState.zoom.value;

    context.beginPath();
    context.ellipse(
      element.width / 2,
      element.height / 2,
      radius,
      radius,
      0,
      0,
      2 * Math.PI,
    );
    context.stroke();

    // context.strokeStyle = "transparent";
    context.fillStyle = getThemedColor("rgba(0, 0, 0, 0.04)", appState.theme);
    context.beginPath();
    context.ellipse(
      element.width / 2,
      element.height / 2,
      radius * (1 - opacity),
      radius * (1 - opacity),
      0,
      0,
      2 * Math.PI,
    );

    context.fill();

    context.restore();

    if (
      appState.isMidpointSnappingEnabled &&
      !appState.gridModeEnabled &&
      (!app.lastPointerMoveEvent ||
        !shouldRotateWithDiscreteAngle(app.lastPointerMoveEvent))
    ) {
      // Draw midpoint indicators
      context.save();
      context.translate(
        element.x + appState.scrollX,
        element.y + appState.scrollY,
      );

      const midpointRadius = 5 / appState.zoom.value;
      const cutoutPadding = 5 / appState.zoom.value;
      const cutoutRadius = midpointRadius + cutoutPadding;

      let midpoints;
      // 菱形没有“直边中点”，只能对四条圆角曲线取 t=0.5 的贝塞尔点，
      // 再绕元素中心旋转回元素角度，最后换算成元素本地坐标。
      if (element.type === "diamond") {
        const [, curves] = deconstructDiamondElement(element);
        const center = elementCenterPoint(element, allElementsMap);

        midpoints = curves.map((curve) => {
          const point = bezierEquation(curve, 0.5);
          const rotatedPoint = pointRotateRads(point, center, element.angle);
          return {
            x: rotatedPoint[0] - element.x,
            y: rotatedPoint[1] - element.y,
          };
        });
      } else {
        const center = elementCenterPoint(element, allElementsMap);
        const basePoints = [
          { x: element.width / 2, y: 0 }, // TOP
          { x: element.width, y: element.height / 2 }, // RIGHT
          { x: element.width / 2, y: element.height }, // BOTTOM
          { x: 0, y: element.height / 2 }, // LEFT
        ];
        midpoints = basePoints.map((point) => {
          const globalPoint = pointFrom<GlobalPoint>(
            point.x + element.x,
            point.y + element.y,
          );
          const rotatedPoint = pointRotateRads(
            globalPoint,
            center,
            element.angle,
          );
          return {
            x: rotatedPoint[0] - element.x,
            y: rotatedPoint[1] - element.y,
          };
        });
      }

      // Clear cutouts around midpoints
      // 先在中点位置挖出透明小方块，再画实心中点：否则前面绘制的半透明
      // 填充层会透出来，让中点颜色发灰。
      midpoints.forEach((midpoint) => {
        context.clearRect(
          midpoint.x - cutoutRadius,
          midpoint.y - cutoutRadius,
          cutoutRadius * 2,
          cutoutRadius * 2,
        );
      });

      context.fillStyle = `rgba(${
        BINDING_HIGHLIGHT_RGB[appState.theme]
      }, ${opacity})`;

      midpoints.forEach((midpoint) => {
        context.beginPath();
        context.arc(midpoint.x, midpoint.y, midpointRadius, 0, 2 * Math.PI);
        context.fill();
      });

      context.restore();
    }
  }

  return {
    runtime: (state?.runtime ?? 0) + deltaTime,
  };
};

/**
 * 绑定高亮分派器：根据特性开关选择 simple / complex 实现。
 *
 * suggestedBinding 为 null 表示当前指针没有命中任何可绑定元素（命中测试在
 * 指针移动时写入 appState.suggestedBinding），直接返回，因此无候选时交互层
 * 没有任何额外开销。
 *
 * simple 分支在这里统一 translate(scrollX, scrollY)，并顺带计算指针坐标与
 * “角度是否被锁定”：按住 shift 等离散角度约束时不应画中点，否则会让用户
 * 误以为中点吸附仍然生效。
 */
const renderBindingHighlightForBindableElement = (
  app: AppClassProperties,
  context: CanvasRenderingContext2D,
  suggestedBinding: AppState["suggestedBinding"],
  allElementsMap: NonDeletedSceneElementsMap,
  appState: InteractiveCanvasAppState,
  deltaTime: number,
  state?: { runtime: number },
) => {
  if (suggestedBinding === null) {
    return;
  }

  if (getFeatureFlag("COMPLEX_BINDINGS")) {
    return renderBindingHighlightForBindableElement_complex(
      app,
      context,
      suggestedBinding.element,
      allElementsMap,
      appState,
      deltaTime,
      state,
    );
  }

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  const pointerCoords = app.lastPointerMoveCoords
    ? pointFrom<GlobalPoint>(
        app.lastPointerMoveCoords.x,
        app.lastPointerMoveCoords.y,
      )
    : null;
  const angleLocked =
    !!app.lastPointerMoveEvent &&
    shouldRotateWithDiscreteAngle(app.lastPointerMoveEvent);
  renderBindingHighlightForBindableElement_simple(
    context,
    suggestedBinding,
    allElementsMap,
    appState,
    pointerCoords,
    angleLocked,
  );
  context.restore();
};

/**
 * 选择框绘制所需的中间结构。
 *
 * 之所以不直接用元素对象：多选整体框、组框、协作选中框共享同一条绘制路径，
 * 预先算好包围盒与旋转中心，避免 renderSelectionBorder 里反复调用
 * getElementAbsoluteCoords / getCommonBounds。
 *
 * angle 对整体框/组框恒为 0（轴对齐），只有单元素框才带真实角度。
 */
type ElementSelectionBorder = {
  angle: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  selectionColors: string[];
  dashed?: boolean;
  cx: number;
  cy: number;
  activeEmbeddable: boolean;
  padding?: number;
};

/**
 * 画单个选中元素（或一组元素 / 多选整体）的边框。
 *
 * selectionColors 是数组而不是单色：多人协作时同一条边要按“每个协作者一种
 * 颜色”重复描边，再用 lineDashOffset 把虚线相位错开，形成彩虹虚线来区分
 * 不同人的选中态；count 为颜色数，虚线周期必须乘以 count，否则各色虚线会
 * 完全重叠成一种颜色。
 *
 * 参数要点：
 *   - x1/y1/x2/y2：元素绝对包围盒（场景坐标，含旋转后的外接矩形）；
 *   - cx/cy：旋转中心，交给 strokeRectWithRotation_simple 做旋转；
 *   - padding：默认 DEFAULT_TRANSFORM_HANDLE_SPACING * 2，图片/裁剪时
 *     调用方传 0，让边框紧贴图片边缘；
 *   - activeEmbeddable：嵌入内容被激活时线宽从 1px 加粗到 4px。
 * 所有尺寸都除以 zoom，保证屏幕上恒定。
 */
const renderSelectionBorder = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementProperties: ElementSelectionBorder,
) => {
  const {
    angle,
    x1,
    y1,
    x2,
    y2,
    selectionColors,
    cx,
    cy,
    dashed,
    activeEmbeddable,
  } = elementProperties;
  const elementWidth = x2 - x1;
  const elementHeight = y2 - y1;

  const padding =
    elementProperties.padding ?? DEFAULT_TRANSFORM_HANDLE_SPACING * 2;

  const linePadding = padding / appState.zoom.value;
  const lineWidth = 8 / appState.zoom.value;
  const spaceWidth = 4 / appState.zoom.value;

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.lineWidth = (activeEmbeddable ? 4 : 1) / appState.zoom.value;

  // 每个协作者一种颜色，逐层描同一条边；虚线周期乘以颜色数，配合下面的
  // lineDashOffset 让各色虚线首尾相接而不是彼此覆盖。
  const count = selectionColors.length;
  for (let index = 0; index < count; ++index) {
    context.strokeStyle = selectionColors[index];
    // 每一层虚线相位错开一个“实线 + 空白”周期，count 层刚好铺满整个虚线
    // 周期；否则多层颜色会从同一相位出发，看起来只剩最后一层。
    if (dashed) {
      context.setLineDash([
        lineWidth,
        spaceWidth + (lineWidth + spaceWidth) * (count - 1),
      ]);
    }
    context.lineDashOffset = (lineWidth + spaceWidth) * index;
    strokeRectWithRotation_simple(
      context,
      x1 - linePadding,
      y1 - linePadding,
      elementWidth + linePadding * 2,
      elementHeight + linePadding * 2,
      cx,
      cy,
      angle,
    );
  }
  context.restore();
};

/**
 * 高亮一个 frame（悬停或选中 frame 时的蓝色描边）。
 *
 * 使用 getElementAbsoluteCoords 而不是直接读 x/y/width/height：frame 可能
 * 带旋转，只有绝对坐标才是旋转后的包围盒。圆角半径按 zoom 反算，否则放大
 * 后圆角要么消失成直角，要么大到看似圆框。
 */
const renderFrameHighlight = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  frame: NonDeleted<ExcalidrawFrameLikeElement>,
  elementsMap: ElementsMap,
) => {
  const [x1, y1, x2, y2] = getElementAbsoluteCoords(frame, elementsMap);
  const width = x2 - x1;
  const height = y2 - y1;

  context.strokeStyle = getThemedColor("rgb(0,118,255)", appState.theme);
  context.lineWidth = FRAME_STYLE.strokeWidth / appState.zoom.value;

  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  strokeRectWithRotation_simple(
    context,
    x1,
    y1,
    width,
    height,
    x1 + width / 2,
    y1 + height / 2,
    frame.angle,
    false,
    FRAME_STYLE.radius / appState.zoom.value,
  );
  context.restore();
};

/**
 * 给一组元素画统一的包围盒高亮（hover 高亮、锁定元素提示、搜索命中区域等）。
 *
 * 元素分两类：无 groupIds 的逐个元素一个框；属于组的按“当前被选中的组”
 * 合并成一个框（由 selectGroupsFromGivenElements 根据 appState 判断）。这样
 * 组整体被选中时不会出现一堆小框套在大框里的视觉噪音。
 *
 * 组框用虚线：虚线在视觉上表示“这是聚合框，不是真实元素边界”。颜色默认取
 * 主题蓝，锁定元素由调用方传入灰色 + dashed。
 *
 * @param config.colors 覆盖默认描边色（多色会画成彩虹虚线）
 * @param config.dashed 强制虚线
 */
const renderElementsBoxHighlight = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elements: readonly NonDeletedExcalidrawElement[],
  config?: { colors?: string[]; dashed?: boolean },
) => {
  const {
    colors = [getThemedColor("rgb(0,118,255)", appState.theme)],
    dashed = false,
  } = config || {};
  // 组内元素单独画框会显得杂乱，因此拆成“无组元素列表 + 组元素列表”，
  // 前者逐个成框，后者按选中组聚合成一个框。
  const individualElements = elements.filter(
    (element) => element.groupIds.length === 0,
  );

  const elementsInGroups = elements.filter(
    (element) => element.groupIds.length > 0,
  );

  // 统一转换成 ElementSelectionBorder，复用同一个绘制函数，保证组框、单框、
  // 多选整体框的线宽与虚线节奏完全一致。
  const getSelectionFromElements = (elements: ExcalidrawElement[]) => {
    const [x1, y1, x2, y2] = getCommonBounds(elements);
    return {
      angle: 0,
      x1,
      x2,
      y1,
      y2,
      selectionColors: colors,
      dashed,
      cx: x1 + (x2 - x1) / 2,
      cy: y1 + (y2 - y1) / 2,
      activeEmbeddable: false,
    };
  };

  const getSelectionForGroupId = (groupId: GroupId) => {
    const groupElements = getElementsInGroup(elements, groupId);
    return getSelectionFromElements(groupElements);
  };

  // selectGroupsFromGivenElements 返回 groupId → 是否选中的映射；先过滤出
  // true 的组，再按组取元素集合计算公共包围盒。
  Object.entries(selectGroupsFromGivenElements(elementsInGroups, appState))
    .filter(([id, isSelected]) => isSelected)
    .map(([id, isSelected]) => id)
    .map((groupId) => getSelectionForGroupId(groupId))
    .concat(
      // 无组元素排在组框之后绘制，保证它们的框不会被聚合框盖住一截；
      // 这一顺序只影响覆盖关系，不影响命中。
      individualElements.map((element) => getSelectionFromElements([element])),
    )
    .forEach((selection) =>
      renderSelectionBorder(context, appState, selection),
    );
};

/**
 * 画线性元素（线 / 箭头）的所有可拖拽端点与线段中点。
 *
 * 前置条件：selectedLinearElement 非空，否则说明当前没进入线性编辑态，直接
 * 返回，避免在多选等场景误画手柄。
 *
 * 端点规则：
 *   - 肘形箭头只允许拖首尾两点，中间拐点由路由算法决定，跳过；
 *   - 闭合多边形（polygon）首尾坐标重合，且末点绘制在上层，因此首点被选中
 *     时要同步把末点标成选中，否则用户看不到选中反馈；
 *   - 重叠判定使用 2/zoom 的容差：缩放越小容差越大，避免亚像素差导致漏判。
 *
 * 中点规则：
 *   - 肘形箭头：逐段求几何中点，但跳过“太短”的段（isSegmentTooShort），
 *     否则相邻中点手柄会挤在一起无法点中；fixedSegments 中的段画成 phantom，
 *     表示该段不允许插入新点；
 *   - 普通线：用 getEditorMidPoints（会考虑绑定后的实际走向），并且只在
 *     编辑态或恰好两个端点时显示，避免常态下的视觉噪音。
 *
 * 整个函数包在一个 save/restore 中，统一 translate scroll 并设置 1/zoom 线宽。
 */
const renderLinearPointHandles = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  element: NonDeleted<ExcalidrawLinearElement>,
  elementsMap: RenderableElementsMap,
) => {
  if (!appState.selectedLinearElement) {
    return;
  }
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.lineWidth = 1 / appState.zoom.value;
  const points: GlobalPoint[] = LinearElementEditor.getPointsGlobalCoordinates(
    element,
    elementsMap,
  );

  const { POINT_HANDLE_SIZE } = LinearElementEditor;
  const radius = appState.selectedLinearElement?.isEditing
    ? POINT_HANDLE_SIZE
    : POINT_HANDLE_SIZE / 2;

  const _isElbowArrow = isElbowArrow(element);
  const _isLineElement = isLineElement(element);

  // 逐点绘制。注意不能用 forEach 的返回值提前退出，因此肘形箭头的中间拐点
  // 用 continue 语义（return）跳过；points 的顺序就是元素 points 的顺序，
  // idx 同时被用于 selectedPointsIndices 与 fixedSegments 判断。
  points.forEach((point, idx) => {
    if (_isElbowArrow && idx !== 0 && idx !== points.length - 1) {
      return;
    }

    const isOverlappingPoint =
      idx > 0 &&
      (idx !== points.length - 1 || !_isLineElement || !element.polygon) &&
      pointsEqual(
        point,
        idx === points.length - 1 ? points[0] : points[idx - 1],
        2 / appState.zoom.value,
      );

    let isSelected =
      !!appState.selectedLinearElement?.isEditing &&
      !!appState.selectedLinearElement?.selectedPointsIndices?.includes(idx);
    // 首尾点重合时末点绘制在上层（后画），用户实际看到的是末点；因此选中
    // 首点必须同步把末点也标成选中，否则点下去像是没有反馈。
    // when element is a polygon, highlight the last point as well if first
    // point is selected since they overlap and the last point tends to be
    // rendered on top
    if (
      _isLineElement &&
      element.polygon &&
      !isSelected &&
      idx === element.points.length - 1 &&
      !!appState.selectedLinearElement?.isEditing &&
      !!appState.selectedLinearElement?.selectedPointsIndices?.includes(0)
    ) {
      isSelected = true;
    }

    renderSingleLinearPoint(
      context,
      appState,
      point,
      radius,
      isSelected,
      false,
      isOverlappingPoint,
    );
  });

  // Rendering segment mid points
  // 中点手柄分两条路径：肘形箭头必须走几何中点（路径由算法决定，编辑器
  // 中点没有意义），普通线性元素走 getEditorMidPoints（会考虑绑定后实际
  // 曲线走向，两段之间的视觉中点可能与几何中点不同）。
  if (isElbowArrow(element)) {
    const fixedSegments =
      element.fixedSegments?.map((segment) => segment.index) || [];
    points.slice(0, -1).forEach((p, idx) => {
      if (
        !LinearElementEditor.isSegmentTooShort(
          element,
          points[idx + 1],
          points[idx],
          idx,
          appState.zoom,
          elementsMap,
        )
      ) {
        renderSingleLinearPoint(
          context,
          appState,
          pointFrom<GlobalPoint>(
            (p[0] + points[idx + 1][0]) / 2,
            (p[1] + points[idx + 1][1]) / 2,
          ),
          POINT_HANDLE_SIZE / 2,
          false,
          !fixedSegments.includes(idx + 1),
          false,
        );
      }
    });
  } else {
    const midPoints = LinearElementEditor.getEditorMidPoints(
      element,
      elementsMap,
      appState,
    ).filter(
      (midPoint, idx, midPoints): midPoint is GlobalPoint =>
        midPoint !== null &&
        !(isElbowArrow(element) && (idx === 0 || idx === midPoints.length - 1)),
    );

    midPoints.forEach((segmentMidPoint) => {
      if (appState.selectedLinearElement?.isEditing || points.length === 2) {
        renderSingleLinearPoint(
          context,
          appState,
          segmentMidPoint,
          POINT_HANDLE_SIZE / 2,
          false,
          true,
          false,
        );
      }
    });
  }

  context.restore();
};

/**
 * 画箭头端点到绑定聚焦点（focus point）的虚线连线。
 *
 * 作用是让用户理解“箭头看起来没连上，但逻辑上绑定在这里”。线宽与虚线间隔
 * 都除以 zoom，保证屏幕上恒为 1px 实线与 4/4 的虚线节奏。
 *
 * @param fromPoint 箭头端点（场景坐标）
 * @param toPoint 聚焦点（场景坐标）
 */
const renderFocusPointConnectionLine = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  fromPoint: GlobalPoint,
  toPoint: GlobalPoint,
) => {
  context.save();
  context.translate(appState.scrollX, appState.scrollY);

  context.strokeStyle = getThemedColor(
    "rgba(134, 131, 226, 0.6)",
    appState.theme,
  );
  context.lineWidth = 1 / appState.zoom.value;
  context.setLineDash([4 / appState.zoom.value, 4 / appState.zoom.value]);

  context.beginPath();
  context.moveTo(fromPoint[0], fromPoint[1]);
  context.lineTo(toPoint[0], toPoint[1]);
  context.stroke();

  context.restore();
};

/**
 * 画绑定聚焦点的小圆（hover 时填充加深）。
 *
 * 与 highlightPoint 的区别：这个点是持久指示（代表绑定锚点），不是瞬时
 * hover 反馈，因此用描边 + 白底；半径由调用方按 FOCUS_POINT_SIZE 换算后传入，
 * 这里只负责除 zoom。
 */
const renderFocusPointCicle = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  point: GlobalPoint,
  radius: number,
  isHovered: boolean,
) => {
  context.save();
  context.translate(appState.scrollX, appState.scrollY);
  context.strokeStyle = getThemedColor(
    "rgba(134, 131, 226, 0.6)",
    appState.theme,
  );
  context.lineWidth = 1 / appState.zoom.value;
  context.setLineDash([]);
  context.fillStyle = getThemedColor(
    isHovered ? "rgba(134, 131, 226, 0.9)" : "rgba(255, 255, 255, 0.9)",
    appState.theme,
  );

  fillCircle(
    context,
    point[0],
    point[1],
    radius / appState.zoom.value,
    true,
    true,
  );
  context.restore();
};

/**
 * 画箭头某一端（start / end）的绑定聚焦点指示，共三层：
 *   1. hover 高亮（仅在悬停该端点、且未拖拽它时）；
 *   2. 端点 → 聚焦点的虚线；
 *   3. 聚焦点小圆。
 *
 * 跳过条件：
 *   - 该端没有 binding，或 binding 指向的元素已删除 / 不可绑定；
 *   - isFocusPointVisible 判定聚焦点当前不可见（例如被箭头自身遮挡）；
 *   - 端点正被拖拽且已选中：此时端点跟随指针，再画虚线会闪烁。
 *
 * 注意 binding.fixedPoint 是相对元素的归一化坐标（0~1），必须经
 * getGlobalFixedPointForBindableElement 转成场景坐标才能绘制；直接用会画到
 * 画布左上角附近。
 */
const renderFocusPointIndicator = ({
  arrow,
  appState,
  type,
  context,
  elementsMap,
}: {
  arrow: NonDeleted<ExcalidrawArrowElement>;
  appState: InteractiveCanvasAppState;
  context: CanvasRenderingContext2D;
  elementsMap: NonDeletedSceneElementsMap;
  type: "start" | "end";
}) => {
  const binding = type === "start" ? arrow.startBinding : arrow.endBinding;
  const bindableElement =
    binding?.elementId && elementsMap.get(binding.elementId);

  if (
    !bindableElement ||
    !isBindableElement(bindableElement) ||
    bindableElement.isDeleted
  ) {
    return;
  }

  const focusPoint = getGlobalFixedPointForBindableElement(
    binding.fixedPoint,
    bindableElement,
    elementsMap,
  );

  // Only render if focus point is within the bindable element
  // 聚焦点必须仍在目标元素内部且未被箭头自身遮挡才画，否则会出现
  // “悬浮在空白处的小圆”，反而让用户以为绑定失效。
  if (
    !isFocusPointVisible(
      focusPoint,
      arrow,
      bindableElement,
      elementsMap,
      appState,
      type,
    )
  ) {
    return;
  }

  const linearState = appState.selectedLinearElement;
  const isDragging = !!linearState?.isDragging;
  const pointIndex = type === "start" ? 0 : arrow.points.length - 1;
  const pointSelected =
    !!linearState?.selectedPointsIndices?.includes(pointIndex);

  // render focus point highlight
  // ----------------------------
  // 高亮层画在圆点之下：先叠加的半透明圆让下面的虚线/圆点显得“被照亮”，
  // 而不是把圆点整体染成另一种颜色。

  // hover 高亮与“拖拽该聚焦点”互斥：拖拽时端点跟随指针，再由拖拽反馈负责
  // 视觉，叠加高亮会让颜色变深、看起来像两个点。
  if (
    linearState?.hoveredFocusPointBinding === type &&
    !linearState.draggedFocusPointBinding
  ) {
    highlightPoint(focusPoint, context, appState);
  }

  // render focus point
  // ----------------------------

  if (!(pointSelected && isDragging)) {
    const focusPoint = getGlobalFixedPointForBindableElement(
      binding.fixedPoint,
      bindableElement,
      elementsMap,
    );

    const isHovered = linearState?.hoveredFocusPointBinding === type;

    // Render dashed line from arrow start point to focus point
    // 端点坐标要与 focus point 同一个坐标系（场景坐标），否则旋转元素上
    // 连线会指向错误方向。
    const arrowPoint = LinearElementEditor.getPointAtIndexGlobalCoordinates(
      arrow,
      pointIndex,
      elementsMap,
    );

    renderFocusPointConnectionLine(context, appState, arrowPoint, focusPoint);

    renderFocusPointCicle(
      context,
      appState,
      focusPoint,
      FOCUS_POINT_SIZE / 1.5,
      isHovered,
    );
  }
};

/**
 * 画 8 个缩放 / 旋转手柄。
 *
 * key 决定形态：rotation 画圆，其余画小方块（优先 roundRect，浏览器不支持时
 * 退回 strokeRectWithRotation_simple）。坐标已由 getTransformHandles /
 * getTransformHandlesFromCoords 算好并含 scroll，这里不能再 translate。
 *
 * 状态约定：fillStyle 由调用方设为白色，本函数只设置描边色与 1/zoom 线宽，
 * 避免每个手柄重复设状态。transformHandle 为 undefined 的边（例如 frame
 * 禁用了旋转）直接跳过。
 */
const renderTransformHandles = (
  context: CanvasRenderingContext2D,
  renderConfig: InteractiveCanvasRenderConfig,
  appState: InteractiveCanvasAppState,
  transformHandles: TransformHandles,
  angle: number,
): void => {
  Object.keys(transformHandles).forEach((key) => {
    const transformHandle = transformHandles[key as TransformHandleType];
    if (transformHandle !== undefined) {
      const [x, y, width, height] = transformHandle;

      context.save();
      context.lineWidth = 1 / appState.zoom.value;
      if (renderConfig.selectionColor) {
        context.strokeStyle = renderConfig.selectionColor;
      }
      // 旋转手柄画圆，其余画圆角小方块；两者都保持轴对齐（不随元素旋转），
      // 只有缺少 roundRect 的退化路径才用旋转矩形绘制。
      if (key === "rotation") {
        fillCircle(context, x + width / 2, y + height / 2, width / 2, true);
        // prefer round corners if roundRect API is available
      } else if (context.roundRect) {
        context.beginPath();
        context.roundRect(x, y, width, height, 2 / appState.zoom.value);
        context.fill();
        context.stroke();
      } else {
        strokeRectWithRotation_simple(
          context,
          x,
          y,
          width,
          height,
          x + width / 2,
          y + height / 2,
          angle,
          true, // fill before stroke
        );
      }
      context.restore();
    }
  });
};

/**
 * 画图片裁剪态的四个角手柄（每个角是两条 20px 的“L”形短线）。
 *
 * handles 表把四个角编码为 [角点偏移, 横线起止, 竖线起止] 五组坐标，全部相对
 * 元素中心表达，因此循环里只要 translate(cx, cy) + rotate(角度) 就能一次性
 * 处理旋转图片，不必为每个角单独算旋转矩阵。
 *
 * 线段长度会被 Math.min(20/zoom, 半宽/半高) 截断：图片很小时手柄不能超出
 * 图片边界，否则看起来像画到了外面。旋转中心取 getElementAbsoluteCoords 的
 * cx/cy（包围盒中心），与元素自身旋转中心一致。
 */
const renderCropHandles = (
  context: CanvasRenderingContext2D,
  renderConfig: InteractiveCanvasRenderConfig,
  appState: InteractiveCanvasAppState,
  croppingElement: ExcalidrawImageElement,
  elementsMap: ElementsMap,
): void => {
  const [x1, y1, , , cx, cy] = getElementAbsoluteCoords(
    croppingElement,
    elementsMap,
  );

  const LINE_WIDTH = 3;
  const LINE_LENGTH = 20;

  const ZOOMED_LINE_WIDTH = LINE_WIDTH / appState.zoom.value;
  const ZOOMED_HALF_LINE_WIDTH = ZOOMED_LINE_WIDTH / 2;

  const HALF_WIDTH = cx - x1 + ZOOMED_LINE_WIDTH;
  const HALF_HEIGHT = cy - y1 + ZOOMED_LINE_WIDTH;

  const HORIZONTAL_LINE_LENGTH = Math.min(
    LINE_LENGTH / appState.zoom.value,
    HALF_WIDTH,
  );
  const VERTICAL_LINE_LENGTH = Math.min(
    LINE_LENGTH / appState.zoom.value,
    HALF_HEIGHT,
  );

  context.save();
  context.fillStyle = renderConfig.selectionColor;
  context.strokeStyle = renderConfig.selectionColor;
  context.lineWidth = ZOOMED_LINE_WIDTH;

  // 四个角的手柄表：[角点偏移, 横线起点, 横线终点, 竖线起点, 竖线终点]。
  // 所有坐标都相对元素中心，横线向左/右延伸、竖线向上/下延伸，拼出“⌐”形。
  const handles: Array<
    [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ]
  > = [
    [
      // x, y
      [-HALF_WIDTH, -HALF_HEIGHT],
      // horizontal line: first start and to
      [0, ZOOMED_HALF_LINE_WIDTH],
      [HORIZONTAL_LINE_LENGTH, ZOOMED_HALF_LINE_WIDTH],
      // vertical line: second  start and to
      [ZOOMED_HALF_LINE_WIDTH, 0],
      [ZOOMED_HALF_LINE_WIDTH, VERTICAL_LINE_LENGTH],
    ],
    [
      [HALF_WIDTH - ZOOMED_HALF_LINE_WIDTH, -HALF_HEIGHT],
      [ZOOMED_HALF_LINE_WIDTH, ZOOMED_HALF_LINE_WIDTH],
      [
        -HORIZONTAL_LINE_LENGTH + ZOOMED_HALF_LINE_WIDTH,
        ZOOMED_HALF_LINE_WIDTH,
      ],
      [0, 0],
      [0, VERTICAL_LINE_LENGTH],
    ],
    [
      [-HALF_WIDTH, HALF_HEIGHT],
      [0, -ZOOMED_HALF_LINE_WIDTH],
      [HORIZONTAL_LINE_LENGTH, -ZOOMED_HALF_LINE_WIDTH],
      [ZOOMED_HALF_LINE_WIDTH, 0],
      [ZOOMED_HALF_LINE_WIDTH, -VERTICAL_LINE_LENGTH],
    ],
    [
      [HALF_WIDTH - ZOOMED_HALF_LINE_WIDTH, HALF_HEIGHT],
      [ZOOMED_HALF_LINE_WIDTH, -ZOOMED_HALF_LINE_WIDTH],
      [
        -HORIZONTAL_LINE_LENGTH + ZOOMED_HALF_LINE_WIDTH,
        -ZOOMED_HALF_LINE_WIDTH,
      ],
      [0, 0],
      [0, -VERTICAL_LINE_LENGTH],
    ],
  ];

  handles.forEach((handle) => {
    const [[x, y], [x1s, y1s], [x1t, y1t], [x2s, y2s], [x2t, y2t]] = handle;

    context.save();
    context.translate(cx, cy);
    context.rotate(croppingElement.angle);

    context.beginPath();
    context.moveTo(x + x1s, y + y1s);
    context.lineTo(x + x1t, y + y1t);
    context.stroke();

    context.beginPath();
    context.moveTo(x + x2s, y + y2s);
    context.lineTo(x + x2t, y + y2t);
    context.stroke();
    context.restore();
  });

  context.restore();
};

/**
 * 画文本编辑框（虚线框 + 内边距）。
 *
 * 虚线框比文字本身大 padding（由 getTextBoxPadding 按 zoom 计算），给光标和
 * 字符升降部留出呼吸空间。先 translate 到文本中心再 rotate，让框跟随文本角度；
 * globalAlpha 0.5 避免框盖过文字；虚线长度同样按 zoom 反算。
 */
const renderTextBox = (
  text: ExcalidrawTextElement,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  selectionColor: InteractiveCanvasRenderConfig["selectionColor"],
) => {
  context.save();
  const padding = getTextBoxPadding(appState.zoom.value);
  const width = text.width + padding * 2;
  const height = text.height + padding * 2;
  const cx = text.x + text.width / 2;
  const cy = text.y + text.height / 2;
  const shiftX = -(text.width / 2 + padding);
  const shiftY = -(text.height / 2 + padding);
  context.translate(cx + appState.scrollX, cy + appState.scrollY);
  context.rotate(text.angle);
  context.lineWidth = 1 / appState.zoom.value;
  context.strokeStyle = selectionColor;
  context.globalAlpha = 0.5;
  context.setLineDash([6 / appState.zoom.value, 4 / appState.zoom.value]);
  context.strokeRect(shiftX, shiftY, width, height);
  context.restore();
};

/**
 * 文本工具悬停提示的三种语义（对应 hover.type）：
 *   - "text"：命中的是已有文本，画与编辑态相同的虚线框，点击即进入编辑；
 *   - "container"：命中的是可绑定空容器，画绑定轮廓（不含呼吸动画，也不受
 *     isBindingEnabled 开关限制，因为目标已经由命中测试按修饰键解析过）；
 *   - "arrow"：命中的是箭头端点或标签锚点，画一个圆点。
 * 三者都只是“点击后会发生什么”的预览，不修改任何状态。
 */
/**
 * The text tool's hover affordance — what a click would act on (see
 * `AppTextTool`): a dashed box around the text it would edit, the binding
 * outline around the empty container it would label, or a point on the arrow
 * anchor (free endpoint / midpoint label) it would attach text to.
 *
 * Purely presentational: `AppTextTool` keeps the state current at every event
 * that can change it. The element lookup only guards against the element
 * vanishing through channels no local event covers, e.g. a collaborator
 * deleting it.
 */
const renderTextToolHover = (
  app: AppClassProperties,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  elementsMap: NonDeletedSceneElementsMap,
  selectionColor: InteractiveCanvasRenderConfig["selectionColor"],
) => {
  const hover = appState.textToolHover!;
  const element = elementsMap.get(hover.elementId);
  if (!element || element.isDeleted) {
    return;
  }
  switch (hover.type) {
    case "text": {
      if (isTextElement(element)) {
        // the same subtle box as around a wrapped text being edited; a
        // label's stored coords can be stale, so derive them
        renderTextBox(
          getTextElementWithAccuratePosition(element, elementsMap),
          context,
          appState,
          selectionColor,
        );
      }
      return;
    }
    case "container": {
      if (isBindableElement(element)) {
        // the outline arrow binding shows, minus its animation and its
        // `isBindingEnabled` gate: the resolved target already accounts for
        // the modifier, independently of the arrow-binding preference
        // 复用 simple 版轮廓，但刻意不传 angleLocked（默认 false）：文本工具
        // 没有角度约束的概念。这里手动补 scroll，因为 simple 版假定调用方
        // 已完成平移。
        context.save();
        context.translate(appState.scrollX, appState.scrollY);
        renderBindingHighlightForBindableElement_simple(
          context,
          { element },
          elementsMap,
          appState,
          app.lastPointerMoveCoords
            ? pointFrom<GlobalPoint>(
                app.lastPointerMoveCoords.x,
                app.lastPointerMoveCoords.y,
              )
            : null,
        );
        context.restore();
      }
      return;
    }
    case "arrow": {
      if (isArrowElement(element)) {
        // label 锚点用绑定文本的中心（箭头中段），start/end 用端点场景坐标；
        // -1 是“最后一个点”的惯用写法，与 points.length - 1 等价。
        const point =
          hover.anchor === "label"
            ? LinearElementEditor.getBoundTextElementCenter(
                element,
                elementsMap,
              )
            : LinearElementEditor.getPointAtIndexGlobalCoordinates(
                element,
                hover.anchor === "start" ? 0 : -1,
                elementsMap,
              );
        highlightPoint(point, context, appState);
      }
    }
  }
};

/**
 * 画“文本自动换行后仍可恢复宽度”的提示手柄（右下角的斜向折线）。
 *
 * 只有非 autoResize 文本才有这个手柄（autoResize 文本宽度随内容变化，无需
 * 恢复），getTextAutoResizeHandle 返回 null 时说明当前缩放/形态下不适用，
 * 直接跳过。半透明 + round lineCap，让它看起来像操作提示而不是内容。
 */
const renderResetAutoResizeHandle = (
  text: ExcalidrawTextElement,
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  selectionColor: InteractiveCanvasRenderConfig["selectionColor"],
  formFactor: EditorInterface["formFactor"],
) => {
  const autoResizeHandle = getTextAutoResizeHandle(
    text,
    appState.zoom.value,
    formFactor,
  );

  if (!autoResizeHandle) {
    return;
  }

  context.save();
  context.globalAlpha = 0.5;
  context.lineWidth = 1.5 / appState.zoom.value;
  context.lineCap = "round";
  context.strokeStyle = selectionColor;
  context.beginPath();
  context.moveTo(
    autoResizeHandle.start[0] + appState.scrollX,
    autoResizeHandle.start[1] + appState.scrollY,
  );
  context.lineTo(
    autoResizeHandle.end[0] + appState.scrollX,
    autoResizeHandle.end[1] + appState.scrollY,
  );
  context.stroke();
  context.restore();
};

/**
 * 交互层主绘制函数：一次把当前帧所有 UI 覆盖物画到 canvas 上。
 *
 * 调用关系：只由本文件的 renderInteractiveScene 调用；后者由 InteractiveCanvas
 * 注册进 AnimationController，每帧执行一次（React 重渲染只更新 rendererParams
 * ref，不会直接触发绘制）。
 *
 * 参数要点：
 *   - elementsMap：经过视口/状态过滤的可见元素，用于绘制；
 *   - visibleElements：同上但保序，用于定位“正在编辑的线性元素”——协作场景下
 *     ShapeCache 可能落后一个版本，必须从 visibleElements 里取实体对象；
 *   - allElementsMap：未过滤全集，绑定目标与锁定元素可能不在可见集里；
 *   - selectedElements：选中元素，决定选择框与手柄；
 *   - animationState / deltaTime：帧间动画状态与毫秒间隔。
 *
 * 返回值：{ scrollBars, animationState }。scrollBars 交给 App 计算可滚动区域；
 * animationState 由 AnimationController 保存并在下一帧回传，只要其中还有
 * 非 undefined 字段（例如 bindingHighlight），循环就会继续。
 *
 * 关键不变量：
 *   - canvas 为 null（首次挂载前）时返回 {}，调用方必须容忍；
 *   - scroll 必须与静态层使用同一个 snapScrollToDevicePixels 结果，否则两层
 *     会出现半像素错位（表现为覆盖物抖动）；
 *   - 除 renderRemoteCursors 与滚动条（自行处理视口坐标）外，所有绘制都在
 *     scale(zoom) 之后、由各片段自行叠加 scroll。
 *   - textToolHover 等可选状态全部用 if 守卫，缺失时不影响其余层。
 */
const _renderInteractiveScene = ({
  app,
  canvas,
  elementsMap,
  visibleElements,
  selectedElements,
  allElementsMap,
  scale,
  appState: unsnappedAppState,
  renderConfig,
  editorInterface,
  animationState,
  deltaTime,
}: InteractiveSceneRenderConfig): {
  scrollBars?: ReturnType<typeof getScrollBars>;
  animationState?: typeof animationState;
} => {
  if (canvas === null) {
    return {};
  }

  // the same whole-device-pixel scroll the static scene draws at, so the
  // overlays sit exactly on the content
  const appState = snapScrollToDevicePixels(unsnappedAppState, scale);

  // 归一化尺寸 = 位图尺寸 / scale，即逻辑像素；滚动条与协作光标都基于它定位，
  // 避免在 devicePixelRatio > 1 的屏幕上偏到画布外。
  const [normalizedWidth, normalizedHeight] = getNormalizedCanvasDimensions(
    canvas,
    scale,
  );
  // 动画状态按“展开旧状态 + 覆盖字段”传递：本帧没有动画时也必须显式把
  // bindingHighlight 置为 undefined，否则 AnimationController 会以为动画
  // 仍在进行而持续空转，白白占用一帧 rAF。
  let nextAnimationState = animationState;

  const context = bootstrapCanvas({
    canvas,
    scale,
    normalizedWidth,
    normalizedHeight,
  });

  // Apply zoom
  context.save();
  context.scale(appState.zoom.value, appState.zoom.value);

  // 从这里到 context.restore() 之前，坐标系已经乘过 zoom。绘制顺序即层级
  // （后画的覆盖先画的），顺序刻意与 StaticCanvas 的“内容在下、交互在上”对齐：
  //   1. 正在编辑的线性元素端点手柄（最底层，避免盖住后续选择框）
  //   2. 框选矩形 selectionElement
  //   3. 文本自动宽度提示与文本编辑虚线框
  //   4. 绑定高亮（唯一带持续动画的层，会把新的 animationState 写回）
  //   5. 文本工具悬停提示、frame 高亮、元素组高亮、锁定高亮
  //   6. 线性编辑态端点、箭头 hover 高亮与绑定 focus point
  //   7. 选择边框与变换手柄（单选用元素自身角度，多选用公共包围盒）
  //   8. 搜索命中底色、吸附参考线
  // 之后 restore 回视口坐标，再画协作光标与滚动条。
  let editingLinearElement: NonDeleted<ExcalidrawLinearElement> | undefined =
    undefined;

  // 在 visibleElements 中定位“正在编辑的线性元素”的实体对象。之所以不用
  // elementsMap：协作场景下 ShapeCache 可能落后一个版本，返回空 shape，导致
  // 端点手柄全部落在 (0,0)。
  visibleElements.forEach((element) => {
    // Getting the element using LinearElementEditor during collab mismatches version - being one head of visible elements due to
    // ShapeCache returns empty hence making sure that we get the
    // correct element from visible elements
    if (
      appState.selectedLinearElement?.isEditing &&
      appState.selectedLinearElement.elementId === element.id
    ) {
      if (element) {
        editingLinearElement = element as NonDeleted<ExcalidrawLinearElement>;
      }
    }
  });

  // 线性元素编辑态优先：端点手柄必须画在元素之上，且编辑期间不画普通
  // 选择框（hasBoundingBox 在 App.selection 侧已处理）。
  if (editingLinearElement) {
    renderLinearPointHandles(
      context,
      appState,
      editingLinearElement,
      elementsMap,
    );
  }

  // 框选矩形：selectionElement 是临时元素，只在拖拽框选时存在；
  // 裁剪图片时不画，避免和裁剪框重叠。
  // Paint selection element
  if (appState.selectionElement && !appState.isCropping) {
    // renderSelectionElement 复用元素渲染管线，异常不应中断整个交互层，
    // 因此这里兜底 catch：宁可少画一个框，也不能让选择框与手柄全部消失。
    try {
      renderSelectionElement(
        appState.selectionElement,
        context,
        appState,
        renderConfig.selectionColor,
      );
    } catch (error: any) {
      console.error(error);
    }
  }

  // 自动换行文本会额外画一个“恢复宽度”提示；autoResize 文本宽度跟随内容，
  // 不存在“恢复”的概念，因此这里显式排除。selectedElements 而非 appState
  // 决定了活动文本：多选时只有唯一文本才会进入此分支。
  const activeTextElement = getActiveTextElement(selectedElements, appState);

  if (activeTextElement && !activeTextElement.autoResize) {
    renderResetAutoResizeHandle(
      activeTextElement,
      context,
      appState,
      renderConfig.selectionColor,
      editorInterface.formFactor,
    );
  }

  // 编辑态文本的虚线框。这里从 allElementsMap 取元素而不是 elementsMap：
  // 正在编辑的文本可能因为过滤（例如容器内文字）不在可见集里，但仍需要
  // 画出编辑框。autoResize 文本的框由 DOM 输入层负责，这里跳过。
  if (appState.editingTextElement) {
    const textElement = allElementsMap.get(appState.editingTextElement.id) as
      | ExcalidrawTextElement
      | undefined;
    if (textElement && !textElement.autoResize) {
      renderTextBox(
        textElement,
        context,
        appState,
        renderConfig.selectionColor,
      );
    }
  }

  // 绑定高亮是唯一带持续动画的交互层：suggestedBinding 由指针移动时的
  // 命中测试写入，这里用 deltaTime 推进呼吸效果，并把新的 animationState
  // 返回给 AnimationController，下一帧继续。
  if (appState.isBindingEnabled && appState.suggestedBinding) {
    nextAnimationState = {
      ...animationState,
      bindingHighlight: renderBindingHighlightForBindableElement(
        app,
        context,
        appState.suggestedBinding,
        allElementsMap,
        appState,
        deltaTime,
        animationState?.bindingHighlight,
      ),
    };
  } else {
    nextAnimationState = {
      ...animationState,
      bindingHighlight: undefined,
    };
  }

  // 文本工具的悬停预览：textToolHover 由 AppTextTool 在每次可能改变它的
  // 事件后写入，这里只负责画，不在渲染阶段做命中测试。
  if (appState.textToolHover) {
    renderTextToolHover(
      app,
      context,
      appState,
      allElementsMap,
      renderConfig.selectionColor,
    );
  }

  // frame 高亮由 hover 或“即将把元素拖入 frame”写入，是一个瞬时状态；
  // 用 elementsMap 取坐标，因此 frame 必须可见才会被画出来。
  if (appState.frameToHighlight) {
    renderFrameHighlight(
      context,
      appState,
      appState.frameToHighlight,
      elementsMap,
    );
  }

  // 搜索/命令面板列举元素时用它把一组元素框起来；颜色走默认主题蓝，
  // 与“选中”区分开（选中框由后面的 renderSelectionBorder 绘制）。
  if (appState.elementsToHighlight) {
    renderElementsBoxHighlight(context, appState, appState.elementsToHighlight);
  }

  // activeLockedId 表示“锁定的元素/组正处于可交互态”（例如 hover 后按了
  // 解锁快捷键的提示）。它可能是单个元素，也可能是组 id，因此先用
  // allElementsMap 试取，取不到再按组展开。这里刻意不做类型过滤：
  // 运行时数据可信，逐个 typecheck 会带来不必要的开销。
  if (appState.activeLockedId) {
    const element = allElementsMap.get(appState.activeLockedId);
    const elements = element
      ? [element]
      : getElementsInGroup(allElementsMap, appState.activeLockedId);
    renderElementsBoxHighlight(
      context,
      appState,
      elements as NonDeletedExcalidrawElement[], // We don't typecheck runtime because of performance
      {
        colors: [getThemedColor("#ced4da", appState.theme)],
        dashed: true,
      },
    );
  }

  // 选中 frame 时多选手柄不提供旋转（frame 的旋转在语义上不成立），
  // 这个标记会在下面的 getTransformHandlesFromCoords 里合并进 omitSides。
  const isFrameSelected = selectedElements.some((element) =>
    isFrameLikeElement(element),
  );

  // Getting the element using LinearElementEditor during collab mismatches version - being one head of visible elements due to
  // ShapeCache returns empty hence making sure that we get the
  // correct element from visible elements
  if (
    selectedElements.length === 1 &&
    appState.selectedLinearElement?.isEditing &&
    appState.selectedLinearElement.elementId === selectedElements[0].id
  ) {
    renderLinearPointHandles(
      context,
      appState,
      selectedElements[0] as NonDeleted<ExcalidrawLinearElement>,
      elementsMap,
    );
  }

  // 这里用 allElementsMap 而不是 elementsMap：被选中的线性元素可能刚好被
  // 过滤掉（例如位于折叠 frame 内），但仍应显示 hover 与 focus point 反馈。
  const linearState = appState.selectedLinearElement;
  const selectedLinearElement =
    linearState &&
    LinearElementEditor.getElement(linearState.elementId, allElementsMap);
  // Arrows have a different highlight behavior when
  // they are the only selected element
  if (selectedLinearElement) {
    // 只有唯一选中的线性元素才做 hover 高亮：多选时 hoverPointIndex 可能
    // 指向别的元素，直接用会画错位置。拖拽期间也不画，避免与实时手柄重复。
    if (!appState.selectedLinearElement.isDragging) {
      if (linearState.segmentMidPointHoveredCoords) {
        renderElbowArrowMidPointHighlight(context, appState);
      } else if (
        isElbowArrow(selectedLinearElement)
          ? linearState.hoverPointIndex === 0 ||
            linearState.hoverPointIndex ===
              selectedLinearElement.points.length - 1
          : linearState.hoverPointIndex >= 0
      ) {
        renderLinearElementPointHighlight(context, appState, elementsMap);
      }
    }

    // 箭头额外画两端的绑定 focus point，让用户看清“看似悬空但已绑定”的
    // 端点锚在哪里；非箭头线性元素没有 binding，跳过。
    if (isArrowElement(selectedLinearElement)) {
      renderFocusPointIndicator({
        arrow: selectedLinearElement,
        elementsMap: allElementsMap,
        appState,
        context,
        type: "start",
      });

      renderFocusPointIndicator({
        arrow: selectedLinearElement,
        elementsMap: allElementsMap,
        appState,
        context,
        type: "end",
      });
    }
  }

  // 三个互斥场景下不画常规选择框：
  //   - multiElement：正在连画多段线，未定稿元素不参与选择；
  //   - newElement：拖拽创建中的元素由 NewElementCanvas 负责；
  //   - selectedLinearElement.isEditing：线性编辑态用端点手柄表达选中，
  //     再画矩形框会与手柄语义冲突。
  // Paint selected elements
  if (
    !appState.multiElement &&
    !appState.newElement &&
    !appState.selectedLinearElement?.isEditing
  ) {
    const showBoundingBox = hasBoundingBox(
      selectedElements,
      appState,
      editorInterface,
    );

    // 线性元素单选且未锁定时才画端点手柄：锁定元素不可拖，画手柄会误导；
    // 多选时拖拽语义是整体平移，单独端点没有意义。
    const isSingleLinearElementSelected =
      selectedElements.length === 1 && isLinearElement(selectedElements[0]);
    // render selected linear element points
    if (
      isSingleLinearElementSelected &&
      appState.selectedLinearElement?.elementId === selectedElements[0].id &&
      !selectedElements[0].locked
    ) {
      renderLinearPointHandles(
        context,
        appState,
        selectedElements[0] as NonDeleted<ExcalidrawLinearElement>,
        elementsMap,
      );
    }
    const selectionColor =
      renderConfig.selectionColor || getThemedColor("#000", appState.theme);
    const lockedSelectionColor = getThemedColor("#ced4da", appState.theme);
    const groupSelectionColor = getThemedColor("#000", appState.theme);

    // showBoundingBox 由 hasBoundingBox 结合 editorInterface 推出（例如某些
    // 移动端形态不显示）。先建“本地选中 id → 元素”的 Map，避免在遍历所有
    // 可见元素时反复做数组线性查找。
    if (showBoundingBox) {
      // Optimisation for finding quickly relevant element ids
      const locallySelectedIds = arrayToMap(selectedElements);

      const selections: ElementSelectionBorder[] = [];

      // 一次遍历同时收集本地与远端（协作）选中框。selectionColors 是颜色
      // 数组：本地色在前，远端按 socketId 逐个追加，远端色取自协作者光标色，
      // 保证同一个人的选择框与光标颜色一致。
      for (const element of elementsMap.values()) {
        const selectionColors = [];
        const remoteClients = renderConfig.remoteSelectedElementIds.get(
          element.id,
        );
        if (
          !(
            // Elbow arrow elements cannot be selected when bound on either end
            (
              isSingleLinearElementSelected &&
              isElbowArrow(element) &&
              (element.startBinding || element.endBinding)
            )
          )
        ) {
          // local user
          if (
            locallySelectedIds.has(element.id) &&
            !isSelectedViaGroup(appState, element)
          ) {
            selectionColors.push(selectionColor);
          }
          // remote users
          if (remoteClients) {
            selectionColors.push(
              ...remoteClients.map((socketId) => {
                const background = getClientColor(
                  socketId,
                  appState.collaborators.get(socketId),
                );
                return background;
              }),
            );
          }
        }

        // 只有确实存在颜色才收集。锁定元素强制换成灰色虚线并覆盖多人颜色：
        // 锁定态下“谁选中了它”不重要，重要的是提示当前不可编辑。
        if (selectionColors.length) {
          const [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(
            element,
            elementsMap,
            true,
          );
          selections.push({
            angle: element.angle,
            x1,
            y1,
            x2,
            y2,
            selectionColors: element.locked
              ? [lockedSelectionColor]
              : selectionColors,
            dashed: !!remoteClients || element.locked,
            cx,
            cy,
            activeEmbeddable:
              appState.activeEmbeddable?.element === element &&
              appState.activeEmbeddable.state === "active",
            padding:
              element.id === appState.croppingElementId ||
              isImageElement(element)
                ? 0
                : undefined,
          });
        }
      }

      // 组框与元素框分开收集：组框固定虚线，表示“这是聚合边界”，且不参与
      // 变换手柄定位（手柄仍按 selectedElements 的公共包围盒计算）。
      const addSelectionForGroupId = (groupId: GroupId) => {
        const groupElements = getElementsInGroup(elementsMap, groupId);
        const [x1, y1, x2, y2] = getCommonBounds(groupElements);
        selections.push({
          angle: 0,
          x1,
          x2,
          y1,
          y2,
          selectionColors: groupElements.some((el) => el.locked)
            ? [lockedSelectionColor]
            : [groupSelectionColor],
          dashed: true,
          cx: x1 + (x2 - x1) / 2,
          cy: y1 + (y2 - y1) / 2,
          activeEmbeddable: false,
        });
      };

      // 进入组编辑时（editingGroupId），即使组没有被整体选中也要画虚框，
      // 让用户清楚当前操作范围。
      for (const groupId of getSelectedGroupIds(appState)) {
        // TODO: support multiplayer selected group IDs
        addSelectionForGroupId(groupId);
      }

      if (appState.editingGroupId) {
        addSelectionForGroupId(appState.editingGroupId);
      }

      // 统一最后绘制，保证组框/整体框压在单个元素框之上，不会被后收集的
      // 元素框裁掉一部分。
      selections.forEach((selection) =>
        renderSelectionBorder(context, appState, selection),
      );
    }
    // Paint resize transformHandles
    context.save();
    context.translate(appState.scrollX, appState.scrollY);

    // 手柄坐标由 getTransformHandles 直接算出“含 scroll 的画布坐标”，所以
    // 这里只 translate 一次，渲染函数内部不再叠加 scroll。
    if (selectedElements.length === 1) {
      context.fillStyle = getThemedColor("#fff", appState.theme);
      const transformHandles = getTransformHandles(
        selectedElements[0],
        appState.zoom,
        elementsMap,
        "mouse", // when we render we don't know which pointer type so use mouse,
        getOmitSidesForEditorInterface(editorInterface),
      );
      if (
        !appState.viewModeEnabled &&
        showBoundingBox &&
        // do not show transform handles when text is being edited
        !isTextElement(appState.editingTextElement) &&
        // do not show transform handles when image is being cropped
        !appState.croppingElementId
      ) {
        renderTransformHandles(
          context,
          renderConfig,
          appState,
          transformHandles,
          selectedElements[0].angle,
        );
      }

      if (appState.croppingElementId && !appState.isCropping) {
        const croppingElement = elementsMap.get(appState.croppingElementId);

        if (croppingElement && isImageElement(croppingElement)) {
          renderCropHandles(
            context,
            renderConfig,
            appState,
            croppingElement,
            elementsMap,
          );
        }
      }
    } else if (
      // 多选：只画公共包围盒的虚线框 + 8 个手柄，不再画每个元素的单独框
      // （单独框已在上面的 showBoundingBox 分支画过）。旋转中不提供手柄；
      // 含锁定元素时禁用整套手柄，而不是只禁用锁定的那个，避免产生
      // “部分可拖”的歧义状态。
      selectedElements.length > 1 &&
      !appState.isRotating &&
      !selectedElements.some((el) => el.locked)
    ) {
      // 多选整体框向外扩一圈 padding，与元素自身的选中框在视觉上分开，也给
      // 外侧的 8 个手柄留出空间。临时切换虚线后必须还原，否则会污染后续
      // 绘制（同一 context 被复用）。
      const dashedLinePadding =
        (DEFAULT_TRANSFORM_HANDLE_SPACING * 2) / appState.zoom.value;
      context.fillStyle = getThemedColor("#fff", appState.theme);
      const [x1, y1, x2, y2] = getCommonBounds(selectedElements, elementsMap);
      const initialLineDash = context.getLineDash();
      context.setLineDash([2 / appState.zoom.value]);
      const lineWidth = context.lineWidth;
      context.lineWidth = 1 / appState.zoom.value;
      context.strokeStyle = selectionColor;
      strokeRectWithRotation_simple(
        context,
        x1 - dashedLinePadding,
        y1 - dashedLinePadding,
        x2 - x1 + dashedLinePadding * 2,
        y2 - y1 + dashedLinePadding * 2,
        (x1 + x2) / 2,
        (y1 + y2) / 2,
        0,
      );
      context.lineWidth = lineWidth;
      context.setLineDash(initialLineDash);
      const transformHandles = getTransformHandlesFromCoords(
        [x1, y1, x2, y2, (x1 + x2) / 2, (y1 + y2) / 2],
        0 as Radians,
        appState.zoom,
        "mouse",
        isFrameSelected
          ? {
              ...getOmitSidesForEditorInterface(editorInterface),
              rotation: true,
            }
          : getOmitSidesForEditorInterface(editorInterface),
      );
      if (selectedElements.some((element) => !element.locked)) {
        renderTransformHandles(
          context,
          renderConfig,
          appState,
          transformHandles,
          0,
        );
      }
    }
    context.restore();
  }

  // 搜索命中：matchedLines 的偏移是“元素本地坐标”，需要先平移到元素中心、
  // 再旋转到元素角度后才能绘制。frame 内的命中偏移事先按 zoom 预乘过，
  // 因此要除以 zoomFactor 还原，否则 frame 里的高亮会随缩放漂移。
  appState.searchMatches?.matches.forEach(({ id, focus, matchedLines }) => {
    const element = elementsMap.get(id);

    if (element) {
      const [elementX1, elementY1, , , cx, cy] = getElementAbsoluteCoords(
        element,
        elementsMap,
        true,
      );

      context.save();
      context.fillStyle =
        SEARCH_MATCH_COLOR[appState.theme][focus ? "focus" : "match"];

      const zoomFactor = isFrameLikeElement(element) ? appState.zoom.value : 1;

      context.translate(appState.scrollX, appState.scrollY);
      context.translate(cx, cy);
      context.rotate(element.angle);

      matchedLines.forEach((matchedLine) => {
        // focus 表示当前聚焦的命中项：它始终高亮；其余行只在 showOnCanvas
        // （位于可视区域内）时绘制，避免为屏幕外文本浪费 fillRect。
        (matchedLine.showOnCanvas || focus) &&
          context.fillRect(
            elementX1 + matchedLine.offsetX / zoomFactor - cx,
            elementY1 + matchedLine.offsetY / zoomFactor - cy,
            matchedLine.width / zoomFactor,
            matchedLine.height / zoomFactor,
          );
      });

      context.restore();
    }
  });

  // 吸附参考线由 snapping.ts 写入 appState.snapLines，renderSnaps 内部自行
  // 处理 scroll。必须在这里（restore 之前）画，才能与场景内容严格对齐。
  renderSnaps(context, appState);

  context.restore();

  // 协作光标使用视口坐标（InteractiveCanvas 已把 pointer 的场景坐标换算好），
  // 因此必须在 restore 之后绘制，不能参与 zoom 变换；它也不受滚动条开关影响。
  renderRemoteCursors({
    context,
    renderConfig,
    appState,
    normalizedWidth,
    normalizedHeight,
  });

  // Paint scrollbars
  // 滚动条几何基于归一化画布尺寸（已去掉 devicePixelRatio），既用于绘制也
  // 通过返回值交给 App 做命中测试；它不参与缩放坐标系，所以放在最后。
  let scrollBars;
  if (renderConfig.renderScrollbars) {
    scrollBars = getScrollBars(
      elementsMap,
      normalizedWidth,
      normalizedHeight,
      appState,
    );

    context.save();
    context.fillStyle = getThemedColor(SCROLLBAR_COLOR, appState.theme);
    context.strokeStyle = getThemedColor(
      "rgba(255,255,255,0.8)",
      appState.theme,
    );
    // 两个方向都要画，但任一方向在“内容小于视口”时可能返回 null，因此先
    // 判空再画；圆角半径固定为宽度一半，与静态滚动条视觉一致。
    [scrollBars.horizontal, scrollBars.vertical].forEach((scrollBar) => {
      if (scrollBar) {
        roundRect(
          context,
          scrollBar.x,
          scrollBar.y,
          scrollBar.width,
          scrollBar.height,
          SCROLLBAR_WIDTH / 2,
        );
      }
    });
    context.restore();
  }

  return {
    scrollBars,
    animationState: nextAnimationState,
  };
};

/**
 * 对外导出的交互层渲染入口。
 *
 * 与 StaticCanvas 的 renderStaticScene 不同：这里没有 rAF 节流参数，因为
 * 调用方 InteractiveCanvas 本身就跑在 AnimationController 的循环里，每帧调用
 * 一次。因此本函数不做“合并下一帧”的调度，只负责转调 _renderInteractiveScene
 * 并同步触发 callback。
 *
 * 返回值原样透传（scrollBars / animationState）。animationState 是下一帧
 * 动画的输入：只要其中还有非 undefined 字段，循环就继续；全部为 undefined 时
 * AnimationController 会停止，交互层回到无动画的静默状态。
 *
 * 泛型 U 仅为让测试中的 spy 获得与实现一致的返回类型，运行时无额外开销。
 */
/**
 * Interactive scene is the ui-canvas where we render bounding boxes, selections
 * and other ui stuff.
 */
/**
 * 对外入口：按需节流后调用 `_renderInteractiveScene`。
 *
 * 与静态画布的差别：这里即使 throttle=false 也不在 React 渲染里同步画，
 * 而是由 InteractiveCanvas 的 AnimationController 每帧调用；节流只用于
 * 明确不需要连续动画的调用方。
 */
export const renderInteractiveScene = <
  U extends typeof _renderInteractiveScene,
>(
  renderConfig: InteractiveSceneRenderConfig,
): ReturnType<U> => {
  const ret = _renderInteractiveScene(renderConfig);
  // 回调必须在绘制完成后同步执行：App 依赖它拿到本帧的 scrollBars 与
  // animationState；提前调用只会得到上一帧的数据。
  renderConfig.callback(ret);
  return ret as ReturnType<U>;
};
