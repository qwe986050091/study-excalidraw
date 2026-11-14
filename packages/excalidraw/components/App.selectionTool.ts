import {
  CURSOR_TYPE,
  DRAGGING_THRESHOLD,
  getGridPoint,
  isSelectionLikeTool,
  KEYS,
  shouldMaintainAspectRatio,
  shouldResizeFromCenter,
  shouldRotateWithDiscreteAngle,
  tupleToCoors,
  viewportCoordsToSceneCoords,
} from "@excalidraw/common";
import {
  addElementsToFrame,
  cropElement,
  dragSelectedElements,
  getCommonBounds,
  getCommonFrameId,
  getElementAbsoluteCoords,
  getElementsInGroup,
  getElementsInResizingFrame,
  getElementWithTransformHandleType,
  getFrameChildren,
  getResizeArrowDirection,
  getResizeOffsetXY,
  getTransformHandleTypeFromCoords,
  getUncroppedWidthAndHeight,
  handleFocusPointPointerDown,
  hitElementBoundingBoxOnly,
  isBindingElement,
  isElbowArrow,
  isElementInFrame,
  isElementInGroup,
  isEmbeddableElement,
  isFrameLikeElement,
  isImageElement,
  isInitializedImageElement,
  isLinearElement,
  isNonDeletedElement,
  isSelectedViaGroup,
  isStickyNoteElement,
  LinearElementEditor,
  makeNextSelectedElementIds,
  transformElements,
  uncropElementSides,
  updateBoundElements,
  removeArrowsWithoutEndInFrame,
  updateFrameMembershipOfSelectedElements,
} from "@excalidraw/element";
import {
  clamp,
  pointDistance,
  pointFrom,
  pointRotateRads,
  vector,
  vectorDot,
  vectorFromPoint,
  vectorNormalize,
  vectorSubtract,
} from "@excalidraw/math";

import type { TransformHandleType } from "@excalidraw/element";
import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
  NonDeletedSceneElementsMap,
  PointerType,
} from "@excalidraw/element/types";

import { actionToggleLinearEditor } from "../actions";
import {
  getElementsWithinSelection,
  getSelectedElements,
  isSomeElementSelected,
} from "../scene";

import { snapDraggedElements, snapResizingElements } from "../snapping";

import { selectGroupsForSelectedElements } from "./App.selection";

import type React from "react";
import type { PointerDownState } from "../types";
import type App from "./App";

/**
 * 选择工具（以及套索工具）的指针状态机。
 *
 * 在整条链路里的位置：指针事件从 App 的 pointerdown/move/up 进入，本文件
 * 只负责把“手势”翻译成对 selection / scene 的调用；它不写历史，也不直接
 * 提交 Store——元素变更通过 scene.mutateElement 落到不可变快照，
 * pointerup 之后由 React 提交触发 Store.commit，从而只产生一条 undo。
 *
 * 一次 pointerdown 在这里决定接下来走哪条手势分支，结果写进
 * `PointerDownState`（hit / resize / boxSelection / …），后续 pointermove
 * 只读这个状态，不再重新判断“用户想干什么”。分支优先级：
 * 1. 变换手柄命中 → 缩放/旋转/裁剪（maybeHandleResize）；
 * 2. 线性元素编辑器已激活 → 端点拖拽；
 * 3. 命中元素 → 选择并准备拖拽（handleSelectionDragOnPointerMove）；
 * 4. 空白 → 框选（handleBoxSelectionOnPointerMove）。
 *
 * 两个容易读漏的细节：
 * - 拖拽是否真正开始由 DRAG_THRESHOLD 决定，pointerdown 只记录候选；
 * - alt+click 在重叠元素间循环选择，判断放在 pointerup（没有拖动时），
 *   所以点击手柄也会先尝试循环而不是立即缩放。
 *
 * The selection tool's (and the lasso's) selection: what a pointer down
 * selects, what a click (a pointer up without a drag) does to the selection —
 * including alt-click cycling through the overlapping elements — and the
 * selection's transform handles (resizing, rotating, cropping).
 */
export class AppSelectionTool {
  /**
   * 只持有 App 引用；状态全部存在 App/Scene 里，因此工具实例本身无状态，
   * 可以随 App 重建而不需要迁移数据。
   */
  constructor(private app: App) {}

  /**
   * 切到非选择类工具时清空选择。
   *
   * 调用点在工具切换流程里；选择类工具（selection/lasso）之间切换保留
   * 选择，避免用户在选区与套索之间来回切时丢失已选元素。
   */
  clearSelectionIfNotUsingSelection = (): void => {
    if (!isSelectionLikeTool(this.app.state.activeTool.type)) {
      this.app.selection.clear();
    }
  };

