import type { UserIdleState, EditorInterface } from "@excalidraw/common";
import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeletedElementsMap,
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import type { MakeBrand } from "@excalidraw/common/utility-types";
import type { RenderEnvironment } from "@excalidraw/element/renderEnvironment";

import type {
  AppClassProperties,
  AppState,
  EmbedsValidationStatus,
  ElementRenderOverrides,
  ElementsPendingErasure,
  InteractiveCanvasAppState,
  StaticCanvasAppState,
  SocketId,
  PendingExcalidrawElements,
} from "../types";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Drawable } from "roughjs/bin/core";

/**
 * 渲染配置与渲染输入的契约。
 *
 * 三层画布各自只声明自己需要的字段，避免把整个 AppState 传进绘制函数：
 * - StaticCanvasRenderConfig：静态元素绘制；
 * - InteractiveCanvasRenderConfig：选择框/手柄/协作光标；
 * - SVGRenderConfig：导出 SVG（与 canvas 路径分开）。
 * `StaticSceneRenderConfig` 才是 `renderStaticScene` 的真正入参，里面同时
 * 带了元素集合、appState 和 renderConfig。
 */
export type RenderableElementsMap = NonDeletedElementsMap &
  MakeBrand<"RenderableElementsMap">;

export type StaticCanvasRenderConfig = {
  canvasBackgroundColor: AppState["viewBackgroundColor"];
  /**
   * Backing-store scale the target canvas was bootstrapped with -- the owner
   * window's devicePixelRatio when rendering into the editor, exportScale when
   * exporting. Element caches are built and blitted at this ratio, so it must
   * be the same value passed as `StaticSceneRenderConfig["scale"]`.
   */
  scale: number;
  /**
   * Host environment that creates the canvases and images this render
   * rasterizes (per-editor owner window in the app; the export's
   * `config.environment` when exporting). Defaults to the browser's.
   */
  renderEnvironment?: RenderEnvironment;
  /** export only: clips everything drawn to this frame (square corners) */
  clipToFrame?: ExcalidrawFrameLikeElement | null;
  // extra options passed to the renderer
  // ---------------------------------------------------------------------------
  imageCache: AppClassProperties["imageCache"];
  renderGrid: boolean;
  /** whether to render link icons on elements with links (never rendered
   when exporting). @default true */
  renderLinks?: boolean;
  /** when exporting the behavior is slightly different (e.g. we can't use
   CSS filters), and we disable render optimizations for best output */
  isExporting: boolean;
  embedsValidationStatus: EmbedsValidationStatus;
  elementsPendingErasure: ElementsPendingErasure;
  pendingFlowchartNodes: PendingExcalidrawElements | null;
  theme: AppState["theme"];
  elementRenderOverrides?: ElementRenderOverrides;
};

export type SVGRenderConfig = {
  /**
   * Host environment used for the text measurements this render needs (the
   * SVG itself is built through `exportToSvg`'s owner document). Defaults to
   * the browser's.
   */
  renderEnvironment?: RenderEnvironment;
  offsetX: number;
  offsetY: number;
  isExporting: boolean;
  exportWithDarkMode: boolean;
  renderEmbeddables: boolean;
  frameRendering: AppState["frameRendering"];
  canvasBackgroundColor: AppState["viewBackgroundColor"];
  embedsValidationStatus: EmbedsValidationStatus;
  /**
   * whether to attempt to reuse images as much as possible through symbols
   * (reduces SVG size, but may be incompoatible with some SVG renderers)
   *
   * @default true
   */
  reuseImages: boolean;
  theme: AppState["theme"];
};

/**
 * 交互画布的协作态。
 *
 * 这些 Map 由 InteractiveCanvas 在每次渲染前从 appState.collaborators
 * 重建（见 components/canvases/InteractiveCanvas.tsx 的
 * collaborators.forEach），渲染函数只读。
 * remoteSelectedElementIds 是“元素 id → 多个 socket”的反向索引，因为同一
 * 元素可能被多人同时选中，需要画多圈不同颜色的高亮。
 */
