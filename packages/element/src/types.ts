import type { LocalPoint, Radians } from "@excalidraw/math";

import type {
  FONT_FAMILY,
  ROUNDNESS,
  TEXT_ALIGN,
  THEME,
  VERTICAL_ALIGN,
} from "@excalidraw/common";

import type {
  MakeBrand,
  MarkNonNullable,
  Merge,
  ValueOf,
} from "@excalidraw/common/utility-types";

/**
 * 元素模型（Excalidraw 的“文档层”）总览
 *
 * 这里定义的是可序列化、可跨端传输的元素形状，不包含任何计算缓存或
 * 本地 UI 状态。核心不变量：
 * - 所有字段在类型层面是 `Readonly`，但运行时元素会被就地 mutate
 *   （见 mutateElement.ts），真正不可变的副本只存在于 Store 快照与历史
 *   delta 中；
 * - `version` / `versionNonce` 是协作冲突裁决的唯一依据：version 大者胜，
 *   同 version 时 versionNonce 小者胜（见 data/reconcile.ts）；
 * - 删除是软删除：`isDeleted` 置 true 且元素仍留在 Scene/文件中，作为
 *   tombstone 参与同步，过期后才被过滤（见 excalidraw-app/data/index.ts 的
 *   isSyncableElement）；
 * - `index` 是 fractional index，负责跨端稳定排序，不只是数组下标。
 *
 * 阅读顺序：本文件 → Scene.ts（元素集合）→ mutateElement.ts（版本推进）
 * → store.ts（快照/增量）→ delta.ts（不可变应用）。
 */

export type ChartType = "bar" | "line" | "radar";
export type FillStyle = "hachure" | "cross-hatch" | "solid" | "zigzag";
export type FontFamilyKeys = keyof typeof FONT_FAMILY;
export type FontFamilyValues = typeof FONT_FAMILY[FontFamilyKeys];
export type Theme = typeof THEME[keyof typeof THEME];
export type FontString = string & { _brand: "fontString" };
export type GroupId = string;
export type PointerType = "mouse" | "pen" | "touch";
export type StrokeRoundness = "round" | "sharp";
export type RoundnessType = ValueOf<typeof ROUNDNESS>;
export type StrokeStyle = "solid" | "dashed" | "dotted";
export type TextAlign = typeof TEXT_ALIGN[keyof typeof TEXT_ALIGN];

type VerticalAlignKeys = keyof typeof VERTICAL_ALIGN;
export type VerticalAlign = typeof VERTICAL_ALIGN[VerticalAlignKeys];
export type FractionalIndex = string & { _brand: "franctionalIndex" };

export type BoundElement = Readonly<{
  id: ExcalidrawLinearElement["id"];
  type: "arrow" | "text";
}>;

/**
 * 所有元素共享的基类字段。
 *
 * 这里刻意把“几何/样式”和“协作元数据”放在一起：渲染、命中测试、同步都
 * 直接读同一个对象，没有额外的 side table。扩展元素（text/linear/image/
 * frame…）只追加自己的字段，不覆盖这里的语义。
 */
type _ExcalidrawElementBase = Readonly<{
  id: string;
  x: number;
  y: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roundness: null | { type: RoundnessType; value?: number };
  roughness: number;
  opacity: number;
  width: number;
  height: number;
  angle: Radians;
  /** Random integer used to seed shape generation so that the roughjs shape
      doesn't differ across renders. */
  seed: number;
  /** Integer that is sequentially incremented on each change. Used to reconcile
      elements during collaboration or when saving to server. */
  version: number;
  /** Random integer that is regenerated on each change.
      Used for deterministic reconciliation of updates during collaboration,
      in case the versions (see above) are identical. */
  versionNonce: number;
  /** String in a fractional form defined by https://github.com/rocicorp/fractional-indexing.
      Used for ordering in multiplayer scenarios, such as during reconciliation or undo / redo.
      Always kept in sync with the array order by `syncMovedIndices` and `syncInvalidIndices`.
      Could be null, i.e. for new elements which were not yet assigned to the scene. */
  index: FractionalIndex | null;
  isDeleted: boolean;
  /** List of groups the element belongs to.
      Ordered from deepest to shallowest. */
  groupIds: readonly GroupId[];
  frameId: string | null;
  /** other elements that are bound to this element */
  boundElements: readonly BoundElement[] | null;
  /** epoch (ms) timestamp of last element update */
  updated: number;
  /** Client wall-clock creation time in epoch milliseconds; null if unknown.
      Preserved for this element's lifetime, including edits and undo/redo,
      and excluded from `ElementUpdate` (mutateElement / newElementWith).
      Duplicating an element starts a new lifetime. Not an ordering clock. */
  created: number | null;
  link: string | null;
  locked: boolean;
  customData?: Record<string, any>;
}>;

