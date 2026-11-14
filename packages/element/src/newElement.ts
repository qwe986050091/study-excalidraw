/**
 * 文件位置：所有元素构造的唯一起点。处于「工具/动作层」与「元素模型」之间：
 * 上游（App、actions、restore）只调用这里的 newXxxElement，不直接拼对象字面量。
 *
 * 为什么必须集中到一处：
 * - 版本字段（version/versionNonce/seed）的初始化语义只在 _newElementBase
 *   维护，任何绕过它的构造都会破坏协同 reconcile 的收敛性；
 * - 每种类型的必填字段（framename、arrowhead、image status…）在各自
 *   newXxxElement 里补齐后再落到基座，保证返回对象结构完整。
 *
 * 调用关系（已核对）：restore、App 的绘制/粘贴/复制路径、以及各类 action
 * 都经由这些工厂；因此这里的默认值会被写进导出文件与协作广播。
 */
import {
  DEFAULT_ELEMENT_PROPS,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_STICKY_NOTE_SIZE,
  STICKY_NOTE_MIN_SIZE,
  DEFAULT_VERTICAL_ALIGN,
  DEFAULT_STROKE_STREAMLINE,
  VERTICAL_ALIGN,
  randomInteger,
  randomId,
  getFontString,
  getUpdatedTimestamp,
  getLineHeight,
} from "@excalidraw/common";

import type { Radians } from "@excalidraw/math";

import type { MarkOptional, Merge } from "@excalidraw/common/utility-types";

import {
  getElementAbsoluteCoords,
  getResizedElementAbsoluteCoords,
} from "./bounds";
import { newElementWith } from "./mutateElement";
import {
  normalizeStickyNoteBackgroundColor,
  normalizeStickyNoteStrokeColor,
} from "./stickyNote";
import { getBoundTextMaxWidth } from "./textElement";
import { normalizeText, measureText } from "./textMeasurements";
import { wrapText } from "./textWrapping";

import { isLineElement } from "./typeChecks";

import type { RenderEnvironment } from "./renderEnvironment";

import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  ExcalidrawTextElement,
  ExcalidrawLinearElement,
  ExcalidrawGenericElement,
  NonDeleted,
  TextAlign,
  VerticalAlign,
  Arrowhead,
  ExcalidrawFreeDrawElement,
  FontFamilyValues,
  ExcalidrawTextContainer,
  ExcalidrawFrameElement,
  ExcalidrawEmbeddableElement,
  ExcalidrawMagicFrameElement,
  ExcalidrawIframeElement,
  ElementsMap,
  ExcalidrawArrowElement,
  ExcalidrawElbowArrowElement,
  ExcalidrawLineElement,
  ExcalidrawStickyNoteElement,
} from "./types";

/**
 * 构造参数类型。Omit 掉由构造器自己决定的字段（id/type/isDeleted/updated），
 * 再用 MarkOptional 把“有默认值”的字段全部变可选——这样调用点只需传
 * 真正关心的属性，其余走 DEFAULT_ELEMENT_PROPS 或基座默认值。
 * 注意 created 也在可选列表里：只有复制/还原旧元素时才显式传入。
 */
export type ElementConstructorOpts = MarkOptional<
  Omit<ExcalidrawGenericElement, "id" | "type" | "isDeleted" | "updated">,
  | "width"
  | "height"
  | "angle"
  | "groupIds"
  | "frameId"
  | "index"
  | "boundElements"
  | "seed"
  | "version"
  | "versionNonce"
  | "link"
  | "strokeStyle"
  | "fillStyle"
  | "strokeColor"
  | "backgroundColor"
  | "roughness"
  | "strokeWidth"
  | "roundness"
  | "locked"
  | "opacity"
  | "customData"
  | "created"
>;

