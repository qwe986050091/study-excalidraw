import {
  getCommonFrameId,
  getFrameChildrenInsertionIndex,
  getContainerElement,
  isElementInViewport,
  isTextElement,
} from "@excalidraw/element";

import { arrayToMap, memoize, toBrandedType } from "@excalidraw/common";

import type {
  ExcalidrawElement,
  ExcalidrawFrameLikeElement,
  NonDeleted,
  NonDeletedElementsMap,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import type { Scene } from "@excalidraw/element";

import { cancelStaticSceneThrottle } from "../renderer/staticScene";

import type { RenderableElementsMap } from "./types";

import type { AppState, ElementRenderOffsets } from "../types";

type GetRenderableElementsOpts = {
  zoom: AppState["zoom"];
  offsetLeft: AppState["offsetLeft"];
  offsetTop: AppState["offsetTop"];
  scrollX: AppState["scrollX"];
  scrollY: AppState["scrollY"];
  height: AppState["height"];
  width: AppState["width"];
  editingTextElement: AppState["editingTextElement"];
  newElement: AppState["newElement"];
  selectedElements: readonly NonDeletedExcalidrawElement[];
  selectedElementsAreBeingDragged: AppState["selectedElementsAreBeingDragged"];
  frameToHighlight: AppState["frameToHighlight"];
};

/**
 * Renderer：决定“这一帧画哪些元素、按什么顺序画”。
 *
 * 它不负责真正落笔（那是 renderer/staticScene.ts 与 interactiveScene.ts），
 * 只做两件事：
 * 1. 视口裁剪：把 Scene 的全量非删除元素缩成 visibleElements；
 * 2. 渲染顺序修正：拖拽元素悬停在 frame 上时，临时把选中项排到 frame
 *    子元素区间里，让预览看起来像已经入框（真正的 frameId 要等 pointerup
 *    才写，避免用户取消时还要回滚 index）。
 *
 * 三层画布共用同一份 `getRenderableElements` 结果：
 * - StaticCanvas：普通元素；
 * - NewElementCanvas：正在拖拽创建的那个元素；
 * - InteractiveCanvas：选择框、手柄、协作光标等 UI 覆盖层。
 */
export class Renderer {
  private scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /**
   * 在“文档可见集”上再叠加渲染偏移后的可见性修正。
   *
   * 使用场景：元素正在被拖拽/动画位移（offset 非 0），但文档坐标没变。
   * 此时必须按“元素 + offset”重新做视口判断，否则拖出屏幕的元素仍会被画，
   * 拖入屏幕的元素反而缺失。未出现在 offsets 里的元素保持原可见性，
   * 不进入几何计算，保证绝大多数帧不产生额外开销。
   *
   * 返回数组的顺序与 `elementsMap` 一致（新增元素需要重建时），调用方可以
   * 直接当成绘制顺序使用。
   *
   * Adjusts the document-visible set for render-override translations: an
   * element leaves it when its offset moves it out of view and enters it when
   * its offset brings it in; everything else keeps its document visibility.
   * Only translated elements go through viewport geometry. The result is
   * memoized on the offsets' identity so that opacity-only snapshots don't
   * reach it at all.
   */
  public getVisibleElementsWithRenderOffsets(
    visibleElements: readonly NonDeletedExcalidrawElement[],
    elementsMap: RenderableElementsMap,
    appState: AppState,
    offsets: ElementRenderOffsets,
  ) {
    return this._getVisibleElementsWithRenderOffsets({
      visibleElements,
      elementsMap,
      offsets,
      zoom: appState.zoom,
      scrollX: appState.scrollX,
      scrollY: appState.scrollY,
      offsetLeft: appState.offsetLeft,
      offsetTop: appState.offsetTop,
      width: appState.width,
      height: appState.height,
      selectedElements: this.scene.getSelectedElements(appState),
      frameToHighlight: appState.selectedElementsAreBeingDragged
        ? appState.frameToHighlight
        : null,
    });
  }

  /**
   * 只在“文档可见集”之上做增删，不做全量重建的那个 memoize 版本。
   *
   * offsets 是 Map，调用方每次动画帧可能传入新实例；memoize 以引用相等
   * 作为 key，所以只有真正位移过的帧才会重新计算。若新增集合为空，
   * 直接返回过滤后的原数组（顺序不变、引用可变），避免为很少的删除付出
   * 一次 O(n) 的场景顺序重建。
   */
  private _getVisibleElementsWithRenderOffsets = memoize(
    ({
      visibleElements,
      elementsMap,
      offsets,
      selectedElements,
      frameToHighlight,
      ...viewport
    }: Pick<
      GetRenderableElementsOpts,
      | "zoom"
      | "scrollX"
      | "scrollY"
      | "offsetLeft"
      | "offsetTop"
      | "width"
      | "height"
      | "selectedElements"
      | "frameToHighlight"
    > & {
      visibleElements: readonly NonDeletedExcalidrawElement[];
      elementsMap: RenderableElementsMap;
      offsets: ElementRenderOffsets;
    }) => {
      // Shifting the viewport instead of the element also works for arrow
      // labels, whose coordinates derive from their container.
      // 反向平移视口而不是修改元素坐标：isElementInViewport 内部会读取
      // 元素绝对坐标，箭头标签的坐标又由容器推导，直接改元素会污染缓存。
      const isVisible = (
        element: NonDeletedExcalidrawElement,
        offset: ElementRenderOffsets extends ReadonlyMap<string, infer T>
          ? T
          : never,
      ) =>
        isElementInViewport(
          element,
          viewport.width,
          viewport.height,
          {
            ...viewport,
            scrollX: viewport.scrollX + offset.x,
            scrollY: viewport.scrollY + offset.y,
          },
          elementsMap,
        );

      const documentVisible = this.getVisibleSet(visibleElements);
      // added/removed 是相对“文档可见集”的差集，而非相对上一帧：
      // 这样结果与调用顺序无关，memoize 复用也不会累积误差。
      const added = new Set<NonDeletedExcalidrawElement>();
      const removed = new Set<NonDeletedExcalidrawElement>();
      const update = (
        element: NonDeletedExcalidrawElement,
        visible: boolean,
      ) => {
        if (documentVisible.has(element) !== visible) {
          (visible ? added : removed).add(element);
        }
      };
      for (const [id, offset] of offsets) {
        const element = elementsMap.get(id);
        // A bound label's own offset is ignored, and it needs no entry of
        // its own: the static renderer draws it with its container and skips
        // its entry, so its document visibility can stay as it is.
        if (
          !element ||
          (isTextElement(element) && getContainerElement(element, elementsMap))
        ) {
          continue;
        }
        update(element, isVisible(element, offset));
      }

      if (!added.size && !removed.size) {
        return visibleElements;
      }

      const needsFrameReordering =
        frameToHighlight &&
        getCommonFrameId(selectedElements) !== frameToHighlight.id;
      if (!added.size && !needsFrameReordering) {
        return visibleElements.filter((element) => !removed.has(element));
      }

      // Rebuild in scene order when elements enter the view. Frame-drag
      // ordering also needs rebuilding on removals, since the anchoring frame
      // may have left the view.
      // 重建必须按 elementsMap 的插入顺序（即场景 z-order），不能把 added
      // 追加到末尾：否则新进入视口的元素会错误地盖住原本在它上面的元素。
      const result: NonDeletedExcalidrawElement[] = [];
      for (const element of elementsMap.values()) {
        if (
          added.has(element) ||
          (documentVisible.has(element) && !removed.has(element))
        ) {
          result.push(element);
        }
      }
      return needsFrameReordering
        ? this.sortSelectedElementsIntoHighlightedFrame({
            visibleElements: result,
            selectedElements,
            frameToHighlight,
          })
        : result;
    },
  );

  /** the document-visible elements as a set, cached per visible array */
  /**
   * 用 WeakMap 以数组引用为 key 缓存 Set。
   *
   * 上游把同一个 visibleElements 数组传给静态/新建/交互三块画布，所以
   * 三次调用只会构建一次 Set；数组被丢弃后缓存随之回收，不需要手动清理。
   * 一旦数组内容变新（新数组），缓存自然失效。
   */
  private visibleSets = new WeakMap<
    readonly NonDeletedExcalidrawElement[],
    Set<NonDeletedExcalidrawElement>
  >();

  private getVisibleSet(
    visibleElements: readonly NonDeletedExcalidrawElement[],
  ) {
    let set = this.visibleSets.get(visibleElements);
    if (!set) {
      set = new Set(visibleElements);
      this.visibleSets.set(visibleElements, set);
    }
    return set;
  }

  /**
   * 对过滤后的元素集做逐元素视口判断，返回按场景顺序排列的可见数组。
   *
   * 这里是唯一的“裁剪点”：之后的所有绘制都不再判断可见性。判断必须用
   * `elementsMap`（已剔除编辑中的文本/新建元素）而不是全量 map，否则
   * 被剔除元素的坐标参与测量会得到不同结果。
   */
  private getVisibleCanvasElements({
    elementsMap,
    zoom,
    offsetLeft,
    offsetTop,
    scrollX,
    scrollY,
    height,
    width,
  }: {
    elementsMap: NonDeletedElementsMap;
    zoom: AppState["zoom"];
    offsetLeft: AppState["offsetLeft"];
    offsetTop: AppState["offsetTop"];
    scrollX: AppState["scrollX"];
    scrollY: AppState["scrollY"];
    height: AppState["height"];
    width: AppState["width"];
  }): readonly NonDeletedExcalidrawElement[] {
    const visibleElements: NonDeletedExcalidrawElement[] = [];
    for (const element of elementsMap.values()) {
      if (
        isElementInViewport(
          element,
          width,
          height,
          {
            zoom,
            offsetLeft,
            offsetTop,
            scrollX,
            scrollY,
          },
          elementsMap,
        )
      ) {
        visibleElements.push(element);
      }
    }
    return visibleElements;
  }

  /**
   * 从可见元素里剔除“不该由静态画布画”的两类：
   * - 正在文本编辑的元素（由 WYSIWYG 的 DOM 覆盖层绘制）；
   * - 不带 frameId 的新元素（由 NewElementCanvas 单独绘制，方便做透明预览
   *   和独立节流）。
   * 带 frameId 的新元素留在 Map 里，因为 frame 裁剪需要它和 frame 同批绘制。
   */
  private getRenderableElementsMap({
    elements,
    editingTextElement,
    newElement,
  }: {
    elements: readonly NonDeletedExcalidrawElement[];
    editingTextElement: AppState["editingTextElement"];
    newElement: AppState["newElement"];
  }) {
    const elementsMap = toBrandedType<RenderableElementsMap>(new Map());
    // 只有“无 frameId”的新元素才交给 NewElementCanvas。带 frameId 的必须
    // 留在静态 map 中，因为它要参与 frame 的裁剪与分组绘制。
    const newElementCanvasElement = newElement?.frameId ? null : newElement;

    for (const element of elements) {
      if (newElementCanvasElement?.id === element.id) {
        continue;
      }

      // we don't want to render text element that's being currently edited
      // (it's rendered on remote only)
      if (
        !editingTextElement ||
        editingTextElement.type !== "text" ||
        element.id !== editingTextElement.id
      ) {
        elementsMap.set(element.id, element);
      }
    }
    return { elementsMap, newElementCanvasElement };
  }

  /**
   * 把被拖拽的选中元素“临时排进”目标 frame 的子元素区间。
   *
   * 只改绘制顺序，不改元素数据：真正写 frameId 要等 pointerup（用户在
   * 中途取消时不需要回滚 index，也不产生一条无意义的历史）。
   *
   * 实现要点：先取非选中元素组成数组，用 getFrameChildrenInsertionIndex
   * 找到 frame 现有子元素在其中的插入点，再把选中项整体插入。若 frame
   * 已不在可见集里（insertionIndex === null），原样返回，避免把选中项
   * 排到不存在的锚点后面。
   */
  private sortSelectedElementsIntoHighlightedFrame<
    T extends ExcalidrawElement,
  >({
    visibleElements,
    selectedElements,
    frameToHighlight,
  }: {
    selectedElements: readonly NonDeletedExcalidrawElement[];
    visibleElements: readonly T[];
    frameToHighlight: NonDeleted<ExcalidrawFrameLikeElement>;
  }): readonly T[] {
    if (!selectedElements.length) {
      return visibleElements;
    }

    // we assume all selected elements are eligible frame children if
    // frameToHighlight is defined
    const selectedElementsMap = arrayToMap(selectedElements);

    // thus, all deselected elements are the ones we won't reorder
    const deselectedElements = visibleElements.filter(
      (element) => !selectedElementsMap.has(element.id),
    );

    const insertionIndex = getFrameChildrenInsertionIndex(
      deselectedElements,
      frameToHighlight.id,
    );

    if (insertionIndex === null) {
      // frame 本身不在可见集里：没有可靠的 z-order 锚点，宁可不动
      return visibleElements;
    }

    return [
      ...deselectedElements.slice(0, insertionIndex),
      ...selectedElements,
      ...deselectedElements.slice(insertionIndex),
    ] as readonly T[];
  }

  /**
   * 渲染集合的主 memoize。
   *
   * key 只包含真正影响结果的项：canvasNonce（Scene 变化令牌）、视口、以及
   * 正在编辑/新建的元素。selectedElements、frameToHighlight 等不在 key 里，
   * 由外层 `getRenderableElements` 在 memo 之后再做顺序修正，避免选择变化
   * 触发整棵元素集合重建。
   */
  private _getRenderableElements = memoize(
    ({
      canvasNonce,
      // 注意这里逐个解构视口字段而不是 spread：memoize 的 key 由实参对象
      // 的字段组成，spread 会把 selectedElements 等不相关字段也带进 key，
      // 导致每次选择变化都触发整棵元素集合重建。
      zoom,
      offsetLeft,
      offsetTop,
      scrollX,
      scrollY,
      height,
      width,
      editingTextElement,
      newElement,
    }: Omit<
      GetRenderableElementsOpts,
      | "selectedElements"
      | "selectedElementsAreBeingDragged"
      | "frameToHighlight"
    > & {
      canvasNonce: string;
    }) => {
      const elements = this.scene.getNonDeletedElements();

      const { elementsMap, newElementCanvasElement } =
        this.getRenderableElementsMap({
          elements,
          editingTextElement,
          newElement,
        });

      const visibleElements = this.getVisibleCanvasElements({
        elementsMap,
        zoom,
        offsetLeft,
        offsetTop,
        scrollX,
        scrollY,
        height,
        width,
      });

      return {
        elementsMap,
        visibleElements,
        newElementCanvasElement,
        canvasNonce,
      };
    },
  );

  /**
   * 对外的渲染集合入口。
   *
   * 一个容易踩的坑：拖拽创建的新元素是“就地 mutate 且不通知 Scene”的，
   * 所以 sceneNonce 不会变。如果只拿 sceneNonce 做 key，拖拽预览会卡在
   * 第一帧。这里对“有 frameId 的新元素”和“新文本”额外拼上它自己的
   * versionNonce，让这两类元素仍然能驱动重绘。
   */
  public getRenderableElements = (opts: GetRenderableElementsOpts) => {
    const { newElement } = opts;
    // A new element being drag-sized is mutated in place without informing
    // the scene, so `sceneNonce` doesn't move. Fold the element's own nonce
    // in where a canvas draws it from the live element but memoizes on this
    // nonce: a framed new element stays in the static canvas' element map
    // (see getRenderableElementsMap), and a new text gets its dashed text box
    // drawn by the interactive canvas (it doubles as `editingTextElement`).
    const canvasNonce = `${this.scene.getSceneNonce()}${
      newElement?.frameId || isTextElement(newElement)
        ? `:${newElement.versionNonce}`
        : ""
    }`;

    const ret = this._getRenderableElements({
      canvasNonce,

      // don't spread `opts` because we don't want to memoize on some props

      zoom: opts.zoom,
      offsetLeft: opts.offsetLeft,
      offsetTop: opts.offsetTop,
      scrollX: opts.scrollX,
      scrollY: opts.scrollY,
      height: opts.height,
      width: opts.width,
      editingTextElement: opts.editingTextElement,
      newElement: opts.newElement,
    });

    // if we're dragging elements over a frame, reorder the selected elements
    // inside the frame during render (we don't set the `element.frameId` until
    // pointerup else we'd have to painstainly restore the orig index if user
    // didn't end up adding elements to the frame)
    // 这个判断顺序很关键：先看有没有悬停 frame，再看是否真的在拖拽，
    // 最后排除“所有选中元素已经在同一 frame 里”的情况——否则组内拖动
    // 会把自己重新排一遍，反而打乱原有 z-order。
    if (
      opts.frameToHighlight &&
      opts.selectedElementsAreBeingDragged &&
      // if all dragged elements are already in the frame, don't reorder
      getCommonFrameId(opts.selectedElements) !== opts.frameToHighlight.id
    ) {
      const reorderedVisibleElements =
        this.sortSelectedElementsIntoHighlightedFrame({
          visibleElements: ret.visibleElements,
          selectedElements: opts.selectedElements,
          frameToHighlight: opts.frameToHighlight,
        });

      return {
        ...ret,
        visibleElements: reorderedVisibleElements,
      };
    }

    return ret;
  };

  /**
   * 只清理本 Renderer 持有的缓存与画布节流器，不动 Scene / RoughCanvas。
   * 上游可能复用这些对象，彻底销毁会破坏 TS 契约。
   */
  // NOTE Doesn't destroy everything (scene, rc, etc.) because it may not be
  // safe to break TS contract here (for upstream cases)
  public destroy(staticCanvas: HTMLCanvasElement) {
    // 只丢弃与这块 canvas 绑定的节流器与两份 memoize 缓存；Scene 与
    // RoughCanvas 由 App 持有，可能被后续实例复用。
    cancelStaticSceneThrottle(staticCanvas);
    this._getRenderableElements.clear();
    this._getVisibleElementsWithRenderOffsets.clear();
    // visibleSets 是 WeakMap，随数组回收，不需要（也无法）逐个清理
  }
}
