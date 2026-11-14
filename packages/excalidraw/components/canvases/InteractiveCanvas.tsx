/**
 * 交互画布 React 组件。
 *
 * 在渲染链路中的位置：
 *   App → InteractiveCanvas（本文件）→ renderInteractiveScene（renderer 层）
 *   → AnimationController（每帧循环）→ _renderInteractiveScene。
 * 兄弟组件 StaticCanvas 只画文档内容；本组件画选择框、手柄、绑定高亮、
 * 吸附线、协作光标与滚动条，因此它的 canvas 永远叠在静态 canvas 之上。
 * 第三层 NewElementCanvas 负责拖拽创建中的元素，三者绘制范围互不重叠。
 *
 * 输入：全部绘制所需的 props（三份元素集合、appState 快照、scale、回调等）。
 * 输出：没有 React 子内容，副作用是本画布像素 + 通过
 *   renderInteractiveSceneCallback 把滚动条/动画状态回传 App。
 *
 * 关键不变量：
 *   1. 组件不直接绘制，绘制只发生在 AnimationController 的回调里；
 *   2. React 每次渲染只更新 rendererParams.current，绝不重启动画循环
 *      （否则每帧重新注册回调，动画会卡死或叠加）；
 *   3. animationKey 每个实例唯一，多编辑器共存时互不取消对方的动画；
 *   4. 卸载时必须 cancel 对应 animationKey，避免 rAF 持有已卸载组件。
 */
import React, { useEffect, useRef } from "react";

import {
  isShallowEqual,
  sceneCoordsToViewportCoords,
  type EditorInterface,
} from "@excalidraw/common";

import type {
  InteractiveCanvasRenderConfig,
  InteractiveSceneRenderAnimationState,
  InteractiveSceneRenderConfig,
  RenderableElementsMap,
  RenderInteractiveSceneCallback,
} from "@excalidraw/excalidraw/scene/types";

import type {
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
} from "@excalidraw/element/types";

import { t } from "../../i18n";
import { getSelectionColor } from "../../renderer/helpers";
import { renderInteractiveScene } from "../../renderer/interactiveScene";

import { AnimationController } from "../../renderer/animation";

import type {
  AppClassProperties,
  AppState,
  InteractiveCanvasAppState,
} from "../../types";
import type { DOMAttributes } from "react";

/**
 * 本组件的 props。
 *
 * 三份元素集合用途不同：elementsMap / visibleElements 已按视口与状态过滤，
 * 供绘制使用；allElementsMap 是全集，绑定目标、锁定元素可能不在可见集里。
 * canvasNonce 与 selectionNonce 是外部强制重绘用的“版本号”，任一变化都会
 * 让 React.memo 失效。交互事件全部透传自 App，组件本身不做命中测试。
 */
type InteractiveCanvasProps = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  canvas: HTMLCanvasElement | null;
  elementsMap: RenderableElementsMap;
  visibleElements: readonly NonDeletedExcalidrawElement[];
  selectedElements: readonly NonDeletedExcalidrawElement[];
  allElementsMap: NonDeletedSceneElementsMap;
  canvasNonce: string;
  selectionNonce: number | undefined;
  scale: number;
  appState: InteractiveCanvasAppState;
  renderScrollbars: boolean;
  editorInterface: EditorInterface;
  app: AppClassProperties;
  interactionEnabled: boolean;
  navigationEnabled: boolean;
  renderInteractiveSceneCallback: (
    data: RenderInteractiveSceneCallback,
  ) => void;
  handleCanvasRef: (canvas: HTMLCanvasElement | null) => void;
  onContextMenu: Exclude<
    DOMAttributes<HTMLCanvasElement | HTMLDivElement>["onContextMenu"],
    undefined
  >;
  onClick: Exclude<DOMAttributes<HTMLCanvasElement>["onClick"], undefined>;
  onPointerMove: Exclude<
    DOMAttributes<HTMLCanvasElement>["onPointerMove"],
    undefined
  >;
  onPointerUp: Exclude<
    DOMAttributes<HTMLCanvasElement>["onPointerUp"],
    undefined
  >;
  onPointerCancel: Exclude<
    DOMAttributes<HTMLCanvasElement>["onPointerCancel"],
    undefined
  >;
  onTouchMove: Exclude<
    DOMAttributes<HTMLCanvasElement>["onTouchMove"],
    undefined
  >;
  onPointerDown: Exclude<
    DOMAttributes<HTMLCanvasElement>["onPointerDown"],
    undefined
  >;
  onDoubleClick: Exclude<
    DOMAttributes<HTMLCanvasElement>["onDoubleClick"],
    undefined
  >;
};