/**
 * 仅存在于拖拽框选过程中的临时元素，用来把“正在画的选区矩形”也纳入
 * 元素管线；它不会进入持久化快照。
 */
export type ExcalidrawSelectionElement = _ExcalidrawElementBase & {
  type: "selection";
};

export type ExcalidrawRectangleElement = _ExcalidrawElementBase & {
  type: "rectangle";
};

export type ExcalidrawStickyNoteElement = _ExcalidrawElementBase &
  Readonly<{
    type: "stickynote";
    /**
     * The height the user set, from which the layout derives `height`: the
     * note grows above it to fit its label and never shrinks below it
     */
    baseHeight: number;
  }>;

export type ExcalidrawDiamondElement = _ExcalidrawElementBase & {
  type: "diamond";
};

export type ExcalidrawEllipseElement = _ExcalidrawElementBase & {
  type: "ellipse";
};

export type ExcalidrawEmbeddableElement = _ExcalidrawElementBase &
  Readonly<{
    type: "embeddable";
  }>;

export type MagicGenerationData =
  | {
      status: "pending";
    }
  | { status: "done"; html: string }
  | {
      status: "error";
      message?: string;
      code: "ERR_GENERATION_INTERRUPTED" | string;
    };

export type ExcalidrawIframeElement = _ExcalidrawElementBase &
  Readonly<{
    type: "iframe";
    // TODO move later to AI-specific frame
    customData?: { generationData?: MagicGenerationData };
  }>;

export type ExcalidrawIframeLikeElement =
  | ExcalidrawIframeElement
  | ExcalidrawEmbeddableElement;

export type IframeData =
  | {
      intrinsicSize: { w: number; h: number };
      error?: Error;
      sandbox?: { allowSameOrigin?: boolean };
    } & (
      | { type: "video" | "generic"; link: string }
      | { type: "document"; srcdoc: (theme: Theme) => string }
    );

export type ImageCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
};

export type ExcalidrawImageElement = _ExcalidrawElementBase &
  Readonly<{
    type: "image";
    fileId: FileId | null;
    /** whether respective file is persisted */
    status: "pending" | "saved" | "error";
    /** X and Y scale factors <-1, 1>, used for image axis flipping */
    scale: [number, number];
    /** whether an element is cropped */
    crop: ImageCrop | null;
  }>;

export type InitializedExcalidrawImageElement = MarkNonNullable<
  ExcalidrawImageElement,
  "fileId"
>;

export type ExcalidrawFrameElement = _ExcalidrawElementBase & {
  type: "frame";
  name: string | null;
};

export type ExcalidrawMagicFrameElement = _ExcalidrawElementBase & {
  type: "magicframe";
  name: string | null;
};

export type ExcalidrawFrameLikeElement =
  | ExcalidrawFrameElement
  | ExcalidrawMagicFrameElement;

/**
 * 没有额外字段的“基础图形”集合。渲染器对它们的差异只体现在
 * `renderElement` 的 shape 生成分支，数据模型完全一致。
 */
export type ExcalidrawGenericElement =
  | ExcalidrawSelectionElement
  | ExcalidrawRectangleElement
  | ExcalidrawDiamondElement
  | ExcalidrawEllipseElement;

