/**
 * 静态画布组件：文档内容的唯一绘制出口。
 *
 * 渲染链路：
 *   App → StaticCanvas（本文件）→ renderStaticScene（renderer/staticScene.ts）
 *   → 每个元素的 shape 缓存 → canvas 2d context。
 * 上方叠着 InteractiveCanvas（选择框/手柄/协作光标）与 NewElementCanvas
 * （拖拽创建中的元素），三者各自独立 canvas，互不擦除。
 *
 * 输入：可见元素集合、appState 快照、scale（设备像素比）与 renderConfig
 * （主题、frame 渲染配置等）。输出：纯副作用（画布像素），没有返回值。
 *
 * 关键不变量：
 *   1. 本组件不持有绘制状态，所有输入都来自 props，因此可以做 React.memo；
 *   2. 没有脏矩形机制：每次重绘都是整帧可见元素，靠视口裁剪 + 元素级
 *      shape 缓存 + renderStaticScene 内部 rAF 节流控制成本；
 *   3. 画布尺寸必须在每次 appState.width/height/scale 变化时同步，否则
 *      canvas 会被拉伸（CSS 尺寸与位图尺寸不一致）。
 */
import React, { useEffect, useRef } from "react";

import { isShallowEqual } from "@excalidraw/common";

import type {
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import { isRenderThrottlingEnabled } from "../../reactUtils";
import { renderStaticScene } from "../../renderer/staticScene";

import type {
  RenderableElementsMap,
  StaticCanvasRenderConfig,
} from "../../scene/types";
import type { AppState, StaticCanvasAppState } from "../../types";
import type { RoughCanvas } from "roughjs/bin/canvas";

/**
 * 本组件的 props。
 *
 * canvas 由 App 创建并持有，组件只负责挂载与绘制；elementsMap /
 * visibleElements 是两份等价但用途不同的可见元素视图（Map 便于查找、
 * 数组保序便于遍历），canvasNonce 是外部强制重绘的版本号。
 */
type StaticCanvasProps = {
  canvas: HTMLCanvasElement;
  rc: RoughCanvas;
  elementsMap: RenderableElementsMap;
  allElementsMap: NonDeletedSceneElementsMap;
  visibleElements: readonly NonDeletedExcalidrawElement[];
  canvasNonce: string;
  selectionNonce: number | undefined;
  scale: number;
  appState: StaticCanvasAppState;
  renderConfig: StaticCanvasRenderConfig;
};

/**
 * 静态画布组件：只负责把当前 props 同步到 canvas 尺寸，然后调用
 * renderStaticScene。它不持有任何绘制状态，因此可以用 props 比较做
 * React.memo。
 *
 * 注意 `useEffect` 没有依赖数组：每次渲染都重绘。真正的节流发生在
 * renderStaticScene 内部（rAF），以及外层 areEqual 对 props 的浅比较。
 */
const StaticCanvas = (props: StaticCanvasProps) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isComponentMounted = useRef(false);

  useEffect(() => {
    // CSS 尺寸用逻辑像素，width/height 用设备像素；两者必须同时设置，
    // 否则高分屏上会被浏览器按位图尺寸拉伸，出现模糊或错位。
    props.canvas.style.width = `${props.appState.width}px`;
    props.canvas.style.height = `${props.appState.height}px`;
    props.canvas.width = props.appState.width * props.scale;
    props.canvas.height = props.appState.height * props.scale;
  }, [props.appState.height, props.appState.width, props.canvas, props.scale]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) {
      return;
    }

    const canvas = props.canvas;

    if (!isComponentMounted.current) {
      isComponentMounted.current = true;

      // 只在首次挂载时把 canvas 塞进 wrapper：后续渲染保持同一个 DOM 节点，
      // 避免 replaceChildren 导致画布内容被清空（会闪一帧白）。
      wrapper.replaceChildren(canvas);
      canvas.classList.add("excalidraw__canvas", "static");
    }

    // 第二个参数是 rAF 节流开关：拖拽/缩放等高频场景下合并到下一帧绘制，
    // 导出等一次性场景则同步绘制，保证取到的像素就是最终结果。
    renderStaticScene(
      {
        canvas,
        rc: props.rc,
        scale: props.scale,
        elementsMap: props.elementsMap,
        allElementsMap: props.allElementsMap,
        visibleElements: props.visibleElements,
        appState: props.appState,
        renderConfig: props.renderConfig,
      },
      isRenderThrottlingEnabled(),
    );
  });

  return <div className="excalidraw__canvas-wrapper" ref={wrapperRef} />;
};