  /**
   * pointerdown 的手势判定入口。
   *
   * @returns whether the pointer event has been completely handled
   *
   * @returns 事件是否已被“完全处理”。返回 true 表示调用方（App）不要再
   *   继续向下分发；返回 false 表示还要允许后续的拖拽/框选逻辑接手。
   *
   * 顺序不能随意调整：变换手柄优先于元素命中，线性编辑器优先于普通
   * 选择，链接命中优先于全部拖拽——任何一步提前 return 都会改变手势语义。
   */
  handleSelectionOnPointerDown = (
    event: React.PointerEvent<HTMLElement>,
    pointerDownState: PointerDownState,
  ): boolean => {
    if (isSelectionLikeTool(this.app.state.activeTool.type)) {
      // 在已编辑元素上按下时，交给 duplicate 模块处理（如拖动复制句柄），
      // 本函数不再干预
      if (this.app.duplicate.hitEditedElement(pointerDownState)) {
        return false;
      }

      const elementsMap = this.app.scene.getNonDeletedElementsMap();
      const selectedElements = this.app.scene.getSelectedElements(
        this.app.state,
      );

      // 第一优先：变换手柄。命中后写入 resize 状态，pointermove 不再重算。
      const transformHandle = this.getTransformHandleAt(
        selectedElements,
        pointerDownState.origin.x,
        pointerDownState.origin.y,
        event.pointerType,
      );
      if (transformHandle) {
        // (in the crop editor, the handles crop the image rather than resize it)
        if (transformHandle.element && !this.app.state.croppingElementId) {
          this.app.setState({ resizingElement: transformHandle.element });
        }
        pointerDownState.resize.handleType =
          transformHandle.transformHandleType;
      }
      if (pointerDownState.resize.handleType) {
        // 手柄命中不代表已经开始缩放：isResizing 只是“候选”，真正的
        // 位移在 maybeHandleResize 里按阈值与按键状态推进。
        pointerDownState.resize.isResizing = true;
        // offset 记录“指针相对手柄锚点的偏差”，拖拽时先减掉它，
        // 元素才不会在按下瞬间跳到指针位置。
        pointerDownState.resize.offset = tupleToCoors(
          getResizeOffsetXY(
            pointerDownState.resize.handleType,
            selectedElements,
            elementsMap,
            pointerDownState.origin.x,
            pointerDownState.origin.y,
          ),
        );
        if (
          selectedElements.length === 1 &&
          isLinearElement(selectedElements[0]) &&
          selectedElements[0].points.length === 2
        ) {
          pointerDownState.resize.arrowDirection = getResizeArrowDirection(
            pointerDownState.resize.handleType,
            selectedElements[0],
          );
        }
        // an alt-click on a resize handle (over the selected element) cycles
        // the selection too — alt-resizing starts past the drag threshold
        if (pointerDownState.resize.handleType !== "rotation") {
          pointerDownState.hit.cycleTarget = this.getSelectionCycleTarget(
            event,
            this.app.getElementsAtPosition(
              pointerDownState.origin.x,
              pointerDownState.origin.y,
            ),
          );
        }
      } else {
        // 第二优先：线性元素编辑器。只有“已处于编辑态”的线性元素才会
        // 消费按下事件（加点、拖端点、拖标签），普通选择不会进这里。
        if (this.app.state.selectedLinearElement) {
          const linearElementEditor = this.app.state.selectedLinearElement;
          const ret = LinearElementEditor.handlePointerDown(
            event,
            this.app,
            this.app.store,
            pointerDownState.origin,
            linearElementEditor,
            this.app.scene,
          );

          if (ret.hitElement) {
            pointerDownState.hit.element = ret.hitElement;
          }
          pointerDownState.hit.arrowLabel = ret.hitBoundText;
          if (ret.linearElementEditor) {
            this.app.setState({
              selectedLinearElement: ret.linearElementEditor,
            });
          }
          if (ret.didAddPoint) {
            // 在线上按下并插入了新端点：这次 pointerdown 已被线性编辑器
            // 完全消费，后续不应再走选择/拖拽
            return true;
          }

          // Also check at current pointer position if focus point is being hovered
          // (in case we're clicking directly without a prior move event)
          const elementsMap = this.app.scene.getNonDeletedElementsMap();
          const arrow = LinearElementEditor.getElement(
            linearElementEditor.elementId,
            elementsMap,
          ) as any;

          if (arrow && isBindingElement(arrow)) {
            const {
              hitFocusPoint,
              pointerOffset,
              arrowOtherEndpointInitialBinding,
            } = handleFocusPointPointerDown(
              arrow,
              pointerDownState,
              elementsMap,
              this.app.state,
            );

            // If focus point is hit, update state and prevent element selection
            if (hitFocusPoint) {
              this.app.setState({
                selectedLinearElement: {
                  ...linearElementEditor,
                  hoveredFocusPointBinding: hitFocusPoint,
                  draggedFocusPointBinding: hitFocusPoint,
                  pointerOffset,
                  initialState: {
                    ...linearElementEditor.initialState,
                    arrowOtherEndpointInitialBinding,
                  },
                },
              });
              return false;
            }
          }
        }

        // 命中测试分两次：先取全部（含锁定），再过滤出未锁定的。
        // 锁定元素只有“已选中时”才允许被拖拽，所以不能直接从候选里删掉。
        const allHitElements = this.app.getElementsAtPosition(
          pointerDownState.origin.x,
          pointerDownState.origin.y,
          {
            includeLockedElements: true,
          },
        );
        const unlockedHitElements = allHitElements.filter((e) => !e.locked);

        // Cannot set preferSelected in getElementAtPosition as we do in pointer move; consider:
        // A & B: both unlocked, A selected, B on top, A & B overlaps in some way
        // we want to select B when clicking on the overlapping area
        const hitElementMightBeLocked = this.app.getElementAtPosition(
          pointerDownState.origin.x,
          pointerDownState.origin.y,
          {
            allHitElements,
          },
        );

        if (
          !hitElementMightBeLocked ||
          hitElementMightBeLocked.id !== this.app.state.activeLockedId
        ) {
          this.app.setState({
            activeLockedId: null,
          });
        }

        if (
          hitElementMightBeLocked &&
          hitElementMightBeLocked.locked &&
          !unlockedHitElements.some(
            (el) => this.app.state.selectedElementIds[el.id],
          )
        ) {
          // 命中的是锁定元素，且它上方没有已选中的未锁定元素：不进入
          // 拖拽分支（锁定元素不可直接拖动）
          pointerDownState.hit.element = null;
        } else {
          // hitElement may already be set above, so check first
          pointerDownState.hit.element =
            pointerDownState.hit.element ??
            this.app.getElementAtPosition(
              pointerDownState.origin.x,
              pointerDownState.origin.y,
            );
        }

        this.app.hitLinkElement = this.app.getElementLinkAtPosition(
          pointerDownState.origin,
          hitElementMightBeLocked,
        );

        // 链接命中优先于元素拖拽：点在小链接图标上应当打开链接，
        // 而不是开始拖动元素，所以这里直接消费事件
        if (this.app.hitLinkElement) {
          return true;
        }

        if (
          this.app.state.croppingElementId &&
          pointerDownState.hit.element?.id !== this.app.state.croppingElementId
        ) {
          // 裁剪模式下点了别的元素：先结束裁剪，再按普通点击继续处理
          this.app.finishImageCropping();
        }

        if (pointerDownState.hit.element) {
          // Early return if pointer is hitting link icon
          const hitLinkElement = this.app.getElementLinkAtPosition(
            {
              x: pointerDownState.origin.x,
              y: pointerDownState.origin.y,
            },
            pointerDownState.hit.element,
          );
          if (hitLinkElement) {
            return false;
          }
        }

        // For overlapped elements one position may hit
        // multiple elements
        pointerDownState.hit.allHitElements = unlockedHitElements;

        pointerDownState.hit.cycleTarget = this.getSelectionCycleTarget(
          event,
          unlockedHitElements,
        );
        // the selection cycles on pointerup — or, on an alt-drag, is what's
        // duplicated
        if (pointerDownState.hit.cycleTarget) {
          this.app.setState({
            previousSelectedElementIds: this.app.state.selectedElementIds,
          });
          return false;
        }

        const hitElement = pointerDownState.hit.element;
        const someHitElementIsSelected =
          pointerDownState.hit.allHitElements.some((element) =>
            this.app.selection.isASelectedElement(element),
          ) ||
          // the selected linear element's point handles, midpoint knob and
          // label extend beyond its own hit area, so a hit reported by
          // `LinearElementEditor.handlePointerDown` counts even when the
          // position-based hit test above missed the element
          (hitElement !== null &&
            this.app.selection.isASelectedElement(hitElement));
        if (
          (hitElement === null || !someHitElementIsSelected) &&
          !event.shiftKey &&
          !pointerDownState.hit.hasHitCommonBoundingBoxOfSelectedElements &&
          (!this.app.state.selectedLinearElement?.isEditing ||
            (hitElement &&
              hitElement?.id !==
                this.app.state.selectedLinearElement?.elementId))
        ) {
          // 只有“没按 shift、没命中选中元素的包围盒、也不是在编辑同一
          // 线性元素”时才清空旧选择；否则交给后续逻辑做累加/切换
          this.clearSelection(hitElement);
        }

        if (this.app.state.selectedLinearElement?.isEditing) {
          // 编辑中的线性元素：点击自身继续编辑，点击别处退出编辑并只保留
          // 一个选中 id（makeNextSelectedElementIds 会处理组内展开）
          this.app.setState((prevState) => ({
            selectedLinearElement: prevState.selectedLinearElement
              ? {
                  ...prevState.selectedLinearElement,
                  isEditing:
                    !!hitElement &&
                    hitElement.id ===
                      this.app.state.selectedLinearElement?.elementId,
                }
              : null,
            selectedElementIds: prevState.selectedLinearElement
              ? makeNextSelectedElementIds(
                  {
                    [prevState.selectedLinearElement.elementId]: true,
                  },
                  this.app.state,
                )
              : makeNextSelectedElementIds({}, prevState),
          }));
          // If we click on something
        } else if (hitElement != null) {
          // == deep selection ==
          // on CMD/CTRL, drill down to hit element regardless of groups etc.
          // ctrl/cmd 是“穿透选择”：忽略组/容器的选择语义，直接选中命中的
          // 那一个元素；ctrl+alt 则切换为套索工具（见下）。
          if (event[KEYS.CTRL_OR_CMD]) {
            if (event.altKey) {
              // ctrl + alt means we're lasso selecting - start lasso trail and switch to lasso tool

              // Close any open dialogs that might interfere with lasso selection
              if (this.app.state.openDialog?.name === "elementLinkSelector") {
                this.app.setOpenDialog(null);
              }
              this.app.lassoTrail.startPath(
                pointerDownState.origin.x,
                pointerDownState.origin.y,
                event.shiftKey,
              );
              this.app.setActiveTool({ type: "lasso", fromSelection: true });
              return false;
            }
            if (!this.app.state.selectedElementIds[hitElement.id]) {
              pointerDownState.hit.wasAddedToSelection = true;
            }
            this.app.setState({
              previousSelectedElementIds: this.app.state.selectedElementIds,
            });
            this.app.selection.select(hitElement, { deep: true });
            // mark as not completely handled so as to allow dragging etc.
            return false;
          }

          // deselect if item is selected
          // if shift is not clicked, this will always return true
          // otherwise, it will trigger selection based on current
          // state of the box
          if (!this.app.state.selectedElementIds[hitElement.id]) {
            // if we are currently editing a group, exiting editing mode and deselect the group.
            if (
              this.app.state.editingGroupId &&
              !isElementInGroup(hitElement, this.app.state.editingGroupId)
            ) {
              this.app.selection.clear();
            }

            // Add hit element to selection. At this point if we're not holding
            // SHIFT the previously selected element(s) were deselected above
            // (make sure you use setState updater to use latest state)
            // With shift-selection, we want to make sure that frames and their containing
            // elements are not selected at the same time.
            if (
              !someHitElementIsSelected &&
              !pointerDownState.hit.hasHitCommonBoundingBoxOfSelectedElements
            ) {
              this.app.selection.add(hitElement);
              pointerDownState.hit.wasAddedToSelection = true;
            }
          }
        }

        this.app.setState({
          previousSelectedElementIds: this.app.state.selectedElementIds,
        });
      }
    }
    return false;
  };