/**
 * 缓存与生命周期补充说明：
 *   - rendererParams 保存“最近一帧的完整输入”：AnimationController 的回调
 *     只注册一次，闭包看不到后续 props，只能通过 ref 读取最新值；
 *   - 远端协作者的 5 个 Map 每帧重建，保证成员加入/离开后索引不会残留；
 *   - 返回值只有一个空 canvas，文本子节点仅用于无障碍朗读。
 */
/**
 * 交互画布：选择框、变换手柄、吸附线、协作光标、滚动条等“非元素”内容。
 *
 * 与 StaticCanvas 的最大差别是它跑在 AnimationController 的循环里，而不是
 * 每次 React 渲染画一次——因为绑定高亮、协作光标呼吸等需要连续动画。
 * `rendererParams` 用 ref 存最近一帧的输入，循环每帧读它，避免闭包拿到
 * 旧 props；React 重渲染只更新 ref，不重启动画。
 */
const InteractiveCanvas = (props: InteractiveCanvasProps) => {
  const isComponentMounted = useRef(false);
  const rendererParams = useRef(null as InteractiveSceneRenderConfig | null);
  // Unique per mounted instance so concurrent editors don't share the
  // interactive scene animation slot.
  const animationKeyRef = useRef<symbol | null>(null);
  if (animationKeyRef.current === null) {
    animationKeyRef.current = Symbol("interactiveSceneAnimation");
  }
  const animationKey = animationKeyRef.current;

  useEffect(() => {
    return () => {
      AnimationController.cancel(animationKey);
    };
  }, [animationKey]);

  useEffect(() => {
    if (!isComponentMounted.current) {
      isComponentMounted.current = true;
      return;
    }

    const remotePointerButton: InteractiveCanvasRenderConfig["remotePointerButton"] =
      new Map();
    const remotePointerViewportCoords: InteractiveCanvasRenderConfig["remotePointerViewportCoords"] =
      new Map();
    const remoteSelectedElementIds: InteractiveCanvasRenderConfig["remoteSelectedElementIds"] =
      new Map();
    const remotePointerUsernames: InteractiveCanvasRenderConfig["remotePointerUsernames"] =
      new Map();
    const remotePointerUserStates: InteractiveCanvasRenderConfig["remotePointerUserStates"] =
      new Map();

    // 把 collaborators 的“每人一份”结构转成渲染器要的“每类一份”反向索引。
    // pointer.renderCursor === false 的用户仍然参与选中高亮，但不画光标。
    props.appState.collaborators.forEach((user, socketId) => {
      if (user.selectedElementIds) {
        for (const id of Object.keys(user.selectedElementIds)) {
          if (!remoteSelectedElementIds.has(id)) {
            remoteSelectedElementIds.set(id, []);
          }
          remoteSelectedElementIds.get(id)!.push(socketId);
        }
      }
      if (!user.pointer || user.pointer.renderCursor === false) {
        return;
      }
      if (user.username) {
        remotePointerUsernames.set(socketId, user.username);
      }
      if (user.userState) {
        remotePointerUserStates.set(socketId, user.userState);
      }
      remotePointerViewportCoords.set(
        socketId,
        sceneCoordsToViewportCoords(
          {
            sceneX: user.pointer.x,
            sceneY: user.pointer.y,
          },
          props.appState,
        ),
      );
      remotePointerButton.set(socketId, user.button);
    });

    // 选择色从容器上的 CSS 变量读取：宿主可以整体换肤，而不必把颜色逐层
    // 透传；容器尚未挂载时返回兜底色，保证首帧不是黑色。
    const selectionColor = getSelectionColor(props.containerRef?.current);

    // 整体替换 ref 而不是逐字段赋值：保证渲染器每次看到的都是一组自洽的
    // 输入，不会出现“新 appState + 旧 elementsMap”的中间态。
    rendererParams.current = {
      app: props.app,
      canvas: props.canvas,
      elementsMap: props.elementsMap,
      visibleElements: props.visibleElements,
      selectedElements: props.selectedElements,
      allElementsMap: props.allElementsMap,
      scale: props.scale,
      appState: props.appState,
      renderConfig: {
        remotePointerViewportCoords,
        remotePointerButton,
        remoteSelectedElementIds,
        remotePointerUsernames,
        remotePointerUserStates,
        selectionColor,
        renderScrollbars: props.renderScrollbars,
        // NOTE not memoized on so we don't rerender on cursor move
        lastViewportPosition: props.app.viewport.lastPosition,
      },
      editorInterface: props.editorInterface,
      callback: props.renderInteractiveSceneCallback,
      animationState: {
        bindingHighlight: undefined,
      },
      deltaTime: 0,
    };

    // 只有当前实例没有动画时才启动，避免每次 React 渲染都注册新回调：
    // AnimationController 以 key 为槽位，重复 start 会覆盖旧回调并丢失已累积
    // 的 animationState（表现为绑定高亮呼吸被突然重置）。
    if (!AnimationController.running(animationKey)) {
      AnimationController.start<InteractiveSceneRenderAnimationState>(
        animationKey,
        ({ deltaTime, state }) => {
          // 传入上一帧的 state 与 deltaTime：渲染器是“纯函数 + 返回新状态”，
          // 动画推进完全由这里的返回值驱动，组件本身不持有动画进度。
          const nextAnimationState = renderInteractiveScene({
            ...rendererParams.current!,
            deltaTime,
            animationState: state,
          }).animationState;

          // 只要状态里还有非 undefined 字段就继续循环；全部为 undefined 时
          // 返回 undefined 让 AnimationController 停止——没有动画时不应继续
          // 占用每帧的绘制开销。
          if (nextAnimationState) {
            for (const key in nextAnimationState) {
              if (
                nextAnimationState[
                  key as keyof InteractiveSceneRenderAnimationState
                ] !== undefined
              ) {
                return nextAnimationState;
              }
            }
          }

          return undefined;
        },
        props.app.ownerWindow,
      );
    }
  });

  // CSS 尺寸控制布局、width/height 控制设备像素，scale 负责两者换算；
  // 漏乘 scale 会让高分屏上的覆盖物整体变模糊。
  return (
    <canvas
      className="excalidraw__canvas interactive"
      // NOTE no `cursor` style here — the cursor is managed imperatively
      // (see `AppCursor`); an inline style would clobber it whenever its
      // computed value changes across rerenders
      style={{
        width: props.appState.width,
        height: props.appState.height,
      }}
      width={props.appState.width * props.scale}
      height={props.appState.height * props.scale}
      ref={props.handleCanvasRef}
      // NOTE all the handlers early-exit in App when the editor is
      // non-interactive (running only a restricted, link-only code path if
      // `interaction.allowed.links` is enabled), so they're safe to bind
      // unconditionally
      onContextMenu={props.onContextMenu}
      onClick={props.onClick}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      onTouchMove={props.onTouchMove}
      onPointerDown={props.onPointerDown}
      onDoubleClick={
        props.appState.viewModeEnabled ? undefined : props.onDoubleClick
      }
    >
      {t("labels.drawingCanvas")}
    </canvas>
  );
};