/**
 * 所有元素类型的公共基座。
 *
 * 参数：type 决定 final 类型；opts 是解构后的构造参数，未提供的走默认值，
 * 剩余的 `...rest` 只用于 id/seed/version/versionNonce/created/customData
 * 这类“可选但需要原样透传”的字段。
 *
 * 返回值：字段完整的非删除元素；isDeleted 恒为 false（删除是后续 mutate）。
 * 失败条件：不抛错。位置/尺寸超过 ±1e6 只打印诊断日志——历史上超大元素
 * 会拖垮渲染与序列化，这里保留观测点但不再阻断用户操作。
 *
 * 注意：`rest` 中若带 isDeleted/type 会被忽略或覆盖，调用方不要试图通过
 * 它创建“已删除元素”。
 */
const _newElementBase = <T extends ExcalidrawElement>(
  type: T["type"],
  {
    x,
    y,
    strokeColor = DEFAULT_ELEMENT_PROPS.strokeColor,
    backgroundColor = DEFAULT_ELEMENT_PROPS.backgroundColor,
    fillStyle = DEFAULT_ELEMENT_PROPS.fillStyle,
    strokeWidth = DEFAULT_ELEMENT_PROPS.strokeWidth,
    strokeStyle = DEFAULT_ELEMENT_PROPS.strokeStyle,
    roughness = DEFAULT_ELEMENT_PROPS.roughness,
    opacity = DEFAULT_ELEMENT_PROPS.opacity,
    width = 0,
    height = 0,
    angle = 0 as Radians,
    groupIds = [],
    frameId = null,
    index = null,
    roundness = null,
    boundElements = null,
    link = null,
    locked = DEFAULT_ELEMENT_PROPS.locked,
    ...rest
  }: ElementConstructorOpts & Omit<Partial<ExcalidrawGenericElement>, "type">,
) => {
  // NOTE (mtolmacs): This is a temporary check to detect extremely large
  // element position or sizing
  // 中文补充：只告警不裁剪。粘贴外部数据或 restore 历史文件时该分支可能
  // 被大量触发，因此用 console.error 而非 throw，避免导入失败。
  if (
    x < -1e6 ||
    x > 1e6 ||
    y < -1e6 ||
    y > 1e6 ||
    width < -1e6 ||
    width > 1e6 ||
    height < -1e6 ||
    height > 1e6
  ) {
    console.error("New element size or position is too large", {
      x,
      y,
      width,
      height,
      // @ts-ignore
      points: rest.points,
    });
  }

  // 同一个元素的所有时间戳必须来自同一次取值，否则 created > updated
  // 会出现负的“创建到修改”间隔，影响排序与测试断言。
  const timestamp = getUpdatedTimestamp();

  // assign type to guard against excess properties
  // 显式展开而非 Object.assign：让 TS 的 excess property 检查生效，
  // 也保证字段顺序稳定（对快照测试与序列化 diff 友好）。
  const element: Merge<
    ExcalidrawGenericElement,
    { type: T["type"]; isDeleted: false }
  > = {
    // id 允许外部指定（复制/还原/协作），否则随机；seed 必须随机，
    // 否则 roughjs 会给所有元素画出完全相同的纹理。
    id: rest.id || randomId(),
    type,
    x,
    y,
    width,
    height,
    angle,
    strokeColor,
    backgroundColor,
    fillStyle,
    strokeWidth,
    strokeStyle,
    roughness,
    opacity,
    groupIds,
    frameId,
    index,
    roundness,
    seed: rest.seed ?? randomInteger(),
    // `||` 而非 `??`：把 0 也当作“未提供”，兼容历史数据里 0 表示未初始化的写法。
    version: rest.version || 1,
    // 新元素 versionNonce 为 0，首次 mutate 才随机；这样同 version 时
    // 新建元素在两端能稳定收敛（不会被随机值打乱胜负）。
    versionNonce: rest.versionNonce ?? 0,
    isDeleted: false as false,
    boundElements,
    updated: timestamp,
    // Preserve explicit null when reconstructing a legacy element with its id.
    // 保留显式 null：旧文件里 created:null 是“未知时间”的合法值，
    // 用 ?? 会把它悄悄改成当前时间，破坏“复制旧元素保留 created”的语义。
    created: rest.created === undefined ? timestamp : rest.created,
    link,
    locked,
    customData: rest.customData,
  };
  return element;
};

