/**
 * 本文件位于渲染链路的最末端：不可变数据（Scene → Store 快照）经过
 * History/Delta 得到新元素集合，再经 Renderer 裁剪出 visibleElements，
 * 最后由这里把这些元素真正落到 `<canvas>` 上。
 *
 * 它只负责“画”，不决定“画哪些、按什么顺序画”（那是 scene/Renderer.ts）。
 * 输入是只读的：这里不会 mutate 任何元素，所有变换都作用在 canvas context
 * 上，并用 withSavedContext 保证 save/restore 成对，避免一个元素的
 * 变换泄漏到下一个元素。
 *
 * 另一条调用链是导出：scene/export.ts 直接调用 renderStaticScene（不做
 * 节流），此时 isExporting 为 true，scroll 不吸附、链接图标不画。
 */
import {
  applyDarkModeFilter,
  COLOR_WHITE,
  FRAME_STYLE,
  THEME,
  throttleRAF,
} from "@excalidraw/common";
import { isElementLink } from "@excalidraw/element";
import { createPlaceholderEmbeddableLabel } from "@excalidraw/element";
import { getBoundTextElement } from "@excalidraw/element";
import {
  isEmbeddableElement,
  isIframeLikeElement,
  isTextElement,
} from "@excalidraw/element";
import {
  elementOverlapsWithFrame,
  getTargetFrame,
  isFrameClippable,
  shouldApplyFrameClip,
} from "@excalidraw/element";

import {
  getRenderElementWithPositionOverride,
  resolveElementRenderState,
  renderElement,
  withSavedContext,
} from "@excalidraw/element";

import { getRenderEnvironment } from "@excalidraw/element/renderEnvironment";

import { getElementAbsoluteCoords } from "@excalidraw/element";

import type { RenderEnvironment } from "@excalidraw/element/renderEnvironment";

import type { ElementRenderState } from "@excalidraw/element";