export type ExcalidrawFlowchartNodeElement =
  | ExcalidrawRectangleElement
  | ExcalidrawStickyNoteElement
  | ExcalidrawDiamondElement
  | ExcalidrawEllipseElement;

export type ExcalidrawRectanguloidElement =
  | ExcalidrawRectangleElement
  | ExcalidrawStickyNoteElement
  | ExcalidrawImageElement
  | ExcalidrawTextElement
  | ExcalidrawFreeDrawElement
  | ExcalidrawIframeLikeElement
  | ExcalidrawFrameLikeElement
  | ExcalidrawEmbeddableElement
  | ExcalidrawSelectionElement;

/**
 * 全量元素联合类型。
 *
 * 该类型必须保持 JSON 可序列化，并且不能包含仅本端有意义的计算数据；
 * 所有 peer 之间的元素列表要能直接互换。渲染缓存（ShapeCache、
 * containerCache 等）因此挂在元素对象之外，而不是字段里。
 */
export type ExcalidrawElement =
  | ExcalidrawGenericElement
  | ExcalidrawStickyNoteElement
  | ExcalidrawTextElement
  | ExcalidrawLinearElement
  | ExcalidrawArrowElement
  | ExcalidrawFreeDrawElement
  | ExcalidrawImageElement
  | ExcalidrawFrameElement
  | ExcalidrawMagicFrameElement
  | ExcalidrawIframeElement
  | ExcalidrawEmbeddableElement;

export type ExcalidrawNonSelectionElement = Exclude<
  ExcalidrawElement,
  ExcalidrawSelectionElement
>;

/**
 * 以下三个 branded/narrowed 类型是编译期的“已校验”标记，运行时不产生
 * 额外字段：
 * - `Ordered`：`index` 一定非空，可以安全参与排序；
 * - `NonDeleted`：`isDeleted` 已收窄为 false，渲染/命中测试可直接使用；
 * - `NonDeletedSceneElementsMap`：Scene 对外承诺“全量非删除”，避免调用方
 *   每次都自己 filter。
 */
export type Ordered<TElement extends ExcalidrawElement> = TElement & {
  index: FractionalIndex;
};

export type OrderedExcalidrawElement = Ordered<ExcalidrawElement>;

export type NonDeleted<TElement extends ExcalidrawElement> = TElement & {
  isDeleted: false;
};

export type NonDeletedExcalidrawElement = NonDeleted<ExcalidrawElement>;

export type ExcalidrawTextElement = _ExcalidrawElementBase &
  Readonly<{
    type: "text";
    fontSize: number;
    fontFamily: FontFamilyValues;
    /**
     * The font size the user picked, from which the layout derives `fontSize`.
     * Today only sticky note labels have one: the auto-fit shrinks below it
     * and never above it (compare `baseHeight`, which the note grows above).
     * `null` for every other text. Read it through `getBaseFontSize` —
     * generic binding repair can detach a label without clearing this, so
     * the container decides its meaning.
     */
    baseFontSize: number | null;
    text: string;
    textAlign: TextAlign;
    verticalAlign: VerticalAlign;
    containerId: ExcalidrawTextContainer["id"] | null;
    originalText: string;
    /**
     * If `true` the width will fit the text. If `false`, the text will
     * wrap to fit the width.
     *
     * @default true
     */
    autoResize: boolean;
    /**
     * Unitless line height (aligned to W3C). To get line height in px, multiply
     *  with font size (using `getLineHeightInPx` helper).
     */
    lineHeight: number & { _brand: "unitlessLineHeight" };
    /**
     * Position of text bound to a linear element (such as an arrow),
     * expressed as a normalized arc-length parameter (0–1) along the
     * container's whole path. Independent of how the path is segmented,
     * so it survives midpoint insertion and other geometry changes.
     * */
    labelPosition?: number | null;
  }>;

/**
 * 可被箭头绑定的元素集合。箭头端点绑定只认这些类型；frame 也被列入，
 * 因为 frame 可以作为绑定容器参与布局（见 binding.ts 的
 * bindingProperties 与 getBindingSideMidPoint）。
 */
