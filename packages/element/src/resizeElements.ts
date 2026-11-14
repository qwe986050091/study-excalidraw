/**
 * 本文件：选择框缩放（以及旋转）的几何核心。
 *
 * 链路位置：App 的指针事件层（App.selectionTool）在 pointermove 时调用
 * `transformElements`，由它把“指针位置”翻译成元素的宽高/角度，再通过
 * `scene.mutateElement` 写回；pointerup 之后没有任何补偿逻辑，因此这里必须
 * 一次算对。
 *
 * 输入：
 * - `originalElements`：pointerdown 时的元素快照，整个手势的固定起点；
 * - 指针的 scene 坐标、手柄方向（n/s/e/w/nw/...）、修饰键折算出的三个布尔
 *   （锁比例、从中心缩放、旋转吸附）；
 * - 当前元素（latestElement）与 scene，用于读取绑定文本等关联数据。
 *
 * 输出：元素 mutation；不返回新几何，只有 `transformElements` 返回“是否发生
 * 变换”供外层决定重绘/记录历史。
 *
 * 关键不变量：
 * - 宽高可能为负（指针越过对边），负号代表翻转，不能被 minSize 吃掉；
 * - 文本元素有专用路径（重排 + 字号），不能按普通几何缩放；
 * - 线性元素必须重算 points，只改 width/height 不会改变箭头形状；
 * - 多选缩放按共同包围盒的同一比例映射，不是逐元素独立缩放；
 * - 绑定箭头即使不在选中集合内也要更新（交给 binding.ts 的
 *   updateBoundElements）。
 */
import {
  pointCenter,
  normalizeRadians,
  pointFrom,
  pointRotateRads,
  type Radians,
  type LocalPoint,
} from "@excalidraw/math";

import {
  MIN_FONT_SIZE,
  SHIFT_LOCKING_ANGLE,
  STICKY_NOTE_MIN_SIZE,
  rescalePoints,
  getFontString,
} from "@excalidraw/common";

import type { GlobalPoint } from "@excalidraw/math";

import type { PointerDownState } from "@excalidraw/excalidraw/types";

import type { Mutable } from "@excalidraw/common/utility-types";

import {
  getArrowLocalFixedPoints,
  unbindBindingElement,
  updateBoundElements,
} from "./binding";
import {
  getElementAbsoluteCoords,
  getCommonBounds,
  getResizedElementAbsoluteCoords,
  getCommonBoundingBox,
  getElementBounds,
} from "./bounds";
import { LinearElementEditor } from "./linearElementEditor";
import {
  getBoundTextElement,
  getBoundTextElementId,
  getContainerElement,
  handleBindTextResize,
  getBoundTextMaxWidth,
  computeBoundTextPosition,
} from "./textElement";
import {
  getMinTextElementWidth,
  measureText,
  getApproxMinLineWidth,
  getApproxMinLineHeight,
} from "./textMeasurements";
import { wrapText } from "./textWrapping";

import {
  isArrowElement,
  isBindingElement,
  isBoundToContainer,
  isElbowArrow,
  isFrameLikeElement,
  isFreeDrawElement,
  isImageElement,
  isLinearElement,
  isStickyNoteElement,
  isTextElement,
} from "./typeChecks";

import { isInGroup } from "./groups";
import {
  getStickyNoteMinSize,
  getStickyNoteResizeIntent,
  updateStickyNoteLayout,
} from "./stickyNote";

import type { RenderEnvironment } from "./renderEnvironment";

import type { Scene } from "./Scene";

import type { BoundingBox } from "./bounds";
import type {
  MaybeTransformHandleType,
  TransformHandleDirection,
} from "./transformHandles";
import type {
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  NonDeletedExcalidrawElement,
  NonDeleted,
  ExcalidrawElement,
  ExcalidrawTextElementWithContainer,
  ExcalidrawImageElement,
  ElementsMap,
  ExcalidrawElbowArrowElement,
  ExcalidrawArrowElement,
} from "./types";
import type { ElementUpdate } from "./mutateElement";

/**
 * 缩放/旋转的统一入口，由 App 的指针移动处理调用。
 *
 * 分工：
 * - 单元素：旋转走 `rotateSingleElement`；缩放先由
 *   `getNextSingleWidthAndHeightFromPointer` 把指针位置换成宽高，再进
 *   `resizeSingleElement`；
 * - 多元素：旋转绕共同中心；缩放统一走 `resizeMultipleElements`，按同一个
 *   缩放比例映射每个元素的包围盒。
 *
 * `originalElements` 是 pointerdown 时的快照，整个手势期间都用它作为
 * “起点”。这很关键：缩放不是增量累加，而是始终从原始包围盒重新计算，
 * 否则来回拖动会产生累积误差，且 Shift 切换约束时无法正确回退。
 *
 * 绑定箭头不在选中集合里也会被更新：元素的 resize 会改变固定点位置，
 * 必须让 `updateBoundElements` 把箭头端点重新贴到新边上。
 *
 * 返回 true 表示确实发生了变换（外层据此触发重绘/记录）。
 *
 * 补充：本函数只负责“选中元素自身”的几何，绑定元素的联动统一放在各分支
 * 末尾（旋转后、文本缩放后各有一次）。因此调用方不需要再补一次
 * updateBoundElements，否则会在同一次 pointermove 里重复计算端点。
 */
// Returns true when transform (resizing/rotation) happened
export const transformElements = (
  originalElements: PointerDownState["originalElements"],
  transformHandleType: MaybeTransformHandleType,
  selectedElements: readonly NonDeletedExcalidrawElement[],
  scene: Scene,
  shouldRotateWithDiscreteAngle: boolean,
  shouldResizeFromCenter: boolean,
  shouldMaintainAspectRatio: boolean,
  pointerX: number,
  pointerY: number,
  centerX: number,
  centerY: number,
  renderEnvironment?: RenderEnvironment,
): boolean => {
  const elementsMap = scene.getNonDeletedElementsMap();
  // 单选分支：旋转与缩放是两套完全不同的数学，先按手柄类型分流。
  if (selectedElements.length === 1) {
    const [element] = selectedElements;
    if (transformHandleType === "rotation") {
      // 肘形箭头的旋转会破坏路由与固定段，直接忽略；普通元素旋转后还要
      // 让绑定到它的箭头重新贴合。
      if (!isElbowArrow(element)) {
        rotateSingleElement(
          element,
          scene,
          pointerX,
          pointerY,
          shouldRotateWithDiscreteAngle,
        );
        updateBoundElements(element, scene, { renderEnvironment });
      }
    } else if (transformHandleType) {
      const elementId = selectedElements[0].id;
      const latestElement = elementsMap.get(elementId);
      const origElement = originalElements.get(elementId);

      // 快照缺失说明元素在手势中被删/被替换；此时放弃缩放而不是拿当前值
      // 兜底，否则会把“增量”当成“原始值”，产生跳变。
      if (latestElement && origElement) {
        const { nextWidth, nextHeight } =
          getNextSingleWidthAndHeightFromPointer(
            latestElement,
            origElement,
            transformHandleType,
            pointerX,
            pointerY,
            {
              shouldMaintainAspectRatio,
              shouldResizeFromCenter,
            },
          );

        resizeSingleElement(
          nextWidth,
          nextHeight,
          latestElement,
          origElement,
          originalElements,
          scene,
          transformHandleType,
          {
            shouldMaintainAspectRatio,
            shouldResizeFromCenter,
            renderEnvironment,
          },
        );
      }
    }
    if (isTextElement(element)) {
      // 文本的端点可能被箭头/容器绑定，字号变化后绑定位置需要重算。
      updateBoundElements(element, scene, { renderEnvironment });
    }
    return true;
  } else if (selectedElements.length > 1) {
    // 多选旋转：绕选择集共同中心，按“角度增量”整体旋转。
    if (transformHandleType === "rotation") {
      rotateMultipleElements(
        originalElements,
        selectedElements,
        scene,
        pointerX,
        pointerY,
        shouldRotateWithDiscreteAngle,
        centerX,
        centerY,
        renderEnvironment,
      );
      return true;
    } else if (transformHandleType) {
      const { nextWidth, nextHeight, flipByX, flipByY, originalBoundingBox } =
        getNextMultipleWidthAndHeightFromPointer(
          selectedElements,
          originalElements,
          elementsMap,
          transformHandleType,
          pointerX,
          pointerY,
          {
            shouldMaintainAspectRatio,
            shouldResizeFromCenter,
          },
        );

      resizeMultipleElements(
        selectedElements,
        elementsMap,
        transformHandleType,
        scene,
        originalElements,
        {
          shouldResizeFromCenter,
          shouldMaintainAspectRatio,
          flipByX,
          flipByY,
          nextWidth,
          nextHeight,
          originalBoundingBox,
          renderEnvironment,
        },
      );

      return true;
    }
  }
  return false;
};