/**
 * 从完整 AppState 中挑出交互层真正依赖的字段。
 *
 * 用途只有一个：React.memo 的浅比较。AppState 字段极多，直接比较整个对象
 * 几乎每次都是 false；把字段收敛到这张白名单后，只有影响绘制的状态变化才会
 * 触发重渲染。
 *
 * 维护约束：新增任何在 interactiveScene 里读取的 appState 字段，都必须同步
 * 加到这里，否则该字段变化时画布不会刷新（典型的“看起来卡住”）。
 * collaborators 是例外：它参与协作光标与远端选中框，必须整体比较引用。
 */
const getRelevantAppStateProps = (
  appState: AppState,
): InteractiveCanvasAppState => ({
  zoom: appState.zoom,
  scrollX: appState.scrollX,
  scrollY: appState.scrollY,
  width: appState.width,
  height: appState.height,
  viewModeEnabled: appState.viewModeEnabled,
  activeTool: appState.activeTool,
  openDialog: appState.openDialog,
  editingGroupId: appState.editingGroupId,
  selectedElementIds: appState.selectedElementIds,
  frameToHighlight: appState.frameToHighlight,
  offsetLeft: appState.offsetLeft,
  offsetTop: appState.offsetTop,
  theme: appState.theme,
  selectionElement: appState.selectionElement,
  selectedGroupIds: appState.selectedGroupIds,
  selectedLinearElement: appState.selectedLinearElement,
  multiElement: appState.multiElement,
  newElement: appState.newElement,
  isBindingEnabled: appState.isBindingEnabled,
  isMidpointSnappingEnabled: appState.isMidpointSnappingEnabled,
  gridModeEnabled: appState.gridModeEnabled,
  suggestedBinding: appState.suggestedBinding,
  textToolHover: appState.textToolHover,
  isRotating: appState.isRotating,
  elementsToHighlight: appState.elementsToHighlight,
  collaborators: appState.collaborators, // Necessary for collab. sessions
  activeEmbeddable: appState.activeEmbeddable,
  snapLines: appState.snapLines,
  zenModeEnabled: appState.zenModeEnabled,
  editingTextElement: appState.editingTextElement,
  isCropping: appState.isCropping,
  croppingElementId: appState.croppingElementId,
  searchMatches: appState.searchMatches,
  activeLockedId: appState.activeLockedId,
  hoveredElementIds: appState.hoveredElementIds,
  frameRendering: appState.frameRendering,
  shouldCacheIgnoreZoom: appState.shouldCacheIgnoreZoom,
  exportScale: appState.exportScale,
  currentItemArrowType: appState.currentItemArrowType,
});