export type ExcalidrawBindableElement =
  | ExcalidrawRectangleElement
  | ExcalidrawStickyNoteElement
  | ExcalidrawDiamondElement
  | ExcalidrawEllipseElement
  | ExcalidrawTextElement
  | ExcalidrawImageElement
  | ExcalidrawIframeElement
  | ExcalidrawEmbeddableElement
  | ExcalidrawFrameElement
  | ExcalidrawMagicFrameElement;

/**
 * 可以承载绑定文本（bound text）的容器。箭头也在其中：箭头标签不是独立
 * 文本，而是 `containerId` 指向箭头的文本元素。
 */
export type ExcalidrawTextContainer =
  | ExcalidrawRectangleElement
  | ExcalidrawStickyNoteElement
  | ExcalidrawDiamondElement
  | ExcalidrawEllipseElement
  | ExcalidrawArrowElement;

export type ExcalidrawTextElementWithContainer = {
  containerId: ExcalidrawTextContainer["id"];
} & ExcalidrawTextElement;

export type FixedPoint = [number, number];

export type BindMode = "inside" | "orbit" | "skip";

/**
 * 箭头端点的“固定点”绑定。
 *
 * fixedPoint 是相对被绑定元素包围盒的归一化坐标（0..1），因此元素缩放/
 * 旋转后端点仍然跟着正确的边或角走。mode 决定端点停在元素外侧
 * （"orbit"）还是允许贴到固定点本身（"inside"），"skip" 用于临时跳过
 * 绑定计算。
 */
export type FixedPointBinding = {
  elementId: ExcalidrawBindableElement["id"];

  // Represents the fixed point binding information in form of a vertical and
  // horizontal ratio (i.e. a percentage value in the 0.0-1.0 range). This ratio
  // gives the user selected fixed point by multiplying the bound element width
  // with fixedPoint[0] and the bound element height with fixedPoint[1] to get the
  // bound element-local point coordinate.
  fixedPoint: FixedPoint;

  // Determines whether the arrow remains outside the shape or is allowed to
  // go all the way inside the shape up to the exact fixed point.
  mode: BindMode;
};

type Index = number;

export type PointsPositionUpdates = Map<
  Index,
  { point: LocalPoint; isDragging?: boolean }
>;

export type CardinalityArrowhead =
  | "cardinality_one"
  | "cardinality_many"
  | "cardinality_one_or_many"
  | "cardinality_exactly_one"
  | "cardinality_zero_or_one"
  | "cardinality_zero_or_many";

export type ArrowheadLegacy =
  | "dot"
  | "crowfoot_one"
  | "crowfoot_many"
  | "crowfoot_one_or_many";

export type Arrowhead =
  | "arrow"
  | "bar"
  | "circle"
  | "circle_outline"
  | "triangle"
  | "triangle_outline"
  | "diamond"
  | "diamond_outline"
  | CardinalityArrowhead;

export type AnyArrowhead = Arrowhead | ArrowheadLegacy;

/**
 * 线性元素（line/arrow）共享的形状。
 *
 * `points` 是相对于元素自身 x/y 的局部坐标，首点恒为 (0,0)——所有几何
 * 计算都依赖这个约定。绑定信息不在 points 里，而是单独的 startBinding/
 * endBinding；points 只描述“箭头怎么弯”，不描述“箭头粘在谁身上”。
 */
export type ExcalidrawLinearElement = _ExcalidrawElementBase &
  Readonly<{
    type: "line" | "arrow";
    points: readonly LocalPoint[];
    startBinding: FixedPointBinding | null;
    endBinding: FixedPointBinding | null;
    startArrowhead: Arrowhead | null;
    endArrowhead: Arrowhead | null;
  }>;

export type ExcalidrawLineElement = ExcalidrawLinearElement &
  Readonly<{
    type: "line";
    polygon: boolean;
  }>;

export type FixedSegment = {
  start: LocalPoint;
  end: LocalPoint;
  index: Index;
};

export type ExcalidrawArrowElement = ExcalidrawLinearElement &
  Readonly<{
    type: "arrow";
    elbowed: boolean;
  }>;