/**
 * 单元素旋转。
 *
 * 角度来源：指针相对元素中心的极角 + 270°。加 270° 是因为画布坐标 y 向下，
 * 而元素 angle 的 0 表示“未旋转”、正角度顺时针，直接用 atan2 会相差一个
 * 象限；加 5π/2 后再取模，保证结果落在期望的方向上。
 *
 * 特殊处理：
 * - frame 不允许旋转，角度强制 0；
 * - Shift 吸附时先加半格再向下取整到 SHIFT_LOCKING_ANGLE 的倍数，
 *   这样吸附是“就近”而不是“向下”；
 * - 旋转箭头会先解绑两端：绑定端点按固定点定位，旋转后固定点已不适用，
 *   留着会造成端点与实际图形脱节；
 * - 绑定文本跟随容器旋转，但箭头标签不跟随（箭头自身的角度语义不同）。
 */
const rotateSingleElement = (
  element: NonDeletedExcalidrawElement,
  scene: Scene,
  pointerX: number,
  pointerY: number,
  shouldRotateWithDiscreteAngle: boolean,
) => {
  const [x1, y1, x2, y2] = getElementAbsoluteCoords(
    element,
    scene.getNonDeletedElementsMap(),
  );
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  let angle: Radians;
  if (isFrameLikeElement(element)) {
    angle = 0 as Radians;
  } else {
    angle = ((5 * Math.PI) / 2 +
      Math.atan2(pointerY - cy, pointerX - cx)) as Radians;
    if (shouldRotateWithDiscreteAngle) {
      angle = (angle + SHIFT_LOCKING_ANGLE / 2) as Radians;
      angle = (angle - (angle % SHIFT_LOCKING_ANGLE)) as Radians;
    }
    angle = normalizeRadians(angle as Radians);
  }
  const boundTextElementId = getBoundTextElementId(element);

  let update: ElementUpdate<NonDeletedExcalidrawElement> = {
    angle,
  };

  if (isBindingElement(element)) {
    // 解绑发生在 mutate 之前：unbindBindingElement 会顺手清理目标元素的
    // boundElements，若放在后面，目标仍认为箭头绑着它。
    update = {
      ...update,
    } as ElementUpdate<NonDeletedExcalidrawElement>;

    if (element.startBinding) {
      unbindBindingElement(element, "start", scene);
    }
    if (element.endBinding) {
      unbindBindingElement(element, "end", scene);
    }
  }

  scene.mutateElement(element, update);

  // 绑定文本用 computeBoundTextPosition 重新求中心，而不是简单沿用旧坐标；
  // 文本自身也要写入 angle，否则容器转了、文字仍横着。
  if (boundTextElementId) {
    const textElement =
      scene.getElement<ExcalidrawTextElementWithContainer>(boundTextElementId);

    if (textElement && !isArrowElement(element)) {
      const { x, y } = computeBoundTextPosition(
        element,
        textElement,
        scene.getNonDeletedElementsMap(),
      );
      scene.mutateElement(textElement, {
        angle,
        x,
        y,
      });
    }
  }
};

/**
 * 线性元素/自由绘制元素的 points 重缩放。
 *
 * 只改 width/height 不够：线性元素的形状完全由 points 决定，必须按新宽高
 * 把每个点的 x/y 分别缩放。`normalizePoints` 控制是否把 points 归一到
 * [0,width]×[0,height]（单元素缩放要归一，多选映射时由外部统一处理）。
 *
 * 非线性的元素返回空对象，便于调用方直接展开进 update。
 */
export const rescalePointsInElement = (
  element: NonDeletedExcalidrawElement,
  width: number,
  height: number,
  normalizePoints: boolean,
) =>
  isLinearElement(element) || isFreeDrawElement(element)
    ? {
        points: rescalePoints(
          0,
          width,
          rescalePoints(1, height, element.points, normalizePoints),
          normalizePoints,
        ),
      }
    : {};

/**
 * 由“新宽度”反推字号。
 *
 * 只用宽度做等比：文本高度由换行结果决定，不能用高度反推字号，否则多行
 * 文本会因为行数变化而字号乱跳。
 *
 * 容器内文本的基准宽度不是自身 width，而是 `getBoundTextMaxWidth(container)`，
 * 因为文本宽度受容器内边距限制；直接用自身宽度会让字号偏大。
 *
 * @returns null 表示字号会小于 MIN_FONT_SIZE，调用方应放弃本次缩放
 *   （而不是把字号夹到最小值，那会导致文字溢出容器）。
 */
export const measureFontSizeFromWidth = (
  element: NonDeleted<ExcalidrawTextElement>,
  elementsMap: ElementsMap,
  nextWidth: number,
): { size: number } | null => {
  // 容器内文本的基准宽度取“容器允许的最大文本宽”，否则缩放文本时会把
  // 内边距也算进比例，字号偏大。
  // We only use width to scale font on resize
  let width = element.width;

  const hasContainer = isBoundToContainer(element);
  if (hasContainer) {
    const container = getContainerElement(element, elementsMap);
    if (container) {
      width = getBoundTextMaxWidth(container, element);
    }
  }
  const nextFontSize = element.fontSize * (nextWidth / width);
  if (nextFontSize < MIN_FONT_SIZE) {
    return null;
  }

  return {
    size: nextFontSize,
  };
};

/**
 * 文本元素的缩放专用路径。
 *
 * 文本不能像矩形那样自由拉伸，只能：
 * - 角手柄：按“宽高比中较大的那个轴”等比放大，同时重算字号；
 * - 左右手柄：只改宽度并重新换行，高度由换行结果决定；
 * - 上下手柄：走统一的字号缩放路径（重算 metricsWidth）。
 *
 * 为什么角手柄要取 max：文本始终维持宽高比，若用较小的轴，字号会变小而
 * 宽度没跟上，文字会出现额外空行。
 *
 * 失败条件：字号低于 MIN_FONT_SIZE 时直接返回，保持元素不变（宁可不缩，
 * 也不允许文字小到不可读）。
 *
 * 注意 `metricsWidth` 是“为了算字号而假设的宽度”，不是最终宽度；最终宽度
 * 在左右手柄分支里由 wrapText 的测量结果决定。
 */
export const resizeSingleTextElement = (
  origElement: NonDeleted<ExcalidrawTextElement>,
  element: NonDeleted<ExcalidrawTextElement>,
  scene: Scene,
  transformHandleType: TransformHandleDirection,
  shouldResizeFromCenter: boolean,
  nextWidth: number,
  nextHeight: number,
  renderEnvironment?: RenderEnvironment,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();

  // a corner follows the axis it grows most, as keeping the aspect ratio
  // does (which text always does)
  // 中文：角手柄时把高度补到与宽度同一比例，保证“字号由宽度决定”与最终
  // 高度一致；否则下一帧测量出的高度会和写回值不同，产生一像素级抖动。
  if (transformHandleType.length === 2) {
    nextHeight = Math.max(
      nextHeight,
      (nextWidth / origElement.width) * origElement.height,
    );
  }

  const metricsWidth = element.width * (nextHeight / element.height);

  const metrics = measureFontSizeFromWidth(element, elementsMap, metricsWidth);
  // 字号触底时整个缩放作废；注意 already mutated 的元素不受影响，因为这里
  // 还没写入任何字段。
  if (metrics === null) {
    return;
  }

  // 含 n/s 的手柄（上下边、四角）按“整体等比”处理：宽高与字号一起缩放。
  if (transformHandleType.includes("n") || transformHandleType.includes("s")) {
    const previousOrigin = pointFrom<GlobalPoint>(origElement.x, origElement.y);

    const newOrigin = getResizedOrigin(
      previousOrigin,
      origElement.width,
      origElement.height,
      metricsWidth,
      nextHeight,
      origElement.angle,
      transformHandleType,
      false,
      shouldResizeFromCenter,
    );

    scene.mutateElement(element, {
      fontSize: metrics.size,
      width: metricsWidth,
      height: nextHeight,
      x: newOrigin.x,
      y: newOrigin.y,
    });
    return;
  }

  if (transformHandleType === "e" || transformHandleType === "w") {
    // 纯左右缩放：字号保持不变，改为“按新宽度重新换行”。先保证不小于
    // 单字符最小宽度，否则 wrapText 会得到空结果。
    const minWidth = getMinTextElementWidth(
      getFontString({
        fontSize: element.fontSize,
        fontFamily: element.fontFamily,
      }),
      element.lineHeight,
      renderEnvironment,
    );

    const newWidth = Math.max(minWidth, nextWidth);

    const text = wrapText(
      element.originalText,
      getFontString(element),
      Math.abs(newWidth),
      renderEnvironment,
    );
    const metrics = measureText(
      text,
      getFontString(element),
      element.lineHeight,
      renderEnvironment,
    );

    const newHeight = metrics.height;

    const previousOrigin = pointFrom<GlobalPoint>(origElement.x, origElement.y);

    const newOrigin = getResizedOrigin(
      previousOrigin,
      origElement.width,
      origElement.height,
      newWidth,
      newHeight,
      element.angle,
      transformHandleType,
      false,
      shouldResizeFromCenter,
    );

    const resizedElement: Partial<NonDeleted<ExcalidrawTextElement>> = {
      width: Math.abs(newWidth),
      height: Math.abs(metrics.height),
      x: newOrigin.x,
      y: newOrigin.y,
      text,
      autoResize: false,
    };

    scene.mutateElement(element, resizedElement);
  }
};