  /**
   * 裁剪模式下的“手柄拖拽 = 调整裁剪框”。
   *
   * 与普通缩放的关键差异：修改的不是元素几何，而是 `element.crop` 的
   * 归一化区域；因此必须用未裁剪的自然尺寸换算，并 clamp 在图片边界内。
   *
   * @returns 是否已处理（未进入裁剪模式或没有有效手柄时为 false）
   */
  maybeHandleCrop = (
    pointerDownState: PointerDownState,
    event: MouseEvent | KeyboardEvent,
  ): boolean => {
    // to crop, we must already be in the cropping mode, where croppingElement has been set
    if (!this.app.state.croppingElementId) {
      return false;
    }

    const transformHandleType = pointerDownState.resize.handleType;
    const pointerCoords = pointerDownState.lastCoords;
    const [x, y] = getGridPoint(
      pointerCoords.x - pointerDownState.resize.offset.x,
      pointerCoords.y - pointerDownState.resize.offset.y,
      event[KEYS.CTRL_OR_CMD] ? null : this.app.getEffectiveGridSize(),
    );

    const croppingElement = this.app.scene
      .getNonDeletedElementsMap()
      .get(this.app.state.croppingElementId);

    if (
      transformHandleType &&
      transformHandleType !== "rotation" &&
      croppingElement &&
      isImageElement(croppingElement)
    ) {
      // 必须以“本次手势开始时的快照”为基准计算裁剪，否则连续 pointermove
      // 会在已经改过的 crop 上再叠加，产生指数漂移
      const croppingAtStateStart = pointerDownState.originalElements.get(
        croppingElement.id,
      );

      const image =
        isInitializedImageElement(croppingElement) &&
        this.app.imageCache.get(croppingElement.fileId)?.image;

      if (
        croppingAtStateStart &&
        isImageElement(croppingAtStateStart) &&
        image &&
        !(image instanceof Promise)
      ) {
        const [gridX, gridY] = getGridPoint(
          pointerCoords.x,
          pointerCoords.y,
          event[KEYS.CTRL_OR_CMD] ? null : this.app.getEffectiveGridSize(),
        );

        const dragOffset = {
          x: gridX - pointerDownState.originInGrid.x,
          y: gridY - pointerDownState.originInGrid.y,
        };

        this.app.maybeCacheReferenceSnapPoints(event, [croppingElement]);

        const { snapOffset, snapLines } = snapResizingElements(
          [croppingElement],
          [croppingAtStateStart],
          this.app,
          event,
          dragOffset,
          transformHandleType,
        );

        this.app.scene.mutateElement(
          croppingElement,
          cropElement(
            croppingAtStateStart,
            this.app.scene.getNonDeletedElementsMap(),
            transformHandleType,
            image.naturalWidth,
            image.naturalHeight,
            x + snapOffset.x,
            y + snapOffset.y,
            {
              shouldMaintainAspectRatio: shouldMaintainAspectRatio(event),
              shouldResizeFromCenter: shouldResizeFromCenter(event),
            },
          ),
        );

        updateBoundElements(croppingElement, this.app.scene, {
          renderEnvironment: this.app.renderEnvironment,
        });

        this.app.setState({
          isCropping: true,
          snapLines,
        });
      }

      return true;
    }

    return false;
  };

  /**
   * In the crop editor, a double-click on a handle uncrops its side (a
   * corner's two), and mirrored, the opposite side(s) too.
   *
   * 中文：只有当前图片正被裁剪、且双击位置落在某个非旋转手柄上时才生效；
   * `mirrored` 决定是否同时放开对边（按住 alt 的镜像语义）。
   * 变更需要一次历史记录，所以先 scheduleCapture 再 mutate。
   *
   * @returns whether the double-click has been handled
   */
  maybeUncropSides = (
    image: NonDeleted<ExcalidrawImageElement>,
    sceneX: number,
    sceneY: number,
    mirrored: boolean,
  ): boolean => {
    const handle =
      image.id === this.app.state.croppingElementId &&
      this.getTransformHandleAt(
        [image],
        sceneX,
        sceneY,
        this.app.state.lastPointerDownWith,
      )?.transformHandleType;
    if (!handle || handle === "rotation") {
      return false;
    }
    const updates = uncropElementSides(
      image,
      this.app.scene.getNonDeletedElementsMap(),
      handle,
      mirrored,
    );
    if (updates) {
      this.app.store.scheduleCapture();
      this.app.scene.mutateElement(image, updates);
      updateBoundElements(image, this.app.scene, {
        renderEnvironment: this.app.renderEnvironment,
      });
    }
    return true;
  };