import type {
  ElementsMap,
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import {
  getExternalLinkImg,
  getElementLinkImg,
  getLinkHandleFromCoords,
} from "../components/hyperlink/helpers";

import {
  bootstrapCanvas,
  getNormalizedCanvasDimensions,
  snapScrollToDevicePixels,
} from "./helpers";

import type {
  StaticCanvasRenderConfig,
  StaticSceneRenderConfig,
} from "../scene/types";
import type { StaticCanvasAppState, Zoom } from "../types";

/**
 * A render failure is per-element on purpose, on export too: one bad element
 * must not blank the canvas or fail the export, the rest of the scene
 * survives it.
 *
 * 中文：单个元素抛错只记录日志并继续画下一个。之所以在导出路径也这样做，
 * 是因为整帧失败会让用户拿不到任何图片；局部缺失是更可接受的降级。
 * 打印 id 与几何信息，便于从用户日志里定位是哪个元素坏了。
 */
const logElementRenderError = (
  error: unknown,
  element: NonDeletedExcalidrawElement,
) => {
  console.error(
    error,
    element.id,
    element.x,
    element.y,
    element.width,
    element.height,
  );
};

/**
 * 网格线的两种颜色。深色主题要通过 applyDarkModeFilter 反相，不能直接
 * 复用浅色的灰值，否则在深色背景上会过亮、盖过元素。
 */
const GridLineColor = {
  [THEME.LIGHT]: {
    bold: "#dddddd",
    regular: "#e5e5e5",
  },
  [THEME.DARK]: {
    bold: applyDarkModeFilter("#dddddd"),
    regular: applyDarkModeFilter("#e5e5e5"),
  },
} as const;

/**
 * 画网格背景（在元素之前，充当第一层）。
 *
 * 坐标约定：调用时 context 已经 scale(zoom)，因此这里的 scrollX/scrollY
 * 是场景单位，`width/height` 也已被换算成“场景单位”（见调用处的
 * normalizedWidth / zoom）。`offsetX` 多减一个 gridSize、循环多跑两格，
 * 是为了让网格在视口边缘外也有内容，滚动时不会露出空白缝。
 *
 * `scale` 是 backing store 的物理像素倍率（devicePixelRatio × exportScale），
 * 只用于把线宽对齐到设备像素，不参与坐标换算。
 */
const strokeGrid = (
  context: CanvasRenderingContext2D,
  /** grid cell pixel size */
  gridSize: number,
  /** setting to 1 will disble bold lines */
  gridStep: number,
  scrollX: number,
  scrollY: number,
  zoom: Zoom,
  theme: StaticCanvasRenderConfig["theme"],
  width: number,
  height: number,
  scale: number,
) => {
  const offsetX = (scrollX % gridSize) - gridSize;
  const offsetY = (scrollY % gridSize) - gridSize;

  // 缩放后的实际格子尺寸，用于“缩得太小就别画细线”的判断
  const actualGridSize = gridSize * zoom.value;

  // 虚线间隙按场景单位算（1 / zoom），保证屏幕上的间隙不随缩放变化
  const spaceWidth = 1 / zoom.value;

  // scene units → device pixels
  const devicePixels = zoom.value * scale;

  // 中文：把“位置 + 线宽”一起对齐到整设备像素。1px 的线若落在两个像素
  // 交界处，抗锯齿会把它摊成两条半透明的线，视觉上网格发虚；奇数宽时
  // 再补 0.5 偏移让它正好覆盖整像素。缩得很远时线本身不足 1 设备像素，
  // 此时保留亚像素宽度，靠“更浅”来表达，而不是强行加粗。
  // A line at least a device pixel wide is drawn a whole number of device
  // pixels wide and centered to cover them exactly — on the half pixel when
  // the count is odd. Straddling a pixel boundary renders it as two lighter
  // pixels, which is how the grid looked at every zoom but 100%. Thinner
  // lines (zoomed far out) keep their sub-pixel width: their lightness is
  // the point.
  const snap = (position: number, maxWidthInCssPixels: number) => {
    // a line is `min(1 / zoom, max)` scene units wide; computed straight in
    // device pixels, so `(1 / zoom) × zoom` never lands just under 1
    const widthInDevicePixels = Math.min(
      scale,
      maxWidthInCssPixels * devicePixels,
    );
    if (widthInDevicePixels < 1) {
      return { position, lineWidth: widthInDevicePixels / devicePixels };
    }
    const wholeWidth = Math.round(widthInDevicePixels);
    const center = wholeWidth % 2 ? 0.5 : 0;
    return {
      position:
        (Math.round(position * devicePixels - center) + center) / devicePixels,
      lineWidth: wholeWidth / devicePixels,
    };
  };

  context.save();

  // vertical lines
  // 竖线：x 从 offsetX 起每格一条，多跑两格覆盖视口左右边缘。
  // `isBold` 用 (x - scrollX) 对 gridStep*gridSize 取模，抵消滚动偏移，
  // 保证粗线始终钉在网格的“大格”边界上，滚动画布时不会漂移。
  for (let x = offsetX; x < offsetX + width + gridSize * 2; x += gridSize) {
    const isBold =
      gridStep > 1 && Math.round(x - scrollX) % (gridStep * gridSize) === 0;
    // don't render regular lines when zoomed out and they're barely visible
    if (!isBold && actualGridSize < 10) {
      continue;
    }

    const { position, lineWidth } = snap(x, isBold ? 4 : 1);
    context.lineWidth = lineWidth;
    const lineDash = [lineWidth * 3, spaceWidth + (lineWidth + spaceWidth)];

    context.beginPath();
    context.setLineDash(isBold ? [] : lineDash);
    context.strokeStyle = isBold
      ? GridLineColor[theme].bold
      : GridLineColor[theme].regular;
    context.moveTo(position, offsetY - gridSize);
    context.lineTo(position, Math.ceil(offsetY + height + gridSize * 2));
    context.stroke();
  }

  for (let y = offsetY; y < offsetY + height + gridSize * 2; y += gridSize) {
    // 横线逻辑与竖线完全对称，唯一区别是坐标轴
    const isBold =
      gridStep > 1 && Math.round(y - scrollY) % (gridStep * gridSize) === 0;
    if (!isBold && actualGridSize < 10) {
      continue;
    }

    const { position, lineWidth } = snap(y, isBold ? 4 : 1);
    context.lineWidth = lineWidth;
    const lineDash = [lineWidth * 3, spaceWidth + (lineWidth + spaceWidth)];

    context.beginPath();
    context.setLineDash(isBold ? [] : lineDash);
    context.strokeStyle = isBold
      ? GridLineColor[theme].bold
      : GridLineColor[theme].regular;
    context.moveTo(offsetX - gridSize, position);
    context.lineTo(Math.ceil(offsetX + width + gridSize * 2), position);
    context.stroke();
  }
  context.restore();
};

/**
 * 把 context 裁剪到某个 frame 的圆角矩形内。
 *
 * 先 translate 到 frame 原点画裁剪路径，再 translate 回来：调用方之后的
 * 绘制仍使用“场景坐标”，不需要知道裁剪发生过。圆角半径要除以 zoom，
 * 因为此时 context 已被 scale(zoom)，否则屏幕上的圆角会随缩放变大。
 *
 * 前提：调用方已经 save()，或用 withSavedContext 包裹；本函数只负责 clip，
 * 不负责 restore。
 */
export const frameClip = (
  frame: ExcalidrawFrameLikeElement,
  context: CanvasRenderingContext2D,
  renderConfig: StaticCanvasRenderConfig,
  appState: StaticCanvasAppState,
) => {
  context.translate(frame.x + appState.scrollX, frame.y + appState.scrollY);
  context.beginPath();
  if (context.roundRect) {
    context.roundRect(
      0,
      0,
      frame.width,
      frame.height,
      FRAME_STYLE.radius / appState.zoom.value,
    );
  } else {
    context.rect(0, 0, frame.width, frame.height);
  }
  context.clip();
  context.translate(
    -(frame.x + appState.scrollX),
    -(frame.y + appState.scrollY),
  );
};

type LinkIconCanvasCacheType = "regularLink" | "elementLink";

/**
 * 链接图标的离屏 canvas 缓存。
 *
 * 图标每次重绘都要 drawImage + 填底色，直接画在静态画布上会随滚动反复
 * 生成；这里把“某种类型 + 尺寸 + 背景色”的成品缓存成一张小 canvas，
 * 后续帧只需一次 drawImage。
 *
 * key 里带 backgroundColor：深色主题下图标要有对应底色，否则透明边缘
 * 会露出上一帧的内容。WeakMap 以 renderEnvironment 为 key，让不同
 * 编辑器实例（以及导出环境）互不污染，环境销毁后缓存自动回收。
 */
const linkIconCanvasCache = new WeakMap<
  RenderEnvironment,
  Map<string, HTMLCanvasElement>
>();
/** 上限 8 条，配合下方 LRU：图标尺寸种类很少，超过说明背景/缩放频繁变化 */
const LINK_ICON_CACHE_MAX_ENTRIES = 8;

/** 缓存 key：类型 + 物理像素尺寸 + 背景色，三者任一变化都必须重建位图 */
const getLinkIconCacheKey = (
  type: LinkIconCanvasCacheType,
  canvasWidth: number,
  canvasHeight: number,
  backgroundColor: string,
) => `${type}:${canvasWidth}x${canvasHeight}:${backgroundColor}`;

/**
 * 画元素右上角的外部链接 / 元素链接小图标。
 *
 * 跳过条件：元素没有 link，或元素当前被选中（选中时由交互画布画带背景的
 * 图标，静态层不重复画）。图标位置由 getLinkHandleFromCoords 给出，且要
 * 加上 renderState.offset 才能和动画中的元素对齐。
 *
 * 图标资源是异步解码的：status !== "decoded" 时直接返回，下一帧再试，
 * 不会为了等图而阻塞整帧。
 */
const renderLinkIcon = (
  element: NonDeletedExcalidrawElement,
  context: CanvasRenderingContext2D,
  appState: StaticCanvasAppState,
  elementsMap: ElementsMap,
  renderState: ElementRenderState,
  /** backing-store scale, see StaticCanvasRenderConfig["scale"] */
  scale: number,
  renderEnvironment: RenderEnvironment,
) => {
  if (element.link && !appState.selectedElementIds[element.id]) {
    const [x1, y1, x2, y2] = getElementAbsoluteCoords(element, elementsMap);
    const [x, y, width, height] = getLinkHandleFromCoords(
      [
        x1 + renderState.offset.x,
        y1 + renderState.offset.y,
        x2 + renderState.offset.x,
        y2 + renderState.offset.y,
      ],
      element.angle,
      appState,
    );
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    context.save();
    context.translate(appState.scrollX + centerX, appState.scrollY + centerY);
    context.rotate(element.angle);

    const canvasKey: LinkIconCanvasCacheType = isElementLink(element.link)
      ? "elementLink"
      : "regularLink";

    const linkImg =
      canvasKey === "elementLink"
        ? getElementLinkImg(renderEnvironment)
        : getExternalLinkImg(renderEnvironment);

    if (linkImg.status !== "decoded") {
      context.restore();
      return;
    }

    const canvasWidth = Math.max(
      1,
      Math.floor(width * scale * appState.zoom.value),
    );
    const canvasHeight = Math.max(
      1,
      Math.floor(height * scale * appState.zoom.value),
    );
    const backgroundColor = appState.viewBackgroundColor || COLOR_WHITE;
    const cacheKey = getLinkIconCacheKey(
      canvasKey,
      canvasWidth,
      canvasHeight,
      backgroundColor,
    );

    let cache = linkIconCanvasCache.get(renderEnvironment);
    if (!cache) {
      cache = new Map();
      linkIconCanvasCache.set(renderEnvironment, cache);
    }

    let linkCanvas = cache.get(cacheKey);

    // 命中后先删再插，把该 key 提到 Map 末尾，形成 LRU 顺序
    if (linkCanvas) {
      cache.delete(cacheKey);
      cache.set(cacheKey, linkCanvas);
    } else {
      linkCanvas = renderEnvironment.createCanvas();
      linkCanvas.width = canvasWidth;
      linkCanvas.height = canvasHeight;
      cache.set(cacheKey, linkCanvas);
      // Map 的 keys() 按插入顺序返回，首项即最久未使用项
      if (cache.size > LINK_ICON_CACHE_MAX_ENTRIES) {
        const lruKey = cache.keys().next().value;
        if (lruKey !== undefined) {
          cache.delete(lruKey);
        }
      }

      const linkCanvasCacheContext = linkCanvas.getContext("2d")!;
      // 离屏 canvas 的尺寸是物理像素，绘制前也要按同样的倍率缩放，
      // 否则图标会被画到左上角一小块
      linkCanvasCacheContext.scale(
        scale * appState.zoom.value,
        scale * appState.zoom.value,
      );

      // Seed a sane default so a corrupted color (silently rejected by the
      // canvas) falls back to white instead of a stale fillStyle.
      linkCanvasCacheContext.fillStyle = COLOR_WHITE;
      linkCanvasCacheContext.fillStyle = backgroundColor;

      linkCanvasCacheContext.fillRect(0, 0, width, height);

      linkCanvasCacheContext.drawImage(linkImg.img, 0, 0, width, height);

      linkCanvasCacheContext.restore();
    }
    context.globalAlpha = renderState.opacity;
    context.drawImage(linkCanvas, x - centerX, y - centerY, width, height);
    context.restore();
  }
};
/**
 * 静态画布：元素本体。
 *
 * 一次绘制的坐标链路：
 * 1. `bootstrapCanvas` 把 backing store 按 devicePixelRatio/exportScale
 *    缩放，再填背景；
 * 2. `context.scale(zoom)` 把“场景坐标”映射到 CSS 像素；
 * 3. 每个元素自己再加 `scrollX/scrollY` 与自身 angle 的变换；
 * 4. 元素按数组顺序绘制，后画的覆盖先画的（z-order 就是 index 顺序）。
 *
 * 它没有脏矩形：每帧全量重绘可见元素。性能靠的是
 * - 视口裁剪（Renderer.getRenderableElements）；
 * - 元素级 shape 缓存（ShapeCache）；
 * - rAF 节流（renderStaticSceneThrottled）。
 * 这也是为什么“重绘范围”要沿 Renderer 的 visibleElements 去理解，而不是
 * 找 dirtyRect。
 *
 * iframe/embeddable 单独在第二趟绘制，保证浮在所有普通元素之上。
 */
const _renderStaticScene = ({
  canvas,
  rc,
  elementsMap,
  allElementsMap,
  visibleElements,
  scale,
  appState: unsnappedAppState,
  renderConfig,
}: StaticSceneRenderConfig) => {
  // canvas 已在组件卸载时被置空（或尚未挂载），直接跳过，避免对 null
  // 调 getContext 抛错
  if (canvas === null) {
    return;
  }

  const { renderGrid = true, isExporting } = renderConfig;
  // 导出路径不吸附 scroll：导出画的是矢量，不存在缓存位图被半像素重采样
  // 的问题；吸附反而会让导出结果和真实视口差半个像素。
  // export draws vectors, not cached bitmaps — nothing to keep on the grid
  const appState = isExporting
    ? unsnappedAppState
    : snapScrollToDevicePixels(unsnappedAppState, scale);

  const [normalizedWidth, normalizedHeight] = getNormalizedCanvasDimensions(
    canvas,
    scale,
  );

  const context = bootstrapCanvas({
    canvas,
    scale,
    normalizedWidth,
    normalizedHeight,
    theme: appState.theme,
    isExporting,
    viewBackgroundColor: appState.viewBackgroundColor,
  });

  // Apply zoom
  // 视口变换只有这一处：之后所有绘制都用“场景单位”，滚动由每个元素的
  // translate(scrollX, scrollY) 加回来（见 renderElement 内部）。所以不要
  // 在这里再 translate scroll，否则会双重偏移。
  // 注意 scale 只做一次：bootstrapCanvas 已按 devicePixelRatio/exportScale
  // 设好 transform，这里再乘 zoom，两次相乘就是常见“缩放叠乘”bug。
  context.scale(appState.zoom.value, appState.zoom.value);

  // Grid
  if (renderGrid) {
    strokeGrid(
      context,
      appState.gridSize,
      appState.gridStep,
      appState.scrollX,
      appState.scrollY,
      appState.zoom,
      renderConfig.theme,
      normalizedWidth / appState.zoom.value,
      normalizedHeight / appState.zoom.value,
      scale,
    );
  }

  if (renderConfig.clipToFrame) {
    const frame = renderConfig.clipToFrame;
    context.beginPath();
    context.rect(
      frame.x + appState.scrollX,
      frame.y + appState.scrollY,
      frame.width,
      frame.height,
    );
    context.clip();
  }

  const groupsToBeAddedToFrame = new Set<string>();

  // 预扫一遍：拖拽中的分组若与高亮 frame 相交，就把整组都视为“属于该
  // frame”，后面做 z-order/裁剪时组内元素要一起处理，不能只动被拖的那个。
  visibleElements.forEach((element) => {
    if (
      element.groupIds.length > 0 &&
      appState.frameToHighlight &&
      appState.selectedElementIds[element.id] &&
      (elementOverlapsWithFrame(
        element,
        appState.frameToHighlight,
        elementsMap,
      ) ||
        element.groupIds.find((groupId) => groupsToBeAddedToFrame.has(groupId)))
    ) {
      element.groupIds.forEach((groupId) =>
        groupsToBeAddedToFrame.add(groupId),
      );
    }
  });

  const inFrameGroupsMap = new Map<string, boolean>();

  // 元素渲染状态的解析带缓存（frame 透明度、动画 offset 等都在其中），
  // 同一元素在本帧内可能被取多次（裁剪判断 + 实际绘制），复用同一份结果。
  const getRenderState = (element: ExcalidrawElement) =>
    resolveElementRenderState(
      element,
      elementsMap,
      renderConfig,
      allElementsMap,
    );

  const clipElementToFrame = (
    element: NonDeletedExcalidrawElement,
    renderState: ElementRenderState,
  ) => {
    // 三层短路，任意一层不满足都不裁剪：
    // 1. 元素没有 frameId 且当前没有高亮 frame —— 不在任何框里；
    // 2. frame 渲染或裁剪被用户关闭；
    // 3. 该元素类型本身不可被 frame 裁剪（如 frame 内的 frame 标题）。
    if (
      !(element.frameId || appState.frameToHighlight?.id) ||
      !appState.frameRendering.enabled ||
      !appState.frameRendering.clip ||
      !isFrameClippable(element, elementsMap)
    ) {
      return;
    }
    const targetFrame = getTargetFrame(element, elementsMap, appState);
    if (!targetFrame) {
      return;
    }
    const frameState = getRenderState(targetFrame);
    const frame = getRenderElementWithPositionOverride(
      targetFrame,
      frameState.offset,
    );
    const isTranslated = (state: ElementRenderState) =>
      state.offset.x !== 0 || state.offset.y !== 0;
    // 两种情况需要裁剪：
    // - 元素已属于该 frame，且任一方有动画位移（否则静态位置下元素本就在
    //   框内，裁剪是多余开销）；
    // - 元素正被拖到帧上（shouldApplyFrameClip 判断是否已越过边界）。
    if (
      (element.frameId === frame.id &&
        (isTranslated(renderState) || isTranslated(frameState))) ||
      shouldApplyFrameClip(
        getRenderElementWithPositionOverride(element, renderState.offset),
        frame,
        appState,
        elementsMap,
        inFrameGroupsMap,
      )
    ) {
      frameClip(frame, context, renderConfig, appState);
    }
  };

  // 第一趟：普通元素。绑定的文本不单独画——它由容器元素带着画，保证
  // 旋转/缩放后的相对位置一致（过滤条件里 containerId 在 elementsMap
  // 中才跳过；容器不可见时文本仍要能独立出现）。
  // 跳过 iframeLike：它们统一延后到第二趟，确保浮在所有普通元素之上。
  // Paint visible elements
  visibleElements
    .filter((el) => !isIframeLikeElement(el))
    .forEach((element) => {
      try {
        if (
          isTextElement(element) &&
          element.containerId &&
          elementsMap.has(element.containerId)
        ) {
          // will be rendered with the container
          return;
        }

        const boundTextElement = getBoundTextElement(element, elementsMap);

        const renderState = getRenderState(element);
        // withSavedContext 保证每个元素的 translate/rotate/clip 都被 restore，
        // 一个元素出错也不会让后续元素继承脏的 context 状态。
        withSavedContext(context, () => {
          clipElementToFrame(element, renderState);
          renderElement(
            element,
            elementsMap,
            allElementsMap,
            rc,
            context,
            renderConfig,
            appState,
            renderState,
          );

          // 绑定文本紧跟容器绘制，确保绘制顺序与坐标都从容器派生
          if (boundTextElement) {
            renderElement(
              boundTextElement,
              elementsMap,
              allElementsMap,
              rc,
              context,
              renderConfig,
              appState,
            );
          }
        });

        // 链接图标属于“编辑器辅助信息”，导出时不画；renderLinks 允许
        // 上层（如嵌入只读视图）整体关闭。
        if (!isExporting && renderConfig.renderLinks !== false) {
          renderLinkIcon(
            element,
            context,
            appState,
            elementsMap,
            renderState,
            scale,
            getRenderEnvironment(renderConfig.renderEnvironment),
          );
        }
      } catch (error: any) {
        logElementRenderError(error, element);
      }
    });

  // 第二趟：iframe/embeddable 永远置顶，避免被后画的普通元素盖住。
  // 未通过校验的 embeddable 在非导出模式下画占位标签。
  // render embeddables on top
  visibleElements
    .filter((el) => isIframeLikeElement(el))
    .forEach((element) => {
      try {
        const renderState = getRenderState(element);
        withSavedContext(context, () => {
          clipElementToFrame(element, renderState);
          renderElement(
            element,
            elementsMap,
            allElementsMap,
            rc,
            context,
            renderConfig,
            appState,
            renderState,
          );

          if (
            isIframeLikeElement(element) &&
            (isExporting ||
              (isEmbeddableElement(element) &&
                renderConfig.embedsValidationStatus.get(element.id) !==
                  true)) &&
            element.width &&
            element.height
          ) {
            // 占位标签是合成元素：复用宿主 id/frameId，让透明度与 frame
            // 归属走同一条渲染路径，而不是再注册一个动画目标。
            const label = {
              ...createPlaceholderEmbeddableLabel(
                element,
                renderConfig.renderEnvironment,
              ),
              // Synthetic visual: resolve overrides and frame opacity through
              // its owner, without creating another animation target.
              id: element.id,
              frameId: element.frameId,
            };
            renderElement(
              label,
              elementsMap,
              allElementsMap,
              rc,
              context,
              renderConfig,
              appState,
            );
          }
          if (!isExporting && renderConfig.renderLinks !== false) {
            renderLinkIcon(
              element,
              context,
              appState,
              elementsMap,
              renderState,
              scale,
              getRenderEnvironment(renderConfig.renderEnvironment),
            );
          }
        });
      } catch (error: any) {
        logElementRenderError(error, element);
      }
    });

  // render pending nodes for flowcharts
  // 流程图“待定节点”不在 Scene 里（尚未提交），只存在于 renderConfig，
  // 必须手动补画在最后；它们不参与裁剪与命中测试。
  renderConfig.pendingFlowchartNodes?.forEach((element) => {
    try {
      renderElement(
        element,
        elementsMap,
        allElementsMap,
        rc,
        context,
        renderConfig,
        appState,
      );
    } catch (error) {
      logElementRenderError(error, element);
    }
  });
};

type StaticSceneThrottle = ReturnType<typeof throttleRAF>;

/**
 * canvas → 节流器的弱引用表。
 *
 * 用 WeakMap 而不是全局单例：每块画布必须有自己的 rAF 调度，见
 * renderStaticSceneThrottled 上方的说明。ownerWindow 一并存下，用于检测
 * canvas 是否被移动到了另一个 document。
 */
const staticSceneThrottles = new WeakMap<
  HTMLCanvasElement,
  { throttle: StaticSceneThrottle; ownerWindow: Window }
>();

/**
 * 取（必要时创建）这块 canvas 专属的 rAF 节流器。
 *
 * ownerWindow 必须在创建时确定：throttleRAF 内部会捕获它来安排下一帧。
 * canvas 被 adopt 到别的 document 后旧 window 的 rAF 可能永远不再触发，
 * 所以一旦 ownerWindow 变化就取消并重建。
 */
const getStaticSceneThrottle = (canvas: HTMLCanvasElement) => {
  const ownerWindow = canvas.ownerDocument.defaultView ?? window;
  let entry = staticSceneThrottles.get(canvas);
  // the owner window is captured when the throttle is built, so a canvas
  // adopted into another document (moved rather than remounted) would keep
  // scheduling on the old window's rAF -- which never fires once that window
  // is closed. rebuild whenever the owner window no longer matches.
  if (entry && entry.ownerWindow !== ownerWindow) {
    entry.throttle.cancel();
    entry = undefined;
  }
  if (!entry) {
    entry = {
      throttle: throttleRAF((config: StaticSceneRenderConfig) => {
        _renderStaticScene(config);
      }, ownerWindow),
      ownerWindow,
    };
    staticSceneThrottles.set(canvas, entry);
  }
  return entry.throttle;
};

/**
 * Throttled to animation framerate, one throttle per canvas. A shared
 * throttle drops all but the last caller's pending frame when multiple
 * editors render in the same frame, and a module-realm scheduler would run
 * popout renders on the main window's rAF, which freezes while that window
 * is hidden.
 *
 * 每个 canvas 一个 rAF 节流器，而不是全局共用一个。
 *
 * 原因有两个：
 * - 多个编辑器同帧渲染时，共享节流器只会保留最后一个调用者，前面的画布
 *   会漏帧；
 * - 弹窗（popout）有独立 window，如果共用主窗口的 rAF，主窗口隐藏时
 *   弹窗渲染会被冻结。
 * ownerWindow 变化时重建节流器，处理 canvas 被 adopt 到另一个 document
 * 的情况。
 */
export const renderStaticSceneThrottled = (config: StaticSceneRenderConfig) => {
  // 同一帧内多次调用会被合并成一次重绘，且以最后一次传入的 config 为准。
  // 调用方（StaticCanvas）应把最新的 elements/visibleElements 一起带上。
  getStaticSceneThrottle(config.canvas)(config);
};

/** Drops the canvas' pending frame; the throttle itself is dropped with the
 * canvas. */
export const cancelStaticSceneThrottle = (canvas: HTMLCanvasElement) => {
  staticSceneThrottles.get(canvas)?.throttle.cancel();
};

/**
 * Static scene is the non-ui canvas where we render elements.
 *
 * 对外统一入口：`throttle` 为 true 走 rAF 合并（交互期间每帧一次），
 * 为 false 立即同步绘制（导出、测试、或需要立刻拿到像素的场景）。
 * 立即绘制不经过节流表，因此不会与已排队的帧互相覆盖。
 */
export const renderStaticScene = (
  renderConfig: StaticSceneRenderConfig,
  throttle?: boolean,
) => {
  if (throttle) {
    renderStaticSceneThrottled(renderConfig);
    return;
  }

  _renderStaticScene(renderConfig);
};