/**
 * 多选旋转：所有元素绕选择集共同中心转同一个角度。
 *
 * 计算的是“角度增量”而不是绝对角度：
 * - centerAngle 由指针相对共同中心算出；
 * - 再与元素原始 angle 相加，得到每个元素的新角度；
 * - 位置则让元素中心绕共同中心旋转同样的增量。
 *
 * 为什么位置也要转：多选旋转不是各自原地转，而是像刚体一样整体绕中心转，
 * 否则元素之间会互相穿插。
 *
 * frame 被跳过（不能旋转）；肘形箭头只更新 points（重新路由），
 * 不写 angle，因为它的形状由点决定。
 *
 * 末尾 scene.triggerUpdate() 是必要的：本函数直接 mutate 多个元素，
 * 不经过单个元素的触发路径。
 */
const rotateMultipleElements = (
  originalElements: PointerDownState["originalElements"],
  elements: readonly NonDeletedExcalidrawElement[],
  scene: Scene,
  pointerX: number,
  pointerY: number,
  shouldRotateWithDiscreteAngle: boolean,
  centerX: number,
  centerY: number,
  renderEnvironment?: RenderEnvironment,
) => {
  const elementsMap = scene.getNonDeletedElementsMap();
  let centerAngle =
    (5 * Math.PI) / 2 + Math.atan2(pointerY - centerY, pointerX - centerX);
  // 与单元素旋转相同的“就近吸附”：先偏移半格再截断，得到最接近的角度。
  if (shouldRotateWithDiscreteAngle) {
    centerAngle += SHIFT_LOCKING_ANGLE / 2;
    centerAngle -= centerAngle % SHIFT_LOCKING_ANGLE;
  }

  const rotatedElementsMap = new Map<
    ExcalidrawElement["id"],
    NonDeletedExcalidrawElement
  >(elements.map((element) => [element.id, element]));

  for (const element of elements) {
    // frame 不参与旋转：frame 的语义是“容器边界”，旋转它会让内部元素
    // 与边框的关系失效。
    if (!isFrameLikeElement(element)) {
      const [x1, y1, x2, y2] = getElementAbsoluteCoords(element, elementsMap);
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      // 原始角度必须来自快照：latest 的 angle 已被本手势改过，
      // 再叠加会变成“每次 pointermove 都多转一点”。
      const origAngle =
        originalElements.get(element.id)?.angle ?? element.angle;
      const [rotatedCX, rotatedCY] = pointRotateRads(
        pointFrom(cx, cy),
        pointFrom(centerX, centerY),
        (centerAngle + origAngle - element.angle) as Radians,
      );

      // 肘形箭头只需重算首尾固定点的局部坐标，随后由路由算法重新折线；
      // 普通元素则同时更新位置与 angle。
      const updates = isElbowArrow(element)
        ? {
            // Needed to re-route the arrow
            points: getArrowLocalFixedPoints(element, elementsMap),
          }
        : {
            x: element.x + (rotatedCX - cx),
            y: element.y + (rotatedCY - cy),
            angle: normalizeRadians((centerAngle + origAngle) as Radians),
          };

      scene.mutateElement(element, updates);

      updateBoundElements(element, scene, {
        simultaneouslyUpdated: elements,
        renderEnvironment,
      });

      if (isBindingElement(element)) {
        if (element.startBinding) {
          if (!rotatedElementsMap.has(element.startBinding.elementId)) {
            unbindBindingElement(element, "start", scene);
          }
        }
        if (element.endBinding) {
          if (!rotatedElementsMap.has(element.endBinding.elementId)) {
            unbindBindingElement(element, "end", scene);
          }
        }
      }

      const boundText = getBoundTextElement(element, elementsMap);
      if (boundText && !isArrowElement(element)) {
        const { x, y } = computeBoundTextPosition(
          element,
          boundText,
          elementsMap,
        );

        scene.mutateElement(boundText, {
          x,
          y,
          angle: normalizeRadians((centerAngle + origAngle) as Radians),
        });
      }
    }
  }

  scene.triggerUpdate();
};

/**
 * 指针相对“被拖手柄对应边/角”的偏移，用于判断是否越过对边、以及计算
 * 旋转/翻转方向。
 *
 * 步骤：
 * 1. 取包围盒（单选取元素自身绝对坐标，多选取共同包围盒）；
 * 2. 把指针反向旋转到元素本地坐标，消除元素旋转的影响；
 * 3. 按手柄方向减去对应边/角，再旋转回全局，得到“从手柄指向指针”的向量。
 *
 * 返回值是全局坐标系下的二维向量；无有效手柄时返回 [0,0]，调用方据此
 * 视为“没有拖动”。
 */
export const getResizeOffsetXY = (
  transformHandleType: MaybeTransformHandleType,
  selectedElements: NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  x: number,
  y: number,
): [number, number] => {
  const [x1, y1, x2, y2] =
    selectedElements.length === 1
      ? getElementAbsoluteCoords(selectedElements[0], elementsMap)
      : getCommonBounds(selectedElements);
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const angle = (
    selectedElements.length === 1 ? selectedElements[0].angle : 0
  ) as Radians;
  [x, y] = pointRotateRads(
    pointFrom(x, y),
    pointFrom(cx, cy),
    -angle as Radians,
  );
  switch (transformHandleType) {
    // 下列每个 case 都是“指针 - 对应边/角”，再旋转回全局。
    // 减法的顺序必须是“指针减边”，反过来会得到反向偏移，
    // 手柄拖拽方向与元素变化方向将相反。
    case "n":
      return pointRotateRads(
        pointFrom(x - (x1 + x2) / 2, y - y1),
        pointFrom(0, 0),
        angle,
      );
    case "s":
      return pointRotateRads(
        pointFrom(x - (x1 + x2) / 2, y - y2),
        pointFrom(0, 0),
        angle,
      );
    case "w":
      return pointRotateRads(
        pointFrom(x - x1, y - (y1 + y2) / 2),
        pointFrom(0, 0),
        angle,
      );
    case "e":
      return pointRotateRads(
        pointFrom(x - x2, y - (y1 + y2) / 2),
        pointFrom(0, 0),
        angle,
      );
    case "nw":
      return pointRotateRads(pointFrom(x - x1, y - y1), pointFrom(0, 0), angle);
    case "ne":
      return pointRotateRads(pointFrom(x - x2, y - y1), pointFrom(0, 0), angle);
    case "sw":
      return pointRotateRads(pointFrom(x - x1, y - y2), pointFrom(0, 0), angle);
    case "se":
      return pointRotateRads(pointFrom(x - x2, y - y2), pointFrom(0, 0), angle);
    default:
      // 旋转手柄或无效手柄没有“缩放偏移”的概念，返回零向量让调用方跳过。
      return [0, 0];
  }
};

/**
 * 线性元素缩放时，判断拖的是“起点侧”还是“终点侧”。
 *
 * 只看第二个点的局部坐标符号：points[0] 恒为 (0,0)，所以第二个点落在哪个
 * 象限就代表线往哪个方向延伸。四角手柄各自对应“该角是否与线段同向”，
 * 从而决定缩放时哪一端保持不动。
 *
 * @returns "origin" 表示固定起点、缩放终点；"end" 反之。
 */
export const getResizeArrowDirection = (
  transformHandleType: MaybeTransformHandleType,
  element: NonDeleted<ExcalidrawLinearElement>,
): "origin" | "end" => {
  const [, [px, py]] = element.points;
  // 之所以把四个角拆成四个条件，是因为“起点/终点固定”取决于线段延伸方向，
  // 不能只看手柄本身；例如 nw 手柄在向左上延伸的线上应缩放终点。
  const isResizeEnd =
    (transformHandleType === "nw" && (px < 0 || py < 0)) ||
    (transformHandleType === "ne" && px >= 0) ||
    (transformHandleType === "sw" && px <= 0) ||
    (transformHandleType === "se" && (px > 0 || py > 0));
  return isResizeEnd ? "end" : "origin";
};

/**
 * 缩放锚点：缩放时保持不动的点/边。
 *
 * 用语义名而不是坐标，是为了让 getResizedOrigin 的九个分支与 getResizeAnchor
 * 的判定解耦；新增手柄类型时只需扩展映射，不必改动几何公式。
 */
type ResizeAnchor =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "west-side"
  | "north-side"
  | "east-side"
  | "south-side"
  | "center";

/**
 * 决定缩放时“哪个角/边保持不动”（锚点）。
 *
 * 优先级：
 * 1. 从中心缩放 → center（四边同时对称扩张）；
 * 2. 锁比例 → 边手柄也退化成“对角固定”，否则单轴缩放无法保持比例；
 * 3. 普通情况 → 拖哪个方向，锚点就在相反方向。
 *
 * 注意 e/se/s 与 n/nw/w 的分组不是对称写法：它是按“拖右下方向时左上固定”
 * 推导出来的，改动前要对照 getResizedOrigin 的九个分支。
 */