export type InteractiveCanvasRenderConfig = {
  // collab-related state
  // ---------------------------------------------------------------------------
  remoteSelectedElementIds: Map<ExcalidrawElement["id"], SocketId[]>;
  remotePointerViewportCoords: Map<SocketId, { x: number; y: number }>;
  remotePointerUserStates: Map<SocketId, UserIdleState>;
  remotePointerUsernames: Map<SocketId, string>;
  remotePointerButton: Map<SocketId, string | undefined>;
  selectionColor: string;
  lastViewportPosition: { x: number; y: number };
  // extra options passed to the renderer
  // ---------------------------------------------------------------------------
  renderScrollbars?: boolean;
};

export type RenderInteractiveSceneCallback = {
  scrollBars?: ScrollBars;
};

/**
 * 静态场景一次绘制的完整输入。
 *
 * `elementsMap` 是“可渲染子集”（已排除编辑中的文本与独立新元素），
 * `allElementsMap` 是 Scene 全量非删除——绑定文本、frame 裁剪等需要查
 * 不在可见集合里的关联元素，所以两个 map 必须同时给。
 */
export type StaticSceneRenderConfig = {
  canvas: HTMLCanvasElement;
  rc: RoughCanvas;
  elementsMap: RenderableElementsMap;
  allElementsMap: NonDeletedSceneElementsMap;
  visibleElements: readonly NonDeletedExcalidrawElement[];
  scale: number;
  appState: StaticCanvasAppState;
  renderConfig: StaticCanvasRenderConfig;
};

export type InteractiveSceneRenderAnimationState = {
  bindingHighlight: { runtime: number } | undefined;
};

export type InteractiveSceneRenderConfig = {
  app: AppClassProperties;
  canvas: HTMLCanvasElement | null;
  elementsMap: RenderableElementsMap;
  visibleElements: readonly NonDeletedExcalidrawElement[];
  selectedElements: readonly NonDeletedExcalidrawElement[];
  allElementsMap: NonDeletedSceneElementsMap;
  scale: number;
  appState: InteractiveCanvasAppState;
  renderConfig: InteractiveCanvasRenderConfig;
  editorInterface: EditorInterface;
  callback: (data: RenderInteractiveSceneCallback) => void;
  animationState?: InteractiveSceneRenderAnimationState;
  deltaTime: number;
};

export type NewElementSceneRenderConfig = {
  canvas: HTMLCanvasElement | null;
  rc: RoughCanvas;
  newElement: NonDeletedExcalidrawElement | null;
  elementsMap: RenderableElementsMap;
  allElementsMap: NonDeletedSceneElementsMap;
  scale: number;
  appState: AppState;
  renderConfig: StaticCanvasRenderConfig;
};

export type SceneScroll = {
  scrollX: number;
  scrollY: number;
};

export type ExportType =
  | "png"
  | "clipboard"
  | "clipboard-svg"
  | "backend"
  | "svg";

export type ScrollBars = {
  horizontal: {
    x: number;
    y: number;
    width: number;
    height: number;
    deltaMultiplier: number;
  } | null;
  vertical: {
    x: number;
    y: number;
    width: number;
    height: number;
    deltaMultiplier: number;
  } | null;
};

export type SVGPathString = string & { __brand: "SVGPathString" };

export type ElementShape =
  | Drawable
  | Drawable[]
  | Path2D
  | (Drawable | SVGPathString)[]
  | null;

/**
 * 元素类型 → 缓存的绘制产物。
 *
 * rect/ellipse/diamond 等 roughjs Drawable 可以跨帧复用；text/image/frame
 * 为 null，表示它们没有可缓存的 vector shape（文字走 DOM/文本测量，
 * 图片走 drawImage）。
 */
export type ElementShapes = {
  rectangle: Drawable;
  ellipse: Drawable;
  diamond: Drawable;
  iframe: Drawable;
  embeddable: Drawable;
  freedraw: (Drawable | SVGPathString)[];
  arrow: Drawable[];
  line: Drawable[];
  text: null;
  stickynote: null;
  image: null;
  frame: null;
  magicframe: null;
};