/**
 * 元素构造的公共基座。
 *
 * 版本初始化约定：
 * - `version: rest.version || 1`——新元素从 1 开始；`||` 而不是 `??` 是
 *   为了把 0 也当成“未提供”（历史数据里 0 表示未初始化）；
 * - `versionNonce: rest.versionNonce ?? 0`——注意新元素是 0 而不是随机数，
 *   首次 mutate 才会换成随机数。这样“刚创建”在两个 peer 上可以稳定收敛；
 * - `seed` 必须随机：roughjs 用它决定手绘纹理，固定 seed 会让所有元素
 *   长得一模一样；
 * - `created` 只在复制旧元素时保留，新建时等于 `updated`。
 *
 * 所有 `newXxxElement` 最终都落到 `_newElementBase`，所以版本语义只有
 * 这一处需要维护。
 */
export const newElement = (
  opts: {
    type: ExcalidrawGenericElement["type"];
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawGenericElement> =>
  _newElementBase<ExcalidrawGenericElement>(opts.type, opts);

/**
 * Style invariants of a sticky note: never-transparent colors, solid fill.
 * Applied by the constructor and by every normalization pass. Returns the
 * same object when nothing needs fixing.
 */
export const normalizeStickyNoteStyle = <T extends ExcalidrawStickyNoteElement>(
  element: T,
): T => {
  // 通过 newElementWith 而不是直接改字段：它会推进 version/versionNonce，
  // 让“规范化”在协同场景里成为一次可见更新，对端才会接受。
  return newElementWith(element as ExcalidrawStickyNoteElement, {
    backgroundColor: normalizeStickyNoteBackgroundColor(
      element.backgroundColor,
    ),
    strokeColor: normalizeStickyNoteStrokeColor(element.strokeColor),
    fillStyle: "solid",
  }) as T;
};

/**
 * Geometry invariants of a *finalized* sticky note: minimum size and
 * `baseHeight ≤ height`. Deliberately not part of the constructor — a
 * pointer-down draft starts at 0×0 like every other tool and is previewed at
 * its true dragged size; pointer-up, restore, the skeleton path and the
 * action post-passes enforce this.
 */
export const normalizeStickyNoteGeometry = <
  T extends ExcalidrawStickyNoteElement,
>(
  element: T,
): T => {
  const width = Math.max(element.width, STICKY_NOTE_MIN_SIZE);
  // baseHeight 兼容旧数据：早期便签没有 baseHeight，用当前 height 兜底；
  // 再与最小尺寸取 max，保证编辑时不会把便签压成一条线。
  const baseHeight = Math.max(
    element.baseHeight || element.height || DEFAULT_STICKY_NOTE_SIZE,
    STICKY_NOTE_MIN_SIZE,
  );

  return newElementWith(element as ExcalidrawStickyNoteElement, {
    width,
    height: Math.max(element.height, baseHeight),
    baseHeight,
  }) as T;
};

/** all sticky note invariants (style + finalized geometry) */
export const normalizeStickyNote = <T extends ExcalidrawStickyNoteElement>(
  element: T,
): T => {
  return normalizeStickyNoteGeometry(normalizeStickyNoteStyle(element));
};

/**
 * 便签构造器。
 * baseHeight 缺省等于当前 height：便签的“基准高度”用于文本溢出后自动
 * 长高，初次创建时两者一致；这里刻意不调用 normalizeStickyNoteGeometry，
 * 否则 pointer-down 的 0×0 草稿会被立刻撑到最小尺寸，预览失去拖动感。
 */
export const newStickyNoteElement = (
  opts: {
    type: "stickynote";
    baseHeight?: number;
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawStickyNoteElement> => {
  const base = _newElementBase<ExcalidrawStickyNoteElement>("stickynote", opts);

  // no size inflation here (see `normalizeStickyNoteGeometry`)
  return normalizeStickyNoteStyle({
    ...base,
    baseHeight: opts.baseHeight ?? base.height,
  });
};

/**
 * 嵌入卡片。除通用字段外没有额外必填项，直接落到基座；
 * 其 iframe 内容由上层根据 link 解析，构造阶段不校验 URL。
 */
export const newEmbeddableElement = (
  opts: {
    type: "embeddable";
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawEmbeddableElement> => {
  return _newElementBase<ExcalidrawEmbeddableElement>("embeddable", opts);
};

/**
 * iframe 元素。这里多包一层 `{...}` 只是为了保持返回类型精确
 * （非删除元素），不引入任何额外字段。
 */
export const newIframeElement = (
  opts: {
    type: "iframe";
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawIframeElement> => {
  return {
    ..._newElementBase<ExcalidrawIframeElement>("iframe", opts),
  };
};

/**
 * 画框（frame）。name 是用户可见标签，缺省 null；
 * 这里额外调用一次 newElementWith({}) 的原因：frame 需要经过 mutate
 * 规范化（例如 index/子元素关系），空 patch 也会触发一次完整的归一化。
 */
export const newFrameElement = (
  opts: {
    name?: string;
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawFrameElement> => {
  const frameElement = newElementWith(
    {
      ..._newElementBase<ExcalidrawFrameElement>("frame", opts),
      type: "frame",
      name: opts?.name || null,
    },
    {},
  );

  return frameElement;
};

/** 魔法画框：结构与 frame 一致，仅 type 不同（用于 AI 生成的容器语义）。 */
export const newMagicFrameElement = (
  opts: {
    name?: string;
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawMagicFrameElement> => {
  const frameElement = newElementWith(
    {
      ..._newElementBase<ExcalidrawMagicFrameElement>("magicframe", opts),
      type: "magicframe",
      name: opts?.name || null,
    },
    {},
  );

  return frameElement;
};

/**
 * The point of the text box its alignment pins, as ratios of width/height.
 *
 * This is the point that stays put as the text grows — see the sides passed to
 * `adjustXYWithRotation` in `getAdjustedDimensions`.
 */
export const getTextAnchorRatios = (opts: {
  textAlign: ExcalidrawTextElement["textAlign"];
  verticalAlign: ExcalidrawTextElement["verticalAlign"];
}) => ({
  x: opts.textAlign === "center" ? 0.5 : opts.textAlign === "right" ? 1 : 0,
  y:
    opts.verticalAlign === VERTICAL_ALIGN.MIDDLE
      ? 0.5
      : opts.verticalAlign === VERTICAL_ALIGN.BOTTOM
      ? 1
      : 0,
});

/** computes element x/y offset based on textAlign/verticalAlign */
const getTextElementPositionOffsets = (
  opts: {
    textAlign: ExcalidrawTextElement["textAlign"];
    verticalAlign: ExcalidrawTextElement["verticalAlign"];
  },
  metrics: {
    width: number;
    height: number;
  },
) => {
  // 返回值是“锚点到文本框左/上边的距离”：newTextElement 用 opts.x - offsets.x
  // 把用户给的锚点换算成左上角坐标，因此这里的比例必须与
  // getAdjustedDimensions 的锚定逻辑保持同一套语义。
  const ratios = getTextAnchorRatios(opts);

  return {
    x: metrics.width * ratios.x,
    y: metrics.height * ratios.y,
  };
};

/**
 * 文本元素构造器。
 *
 * 参数 opts.x/y 表示“锚点”，不是左上角：按 textAlign/verticalAlign 换算后
 * 再写入元素坐标，所以居中对齐的文本 x 会比传入值更小。
 * width/height 由 measureText 实测得出，忽略调用方传入的尺寸；
 * 这是文本唯一可信的尺寸来源（字体、换行、行高都会影响）。
 *
 * 返回值：非删除文本元素。失败条件：不抛错；空文本会得到 0 尺寸，
 * 由上层决定是否丢弃（例如双击空白处创建空文本的场景）。
 */
export const newTextElement = (
  opts: {
    text: string;
    originalText?: string;
    fontSize?: number;
    fontFamily?: FontFamilyValues;
    textAlign?: TextAlign;
    verticalAlign?: VerticalAlign;
    containerId?: ExcalidrawTextContainer["id"] | null;
    lineHeight?: ExcalidrawTextElement["lineHeight"];
    autoResize?: ExcalidrawTextElement["autoResize"];
    labelPosition?: ExcalidrawTextElement["labelPosition"];
    baseFontSize?: ExcalidrawTextElement["baseFontSize"];
    renderEnvironment?: RenderEnvironment;
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawTextElement> => {
  const fontFamily = opts.fontFamily || DEFAULT_FONT_FAMILY;
  const fontSize = opts.fontSize || DEFAULT_FONT_SIZE;
  const lineHeight = opts.lineHeight || getLineHeight(fontFamily);
  const text = normalizeText(opts.text);
  const metrics = measureText(
    text,
    getFontString({ fontFamily, fontSize }),
    lineHeight,
    opts.renderEnvironment,
  );
  const textAlign = opts.textAlign || DEFAULT_TEXT_ALIGN;
  const verticalAlign = opts.verticalAlign || DEFAULT_VERTICAL_ALIGN;
  const offsets = getTextElementPositionOffsets(
    { textAlign, verticalAlign },
    metrics,
  );

  const textElementProps: NonDeleted<ExcalidrawTextElement> = {
    ..._newElementBase<ExcalidrawTextElement>("text", opts),
    text,
    fontSize,
    // baseFontSize 是“容器内文本”的基准字号（随容器缩放而变），
    // 独立文本为 null；不能用 fontSize 兜底，否则缩放后会失去还原基准。
    baseFontSize: opts.baseFontSize ?? null,
    fontFamily,
    textAlign,
    verticalAlign,
    x: opts.x - offsets.x,
    y: opts.y - offsets.y,
    width: metrics.width,
    height: metrics.height,
    containerId: opts.containerId || null,
    originalText: opts.originalText ?? text,
    autoResize: opts.autoResize ?? true,
    lineHeight,
    labelPosition: opts.labelPosition ?? null,
  };

  // 空 patch 的 mutate：让文本也走统一的规范化出口（版本相关字段的最终
  // 取值在 mutate 里确定），与 frame/magicframe 的构造方式保持一致。
  const textElement: NonDeleted<ExcalidrawTextElement> = newElementWith(
    textElementProps,
    {},
  );

  return textElement;
};

/**
 * 计算文本变更后的新坐标与尺寸。
 *
 * 参数 nextText 是即将生效的文本；nextFixedWidth 用于“已确定换行宽度”的
 * 场景（例如触发 maxWidth 后转为 autoResize:false），此时不再按内容重算宽。
 * 返回 {x,y,width,height}，坐标已按对齐方式调整，调用方直接写回元素即可。
 *
 * 关键分支：
 * - 居中对齐且未绑定容器且 autoResize：用尺寸差的一半平移，保证视觉中心不动；
 * - 其余情况：先算绝对坐标差，再交给 adjustXYWithRotation 按旋转与锚定边调整。
 * 这是文本编辑时“文字不从光标处乱跳”的核心，改动前请先看现有测试。
 */
const getAdjustedDimensions = (
  element: ExcalidrawTextElement,
  elementsMap: ElementsMap,
  nextText: string,
  /** the width the text is to take regardless of its content */
  nextFixedWidth?: number,
  renderEnvironment?: RenderEnvironment,
): {
  x: number;
  y: number;
  width: number;
  height: number;
} => {
  let { width: nextWidth, height: nextHeight } = measureText(
    nextText,
    getFontString(element),
    element.lineHeight,
    renderEnvironment,
  );

  // wrapped text
  if (nextFixedWidth !== undefined) {
    nextWidth = nextFixedWidth;
  } else if (!element.autoResize) {
    nextWidth = element.width;
  }

  const { textAlign, verticalAlign } = element;
  let x: number;
  let y: number;
  // 居中 + 未绑定容器 + 自适应：只需把尺寸变化量的一半反向平移，
  // 中心点就保持不动，比通用分支更精确（避免旋转矩阵带来的浮点误差）。
  if (
    textAlign === "center" &&
    verticalAlign === VERTICAL_ALIGN.MIDDLE &&
    !element.containerId &&
    element.autoResize
  ) {
    const prevMetrics = measureText(
      element.text,
      getFontString(element),
      element.lineHeight,
      renderEnvironment,
    );
    const offsets = getTextElementPositionOffsets(element, {
      width: nextWidth - prevMetrics.width,
      height: nextHeight - prevMetrics.height,
    });

    x = element.x - offsets.x;
    y = element.y - offsets.y;
  } else {
    const [x1, y1, x2, y2] = getElementAbsoluteCoords(element, elementsMap);

    const [nextX1, nextY1, nextX2, nextY2] = getResizedElementAbsoluteCoords(
      element,
      nextWidth,
      nextHeight,
      false,
    );
    const deltaX1 = (x1 - nextX1) / 2;
    const deltaY1 = (y1 - nextY1) / 2;
    const deltaX2 = (x2 - nextX2) / 2;
    const deltaY2 = (y2 - nextY2) / 2;

    // grow away from the edge(s) the alignment anchors the text to, so that
    // the anchor stays put as the text is edited. `verticalAlign` has no
    // visual effect on unbound text, but standalone text bound to an arrow
    // endpoint uses it to pin the side the arrow attaches to.
    [x, y] = adjustXYWithRotation(
      {
        n:
          verticalAlign === VERTICAL_ALIGN.MIDDLE ||
          verticalAlign === VERTICAL_ALIGN.BOTTOM,
        s:
          verticalAlign === VERTICAL_ALIGN.MIDDLE ||
          verticalAlign === VERTICAL_ALIGN.TOP,
        e: textAlign === "center" || textAlign === "left",
        w: textAlign === "center" || textAlign === "right",
      },
      element.x,
      element.y,
      element.angle,
      deltaX1,
      deltaY1,
      deltaX2,
      deltaY2,
    );
  }

  return {
    width: nextWidth,
    height: nextHeight,
    x: Number.isFinite(x) ? x : element.x,
    y: Number.isFinite(y) ? y : element.y,
  };
};

/**
 * 按“哪些边固定”和旋转角，把尺寸变化量换算成 x/y 位移。
 *
 * sides 表示“锚定边”（n/s/e/w 为 true 时该边保持不动）；delta 是
 * 绝对坐标的变化量拆成两半后的值。旋转角非零时必须用 cos/sin 把局部的
 * 位移旋回世界坐标，否则旋转过的文本在编辑时会沿错误方向漂移。
 * 纯函数、不读元素，便于单测；返回值顺序固定为 [x, y]。
 */
const adjustXYWithRotation = (
  sides: {
    n?: boolean;
    e?: boolean;
    s?: boolean;
    w?: boolean;
  },
  x: number,
  y: number,
  angle: number,
  deltaX1: number,
  deltaY1: number,
  deltaX2: number,
  deltaY2: number,
): [number, number] => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  if (sides.e && sides.w) {
    x += deltaX1 + deltaX2;
  } else if (sides.e) {
    x += deltaX1 * (1 + cos);
    y += deltaX1 * sin;
    x += deltaX2 * (1 - cos);
    y += deltaX2 * -sin;
  } else if (sides.w) {
    x += deltaX1 * (1 - cos);
    y += deltaX1 * -sin;
    x += deltaX2 * (1 + cos);
    y += deltaX2 * sin;
  }

  if (sides.n && sides.s) {
    y += deltaY1 + deltaY2;
  } else if (sides.n) {
    x += deltaY1 * sin;
    y += deltaY1 * (1 - cos);
    x += deltaY2 * -sin;
    y += deltaY2 * (1 + cos);
  } else if (sides.s) {
    x += deltaY1 * -sin;
    y += deltaY1 * (1 + cos);
    x += deltaY2 * sin;
    y += deltaY2 * (1 - cos);
  }
  return [x, y];
};

/**
 * 文本编辑后的尺寸/换行重算入口（比 getAdjustedDimensions 多一层换行策略）。
 *
 * 参数：
 * - container：绑定容器（矩形/箭头标签等），非空时按容器允许的最大宽度换行；
 * - maxWidth：自由文本自适应增长的上限，超过后转为固定宽度换行；
 * - text：允许传入“尚未写回元素”的新文本。
 * 返回：新的 text + 尺寸坐标；元素已删除时返回 undefined（调用方需判空）。
 *
 * 顺序很重要：先判断是否越过 maxWidth（决定是否切换 autoResize），
 * 再决定是否 wrapText，最后才测尺寸——反过来会得到基于旧换行的错误宽高。
 */
export const refreshTextDimensions = (
  textElement: ExcalidrawTextElement,
  container: ExcalidrawTextContainer | null,
  elementsMap: ElementsMap,
  text = textElement.text,
  /**
   * For a free text that grows with its content (`autoResize`): the widest
   * it may grow to. Crossing it, the text stops growing and wraps at this
   * width from then on (`autoResize: false`), anchored as its growth was. A
   * text that is already wider keeps growing.
   */
  maxWidth?: number,
  renderEnvironment?: RenderEnvironment,
) => {
  if (textElement.isDeleted) {
    return;
  }
  if (
    maxWidth !== undefined &&
    !container &&
    textElement.autoResize &&
    textElement.width <= maxWidth
  ) {
    const font = getFontString(textElement);
    if (
      measureText(text, font, textElement.lineHeight, renderEnvironment).width >
      maxWidth
    ) {
      const wrappedText = wrapText(text, font, maxWidth, renderEnvironment);
      return {
        text: wrappedText,
        autoResize: false,
        ...getAdjustedDimensions(
          textElement,
          elementsMap,
          wrappedText,
          maxWidth,
          renderEnvironment,
        ),
      };
    }
  }
  if (container || !textElement.autoResize) {
    text = wrapText(
      text,
      getFontString(textElement),
      container
        ? getBoundTextMaxWidth(container, textElement)
        : textElement.width,
      renderEnvironment,
    );
  }
  const dimensions = getAdjustedDimensions(
    textElement,
    elementsMap,
    text,
    undefined,
    renderEnvironment,
  );
  return { text, ...dimensions };
};

/**
 * 手绘（freedraw）元素。
 *
 * simulatePressure 由输入设备决定（触摸/鼠标没有真实压感，需要模拟）；
 * strokeOptions 缺省给出 variable + 默认 streamline，保证不与历史笔迹
 * 的渲染参数出现断层。points 为空是合法状态（起笔瞬间）。
 */
export const newFreeDrawElement = (
  opts: {
    type: "freedraw";
    points?: ExcalidrawFreeDrawElement["points"];
    simulatePressure: boolean;
    strokeOptions?: ExcalidrawFreeDrawElement["strokeOptions"];
    pressures?: ExcalidrawFreeDrawElement["pressures"];
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawFreeDrawElement> => {
  return {
    ..._newElementBase<ExcalidrawFreeDrawElement>(opts.type, opts),
    points: opts.points || [],
    pressures: opts.pressures || [],
    simulatePressure: opts.simulatePressure,
    strokeOptions: opts.strokeOptions ?? {
      variability: "variable",
      streamline: DEFAULT_STROKE_STREAMLINE,
    },
  };
};

/**
 * 线性元素（line/arrow 的公共基座）。
 * 绑定字段（startBinding/endBinding）与箭头样式一律初始化为 null，
 * 因为绑定关系必须由上层在元素进入 Scene 后才建立——构造时还没有
 * elementsMap，提前写入会产生指向不存在元素的悬空绑定。
 */
export const newLinearElement = (
  opts: {
    type: ExcalidrawLinearElement["type"];
    points?: ExcalidrawLinearElement["points"];
    polygon?: ExcalidrawLineElement["polygon"];
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawLinearElement> => {
  const element = {
    ..._newElementBase<ExcalidrawLinearElement>(opts.type, opts),
    points: opts.points || [],

    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  };

  if (isLineElement(element)) {
    // line 额外要求 polygon 字段（闭合折线）；用 isLineElement 做窄化
    // 而不是比较 type 字符串，避免后续新增线型时漏改这里。
    const lineElement: NonDeleted<ExcalidrawLineElement> = {
      ...element,
      polygon: opts.polygon ?? false,
    };

    return lineElement;
  }

  return element;
};

/**
 * 箭头元素。通过 opts.elbowed 分流成两种结构：
 * - 直角箭头多出 fixedSegments/startIsSpecial/endIsSpecial 三个字段，
 *   它们是直角布线路由的缓存与约束，缺省必须初始化，否则路由计算会崩；
 * - 普通箭头保留 elbowed:false，保证类型判别稳定。
 * 返回类型用条件类型 T extends true 精确对应，调用点无需再断言。
 */
export const newArrowElement = <T extends boolean>(
  opts: {
    type: ExcalidrawArrowElement["type"];
    startArrowhead?: Arrowhead | null;
    endArrowhead?: Arrowhead | null;
    points?: ExcalidrawArrowElement["points"];
    elbowed?: T;
    fixedSegments?: ExcalidrawElbowArrowElement["fixedSegments"] | null;
  } & ElementConstructorOpts,
): T extends true
  ? NonDeleted<ExcalidrawElbowArrowElement>
  : NonDeleted<ExcalidrawArrowElement> => {
  if (opts.elbowed) {
    // fixedSegments 传 [] 而不是 null：路由算法按“已固定段列表”迭代，
    // null 会让首次计算走不到初始化分支。
    return {
      ..._newElementBase<ExcalidrawElbowArrowElement>(opts.type, opts),
      points: opts.points || [],
      startBinding: null,
      endBinding: null,
      startArrowhead: opts.startArrowhead || null,
      endArrowhead: opts.endArrowhead || null,
      elbowed: true,
      fixedSegments: opts.fixedSegments || [],
      startIsSpecial: false,
      endIsSpecial: false,
    } as NonDeleted<ExcalidrawElbowArrowElement>;
  }

  return {
    ..._newElementBase<ExcalidrawArrowElement>(opts.type, opts),
    points: opts.points || [],
    startBinding: null,
    endBinding: null,
    startArrowhead: opts.startArrowhead || null,
    endArrowhead: opts.endArrowhead || null,
    elbowed: false,
  } as T extends true
    ? NonDeleted<ExcalidrawElbowArrowElement>
    : NonDeleted<ExcalidrawArrowElement>;
};

/**
 * 图片元素。status 缺省 pending：文件此时还没上传/落盘，等 FileManager
 * 回调再推进为 saved/error。strokeColor 强制 transparent，
 * 未来若支持给 SVG 换色，transparent 的语义是“保留图片原色”。
 */
export const newImageElement = (
  opts: {
    type: ExcalidrawImageElement["type"];
    status?: ExcalidrawImageElement["status"];
    fileId?: ExcalidrawImageElement["fileId"];
    scale?: ExcalidrawImageElement["scale"];
    crop?: ExcalidrawImageElement["crop"];
  } & ElementConstructorOpts,
): NonDeleted<ExcalidrawImageElement> => {
  return {
    ..._newElementBase<ExcalidrawImageElement>("image", opts),
    // in the future we'll support changing stroke color for some SVG elements,
    // and `transparent` will likely mean "use original colors of the image"
    strokeColor: "transparent",
    status: opts.status ?? "pending",
    fileId: opts.fileId ?? null,
    scale: opts.scale ?? [1, 1],
    crop: opts.crop ?? null,
  };
};