const getResizeAnchor = (
  handleDirection: TransformHandleDirection,
  shouldMaintainAspectRatio: boolean,
  shouldResizeFromCenter: boolean,
): ResizeAnchor => {
  if (shouldResizeFromCenter) {
    return "center";
  }

  if (shouldMaintainAspectRatio) {
    // 锁比例时，边手柄也要有“对角锚点”，否则只能单轴变化，比例无法保持。
    switch (handleDirection) {
      case "n":
        return "south-side";
      case "e": {
        return "west-side";
      }
      case "s":
        return "north-side";
      case "w":
        return "east-side";
      case "ne":
        return "bottom-left";
      case "nw":
        return "bottom-right";
      case "se":
        return "top-left";
      case "sw":
        return "top-right";
    }
  }

  if (["e", "se", "s"].includes(handleDirection)) {
    // 拖向右下方向 → 左上角固定；这三类手柄的公共锚点相同。
    return "top-left";
  } else if (["n", "nw", "w"].includes(handleDirection)) {
    // 拖向左上方向 → 右下角固定。
    return "bottom-right";
  } else if (handleDirection === "ne") {
    // 右上方向唯一对应左下角固定。
    return "bottom-left";
  }
  // 剩下只有 "sw"：左上固定之外的情况都由上面的分支覆盖。
  return "top-right";
};

/**
 * 根据锚点反算缩放后的左上角坐标（新 origin）。
 *
 * 输入是“锚点、旧宽高、新宽高、旋转角、手柄方向”，输出是元素新的 x/y。
 * 由于元素可能被旋转，不能只做 `x += (oldW-newW)/2`：锚点在旋转后的位置会
 * 变化，必须把“尺寸差的一半”按角度分解到 x/y 上。
 *
 * 九种锚点分别对应：
 * - 四角：对角固定，宽高差各贡献一部分位移；
 * - 四边：只在一个方向扩张，另一个方向不动（cos 项消失）；
 * - center：直接减半差值，无旋转项。
 *
 * 这些都是解析式，没有迭代/夹角修正；修改时必须保持“同一锚点下 newWidth
 * 与 newHeight 的系数成对出现”，否则旋转后会漂移。
 *
 * @param prevOrigin 缩放前元素的左上角（线性元素传“包围盒左上角”）
 * @returns 新的左上角坐标 {x, y}
 */
const getResizedOrigin = (
  prevOrigin: GlobalPoint,
  prevWidth: number,
  prevHeight: number,
  newWidth: number,
  newHeight: number,
  angle: number,
  handleDirection: TransformHandleDirection,
  shouldMaintainAspectRatio: boolean,
  shouldResizeFromCenter: boolean,
): { x: number; y: number } => {
  const anchor = getResizeAnchor(
    handleDirection,
    shouldMaintainAspectRatio,
    shouldResizeFromCenter,
  );

  const [x, y] = prevOrigin;

  switch (anchor) {
    // 左上角固定：宽度和高度都向“右下”扩张，因此两个方向的半差值都要
    // 投影到全局轴上。
    case "top-left":
      return {
        x:
          x +
          (prevWidth - newWidth) / 2 +
          ((newWidth - prevWidth) / 2) * Math.cos(angle) +
          ((prevHeight - newHeight) / 2) * Math.sin(angle),
        y:
          y +
          (prevHeight - newHeight) / 2 +
          ((newWidth - prevWidth) / 2) * Math.sin(angle) +
          ((newHeight - prevHeight) / 2) * Math.cos(angle),
      };
    // 右上角固定：宽度向左扩张、高度向下扩张。x 方向的 1+cos 项来自
    // “既保持右边界、又补偿旋转”的合并结果。
    case "top-right":
      return {
        x:
          x +
          ((prevWidth - newWidth) / 2) * (Math.cos(angle) + 1) +
          ((prevHeight - newHeight) / 2) * Math.sin(angle),
        y:
          y +
          (prevHeight - newHeight) / 2 +
          ((prevWidth - newWidth) / 2) * Math.sin(angle) +
          ((newHeight - prevHeight) / 2) * Math.cos(angle),
      };

    // 左下角固定：高度向上、宽度向右；与 top-right 的公式互为镜像，
    // 符号差异全部体现在 1-cos 与 1+cos 上。
    case "bottom-left":
      return {
        x:
          x +
          ((prevWidth - newWidth) / 2) * (1 - Math.cos(angle)) +
          ((newHeight - prevHeight) / 2) * Math.sin(angle),
        y:
          y +
          ((prevHeight - newHeight) / 2) * (Math.cos(angle) + 1) +
          ((newWidth - prevWidth) / 2) * Math.sin(angle),
      };
    // 右下角固定：左上角向“左上”移动；宽高都扩张时，两个半差值同时
    // 参与 x/y，这是最容易写错符号的分支。
    case "bottom-right":
      return {
        x:
          x +
          ((prevWidth - newWidth) / 2) * (Math.cos(angle) + 1) +
          ((newHeight - prevHeight) / 2) * Math.sin(angle),
        y:
          y +
          ((prevHeight - newHeight) / 2) * (Math.cos(angle) + 1) +
          ((prevWidth - newWidth) / 2) * Math.sin(angle),
      };
    // 中心缩放没有旋转项：新旧尺寸差的一半直接向两侧摊开。
    case "center":
      return {
        x: x - (newWidth - prevWidth) / 2,
        y: y - (newHeight - prevHeight) / 2,
      };
    // 东边固定：宽度向左扩张、高度不变。y 只受旋转补偿影响，
    // 所以只剩 prevHeight-newHeight 的一半。
    case "east-side":
      return {
        x: x + ((prevWidth - newWidth) / 2) * (Math.cos(angle) + 1),
        y:
          y +
          ((prevWidth - newWidth) / 2) * Math.sin(angle) +
          (prevHeight - newHeight) / 2,
      };
    // 西边固定：宽度向右扩张，x 用 1-cos 补偿；与 east-side 镜像。
    case "west-side":
      return {
        x: x + ((prevWidth - newWidth) / 2) * (1 - Math.cos(angle)),
        y:
          y +
          ((newWidth - prevWidth) / 2) * Math.sin(angle) +
          (prevHeight - newHeight) / 2,
      };
    // 北边固定：高度向下扩张，x 只受旋转补偿影响。
    case "north-side":
      return {
        x:
          x +
          (prevWidth - newWidth) / 2 +
          ((prevHeight - newHeight) / 2) * Math.sin(angle),
        y: y + ((newHeight - prevHeight) / 2) * (Math.cos(angle) - 1),
      };
    // 南边固定：高度向上扩张，y 用 1+cos 补偿；与 north-side 镜像。
    case "south-side":
      return {
        x:
          x +
          (prevWidth - newWidth) / 2 +
          ((newHeight - prevHeight) / 2) * Math.sin(angle),
        y: y + ((prevHeight - newHeight) / 2) * (Math.cos(angle) + 1),
      };
  }
};

/**
 * 单元素缩放。
 *
 * 关键处理顺序：
 * 1. 文本元素走专用路径（重排文本、字号可能变化），不复用几何缩放；
 * 2. 记录 flipFactor：指针越过对边时宽高会变负，负号表示翻转，不能被
 *    minSize 夹掉；
 * 3. 有绑定文本时计算最小宽高，防止把容器缩到文字放不下；
 * 4. 等比缩放时按同一个 scale 同时作用于宽高与字号；
 * 5. 线性元素用 `rescalePointsInElement` 重算 points，而不是只改 width/
 *    height——否则箭头形状不会跟着变。
 *
 * 副作用顺序：先 mutate 元素，再处理便签布局/绑定文本，最后统一
 * updateBoundElements。任何一步提前 return 都意味着“本帧不更新”，
 * 不会留下半更新状态（几何有效窗口在最后才写入）。
 */