/**
 * 从完整 AppState 中挑出静态层真正依赖的字段，供 React.memo 浅比较。
 *
 * 维护约束：renderStaticScene 读取的任何 appState 字段都必须出现在这里，
 * 否则该字段变化时不会重绘（例如只改 zoom 却看不到画面更新）。
 * selectedElementIds / suggestedBinding 虽不直接参与绘制，但会影响
 * “哪些元素被过滤”，因此仍需比较。
 */
const getRelevantAppStateProps = (appState: AppState): StaticCanvasAppState => {
  const relevantAppStateProps = {
    zoom: appState.zoom,
    scrollX: appState.scrollX,
    scrollY: appState.scrollY,
    width: appState.width,
    height: appState.height,
    viewModeEnabled: appState.viewModeEnabled,
    openDialog: appState.openDialog,
    hoveredElementIds: appState.hoveredElementIds,
    offsetLeft: appState.offsetLeft,
    offsetTop: appState.offsetTop,
    theme: appState.theme,
    shouldCacheIgnoreZoom: appState.shouldCacheIgnoreZoom,
    viewBackgroundColor: appState.viewBackgroundColor,
    exportScale: appState.exportScale,
    selectedElementsAreBeingDragged: appState.selectedElementsAreBeingDragged,
    gridSize: appState.gridSize,
    gridStep: appState.gridStep,
    frameRendering: appState.frameRendering,
    selectedElementIds: appState.selectedElementIds,
    frameToHighlight: appState.frameToHighlight,
    editingGroupId: appState.editingGroupId,
    currentHoveredFontFamily: appState.currentHoveredFontFamily,
    croppingElementId: appState.croppingElementId,
    suggestedBinding: appState.suggestedBinding,
  };

  return relevantAppStateProps;
};

/**
 * 手动 memo 比较。
 *
 * 不能只比 canvasNonce：elementsMap 可能因 appState 过滤而换了新对象，
 * 但 sceneNonce 没变（例如只改了 hover）；反过来，仅 appState 的绘制相关
 * 字段变化也必须重绘。所以这里把“引用级 token + 绘制相关 appState 浅比较”
 * 一起用。
 */
const areEqual = (
  prevProps: StaticCanvasProps,
  nextProps: StaticCanvasProps,
) => {
  if (
    prevProps.canvasNonce !== nextProps.canvasNonce ||
    prevProps.scale !== nextProps.scale ||
    // we need to memoize on elementsMap because they may have renewed
    // even if canvasNonce didn't change (e.g. we filter elements out based
    // on appState)
    // 两者都按引用比较：可见集合是每帧重建的不可变结构，内容变化必然换引用。
    prevProps.elementsMap !== nextProps.elementsMap ||
    prevProps.visibleElements !== nextProps.visibleElements
  ) {
    return false;
  }

  return (
    isShallowEqual(
      // asserting AppState because we're being passed the whole AppState
      // but resolve to only the StaticCanvas-relevant props
      getRelevantAppStateProps(prevProps.appState as AppState),
      getRelevantAppStateProps(nextProps.appState as AppState),
    ) && isShallowEqual(prevProps.renderConfig, nextProps.renderConfig)
  );
};

export default React.memo(StaticCanvas, areEqual);
