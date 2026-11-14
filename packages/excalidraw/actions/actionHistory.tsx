/**
 * 文件位置：撤销/重做动作的注册入口，位于「快捷键/按钮」与「History 回放」
 * 之间。History（packages/excalidraw/history.ts）持有 delta 栈，
 * 这里只负责把手势状态、快捷键与 UI 可用性接到回放逻辑上。
 *
 * 关键约束：历史回放本身已由 History.perform 通过 scheduleMicroAction 排入
 * Store（并因此触发协作广播），所以这里的 perform 必须返回
 * captureUpdate: NEVER，否则同一次撤销会被记成两条历史。
 *
 * 两个动作由 App 在启动时用 history 实例工厂化注册
 * （packages/excalidraw/components/App.tsx 中的 registerAction）。
 */
import {
  KEYS,
  matchKey,
  arrayToMap,
  MOBILE_ACTION_BUTTON_BG,
} from "@excalidraw/common";

import { CaptureUpdateAction } from "@excalidraw/element";

import { orderByFractionalIndex } from "@excalidraw/element";

import type { SceneElementsMap } from "@excalidraw/element/types";

import { IconButton } from "../components/IconButton";
import { UndoIcon, RedoIcon } from "../components/icons";
import { HistoryChangedEvent } from "../history";
import { useEmitter } from "../hooks/useEmitter";
import { t } from "../i18n";

import { useStylesPanelMode } from "../components/App";

import type { History } from "../history";
import type { AppClassProperties, AppState } from "../types";
import type { Action, ActionResult } from "./types";

/**
 * 撤销/重做的动作外壳。
 *
 * 手势进行中（多段线、缩放、文本编辑、框选、正在拖拽）一律不执行：
 * 这时元素处于“半提交”状态，回放 delta 会把临时几何写进历史。
 * `drawShape.hasPendingGesture()` 是后补的同类条件——手绘形状尚未被识别成
 * 元素，`newElement` 还是空的，但同样不能中途撤销。
 *
 * 成功回放返回 `captureUpdate: NEVER`：撤销产生的变更已经由
 * History.perform 通过 micro action 排入 Store，若这里再标 IMMEDIATELY
 * 会被当成新的用户操作重复记录。
 */
const executeHistoryAction = (
  app: AppClassProperties,
  appState: Readonly<AppState>,
  updater: () => [SceneElementsMap, AppState] | void,
): ActionResult => {
  if (
    !appState.multiElement &&
    !appState.resizingElement &&
    !appState.editingTextElement &&
    !appState.newElement &&
    !appState.selectedElementsAreBeingDragged &&
    !appState.selectionElement &&
    !app.flowchart.isCreatingChart &&
    // a drawShape sketch in progress isn't visible via `newElement` while
    // the stroke is still unrecognized — block history mid-gesture the same
    // way as for the other in-progress interactions above
    !app.drawShape.hasPendingGesture()
  ) {
    const result = updater();

    if (!result) {
      return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
    }

    const [nextElementsMap, nextAppState] = result;

    // 回放结果按 fractional index 重排：delta 只保证字段正确，不保证数组
    // 顺序；Scene 的渲染顺序依赖数组顺序，这里必须重新对齐。
    // order by fractional indices in case the map was accidently modified in the meantime
    const nextElements = orderByFractionalIndex(
      Array.from(nextElementsMap.values()),
    );

    return {
      appState: nextAppState,
      elements: nextElements,
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  }

  return { captureUpdate: CaptureUpdateAction.EVENTUALLY };
};

type ActionCreator = (history: History) => Action;

/**
 * 撤销动作。工厂函数注入 history 实例，使动作定义与具体编辑器实例解耦
 * （同一份代码可以被多个 App 实例复用，测试里也能各自建栈）。
 *
 * 快捷键：Ctrl/Cmd+Z，且不带 Shift——Shift+Ctrl+Z 留给 redo。
 */
export const createUndoAction: ActionCreator = (history) => ({
  name: "undo",
  label: "buttons.undo",
  icon: UndoIcon,
  trackEvent: { category: "history" },
  viewMode: false,
  perform: (elements, appState, value, app) =>
    executeHistoryAction(app, appState, () =>
      history.undo(
        arrayToMap(elements) as SceneElementsMap,
        appState,
        app.renderEnvironment,
      ),
    ),
  // Ctrl/Cmd+Z；带 Shift 时交给 redo（见下方 keyTest）。
  // 注意这里只做“按键形状”判断，能否真正撤销由 History 的栈深度决定。
  keyTest: (event) =>
    event[KEYS.CTRL_OR_CMD] && matchKey(event, KEYS.Z) && !event.shiftKey,
  PanelComponent: ({ appState, updateData, data, app }) => {
    // 订阅 history 变更事件来刷新按钮禁用态；useEmitter 会在
    // HistoryChangedEvent 派发时重渲染，避免按钮状态滞后于栈的变化。
    const { isUndoStackEmpty } = useEmitter<HistoryChangedEvent>(
      history.onHistoryChangedEmitter,
      new HistoryChangedEvent(
        history.isUndoStackEmpty,
        history.isRedoStackEmpty,
      ),
    );
    const isMobile = useStylesPanelMode() === "mobile";

    return (
      <IconButton
        type="button"
        icon={UndoIcon}
        aria-label={t("buttons.undo")}
        onClick={updateData}
        size={data?.size || "medium"}
        disabled={isUndoStackEmpty}
        data-testid="button-undo"
        style={{
          ...(isMobile ? MOBILE_ACTION_BUTTON_BG : {}),
        }}
      />
    );
  },
});

/**
 * 重做动作。与 undo 对称，区别只在快捷键组合与读取的栈：
 * Ctrl/Cmd+Shift+Z 或 Ctrl/Cmd+Y 都触发；栈空时按钮禁用。
 */
export const createRedoAction: ActionCreator = (history) => ({
  name: "redo",
  label: "buttons.redo",
  icon: RedoIcon,
  trackEvent: { category: "history" },
  viewMode: false,
  perform: (elements, appState, __, app) =>
    executeHistoryAction(app, appState, () =>
      history.redo(
        arrayToMap(elements) as SceneElementsMap,
        appState,
        app.renderEnvironment,
      ),
    ),
  // 两套习惯都要支持：Windows 用户常用 Ctrl+Y，
  // macOS/跨平台用户常用 Cmd/Ctrl+Shift+Z。
  keyTest: (event) =>
    (event[KEYS.CTRL_OR_CMD] && event.shiftKey && matchKey(event, KEYS.Z)) ||
    (event[KEYS.CTRL_OR_CMD] && !event.shiftKey && matchKey(event, KEYS.Y)),
  PanelComponent: ({ appState, updateData, data, app }) => {
    // 与 undo 共用一次 history 快照：两个按钮的禁用态必须来自同一时刻，
    // 否则回放瞬间可能出现“两个都亮/都灰”的闪烁。
    const { isRedoStackEmpty } = useEmitter(
      history.onHistoryChangedEmitter,
      new HistoryChangedEvent(
        history.isUndoStackEmpty,
        history.isRedoStackEmpty,
      ),
    );
    const isMobile = useStylesPanelMode() === "mobile";

    return (
      <IconButton
        type="button"
        icon={RedoIcon}
        aria-label={t("buttons.redo")}
        onClick={updateData}
        size={data?.size || "medium"}
        disabled={isRedoStackEmpty}
        data-testid="button-redo"
        style={{
          ...(isMobile ? MOBILE_ACTION_BUTTON_BG : {}),
        }}
      />
    );
  },
});