export const resizeSingleElement = (
  nextWidth: number,
  nextHeight: number,
  latestElement: NonDeletedExcalidrawElement,
  origElement: NonDeletedExcalidrawElement,
  originalElementsMap: ElementsMap,
  scene: Scene,
  handleDirection: TransformHandleDirection,
  {
    shouldInformMutation = true,
    shouldMaintainAspectRatio = false,
    shouldResizeFromCenter = false,
    renderEnvironment,
  }: {
    shouldMaintainAspectRatio?: boolean;
    shouldResizeFromCenter?: boolean;
    shouldInformMutation?: boolean;
    renderEnvironment?: RenderEnvironment;
  } = {},
) => {
  if (isTextElement(latestElement) && isTextElement(origElement)) {
    return resizeSingleTextElement(
      origElement,
      latestElement,
      scene,
      handleDirection,
      shouldResizeFromCenter,
      nextWidth,
      nextHeight,
      renderEnvironment,
    );
  }

  // Constraints and font scaling use magnitudes. Keep the signs for the
  // geometry below, where crossing the opposite edge flips the element.
  // 中文：先把符号摘出来，后续 minSize / 字号计算全用绝对值，避免“负宽高”
  // 参与 Math.max 时被误判；写回时再用 flipFactor 还原符号。
  const flipFactorX = nextWidth < 0 ? -1 : 1;
  const flipFactorY = nextHeight < 0 ? -1 : 1;
  nextWidth = Math.abs(nextWidth);
  nextHeight = Math.abs(nextHeight);

  // 绑定文本参与最小尺寸：容器不能缩到文字放不下，否则文本会被裁切。
  // 但锁比例时不等价于“取 max”，下面会重新按 scale 统一宽高。
  const elementsMap = scene.getNonDeletedElementsMap();
  const boundTextElement = getBoundTextElement(latestElement, elementsMap);
  const isResizingStickyNote = isStickyNoteElement(latestElement);
  let minSize: { width: number; height: number } | undefined;
  if (isResizingStickyNote) {
    // 便签的最小尺寸由“一行文字在字号上限下的高度/宽度”决定，而不是
    // 绑定文本当前字号；否则用户放大字号后便签会被撑爆。
    // A note must fit one line at its label's font ceiling.
    minSize = boundTextElement
      ? getStickyNoteMinSize({
          fontSize: boundTextElement.baseFontSize ?? boundTextElement.fontSize,
          fontFamily: boundTextElement.fontFamily,
        })
      : { width: STICKY_NOTE_MIN_SIZE, height: STICKY_NOTE_MIN_SIZE };
  } else if (boundTextElement && !shouldMaintainAspectRatio) {
    minSize = {
      width: getApproxMinLineWidth(
        getFontString(boundTextElement),
        boundTextElement.lineHeight,
        renderEnvironment,
      ),
      height: getApproxMinLineHeight(
        boundTextElement.fontSize,
        boundTextElement.lineHeight,
      ),
    };
  }

  if (minSize) {
    // 用 max 保证不小于最小可读尺寸；注意此时宽高都已取绝对值，
    // 翻转信息仍保存在 flipFactor 里，不会被这里抹掉。
    nextWidth = Math.max(nextWidth, minSize.width);
    nextHeight = Math.max(nextHeight, minSize.height);
    if (shouldMaintainAspectRatio) {
      // Both dimensions must use the same scale even at the minimum size.
      // 中文：锁比例时不能各自 max 再各自缩放，否则比例会变；这里取两个
      // 方向所需比例的最大值，再统一乘回原始宽高。
      const scale = Math.max(
        nextWidth / origElement.width,
        nextHeight / origElement.height,
      );
      nextWidth = origElement.width * scale;
      nextHeight = origElement.height * scale;
    }
  }

  let boundTextFont: { fontSize?: number } = {};
  if (boundTextElement && !isResizingStickyNote) {
    // 字号基准必须用“手势开始时的字号”，不能用当前值：缩放过程中每次
    // pointermove 都会重算，用当前值会指数级放大。
    const stateOfBoundTextElementAtResize = originalElementsMap.get(
      boundTextElement.id,
    ) as typeof boundTextElement | undefined;
    if (stateOfBoundTextElementAtResize) {
      boundTextFont = {
        fontSize: stateOfBoundTextElementAtResize.fontSize,
      };
    }
    if (shouldMaintainAspectRatio) {
      const updatedElement = {
        ...latestElement,
        width: nextWidth,
        height: nextHeight,
      };

      const nextFont = measureFontSizeFromWidth(
        boundTextElement,
        elementsMap,
        getBoundTextMaxWidth(updatedElement, boundTextElement),
      );
      if (nextFont === null) {
        return;
      }
      boundTextFont = {
        fontSize: nextFont.size,
      };
    }
  }

  // 到这里才把翻转符号加回去：前面的约束都基于正尺寸，写回几何时才需要
  // 负值来表达“越过了对边”。
  nextWidth *= flipFactorX;
  nextHeight *= flipFactorY;

  // 线性元素按新宽高重算 points；normalizePoints=true 让 points 归一到
  // 新包围盒，后续 getElementBounds 才是正确的。
  const rescaledPoints = rescalePointsInElement(
    origElement,
    nextWidth,
    nextHeight,
    true,
  );

  let previousOrigin = pointFrom<GlobalPoint>(origElement.x, origElement.y);

  if (isLinearElement(origElement)) {
    // 线性元素的“左上角”不等于 element.x：points 可能延伸到 x 的左侧。
    // 必须用真实包围盒左上角作为缩放原点，否则缩放会围绕错误位置进行。
    const [x1, y1] = getElementBounds(origElement, originalElementsMap);
    previousOrigin = pointFrom<GlobalPoint>(x1, y1);
  }

  const newOrigin: {
    x: number;
    y: number;
  } = getResizedOrigin(
    previousOrigin,
    origElement.width,
    origElement.height,
    nextWidth,
    nextHeight,
    origElement.angle,
    handleDirection,
    shouldMaintainAspectRatio!!,
    shouldResizeFromCenter!!,
  );

  if (isLinearElement(origElement) && rescaledPoints.points) {
    // rescaledPoints 是“重新归一化”的 points：首个点可能不再位于 (0,0)。
    // 先把元素原有偏移补回，再把首点位移转移到 origin 上，最后把 points
    // 平移回首点，保证 x/y 与 points 描述的包围盒一致。
    const offsetX = origElement.x - previousOrigin[0];
    const offsetY = origElement.y - previousOrigin[1];

    newOrigin.x += offsetX;
    newOrigin.y += offsetY;

    const scaledX = rescaledPoints.points[0][0];
    const scaledY = rescaledPoints.points[0][1];

    newOrigin.x += scaledX;
    newOrigin.y += scaledY;

    rescaledPoints.points = rescaledPoints.points.map((p) =>
      pointFrom<LocalPoint>(p[0] - scaledX, p[1] - scaledY),
    );
  }

  // flipping
  // 翻转不仅改宽高符号，还要把 origin 平移一个负尺寸，否则元素会跑到
  // 另一侧。顺序不能与上面交换：上面按正尺寸算过 origin。
  if (nextWidth < 0) {
    newOrigin.x = newOrigin.x + nextWidth;
  }
  if (nextHeight < 0) {
    newOrigin.y = newOrigin.y + nextHeight;
  }

  if ("scale" in latestElement && "scale" in origElement) {
    // 图片的 scale 记录“是否被水平/垂直翻转”，不是尺寸。符号为 0 时
    // 保留原值，避免 Math.sign 把 0 乘成 0。
    scene.mutateElement(latestElement, {
      scale: [
        // defaulting because scaleX/Y can be 0/-0
        (Math.sign(nextWidth) || origElement.scale[0]) * origElement.scale[0],
        (Math.sign(nextHeight) || origElement.scale[1]) * origElement.scale[1],
      ],
    });
  }

  if (
    isArrowElement(latestElement) &&
    boundTextElement &&
    shouldMaintainAspectRatio
  ) {
    const fontSize =
      (Math.abs(nextWidth) / latestElement.width) * boundTextElement.fontSize;
    if (fontSize < MIN_FONT_SIZE) {
      return;
    }
    boundTextFont.fontSize = fontSize;
  }

  if (
    nextWidth !== 0 &&
    nextHeight !== 0 &&
    Number.isFinite(newOrigin.x) &&
    Number.isFinite(newOrigin.y)
  ) {
    // 只在这个“几何有效”的窗口里写回：0 尺寸会让后续测量除零，
    // NaN/Infinity 会污染 scene，宁可这一帧不动。
    let updates: ElementUpdate<ExcalidrawElement> = {
      ...newOrigin,
      width: Math.abs(nextWidth),
      height: Math.abs(nextHeight),
      ...rescaledPoints,
    };

    if (isBindingElement(latestElement)) {
      // 缩放箭头会改变端点相对位置，固定点不再可靠：起点直接解绑，
      // 终点置 null（这里保留原有写法，实际清理由 updateBoundElements 收尾）。
      if (latestElement.startBinding) {
        updates = {
          ...updates,
        } as ElementUpdate<ExcalidrawArrowElement>;

        if (latestElement.startBinding) {
          unbindBindingElement(latestElement, "start", scene);
        }
      }

      if (latestElement.endBinding) {
        updates = {
          ...updates,
          endBinding: null,
        } as ElementUpdate<ExcalidrawArrowElement>;
      }
    }

    scene.mutateElement(latestElement, updates, {
      informMutation: shouldInformMutation,
      isDragging: false,
    });

    if (isStickyNoteElement(latestElement)) {
      // 便签的布局（内边距、行高、文本折行）由配置驱动，必须在写回尺寸后
      // 立即重排；bindings 传 false 是为了把箭头更新留给下面的统一 pass，
      // 避免同一次手势里箭头被更新两次。
      updateStickyNoteLayout(latestElement, scene, {
        ...getStickyNoteResizeIntent(
          latestElement,
          originalElementsMap,
          handleDirection,
          {
            proportional: shouldMaintainAspectRatio,
            fromCenter: shouldResizeFromCenter,
          },
        ),
        // the arrow pass below is this function's — keep it single
        bindings: false,
        renderEnvironment,
      });
    } else {
      if (boundTextElement && boundTextFont != null) {
        // 先改字号再重排文本：handleBindTextResize 会用当前字号测量换行，
        // 顺序反过来会用旧字号算高度，出现一帧闪烁。
        scene.mutateElement(boundTextElement, {
          fontSize: boundTextFont.fontSize,
        });
      }
      handleBindTextResize(
        latestElement,
        scene,
        handleDirection,
        shouldMaintainAspectRatio,
        shouldResizeFromCenter,
        flipFactorY < 0,
        renderEnvironment,
      );
    }

    updateBoundElements(latestElement, scene, { renderEnvironment });
  }
};