  /**
   * 缩放 / 旋转 / 裁剪的统一处理（pointermove 阶段调用）。
   *
   * 前置分流：裁剪模式走 maybeHandleCrop；frame 不可旋转、elbow arrow 不可
   * 变换；alt 按住时先当作“可能是在循环选择”，只有超过 DRAGGING_THRESHOLD
   * 才真正开始 alt-resize。
   *
   * 所有几何计算都以 `pointerDownState.originalElements` 为基准，而不是
   * 当前元素——否则每帧累加会让元素越缩越快。
   *
   * @returns 是否处理了本次移动（true 时调用方不再走拖拽/框选）
   */
  maybeHandleResize = (
    pointerDownState: PointerDownState,
    event: MouseEvent | KeyboardEvent,
  ): boolean => {
    // in the crop editor, the handles crop the image
    if (this.app.state.croppingElementId) {
      return this.maybeHandleCrop(pointerDownState, event);
    }

    const selectedElements = this.app.scene.getSelectedElements(this.app.state);
    const selectedFrames = selectedElements.filter(isFrameLikeElement);

    const transformHandleType = pointerDownState.resize.handleType;

    if (
      // Frames cannot be rotated.
      (selectedFrames.length > 0 && transformHandleType === "rotation") ||
      // Elbow arrows cannot be transformed (resized or rotated).
      (selectedElements.length === 1 && isElbowArrow(selectedElements[0]))
    ) {
      return false;
    }

    // an alt-resize resizes only once it's a deliberate drag, leaving
    // alt-clicks to cycle the selection
    // 缩放距离按 zoom 归一（乘 zoom.value），使阈值在不同缩放下对应相同的
    // 屏幕像素距离；未超阈值时返回 true 只是为了“先占住事件”，不产生变更。
    if (
      event.altKey &&
      transformHandleType &&
      transformHandleType !== "rotation" &&
      !this.app.state.isResizing &&
      pointDistance(
        pointFrom(pointerDownState.origin.x, pointerDownState.origin.y),
        pointFrom(pointerDownState.lastCoords.x, pointerDownState.lastCoords.y),
      ) *
        this.app.state.zoom.value <
        DRAGGING_THRESHOLD
    ) {
      return true;
    }

    this.app.activeResizeHandle =
      transformHandleType && transformHandleType !== "rotation"
        ? transformHandleType
        : null;
    // isResizing 涵盖“缩放”，isRotating 单独标记旋转；activeEmbeddable 清空，
    // 避免缩放时 iframe 仍处于可交互状态而抢走指针
    this.app.setState({
      // TODO: rename this state field to "isScaling" to distinguish
      // it from the generic "isResizing" which includes scaling and
      // rotating
      isResizing: transformHandleType && transformHandleType !== "rotation",
      isRotating: transformHandleType === "rotation",
      activeEmbeddable: null,
    });
    const pointerCoords = pointerDownState.lastCoords;
    let [resizeX, resizeY] = getGridPoint(
      pointerCoords.x - pointerDownState.resize.offset.x,
      pointerCoords.y - pointerDownState.resize.offset.y,
      event[KEYS.CTRL_OR_CMD] ? null : this.app.getEffectiveGridSize(),
    );

    const frameElementsOffsetsMap = new Map<
      string,
      {
        x: number;
        y: number;
      }
    >();

    // 记录 frame 内元素相对 frame 的偏移：缩放 frame 时子元素要按同一
    // 比例跟随，偏移必须在变换前采集，变换后就取不到了。
    selectedFrames.forEach((frame) => {
      const elementsInFrame = getFrameChildren(
        this.app.scene.getNonDeletedElements(),
        frame.id,
      );

      elementsInFrame.forEach((element) => {
        frameElementsOffsetsMap.set(frame.id + element.id, {
          x: element.x - frame.x,
          y: element.y - frame.y,
        });
      });
    });

    // check needed for avoiding flickering when a key gets pressed
    // during dragging
    if (!this.app.state.selectedElementsAreBeingDragged) {
      const [gridX, gridY] = getGridPoint(
        pointerCoords.x,
        pointerCoords.y,
        event[KEYS.CTRL_OR_CMD] ? null : this.app.getEffectiveGridSize(),
      );

      const dragOffset = {
        x: gridX - pointerDownState.originInGrid.x,
        y: gridY - pointerDownState.originInGrid.y,
      };

      const originalElements = [...pointerDownState.originalElements.values()];

      this.app.maybeCacheReferenceSnapPoints(event, selectedElements);

      const { snapOffset, snapLines } = snapResizingElements(
        selectedElements,
        getSelectedElements(originalElements, this.app.state),
        this.app,
        event,
        dragOffset,
        transformHandleType,
      );

      resizeX += snapOffset.x;
      resizeY += snapOffset.y;

      this.app.setState({
        snapLines,
      });
    }

    // images are proportional by default, and so is a sticky note's corner
    // (its label's font ceiling scales with it); Shift frees them. A note's
    // edges stay free by default — Shift constrains them like any shape.
    // proportionalByDefault 与 shouldMaintainAspectRatio 是“取反”关系：
    // 前者表示“默认等比，按 shift 才自由”，所以要传 !shouldMaintain。
    const proportionalByDefault =
      selectedElements.some((element) => isImageElement(element)) ||
      (selectedElements.length === 1 &&
        isStickyNoteElement(selectedElements[0]) &&
        typeof transformHandleType === "string" &&
        transformHandleType.length === 2);

    if (
      transformElements(
        pointerDownState.originalElements,
        transformHandleType,
        selectedElements,
        this.app.scene,
        shouldRotateWithDiscreteAngle(event),
        shouldResizeFromCenter(event),
        proportionalByDefault
          ? !shouldMaintainAspectRatio(event)
          : shouldMaintainAspectRatio(event),
        resizeX,
        resizeY,
        pointerDownState.resize.center.x,
        pointerDownState.resize.center.y,
        this.app.renderEnvironment,
      )
    ) {
      const elementsToHighlight = new Set<NonDeletedExcalidrawElement>();
      selectedFrames.forEach((frame) => {
        getElementsInResizingFrame(
          this.app.scene.getNonDeletedElements(),
          frame,
          this.app.state,
          this.app.scene.getNonDeletedElementsMap(),
        ).forEach((element) => {
          if (isNonDeletedElement(element)) {
            elementsToHighlight.add(element);
          } else {
            // SAFETY: This should never happen, but log it just in case
            console.error(
              "[NONDELETED][INVARIANT] Skipped highlighting deleted element in resizing frame",
            );
          }
        });
      });

      this.app.setState({
        elementsToHighlight: [...elementsToHighlight],
      });

      // 缩放在这里完成，且不记录历史：pointerup 后统一提交一条
      return true;
    }
    return false;
  };