const areEqual = (
  prevProps: InteractiveCanvasProps,
  nextProps: InteractiveCanvasProps,
) => {
  // This could be further optimised if needed, as we don't have to render interactive canvas on each scene mutation
  if (
    prevProps.selectionNonce !== nextProps.selectionNonce ||
    prevProps.canvasNonce !== nextProps.canvasNonce ||
    prevProps.scale !== nextProps.scale ||
    // we need to memoize on elementsMap because they may have renewed
    // even if canvasNonce didn't change (e.g. we filter elements out based
    // on appState)
    // 引用比较是有意为之：elementsMap 是每帧重建的不可变 Map，内容变化必然
    // 换引用；逐项深比较反而更慢，还会掩盖上层的更新时机问题。
    prevProps.elementsMap !== nextProps.elementsMap ||
    prevProps.visibleElements !== nextProps.visibleElements ||
    prevProps.selectedElements !== nextProps.selectedElements ||
    prevProps.renderScrollbars !== nextProps.renderScrollbars ||
    prevProps.interactionEnabled !== nextProps.interactionEnabled ||
    prevProps.navigationEnabled !== nextProps.navigationEnabled
  ) {
    return false;
  }

  // Comparing the interactive appState for changes in case of some edge cases
  return isShallowEqual(
    // asserting AppState because we're being passed the whole AppState
    // but resolve to only the InteractiveCanvas-relevant props
    getRelevantAppStateProps(prevProps.appState as AppState),
    getRelevantAppStateProps(nextProps.appState as AppState),
  );
};

export default React.memo(InteractiveCanvas, areEqual);