/**
 * 单元素：把指针位置换算成“下一帧宽高”。
 *
 * 核心是比例而非绝对值：
 * 1. 用原始元素的未旋转包围盒建立坐标系，把指针反向旋转进本地；
 * 2. 缩放系数 = “从固定边到手柄的距离” / “当前包围盒宽高”，
 *    注意分母用 latestElement 的屏幕尺寸，这样线性元素的点缩放才能跟手；
 * 3. 从中心缩放时把尺寸按 2 倍扩张；
 * 4. 锁比例：边手柄把另一轴按同比例补齐，角手柄取两轴比例的较大者。
 *
 * 为什么用 latest 的尺寸做分母：元素可能在手势中被别的逻辑改过，
 * 用原始值会让比例与当前视觉不一致，产生拖拽漂移。
 *
 * @returns nextWidth/nextHeight 可为负，表示越过对边（翻转），不在这里裁剪。
 */
export const getNextSingleWidthAndHeightFromPointer = (
  latestElement: ExcalidrawElement,
  origElement: ExcalidrawElement,
  handleDirection: TransformHandleDirection,
  pointerX: number,
  pointerY: number,
  {
    shouldMaintainAspectRatio = false,
    shouldResizeFromCenter = false,
  }: {
    shouldMaintainAspectRatio?: boolean;
    shouldResizeFromCenter?: boolean;
  } = {},
) => {
  // Gets bounds corners
  // 中文：这里拿的是“未旋转”的绝对包围盒四角（getResizedElementAbsoluteCoords
  // 的第三个参数表示忽略旋转），后面再把指针反向旋转进来，避免两次旋转。
  const [x1, y1, x2, y2] = getResizedElementAbsoluteCoords(
    origElement,
    origElement.width,
    origElement.height,
    true,
  );
  const startTopLeft = pointFrom(x1, y1);
  const startBottomRight = pointFrom(x2, y2);
  const startCenter = pointCenter(startTopLeft, startBottomRight);

  // Calculate new dimensions based on cursor position
  const rotatedPointer = pointRotateRads(
    pointFrom(pointerX, pointerY),
    startCenter,
    -origElement.angle as Radians,
  );

  // Get bounds corners rendered on screen
  const [esx1, esy1, esx2, esy2] = getResizedElementAbsoluteCoords(
    latestElement,
    latestElement.width,
    latestElement.height,
    true,
  );

  const boundsCurrentWidth = esx2 - esx1;
  const boundsCurrentHeight = esy2 - esy1;

  // It's important we set the initial scale value based on the width and height at resize start,
  // otherwise previous dimensions affected by modifiers will be taken into account.
  const atStartBoundsWidth = startBottomRight[0] - startTopLeft[0];
  const atStartBoundsHeight = startBottomRight[1] - startTopLeft[1];
  let scaleX = atStartBoundsWidth / boundsCurrentWidth;
  let scaleY = atStartBoundsHeight / boundsCurrentHeight;

  if (handleDirection.includes("e")) {
    scaleX = (rotatedPointer[0] - startTopLeft[0]) / boundsCurrentWidth;
  }
  if (handleDirection.includes("s")) {
    scaleY = (rotatedPointer[1] - startTopLeft[1]) / boundsCurrentHeight;
  }
  if (handleDirection.includes("w")) {
    scaleX = (startBottomRight[0] - rotatedPointer[0]) / boundsCurrentWidth;
  }
  if (handleDirection.includes("n")) {
    scaleY = (startBottomRight[1] - rotatedPointer[1]) / boundsCurrentHeight;
  }

  // We have to use dimensions of element on screen, otherwise the scaling of the
  // dimensions won't match the cursor for linear elements.
  // 中文：乘回去的是 latestElement 的宽高，不是 origElement；线性元素的
  // 包围盒会随 points 改变，用最新值才能让“拖多少走多少”。
  let nextWidth = latestElement.width * scaleX;
  let nextHeight = latestElement.height * scaleY;

  if (shouldResizeFromCenter) {
    nextWidth = 2 * nextWidth - origElement.width;
    nextHeight = 2 * nextHeight - origElement.height;
  }

  // adjust dimensions to keep sides ratio
  if (shouldMaintainAspectRatio) {
    // 边手柄（长度 1）让另一轴按比例跟随；角手柄（长度 2）取两轴比例
    // 的较大者，并保留各自符号，保证翻转方向不被抹掉。
    const widthRatio = Math.abs(nextWidth) / origElement.width;
    const heightRatio = Math.abs(nextHeight) / origElement.height;
    if (handleDirection.length === 1) {
      nextHeight *= widthRatio;
      nextWidth *= heightRatio;
    }
    if (handleDirection.length === 2) {
      const ratio = Math.max(widthRatio, heightRatio);
      nextWidth = origElement.width * ratio * Math.sign(nextWidth);
      nextHeight = origElement.height * ratio * Math.sign(nextHeight);
    }
  }

  return {
    nextWidth,
    nextHeight,
  };
};

/**
 * 多选：把指针位置换算成“共同包围盒的下一帧宽高 + 是否翻转”。
 *
 * 与单选不同，这里不做逐元素比例，而是先用原始快照算出整个选择集的共同
 * 包围盒，再按锚点（对角/对边/中心）求新的外框尺寸。真正“映射到每个元素”
 * 的工作在 resizeMultipleElements 里。
 *
 * 两个易错点：
 * - 绑定文本必须手动补进包围盒：原始快照里的文本坐标可能是旧的（箭头标签
 *   由容器推导），不补会让包围盒偏小、标签被裁；
 * - 翻转条件用“指针是否越过锚点”判断，边手柄只判断对应轴，另一轴恒不翻转。
 *
 * @returns originalBoundingBox 一并返回，供 resizeMultipleElements 复用，
 *   避免重复计算（调用方已显式标注这是性能优化）。
 */
const getNextMultipleWidthAndHeightFromPointer = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  originalElementsMap: ElementsMap,
  elementsMap: ElementsMap,
  handleDirection: TransformHandleDirection,
  pointerX: number,
  pointerY: number,
  {
    shouldMaintainAspectRatio = false,
    shouldResizeFromCenter = false,
  }: {
    shouldResizeFromCenter?: boolean;
    shouldMaintainAspectRatio?: boolean;
  } = {},
) => {
  const originalElementsArray = selectedElements.map(
    (el) => originalElementsMap.get(el.id)!,
  );

  // getCommonBoundingBox() uses getBoundTextElement() which returns null for
  // original elements from pointerDownState, so we have to find and add these
  // bound text elements manually. Additionally, the coordinates of bound text
  // elements aren't always up to date.
  // 中文：这里手动补标签，是因为快照里的标签坐标可能滞后；用
  // LinearElementEditor.getBoundTextElementPosition 按箭头当前几何重算，
  // 保证包围盒包含标签的真实位置。
  const boundTextElements = originalElementsArray.reduce((acc, orig) => {
    if (!isLinearElement(orig)) {
      return acc;
    }
    const textId = getBoundTextElementId(orig);
    if (!textId) {
      return acc;
    }
    const text = originalElementsMap.get(textId) ?? null;
    if (!isBoundToContainer(text)) {
      return acc;
    }
    return [
      ...acc,
      {
        ...text,
        ...LinearElementEditor.getBoundTextElementPosition(
          orig,
          text,
          elementsMap,
        ),
      },
    ];
  }, [] as ExcalidrawTextElementWithContainer[]);

  const originalBoundingBox = getCommonBoundingBox(
    originalElementsArray.map((orig) => orig).concat(boundTextElements),
  );

  // 统一用 min/max 表示外框，后续锚点表按“对边”取值即可，不必区分旋转。
  const { minX, minY, maxX, maxY, midX, midY } = originalBoundingBox;
  const width = maxX - minX;
  const height = maxY - minY;

  const anchorsMap = {
    ne: [minX, maxY],
    se: [minX, minY],
    sw: [maxX, minY],
    nw: [maxX, maxY],
    e: [minX, minY + height / 2],
    w: [maxX, minY + height / 2],
    n: [minX + width / 2, maxY],
    s: [minX + width / 2, minY],
  } as Record<TransformHandleDirection, GlobalPoint>;

  // anchor point must be on the opposite side of the dragged selection handle
  // or be the center of the selection if shouldResizeFromCenter
  const [anchorX, anchorY] = shouldResizeFromCenter
    ? [midX, midY]
    : anchorsMap[handleDirection];

  const resizeFromCenterScale = shouldResizeFromCenter ? 2 : 1;

  const scale =
    Math.max(
      Math.abs(pointerX - anchorX) / width || 0,
      Math.abs(pointerY - anchorY) / height || 0,
    ) * resizeFromCenterScale;

  // 先按手柄所在轴决定宽高，未涉及的轴保持原尺寸；锁比例时再用统一
  // scale 覆盖，并用 sign 保留“指针是否越过锚点”的翻转信息。
  let nextWidth =
    handleDirection.includes("e") || handleDirection.includes("w")
      ? Math.abs(pointerX - anchorX) * resizeFromCenterScale
      : width;
  let nextHeight =
    handleDirection.includes("n") || handleDirection.includes("s")
      ? Math.abs(pointerY - anchorY) * resizeFromCenterScale
      : height;

  if (shouldMaintainAspectRatio) {
    nextWidth = width * scale * Math.sign(pointerX - anchorX);
    nextHeight = height * scale * Math.sign(pointerY - anchorY);
  }

  const flipConditionsMap: Record<
    TransformHandleDirection,
    // Condition for which we should flip or not flip the selected elements
    // - when evaluated to `true`, we flip
    // - therefore, setting it to always `false` means we do not flip (in that direction) at all
    // 中文：每条记录是 [x 轴是否翻转, y 轴是否翻转]。边手柄在无关轴上
    // 固定写 false，避免“拖东边却把整组上下翻转”的荒谬行为。
    [x: boolean, y: boolean]
  > = {
    ne: [pointerX < anchorX, pointerY > anchorY],
    se: [pointerX < anchorX, pointerY < anchorY],
    sw: [pointerX > anchorX, pointerY < anchorY],
    nw: [pointerX > anchorX, pointerY > anchorY],
    // e.g. when resizing from the "e" side, we do not need to consider changes in the `y` direction
    //      and therefore, we do not need to flip in the `y` direction at all
    e: [pointerX < anchorX, false],
    w: [pointerX > anchorX, false],
    n: [false, pointerY > anchorY],
    s: [false, pointerY < anchorY],
  };

  const [flipByX, flipByY] = flipConditionsMap[handleDirection].map(
    (condition) => condition,
  );

  return {
    originalBoundingBox,
    nextWidth,
    nextHeight,
    flipByX,
    flipByY,
  };
};