  /**
   * Drags the selection (or, in the crop editor, the image within its crop) —
   * duplicating it on an alt-drag past the drag threshold.
   *
   * @returns whether the pointer event has been completely handled
   */
  /**
   * 拖拽元素（元素已被选中、指针在元素上移动）。
   *
   * 这里只负责“位移 + 吸附 + 写入元素”，不负责历史：历史由外层在
   * pointerup 时统一 capture，所以整个拖拽过程只产生一条 undo。
   * 吸附结果 `snapOffset` 会改变最终位移，但不会改元素自身的 snap 状态。
   */
  handleSelectionDragOnPointerMove = (
    event: PointerEvent,
    pointerDownState: PointerDownState,
    pointerCoords: { x: number; y: number },
    elementsMap: NonDeletedSceneElementsMap,
  ): boolean => {
    const hasHitASelectedElement = pointerDownState.hit.allHitElements.some(
      (element) => this.app.selection.isASelectedElement(element),
    );

    // 线编辑器打开 + shift + 命中的正是被编辑的线：这是在选端点，
    // 不是拖元素，必须让 LinearElementEditor 接管
    const isSelectingPointsInLineEditor =
      this.app.state.selectedLinearElement?.isEditing &&
      event.shiftKey &&
      this.app.state.selectedLinearElement.elementId ===
        pointerDownState.hit.element?.id;

    if (
      (hasHitASelectedElement ||
        pointerDownState.hit.hasHitCommonBoundingBoxOfSelectedElements) &&
      !isSelectingPointsInLineEditor &&
      !pointerDownState.drag.blockDragging
    ) {
      // 进入条件：按下点命中任一已选元素，或命中选区的公共包围盒内部。
      // shift 拖拽线编辑器端点时不走元素拖拽（那是在选点）。
      const selectedElements = this.app.scene.getSelectedElements(
        this.app.state,
      );
      if (
        selectedElements.length > 0 &&
        selectedElements.every((element) => element.locked)
      ) {
        // 全选中的都是锁定元素：不产生位移，但吞掉事件避免误触发框选
        return true;
      }

      // an alt-drag duplicates only once it's a deliberate drag, leaving
      // alt-clicks to cycle the selection
      if (
        event.altKey &&
        !pointerDownState.drag.hasOccurred &&
        pointDistance(
          pointFrom(pointerDownState.origin.x, pointerDownState.origin.y),
          pointFrom(pointerCoords.x, pointerCoords.y),
        ) *
          this.app.state.zoom.value <
          DRAGGING_THRESHOLD
      ) {
        return true;
      }

      const selectedElementsHasAFrame = selectedElements.some((e) =>
        isFrameLikeElement(e),
      );
      const frameToHighlight = selectedElementsHasAFrame
        ? null
        : this.app.getTopLayerFrameAtSceneCoords(pointerCoords, {
            currentFrameId: getCommonFrameId(selectedElements),
            excludeElementIds: this.app.state.selectedElementIds,
          });
      // Only update the state if there is a difference
      // updateFrameToHighlight 内部做浅比较，避免每次 move 都 setState
      this.app.updateFrameToHighlight(frameToHighlight);

      // Marking that click was used for dragging to check
      // if elements should be deselected on pointerup
      pointerDownState.drag.hasOccurred = true;

      // prevent immediate dragging during lasso selection to avoid element displacement
      // only allow dragging if we're not in the middle of lasso selection
      // (on mobile, allow dragging if we hit an element)
      if (
        this.app.state.activeTool.type === "lasso" &&
        this.app.lassoTrail.hasCurrentTrail &&
        !(
          this.app.editorInterface.formFactor !== "desktop" &&
          pointerDownState.hit.element
        ) &&
        !this.app.state.activeTool.fromSelection
      ) {
        // 套索未结束时不允许拖动元素：否则刚画完的轨迹会连带把元素挪走。
        // 例外：移动端命中元素时允许拖（没有 hover，无法用别的入口区分）。
        return true;
      }

      // Clear lasso trail when starting to drag selected elements with lasso tool
      // Only clear if we're actually dragging (not during lasso selection)
      if (
        this.app.state.activeTool.type === "lasso" &&
        selectedElements.length > 0 &&
        pointerDownState.drag.hasOccurred &&
        !this.app.state.activeTool.fromSelection
      ) {
        this.app.lassoTrail.endPath();
      }

      // prevent dragging even if we're no longer holding cmd/ctrl otherwise
      // it would have weird results (stuff jumping all over the screen)
      // Checking for editingTextElement to avoid jump while editing on mobile #6503
      // 这个条件同时排除了：没有选中元素、按下时是 ctrl/cmd 点选（松手后
      // 不能再拖动）、正在编辑文本、embeddable 已激活——后者由它自己的
      // 交互接管指针。
      if (
        selectedElements.length > 0 &&
        !pointerDownState.withCmdOrCtrl &&
        !this.app.state.editingTextElement &&
        this.app.state.activeEmbeddable?.state !== "active"
      ) {
        const dragOffset = {
          x: pointerCoords.x - pointerDownState.drag.origin.x,
          y: pointerCoords.y - pointerDownState.drag.origin.y,
        };

        const originalElements = [
          ...pointerDownState.originalElements.values(),
        ];

        // We only drag in one direction if shift is pressed
        // shift 锁定主轴：比较 X/Y 位移绝对值，较大者为“意图方向”，
        // 另一轴清零。这样拖拽不会既有横向又有纵向的抖动。
        const lockDirection = event.shiftKey;

        if (lockDirection) {
          const distanceX = Math.abs(dragOffset.x);
          const distanceY = Math.abs(dragOffset.y);

          const lockX = lockDirection && distanceX < distanceY;
          const lockY = lockDirection && distanceX > distanceY;

          if (lockX) {
            dragOffset.x = 0;
          }

          if (lockY) {
            dragOffset.y = 0;
          }
        }

        // #region move crop region
        if (this.app.state.croppingElementId) {
          const croppingElement = this.app.scene
            .getNonDeletedElementsMap()
            .get(this.app.state.croppingElementId);

          if (
            croppingElement &&
            isImageElement(croppingElement) &&
            croppingElement.crop !== null &&
            pointerDownState.hit.element === croppingElement
          ) {
            const crop = croppingElement.crop;
            const image =
              isInitializedImageElement(croppingElement) &&
              this.app.imageCache.get(croppingElement.fileId)?.image;

            if (image && !(image instanceof Promise)) {
              const uncroppedSize = getUncroppedWidthAndHeight(croppingElement);
              // moved by what the drag moved since the previous pointer move
              // (locked to an axis with shift, as dragging elements is), so
              // that the image moves back right away after being dragged past
              // its edge
              const { lastOffset } = pointerDownState.drag;
              const instantDragOffset = vector(
                dragOffset.x - lastOffset.x,
                dragOffset.y - lastOffset.y,
              );
              pointerDownState.drag.lastOffset = dragOffset;

              // to reduce cursor:image drift, we need to take into account
              // the canvas image element scaling so we can accurately
              // track the pixels on movement
              instantDragOffset[0] *= image.naturalWidth / uncroppedSize.width;
              instantDragOffset[1] *=
                image.naturalHeight / uncroppedSize.height;

              const [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(
                croppingElement,
                elementsMap,
              );

              const topLeft = vectorFromPoint(
                pointRotateRads(
                  pointFrom(x1, y1),
                  pointFrom(cx, cy),
                  croppingElement.angle,
                ),
              );
              const topRight = vectorFromPoint(
                pointRotateRads(
                  pointFrom(x2, y1),
                  pointFrom(cx, cy),
                  croppingElement.angle,
                ),
              );
              const bottomLeft = vectorFromPoint(
                pointRotateRads(
                  pointFrom(x1, y2),
                  pointFrom(cx, cy),
                  croppingElement.angle,
                ),
              );
              const topEdge = vectorNormalize(
                vectorSubtract(topRight, topLeft),
              );
              const leftEdge = vectorNormalize(
                vectorSubtract(bottomLeft, topLeft),
              );

              // project instantDrafOffset onto leftEdge and topEdge to decompose
              const offsetVector = vector(
                vectorDot(instantDragOffset, topEdge),
                vectorDot(instantDragOffset, leftEdge),
              );

              const nextCrop = {
                ...crop,
                x: clamp(
                  crop.x -
                    offsetVector[0] * Math.sign(croppingElement.scale[0]),
                  0,
                  image.naturalWidth - crop.width,
                ),
                y: clamp(
                  crop.y -
                    offsetVector[1] * Math.sign(croppingElement.scale[1]),
                  0,
                  image.naturalHeight - crop.height,
                ),
              };

              this.app.scene.mutateElement(croppingElement, {
                crop: nextCrop,
              });

              return true;
            }
          }
        }

        // Snap cache *must* be synchronously popuplated before initial drag,
        // otherwise the first drag even will not snap, causing a jump before
        // it snaps to its position if previously snapped already.
        // 吸附缓存必须同步填好：第一次 move 就参与吸附，否则会先跳到未吸附
        // 位置、下一帧再跳回吸附点，形成可见抖动。
        this.app.maybeCacheVisibleGaps(event, selectedElements);
        this.app.maybeCacheReferenceSnapPoints(event, selectedElements);

        const { snapOffset, snapLines } = snapDraggedElements(
          originalElements,
          dragOffset,
          this.app,
          event,
          this.app.scene.getNonDeletedElementsMap(),
        );

        this.app.setState({ snapLines });

        // when we're editing the name of a frame, we want the user to be
        // able to select and interact with the text input
        // 编辑 frame 名称时，指针用于选中输入框里的文字，不能移动 frame
        if (!this.app.state.editingFrame) {
          dragSelectedElements(
            pointerDownState,
            selectedElements,
            dragOffset,
            this.app.scene,
            snapOffset,
            event[KEYS.CTRL_OR_CMD] ? null : this.app.getEffectiveGridSize(),
            this.app.renderEnvironment,
          );
        }

        this.app.setState({
          selectedElementsAreBeingDragged: true,
          // element is being dragged and selectionElement that was created on pointer down
          // should be removed
          selectionElement: null,
        });

        // We duplicate the selected element if alt is pressed on pointer move
        // 到这里才复制：alt 按下但只点击（未超阈值）时走的是循环选择，
        // 由 pointerup 处理，不会创建副本。
        if (event.altKey && !pointerDownState.hit.hasBeenDuplicated) {
          this.app.duplicate.duplicateDraggedSelection(pointerDownState, event);
        }

        return true;
      }
    }

    return false;
  };

  /**
   * Box-selects with the selection tool — the line editor's points, while
   * editing a line.
   *
   * 框选：把指针起点/终点围成的矩形与元素包围盒比较。
   *
   * 选中判据由 `appState.boxSelectionMode` 决定（默认 "contain"，完全
   * 包含才选中；可切到 "overlap"，相交即选中），与拖拽方向无关。
   * 锁定元素和绑定文本永远不参与框选（shouldIgnoreElementFromSelection）；
   * 选中 frame 时会排除已在其内部的子元素，避免重复选中。
   *
   * 这里的 `hasOccurred` 只标记“框选发生过”，不决定是否清空选择；
   * shift 时在已有选择上累加，否则整体替换。
   */
  handleBoxSelectionOnPointerMove = (
    event: PointerEvent,
    pointerDownState: PointerDownState,
  ) => {
    if (this.app.state.activeTool.type === "selection") {
      // 只有 selection 工具进入；lasso 自己维护轨迹，不走包围盒
      pointerDownState.boxSelection.hasOccurred = true;

      const elements = this.app.scene.getNonDeletedElements();

      // box-select line editor points
      if (this.app.state.selectedLinearElement?.isEditing) {
        LinearElementEditor.handleBoxSelection(
          event,
          this.app.state,
          this.app.setState.bind(this.app),
          this.app.scene.getNonDeletedElementsMap(),
        );
        // regular box-select
      } else {
        let shouldReuseSelection = true;

        // 默认复用现有选择；若没按 shift 且已有选中元素，则本次框选要
        // 替换旧选择（ctrl/cmd + 命中元素的特例仍保留）。
        if (
          !event.shiftKey &&
          isSomeElementSelected(elements, this.app.state)
        ) {
          if (pointerDownState.withCmdOrCtrl && pointerDownState.hit.element) {
            this.app.setState((prevState) =>
              selectGroupsForSelectedElements(
                {
                  ...prevState,
                  selectedElementIds: {
                    [pointerDownState.hit.element!.id]: true,
                  },
                },
                this.app.scene.getNonDeletedElements(),
                prevState,
                this.app,
              ),
            );
          } else {
            shouldReuseSelection = false;
          }
        }
        const elementsWithinSelection = this.app.state.selectionElement
          ? getElementsWithinSelection(
              elements,
              this.app.state.selectionElement,
              this.app.scene.getNonDeletedElementsMap(),
              false,
              this.app.state.boxSelectionMode,
            )
          : [];

        this.app.setState((prevState) => {
          // shouldReuseSelection 为 true（shift 或 ctrl 特例）时在旧选择上
          // 合并；否则从空集开始，这就是“不按 shift 时框选会替换选择”的实现
          const nextSelectedElementIds = {
            ...(shouldReuseSelection && prevState.selectedElementIds),
            ...elementsWithinSelection.reduce(
              (acc: Record<ExcalidrawElement["id"], true>, element) => {
                acc[element.id] = true;
                return acc;
              },
              {},
            ),
          };

          if (pointerDownState.hit.element) {
            // if using ctrl/cmd, select the hitElement only if we
            // haven't box-selected anything else
            // ctrl/cmd 点选后再框选：框到东西就移除该元素，没框到则只保留它
            if (!elementsWithinSelection.length) {
              nextSelectedElementIds[pointerDownState.hit.element.id] = true;
            } else {
              delete nextSelectedElementIds[pointerDownState.hit.element.id];
            }
          }

          prevState = !shouldReuseSelection
            ? { ...prevState, selectedGroupIds: {}, editingGroupId: null }
            : prevState;

          return {
            ...selectGroupsForSelectedElements(
              {
                editingGroupId: prevState.editingGroupId,
                selectedElementIds: nextSelectedElementIds,
              },
              this.app.scene.getNonDeletedElements(),
              prevState,
              this.app,
            ),
            // select linear element only when we haven't box-selected anything else
            // 框到恰好一个线性元素时同时打开线编辑器；多个则只保留普通
            // 选择，避免误触端点拖拽
            selectedLinearElement:
              elementsWithinSelection.length === 1 &&
              isLinearElement(elementsWithinSelection[0])
                ? new LinearElementEditor(
                    elementsWithinSelection[0],
                    this.app.scene.getNonDeletedElementsMap(),
                  )
                : null,
            showHyperlinkPopup:
              elementsWithinSelection.length === 1 &&
              (elementsWithinSelection[0].link ||
                isEmbeddableElement(elementsWithinSelection[0]))
                ? "info"
                : false,
          };
        });
      }
    }
  };

  /**
   * After dragging the selection: the dragged elements join the frame they're
   * dropped in, or leave theirs (and the edited group, if they leave it).
   *
   * 中文：这是 frame 归属真正落库的位置——拖拽期间 Renderer 只是“预演”
   * 顺序，直到这里才写 frameId。离开 frame 时还要清理被解散的组 id，
   * 并且移除两端都不在 frame 内的箭头，避免留下跨 frame 的悬挂绑定。
   */
  handleSelectionDragOnPointerUp = (childEvent: PointerEvent) => {
    const sceneCoords = viewportCoordsToSceneCoords(childEvent, this.app.state);
    // update the relationships between selected elements and frames
    const selectedElements = this.app.scene.getSelectedElements(this.app.state);
    const topLayerFrame = this.app.getTopLayerFrameAtSceneCoords(sceneCoords, {
      currentFrameId: getCommonFrameId(selectedElements),
      excludeElementIds: this.app.state.selectedElementIds,
    });
    let nextElements = this.app.scene.getElementsMapIncludingDeleted();

    const updateGroupIdsAfterEditingGroup = (elements: ExcalidrawElement[]) => {
      if (elements.length > 0) {
        // 离开编辑中的组时，截断 groupIds 到该组之前，并顺手清理
        // “只剩一个成员”的残留组（单元素组没有语义，会让之后的框选
        // 继续把它当组处理）
        for (const element of elements) {
          const index = element.groupIds.indexOf(
            this.app.state.editingGroupId!,
          );

          this.app.scene.mutateElement(
            element,
            {
              groupIds: element.groupIds.slice(0, index),
            },
            { informMutation: false, isDragging: false },
          );
        }

        nextElements.forEach((element) => {
          if (
            element.groupIds.length &&
            getElementsInGroup(
              nextElements,
              element.groupIds[element.groupIds.length - 1],
            ).length < 2
          ) {
            this.app.scene.mutateElement(
              element,
              {
                groupIds: [],
              },
              { informMutation: false, isDragging: false },
            );
          }
        });

        this.app.setState({
          editingGroupId: null,
        });
      }
    };

    if (topLayerFrame && !this.app.state.selectedElementIds[topLayerFrame.id]) {
      // 落在 frame 上：把确实与其相交（isElementInFrame）的选中元素加入。
      // 只加入相交的，避免整组元素被拖到 frame 边缘外也被收进去。
      const elementsToAdd = selectedElements.filter((element) =>
        isElementInFrame(element, nextElements, this.app.state),
      );

      if (this.app.state.editingGroupId) {
        updateGroupIdsAfterEditingGroup(elementsToAdd);
      }

      nextElements = addElementsToFrame(
        nextElements,
        elementsToAdd,
        topLayerFrame,
      );
    } else if (!topLayerFrame) {
      // 没落在任何 frame 上：原本属于 frame 的元素要离开，并清理因离开而
      // 失效的编辑组（否则组 id 会残留在一个孤立的 frame 上）
      if (this.app.state.editingGroupId) {
        const elementsToRemove = selectedElements.filter(
          (element) =>
            element.frameId &&
            !isElementInFrame(element, nextElements, this.app.state),
        );

        updateGroupIdsAfterEditingGroup(elementsToRemove);
      }
    }

    nextElements = updateFrameMembershipOfSelectedElements(
      nextElements,
      this.app.state,
      this.app,
    );
    // the dragged arrows, and those bound to the dragged elements
    // 箭头两端必须都留在同一个 frame 内，否则解除绑定（frame 裁剪后
    // 只露出一端会非常怪异）
    removeArrowsWithoutEndInFrame(selectedElements, nextElements);

    // replaceAllElements 一次性替换整个场景，保证上面所有 mutate 作为
    // 一个整体进入快照；随后的 React 提交才会把它记成一条历史
    this.app.scene.replaceAllElements(nextElements);
  };

  /**
   * The selection's transform handle at the scene point, if any — with its
   * element, for a lone selected element.
   *
   * A lone selected element has none while the line editor is open or one of
   * its line points is hovered, nor does an elbow arrow, a two-point line or
   * arrow, or (on mobile devices) any line or arrow. The selection has none in
   * the element link selector.
   *
   * 中文：单选时逐个检查“为什么不该给手柄”——这些跳过条件都是交互冲突，
   * 不是性能优化。多选时用公共包围盒的 8 个手柄，单选时还要判断指针是否
   * 精确落在手柄热区（pointerType 影响热区大小，触控需要更大）。
   *
   * @returns 命中手柄时返回手柄类型；单选额外带上所属 element；
   *   没有命中返回 null
   */
  getTransformHandleAt(
    selectedElements: readonly NonDeletedExcalidrawElement[],
    sceneX: number,
    sceneY: number,
    pointerType: PointerType,
  ): {
    element?: NonDeletedExcalidrawElement;
    transformHandleType: TransformHandleType;
  } | null {
    const { state, editorInterface } = this.app;
    // 元素链接选择器打开时，指针用于选择链接目标，不能触发变换
    if (state.openDialog?.name === "elementLinkSelector") {
      return null;
    }

    if (selectedElements.length === 1) {
      const [element] = selectedElements;
      // 以下任一条件成立都禁用变换手柄：
      // - 线编辑器已打开，或悬停某个端点（此时拖端点优先）；
      // - elbow 箭头：几何由路由算法决定，缩放/旋转无意义；
      // - 移动端上的线性元素（热区太小），或只有两个点的线/箭头
      //   （HACK：等更好的手柄展示方案）
      if (
        state.selectedLinearElement?.isEditing ||
        (state.selectedLinearElement &&
          state.selectedLinearElement.hoverPointIndex !== -1) ||
        isElbowArrow(element) ||
        // HACK: Disable transform handles for linear elements on mobile until a
        // better way of showing them is found
        (isLinearElement(element) &&
          (editorInterface.userAgent.isMobileDevice ||
            element.points.length === 2))
      ) {
        return null;
      }
      const elementWithTransformHandleType = getElementWithTransformHandleType(
        this.app.scene.getNonDeletedElements(),
        state,
        sceneX,
        sceneY,
        state.zoom,
        pointerType,
        this.app.scene.getNonDeletedElementsMap(),
        editorInterface,
      );
      return elementWithTransformHandleType?.transformHandleType
        ? {
            element: elementWithTransformHandleType.element,
            transformHandleType:
              elementWithTransformHandleType.transformHandleType,
          }
        : null;
    }

    if (selectedElements.length > 1) {
      // 多选时没有“所属元素”的概念，返回的手柄只用于 resize/rotate 整个选区
      const transformHandleType = getTransformHandleTypeFromCoords(
        getCommonBounds(selectedElements),
        sceneX,
        sceneY,
        state.zoom,
        pointerType,
        editorInterface,
      );
      return transformHandleType ? { transformHandleType } : null;
    }

    return null;
  }

  /**
   * Updates the selection on a click (no drag): the element below the
   * selected one on an alt-click, the clicked element added to or removed
   * from the selection with shift, or selected, and the selection cleared
   * by a click hitting only a bounding box.
   *
   * @returns whether the pointer event has been completely handled
   *
   * pointerup 的收口：区分“点击”与“拖拽结束”。
   *
   * 点击路径会处理 alt 循环选择、双击进入组/编辑文本、点击空白清空选择；
   * 拖拽路径负责把最终位置提交并 capture 一条历史。注意这里不直接调用
   * store.commit——commit 发生在 React 提交后的 componentDidUpdate。
   *
   * 循环选择必须在“没有拖动也没有缩放”时才生效，否则 alt 拖拽会既复制
   * 元素又把选择切走。
   */
  handleSelectionOnPointerUp = (
    childEvent: PointerEvent,
    pointerDownState: PointerDownState,
    elementsMap: NonDeletedSceneElementsMap,
  ): boolean => {
    const hitElement = pointerDownState.hit.element;

    // alt-click: select the element below the selected one
    // 注意 cycleTarget 在 pointerdown 就算好了，这里仅按“是否发生拖拽/
    // 缩放”决定要不要消费它
    const cycleTarget =
      !pointerDownState.drag.hasOccurred && !this.app.state.isResizing
        ? pointerDownState.hit.cycleTarget
        : null;
    if (cycleTarget) {
      this.app.selection.select(cycleTarget);
    }

    if (
      !cycleTarget &&
      hitElement &&
      !pointerDownState.drag.hasOccurred &&
      !pointerDownState.hit.wasAddedToSelection &&
      // if we're editing a line, pointerup shouldn't switch selection if
      // box selected
      (!this.app.state.selectedLinearElement?.isEditing ||
        !pointerDownState.boxSelection.hasOccurred) &&
      // hitElement can be set when alt + ctrl to toggle lasso and we will
      // just respect the selected elements from lasso instead
      this.app.state.activeTool.type !== "lasso"
    ) {
      // when inside line editor, shift selects points instead
      // shift+点击：切换该元素的选中状态（点在组上则按组语义移除）；
      // 若目标在已选 frame 内，则改为“退出 frame、选中子元素”。
      if (
        childEvent.shiftKey &&
        !this.app.state.selectedLinearElement?.isEditing &&
        // (in the crop editor, the image stays the selection)
        hitElement.id !== this.app.state.croppingElementId
      ) {
        if (this.app.state.selectedElementIds[hitElement.id]) {
          if (
            isSelectedViaGroup(this.app.state, hitElement) ||
            // if not dragging a linear element point (outside editor)
            !this.app.state.selectedLinearElement?.isDragging
          ) {
            this.app.selection.remove(hitElement);
          }
        } else if (
          hitElement.frameId &&
          this.app.state.selectedElementIds[hitElement.frameId]
        ) {
          // when hitElement is part of a selected frame, deselect the frame
          // to avoid frame and containing elements selected simultaneously
          this.app.setState((prevState) => {
            const nextSelectedElementIds: {
              [id: string]: true;
            } = {
              ...prevState.selectedElementIds,
              [hitElement.id]: true,
            };
            // deselect the frame
            delete nextSelectedElementIds[hitElement.frameId!];

            // deselect groups containing the frame
            (this.app.scene.getElement(hitElement.frameId!)?.groupIds ?? [])
              .flatMap((gid) =>
                getElementsInGroup(this.app.scene.getNonDeletedElements(), gid),
              )
              .forEach((element) => {
                delete nextSelectedElementIds[element.id];
              });

            return {
              ...selectGroupsForSelectedElements(
                {
                  editingGroupId: prevState.editingGroupId,
                  selectedElementIds: nextSelectedElementIds,
                },
                this.app.scene.getNonDeletedElements(),
                prevState,
                this.app,
              ),
              showHyperlinkPopup:
                hitElement.link || isEmbeddableElement(hitElement)
                  ? "info"
                  : false,
            };
          });
        } else {
          // add element to selection while keeping prev elements selected
          this.app.setState((_prevState) => ({
            selectedElementIds: makeNextSelectedElementIds(
              {
                ..._prevState.selectedElementIds,
                [hitElement!.id]: true,
              },
              _prevState,
            ),
          }));
        }
      } else {
        this.app.selection.select(hitElement);
      }
    }

    if (
      !cycleTarget &&
      // do not clear selection if lasso is active
      this.app.state.activeTool.type !== "lasso" &&
      // not elbow midpoint dragged
      !(hitElement && isElbowArrow(hitElement)) &&
      // not dragged
      !pointerDownState.drag.hasOccurred &&
      // not resized
      !this.app.state.isResizing &&
      // only hitting the bounding box of the previous hit element
      // “只命中包围盒、没命中形状本身”视为点击空白：此时应清空选择。
      // hitElementBoundingBoxOnly 会考虑旋转、线编辑器与 frame 标题的
      // 扩展热区，不能自己用矩形近似。
      ((hitElement &&
        hitElementBoundingBoxOnly(
          {
            point: pointFrom(
              pointerDownState.origin.x,
              pointerDownState.origin.y,
            ),
            element: hitElement,
            elementsMap,
            threshold: this.app.getElementHitThreshold(hitElement),
            frameNameBound: isFrameLikeElement(hitElement)
              ? this.app.frameNameBoundsCache.get(hitElement)
              : null,
          },
          elementsMap,
        )) ||
        (!hitElement &&
          pointerDownState.hit.hasHitCommonBoundingBoxOfSelectedElements))
    ) {
      if (this.app.state.selectedLinearElement?.isEditing) {
        // Exit editing mode but keep the element selected
        // 线编辑器打开时，点空白只退出编辑态，不清空选择：用户常常
        // 只是想结束加点，而不是取消选中
        this.app.actionManager.executeAction(actionToggleLinearEditor);
      } else {
        // Deselect selected elements
        this.app.selection.clear();
      }
      // reset cursor
      this.app.cursor.set(CURSOR_TYPE.AUTO);
      return true;
    }

    return false;
  };

  /**
   * 清空选择，但保留“当前正在编辑的组”的上下文。
   *
   * 两次 setState 是刻意的：第一次更新选择与组状态，第二次基于最新 state
   * 记录 previousSelectedElementIds（供后续撤销/恢复逻辑使用）。
   * 如果点击的新元素仍属于正在编辑的组，则继续留在该组内。
   */
  clearSelection(hitElement: ExcalidrawElement | null): void {
    this.app.setState((prevState) => ({
      selectedElementIds: makeNextSelectedElementIds({}, prevState),
      activeEmbeddable: null,
      selectedGroupIds: {},
      // Continue editing the same group if the user selected a different
      // element from it
      editingGroupId:
        prevState.editingGroupId &&
        hitElement != null &&
        isElementInGroup(hitElement, prevState.editingGroupId)
          ? prevState.editingGroupId
          : null,
    }));
    this.app.setState({
      selectedElementIds: makeNextSelectedElementIds({}, this.app.state),
      activeEmbeddable: null,
      previousSelectedElementIds: this.app.state.selectedElementIds,
      selectedLinearElement: null,
    });
  }

  /** whether an alt-click on the selection (over other elements) cycles it */
  /**
   * 是否允许 alt 循环选择：恰好选中一个“可选单位”，且线编辑器/裁剪器
   * 未打开。供 UI 决定是否展示相关提示，也可在测试中直接断言。
   */
  canCycleSelection = () => this.getCyclableSelectedUnit() !== null;

  /**
   * The selectable unit (an element, or the group a click would select) an
   * element belongs to. Inside an edited group, its elements are units of
   * their own.
   *
   * 中文：返回“点击该元素时实际选中的单位 id”。处于某组内部时返回最外层
   * 组 id；正在编辑某个组时，只取该组之内（更内层）的组，编辑组本身不再
   * 作为单位，从而可以在组内继续下钻。没有组则退化元素自身 id。
   */
  private getSelectableUnit(element: ExcalidrawElement) {
    const { editingGroupId } = this.app.state;
    const editingGroupIndex = editingGroupId
      ? element.groupIds.indexOf(editingGroupId)
      : -1;
    const groupIds =
      editingGroupIndex > -1
        ? element.groupIds.slice(0, editingGroupIndex)
        : element.groupIds;
    return groupIds.length ? groupIds[groupIds.length - 1] : element.id;
  }

  /**
   * The selected unit, if an alt-click can cycle away from it: exactly one
   * is selected, and neither the linear nor the crop editor is open.
   *
   * 中文：返回唯一被选中的“可选单位”id；数量不是 1 时返回 null。
   * 线编辑器/裁剪器打开期间禁用循环，因为 alt 在那些上下文里有别的含义。
   */
  private getCyclableSelectedUnit(): string | null {
    if (
      this.app.state.selectedLinearElement?.isEditing ||
      this.app.state.croppingElementId
    ) {
      return null;
    }
    const selectedUnits = new Set(
      this.app.scene
        .getSelectedElements(this.app.state)
        .map((element) => this.getSelectableUnit(element)),
    );
    return selectedUnits.size === 1 ? [...selectedUnits][0] : null;
  }

  /**
   * The element an alt-click selects: the selectable unit below the selected
   * one among the hit elements, wrapping around to the topmost — or `null`
   * unless it's an alt-click, the selection can cycle, and it's under the
   * pointer. Inside an edited group, it cycles through the group's elements
   * only, never leaving the group.
   *
   * 中文：只接受“纯 alt”组合；带 ctrl/cmd 或 shift 时返回 null（那些组合
   * 有各自语义）。循环在命中栈内进行并首尾相接，所以它不会选中指针下方
   * 不存在的元素——这也是为什么必须传 hitElements 而不是全场景。
   */
  private getSelectionCycleTarget(
    event: React.PointerEvent<HTMLElement>,
    hitElements: readonly NonDeleted<ExcalidrawElement>[],
  ): NonDeleted<ExcalidrawElement> | null {
    if (!event.altKey || event[KEYS.CTRL_OR_CMD] || event.shiftKey) {
      return null;
    }
    const selectedUnit = this.getCyclableSelectedUnit();
    if (!selectedUnit) {
      return null;
    }

    const { editingGroupId } = this.app.state;
    if (editingGroupId) {
      hitElements = hitElements.filter((element) =>
        isElementInGroup(element, editingGroupId),
      );
    }

    // topmost first, each unit at its topmost hit element
    // 从命中数组末尾（最上层）往前扫，每个单位只记录第一次遇到（最上层）
    // 的元素；units 的插入顺序即“从上到下”，因此循环方向是“往下选”。
    const units = new Map<string, NonDeleted<ExcalidrawElement>>();
    for (let index = hitElements.length - 1; index > -1; index--) {
      const unit = this.getSelectableUnit(hitElements[index]);
      if (!units.has(unit)) {
        units.set(unit, hitElements[index]);
      }
    }
    const order = [...units.keys()];
    const selectedIndex = order.indexOf(selectedUnit);
    if (selectedIndex === -1) {
      // 当前选中单位不在命中栈里（例如被别的元素完全挡住）：没有“下一个”
      return null;
    }
    // (the selected unit itself if alone)
    return units.get(order[(selectedIndex + 1) % order.length])!;
  }
}