export type ExcalidrawElbowArrowElement = Merge<
  ExcalidrawArrowElement,
  {
    elbowed: true;
    fixedSegments: readonly FixedSegment[] | null;
    startBinding: FixedPointBinding | null;
    endBinding: FixedPointBinding | null;
    /**
     * Marks that the 3rd point should be used as the 2nd point of the arrow in
     * order to temporarily hide the first segment of the arrow without losing
     * the data from the points array. It allows creating the expected arrow
     * path when the arrow with fixed segments is bound on a horizontal side and
     * moved to a vertical and vica versa.
     */
    startIsSpecial: boolean | null;
    /**
     * Marks that the 3rd point backwards from the end should be used as the 2nd
     * point of the arrow in order to temporarily hide the last segment of the
     * arrow without losing the data from the points array. It allows creating
     * the expected arrow path when the arrow with fixed segments is bound on a
     * horizontal side and moved to a vertical and vica versa.
     */
    endIsSpecial: boolean | null;
  }
>;

export type StrokeVariability = "variable" | "constant";

export type StrokeOptions = Readonly<{
  variability: StrokeVariability;
  streamline: number;
}>;

export type ExcalidrawFreeDrawElement = _ExcalidrawElementBase &
  Readonly<{
    type: "freedraw";
    points: readonly LocalPoint[];
    pressures: readonly number[];
    simulatePressure: boolean;
    strokeOptions: StrokeOptions;
  }>;

export type FileId = string & { _brand: "FileId" };

export type ExcalidrawElementType = ExcalidrawElement["type"];

/**
 * 元素 Map 家族：差别只在“是否保证包含已删除元素”和“是否保证非删除”。
 * 调用方拿到 Map 时先确认自己需要哪一种，避免在热路径里反复 filter。
 * - ElementsMap：不承诺是否含删除，可能是 Scene 的子集；
 * - SceneElementsMap：承诺是当前 Scene 的全量（含删除）；
 * - NonDeletedSceneElementsMap：承诺是当前 Scene 的全量非删除。
 */
export type ElementsMap = Map<ExcalidrawElement["id"], ExcalidrawElement>;

/**
 * Map of non-deleted elements.
 * Can be a subset of Scene elements.
 */
export type NonDeletedElementsMap = Map<
  ExcalidrawElement["id"],
  NonDeletedExcalidrawElement
> &
  MakeBrand<"NonDeletedElementsMap">;

/**
 * Map of all excalidraw Scene elements, including deleted.
 * Not a subset. Use this type when you need access to current Scene elements.
 */
export type SceneElementsMap = Map<
  ExcalidrawElement["id"],
  Ordered<ExcalidrawElement>
> &
  MakeBrand<"SceneElementsMap">;

/**
 * Map of all non-deleted Scene elements.
 * Not a subset. Use this type when you need access to current Scene elements.
 */
export type NonDeletedSceneElementsMap = Map<
  ExcalidrawElement["id"],
  Ordered<NonDeletedExcalidrawElement>
> &
  MakeBrand<"NonDeletedSceneElementsMap">;

/**
 * 很多入口既接受数组也接受 Map：数组路径通常来自持久化/导入，
 * Map 路径来自运行时 Scene。函数内部用 toIterable 统一遍历。
 */
export type ElementsMapOrArray =
  | readonly ExcalidrawElement[]
  | Readonly<ElementsMap>;

export type NonDeletedElementsMapOrArray =
  | readonly NonDeletedExcalidrawElement[]
  | Readonly<NonDeletedElementsMap | NonDeletedSceneElementsMap>;

/** 工具栏“转换为”菜单使用的线性元素子类型：数据上都落到 line/arrow。 */
export type ExcalidrawLinearElementSubType =
  | "line"
  | "sharpArrow"
  | "curvedArrow"
  | "elbowArrow";

export type ConvertibleGenericTypes = "rectangle" | "diamond" | "ellipse";
export type ConvertibleLinearTypes = ExcalidrawLinearElementSubType;
export type ConvertibleTypes = ConvertibleGenericTypes | ConvertibleLinearTypes;