/**
 * 多选缩放。
 *
 * 不是逐个缩放，而是先算整个选择集的共同包围盒，再按同一个比例把每个
 * 元素的原始包围盒映射到新位置/新尺寸。这样元素之间的相对间距、对齐关系
 * 会被整体拉伸，和设计工具的行为一致。
 *
 * 绑定文本要额外参与包围盒计算：箭头标签的坐标由容器推导，不能只看箭头
 * 自身的 x/y/width/height，否则标签会被裁掉。
 *
 * 与单选的差别：这里所有元素共享同一个 scaleX/scaleY，元素之间的相对间距
 * 也会被拉伸——这是多选缩放的预期行为，不要改成逐个元素独立缩放。
 */
export const resizeMultipleElements = (
  selectedElements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  handleDirection: TransformHandleDirection,
  scene: Scene,
  originalElementsMap: ElementsMap,
  {
    shouldMaintainAspectRatio = false,
    shouldResizeFromCenter = false,
    flipByX = false,
    flipByY = false,
    nextHeight,
    nextWidth,
    originalBoundingBox,
    renderEnvironment,
  }: {
    nextWidth?: number;
    nextHeight?: number;
    shouldMaintainAspectRatio?: boolean;
    shouldResizeFromCenter?: boolean;
    flipByX?: boolean;
    flipByY?: boolean;
    // added to improve performance
    originalBoundingBox?: BoundingBox;
    renderEnvironment?: RenderEnvironment;
  } = {},
) => {
  // in the case of just flipping, there is no need to specify the next width and height
  // 中文：纯翻转时 nextWidth/nextHeight 可以缺省，但 flipByX/flipByY 必须
  // 有确定值（false 也算），否则说明调用方什么都没给，直接返回。
  if (
    nextWidth === undefined &&
    nextHeight === undefined &&
    flipByX === undefined &&
    flipByY === undefined
  ) {
    return;
  }

  // do not allow next width or height to be 0
  // 中文：0 会让下面的 scale/比例全变成 0/除零，直接跳过这一帧。
  if (nextHeight === 0 || nextWidth === 0) {
    return;
  }

  // 允许调用方不传快照（例如仅按比例重排），此时退化为“以当前值当原始值”。
  if (!originalElementsMap) {
    originalElementsMap = elementsMap;
  }

  const targetElements = selectedElements.reduce(
    (
      acc: {
        /** element at resize start */
        orig: NonDeletedExcalidrawElement;
        /** latest element */
        latest: NonDeletedExcalidrawElement;
      }[],
      element,
    ) => {
      // originalElementsMap holds snapshots of the (non-deleted) selection
      // 中文：只收“快照里有记录”的元素，新加入/被替换的元素没有起点比例，
      // 强行参与会导致它按错误原点跳位。
      const origElement = originalElementsMap!.get(element.id) as
        | NonDeletedExcalidrawElement
        | undefined;
      if (origElement) {
        acc.push({ orig: origElement, latest: element });
      }
      return acc;
    },
    [],
  );

  let boundingBox: BoundingBox;

  if (originalBoundingBox) {
    // 复用调用方算好的外框，避免多选场景下重复遍历元素；
    // 注意这个外框必须与 originalElements 来自同一时刻。
    boundingBox = originalBoundingBox;
  } else {
    const boundTextElements = targetElements.reduce((acc, { orig }) => {
      if (!isLinearElement(orig)) {
        return acc;
      }
      const textId = getBoundTextElementId(orig);
      if (!textId) {
        return acc;
      }
      const text = originalElementsMap!.get(textId) ?? null;
      if (!isBoundToContainer(text)) {
        return acc;
      }
      return [
        ...acc,
        {
          ...text,
          ...LinearElementEditor.getBoundTextElementPosition(
            orig,
            text,
            elementsMap,
          ),
        },
      ];
    }, [] as ExcalidrawTextElementWithContainer[]);

    boundingBox = getCommonBoundingBox([
      ...targetElements.map(({ orig }) => orig),
      ...boundTextElements,
    ]);
  }
  const { minX, minY, maxX, maxY, midX, midY } = boundingBox;
  const width = maxX - minX;
  const height = maxY - minY;

  if (nextWidth === undefined && nextHeight === undefined) {
    nextWidth = width;
    nextHeight = height;
  }

  if (shouldMaintainAspectRatio) {
    // 只有一轴给了目标值时，另一轴按原始比例补；两轴都给了但比例不一致时，
    // 以高度为准重算宽度（0.001 容差避免浮点误差反复触发）。
    if (nextWidth === undefined) {
      nextWidth = nextHeight! * (width / height);
    } else if (nextHeight === undefined) {
      nextHeight = nextWidth! * (height / width);
    } else if (Math.abs(nextWidth / nextHeight - width / height) > 0.001) {
      nextWidth = nextHeight * (width / height);
    }
  }

  if (nextWidth && nextHeight) {
    // 单轴手柄（n/s 或 e/w）只在对应轴缩放，另一轴 scale 恒为 1，
    // 避免“拖边手柄却把整组等比放大”。
    let scaleX =
      handleDirection.includes("e") || handleDirection.includes("w")
        ? Math.abs(nextWidth) / width
        : 1;
    let scaleY =
      handleDirection.includes("n") || handleDirection.includes("s")
        ? Math.abs(nextHeight) / height
        : 1;

    let scale: number;

    if (handleDirection.length === 1) {
      scale =
        handleDirection.includes("e") || handleDirection.includes("w")
          ? scaleX
          : scaleY;
    } else {
      scale = Math.max(
        Math.abs(nextWidth) / width || 0,
        Math.abs(nextHeight) / height || 0,
      );
    }

    const anchorsMap = {
      ne: [minX, maxY],
      se: [minX, minY],
      sw: [maxX, minY],
      nw: [maxX, maxY],
      e: [minX, minY + height / 2],
      w: [maxX, minY + height / 2],
      n: [minX + width / 2, maxY],
      s: [minX + width / 2, minY],
    } as Record<TransformHandleDirection, GlobalPoint>;

    // anchor point must be on the opposite side of the dragged selection handle
    // or be the center of the selection if shouldResizeFromCenter
    const [anchorX, anchorY] = shouldResizeFromCenter
      ? [midX, midY]
      : anchorsMap[handleDirection];

    const keepAspectRatio =
      shouldMaintainAspectRatio ||
      targetElements.some(
        (item) =>
          // 旋转过的元素无法在非等比缩放下保持形状，文本与编组也有同样限制；
          // 这里做保守降级：只要集合里有一个这样的元素，整组都锁比例。
          item.latest.angle !== 0 ||
          isTextElement(item.latest) ||
          isInGroup(item.latest),
      );

    if (keepAspectRatio) {
      scaleX = scale;
      scaleY = scale;
    }

    /**
     * to flip an element:
     * 1. determine over which axis is the element being flipped
     *    (could be x, y, or both) indicated by `flipFactorX` & `flipFactorY`
     * 2. shift element's position by the amount of width or height (or both) or
     *    mirror points in the case of linear & freedraw elemenets
     * 3. adjust element angle
     */
    const [flipFactorX, flipFactorY] = [flipByX ? -1 : 1, flipByY ? -1 : 1];

    // 先算齐所有元素的 update，再统一写回：这样 updateBoundElements 能拿到
    // 一份“本次操作后”的完整元素列表，不会出现先后顺序导致的端点错位。
    const elementsAndUpdates: {
      element: NonDeletedExcalidrawElement;
      update: Mutable<
        Pick<ExcalidrawElement, "x" | "y" | "width" | "height" | "angle">
      > & {
        points?: ExcalidrawLinearElement["points"];
        fontSize?: ExcalidrawTextElement["fontSize"];
        scale?: ExcalidrawImageElement["scale"];
        boundTextFontSize?: ExcalidrawTextElement["fontSize"];
        startBinding?: ExcalidrawElbowArrowElement["startBinding"];
        endBinding?: ExcalidrawElbowArrowElement["endBinding"];
        fixedSegments?: ExcalidrawElbowArrowElement["fixedSegments"];
      };
    }[] = [];

    for (const { orig, latest } of targetElements) {
      // bounded text elements are updated along with their container elements
      // 中文：容器内文本的位置/字号由容器分支统一处理，这里跳过以免被缩放
      // 两次（一次按容器，一次按自身），文字会越缩越小。
      if (isTextElement(orig) && isBoundToContainer(orig)) {
        continue;
      }

      // 尺寸与位置都用原始快照的比例映射，而不是在 latest 上继续乘；
      // 这正是“整个手势从同一原点重算”的体现。
      const width = orig.width * scaleX;
      const height = orig.height * scaleY;
      const angle = normalizeRadians(
        (orig.angle * flipFactorX * flipFactorY) as Radians,
      );

      const isLinearOrFreeDraw =
        isLinearElement(orig) || isFreeDrawElement(orig);
      // 翻转时，普通元素要额外平移一个“新宽/高”才能镜像到锚点另一侧；
      // 线性元素靠 mirror points 完成，不能再平移，否则会双重翻转。
      const offsetX = orig.x - anchorX;
      const offsetY = orig.y - anchorY;
      const shiftX = flipByX && !isLinearOrFreeDraw ? width : 0;
      const shiftY = flipByY && !isLinearOrFreeDraw ? height : 0;
      const x = anchorX + flipFactorX * (offsetX * scaleX + shiftX);
      const y = anchorY + flipFactorY * (offsetY * scaleY + shiftY);

      const rescaledPoints = rescalePointsInElement(
        orig,
        width * flipFactorX,
        height * flipFactorY,
        false,
      );

      const update: typeof elementsAndUpdates[0]["update"] = {
        x,
        y,
        width,
        height,
        angle,
        ...rescaledPoints,
      };

      if (isElbowArrow(orig)) {
        // Mirror fixed point binding for elbow arrows
        // when resize goes into the negative direction
        // 中文：fixedPoint 是 0..1 的比例，镜像公式是 1-x（不是 -x）；
        // 这里写成 -x+1 是为了与旧数据序列化结果保持一致。
        if (orig.startBinding) {
          update.startBinding = {
            ...orig.startBinding,
            fixedPoint: [
              flipByX
                ? -orig.startBinding.fixedPoint[0] + 1
                : orig.startBinding.fixedPoint[0],
              flipByY
                ? -orig.startBinding.fixedPoint[1] + 1
                : orig.startBinding.fixedPoint[1],
            ],
          };
        }
        if (orig.endBinding) {
          update.endBinding = {
            ...orig.endBinding,
            fixedPoint: [
              flipByX
                ? -orig.endBinding.fixedPoint[0] + 1
                : orig.endBinding.fixedPoint[0],
              flipByY
                ? -orig.endBinding.fixedPoint[1] + 1
                : orig.endBinding.fixedPoint[1],
            ],
          };
        }
        if (orig.fixedSegments && rescaledPoints.points) {
          // 固定段记录的是“第 index-1 到 index 个点”，缩放后点集变了，
          // 必须把端点换成新点集里的对应点，否则路由会用到旧坐标。
          update.fixedSegments = orig.fixedSegments.map((segment) => ({
            ...segment,
            start: rescaledPoints.points[segment.index - 1],
            end: rescaledPoints.points[segment.index],
          }));
        }
      }

      // 图片 scale 只表示镜像方向（1 或 -1），乘 flipFactor 即可，不影响
      // 已算好的 width/height。
      if (isImageElement(orig)) {
        update.scale = [
          orig.scale[0] * flipFactorX,
          orig.scale[1] * flipFactorY,
        ];
      }

      if (isTextElement(orig)) {
        // 文本字号由“缩放后的宽度”反推；低于最小字号时整组放弃，
        // 避免部分元素已放大、部分没动的不一致状态。
        const metrics = measureFontSizeFromWidth(orig, elementsMap, width);
        if (!metrics) {
          return;
        }
        update.fontSize = metrics.size;
      }

      const boundTextElement = originalElementsMap.get(
        getBoundTextElementId(orig) ?? "",
      ) as ExcalidrawTextElementWithContainer | undefined;

      // sticky notes derive their label's size from the layout below
      // 中文：便签标签不跟容器一起按比例改字号，布局函数会按便签新尺寸
      // 重新排布；其余容器才需要显式传 boundTextFontSize。
      if (boundTextElement && !isStickyNoteElement(orig)) {
        if (keepAspectRatio) {
          const newFontSize = boundTextElement.fontSize * scale;
          if (newFontSize < MIN_FONT_SIZE) {
            return;
          }
          update.boundTextFontSize = newFontSize;
        } else {
          update.boundTextFontSize = boundTextElement.fontSize;
        }
      }

      elementsAndUpdates.push({
        element: latest,
        update,
      });
    }

    const elementsToUpdate = elementsAndUpdates.map(({ element }) => element);
    // 这张 map 用于判断“绑定目标是否也在本次缩放里”：在集合内则保留绑定
    // （一起缩放位置仍正确），不在才解绑。
    const resizedElementsMap = new Map<
      ExcalidrawElement["id"],
      NonDeletedExcalidrawElement
    >(elementsAndUpdates.map(({ element }) => [element.id, element]));

    for (const {
      element,
      update: { boundTextFontSize, ...update },
    } of elementsAndUpdates) {
      const { angle } = update;

      // 写回顺序：先元素本身，再绑定文本/箭头。绑定更新依赖元素的新几何，
      // 必须放在 mutate 之后。
      scene.mutateElement(element, update);

      if (isStickyNoteElement(element)) {
        // the content correction runs before the (single) arrow pass, which
        // must still skip arrows resized in the same gesture
        updateStickyNoteLayout(element, scene, {
          ...getStickyNoteResizeIntent(
            element,
            originalElementsMap,
            handleDirection,
            {
              proportional: keepAspectRatio,
              fromCenter: shouldResizeFromCenter,
              flip: flipByX || flipByY,
            },
          ),
          bindings: { simultaneouslyUpdated: elementsToUpdate },
          renderEnvironment,
        });
      } else {
        // simultaneouslyUpdated 传整组元素：让 updateBoundElements 知道哪些
        // 元素已由本次手势统一处理，避免重复位移。
        updateBoundElements(element, scene, {
          simultaneouslyUpdated: elementsToUpdate,
          renderEnvironment,
        });
      }

      if (isBindingElement(element)) {
        // 只解绑目标不在本次缩放集合里的端点；集合内的目标会一起变换，
        // 绑定关系仍成立，保留才能让箭头继续跟随。
        if (element.startBinding) {
          if (!resizedElementsMap.has(element.startBinding.elementId)) {
            unbindBindingElement(element, "start", scene);
          }
        }
        if (element.endBinding) {
          if (!resizedElementsMap.has(element.endBinding.elementId)) {
            unbindBindingElement(element, "end", scene);
          }
        }
      }

      const boundTextElement = getBoundTextElement(element, elementsMap);
      if (
        boundTextElement &&
        boundTextFontSize &&
        !isStickyNoteElement(element)
      ) {
        // 线性元素的标签角度由箭头方向自然决定，不能写死成 angle，
        // 否则标签会与箭头方向不一致。
        scene.mutateElement(boundTextElement, {
          fontSize: boundTextFontSize,
          angle: isLinearElement(element) ? undefined : angle,
        });
        handleBindTextResize(
          element,
          scene,
          handleDirection,
          // 多选缩放里容器始终按“锁比例”处理文本，因为 keepAspectRatio
          // 已经把整组限制为等比；flipByY 用于让文字跟随容器翻转。
          true,
          shouldResizeFromCenter,
          flipByY,
          renderEnvironment,
        );
      }
    }

    scene.triggerUpdate();
  }
};
