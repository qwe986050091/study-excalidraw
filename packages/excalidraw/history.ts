import { Emitter } from "@excalidraw/common";

import {
  CaptureUpdateAction,
  StoreChange,
  StoreDelta,
} from "@excalidraw/element";

import type {
  RenderEnvironment,
  StoreSnapshot,
  Store,
} from "@excalidraw/element";

import type { SceneElementsMap } from "@excalidraw/element/types";

import type { AppState } from "./types";

/**
 * 撤销/重做 = 一叠“反向 delta”。
 *
 * 设计取舍：
 * - 不存整份场景快照，只存 Store 产出的字段级 delta（内存与性能）；
 * - 入栈时立即 inverse：`record` 收到的是“这次改动”的正向 delta，压栈前
 *   取反，于是 undo 只需 pop 并 apply；
 * - 回放时永远排除 version/versionNonce：撤销被视为“一次新的用户操作”，
 *   必须产生比远端更新鲜的版本，否则协同场景下会被判定为过期更新而丢弃；
 * - 同一个手势内的多次修改由 Store 合并，这里只负责栈与可见性判定。
 *
 * 调用关系：Store.onDurableIncrementEmitter → App 里的订阅回调
 * → History.record → 本文件；撤销动作见 actions/actionHistory.tsx。
 */

export class HistoryDelta extends StoreDelta {
  /**
   * 应用反向 delta，返回新的元素集合与 AppState。
   *
   * `excludedProperties: {version, versionNonce}` 是本类与基类 `applyTo`
   * 的唯一实质差异：内容回到过去，但版本号继续向前。这样撤销后的元素
   * 在协作中仍然“赢”，不会被其他 peer 的旧数据覆盖。
   */
  public applyTo(
    elements: SceneElementsMap,
    appState: AppState,
    snapshot: StoreSnapshot,
    /** measures the labels re-laid out after applying */
    renderEnvironment?: RenderEnvironment,
  ): [SceneElementsMap, AppState, boolean] {
    const [nextElements, elementsContainVisibleChange] = this.elements.applyTo(
      elements,
      // used to fallback into local snapshot in case we couldn't apply the delta
      // due to a missing (force deleted) elements in the scene
      snapshot.elements,
      // we don't want to apply the `version` and `versionNonce` properties for history
      // as we always need to end up with a new version due to collaboration,
      // approaching each undo / redo as a new user action
      {
        excludedProperties: new Set(["version", "versionNonce"]),
        renderEnvironment,
      },
    );

    const [nextAppState, appStateContainsVisibleChange] = this.appState.applyTo(
      appState,
      nextElements,
    );

    const appliedVisibleChanges =
      elementsContainVisibleChange || appStateContainsVisibleChange;

    return [nextElements, nextAppState, appliedVisibleChanges];
  }

  /**
   * Overriding once to avoid type casting everywhere.
   */
  public static override calculate(
    prevSnapshot: StoreSnapshot,
    nextSnapshot: StoreSnapshot,
  ) {
    return super.calculate(prevSnapshot, nextSnapshot) as HistoryDelta;
  }

  /**
   * Overriding once to avoid type casting everywhere.
   */
  public static override inverse(delta: StoreDelta): HistoryDelta {
    return super.inverse(delta) as HistoryDelta;
  }

  /**
   * Overriding once to avoid type casting everywhere.
   */
  public static override applyLatestChanges(
    delta: StoreDelta,
    prevElements: SceneElementsMap,
    nextElements: SceneElementsMap,
    modifierOptions?: "deleted" | "inserted",
  ) {
    return super.applyLatestChanges(
      delta,
      prevElements,
      nextElements,
      modifierOptions,
    ) as HistoryDelta;
  }
}

export class HistoryChangedEvent {
  constructor(
    public readonly isUndoStackEmpty: boolean = true,
    public readonly isRedoStackEmpty: boolean = true,
  ) {}
}

export class History {
  public readonly onHistoryChangedEmitter = new Emitter<
    [HistoryChangedEvent]
  >();

  public readonly undoStack: HistoryDelta[] = [];
  public readonly redoStack: HistoryDelta[] = [];

  public get isUndoStackEmpty() {
    return this.undoStack.length === 0;
  }

  public get isRedoStackEmpty() {
    return this.redoStack.length === 0;
  }

  constructor(private readonly store: Store) {}

  public clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }

  /**
   * Record a non-empty local durable increment, which will go into the undo stack..
   * Do not re-record history entries, which were already pushed to undo / redo stack, as part of history action.
   */
  public record(delta: StoreDelta) {
    // 空 delta 不入栈；HistoryDelta 说明这是历史回放产生的增量，
    // 已经由 perform 手动 push 到另一侧栈，绝不能重复记录。
    if (delta.isEmpty() || delta instanceof HistoryDelta) {
      return;
    }

    // construct history entry, so once it's emitted, it's not recorded again
    const historyDelta = HistoryDelta.inverse(delta);

    this.undoStack.push(historyDelta);

    if (!historyDelta.elements.isEmpty()) {
      // 只有“元素真的变了”才清空 redo。
      // 纯 AppState 变化（比如点空白取消选中）如果也清空，用户会莫名其妙
      // 丢失整条 redo 链——这是被刻意区分开的边界。
      // don't reset redo stack on local appState changes,
      // as a simple click (unselect) could lead to losing all the redo entries
      // only reset on non empty elements changes!
      this.redoStack.length = 0;
    }

    this.onHistoryChangedEmitter.trigger(
      new HistoryChangedEvent(this.isUndoStackEmpty, this.isRedoStackEmpty),
    );
  }

  public undo(
    elements: SceneElementsMap,
    appState: AppState,
    /** measures the labels re-laid out after undoing (the host's, in the editor) */
    renderEnvironment?: RenderEnvironment,
  ) {
    return this.perform(
      elements,
      appState,
      () => History.pop(this.undoStack),
      (entry: HistoryDelta) => History.push(this.redoStack, entry),
      renderEnvironment,
    );
  }

  public redo(
    elements: SceneElementsMap,
    appState: AppState,
    /** measures the labels re-laid out after redoing (the host's, in the editor) */
    renderEnvironment?: RenderEnvironment,
  ) {
    return this.perform(
      elements,
      appState,
      () => History.pop(this.redoStack),
      (entry: HistoryDelta) => History.push(this.undoStack, entry),
      renderEnvironment,
    );
  }

  /**
   * undo / redo 的共同实现。
   *
   * 循环的原因：栈顶的 delta 可能“应用了但看不见”（例如只改了被覆盖的
   * 内部字段）。此时继续 pop 下一条，直到出现可见变化或栈空。每应用一条：
   * 1. 用当前快照算出 nextSnapshot；
   * 2. 生成 StoreChange 并通过 scheduleMicroAction 立即排入 store，保证
   *    撤销本身会被同步广播（协同方也要看到撤销）；
   * 3. 把“剩余未应用的 delta”压回对侧栈，保证可重入。
   *
   * `finally` 里的 history 变更事件只触发一次，避免 UI 按钮状态抖动。
   */
  private perform(
    elements: SceneElementsMap,
    appState: AppState,
    pop: () => HistoryDelta | null,
    push: (entry: HistoryDelta) => void,
    renderEnvironment: RenderEnvironment | undefined,
  ): [SceneElementsMap, AppState] | void {
    try {
      let historyDelta = pop();

      if (historyDelta === null) {
        return;
      }

      const action = CaptureUpdateAction.IMMEDIATELY;

      let prevSnapshot = this.store.snapshot;

      let nextElements = elements;
      let nextAppState = appState;
      let containsVisibleChange = false;

      // iterate through the history entries in case they result in no visible changes
      while (historyDelta) {
        try {
          [nextElements, nextAppState, containsVisibleChange] =
            historyDelta.applyTo(
              nextElements,
              nextAppState,
              prevSnapshot,
              renderEnvironment,
            );

          const prevElements = prevSnapshot.elements;
          const nextSnapshot = prevSnapshot.maybeClone(
            action,
            nextElements,
            nextAppState,
          );

          const change = StoreChange.create(prevSnapshot, nextSnapshot);
          const delta = HistoryDelta.applyLatestChanges(
            historyDelta,
            prevElements,
            nextElements,
          );

          if (!delta.isEmpty()) {
            // schedule immediate capture, so that it's emitted for the sync purposes
            this.store.scheduleMicroAction({
              action,
              change,
              delta,
            });

            historyDelta = delta;
          }

          prevSnapshot = nextSnapshot;
        } finally {
          push(historyDelta);
        }

        if (containsVisibleChange) {
          break;
        }

        historyDelta = pop();
      }

      return [nextElements, nextAppState];
    } finally {
      // trigger the history change event before returning completely
      // also trigger it just once, no need doing so on each entry
      this.onHistoryChangedEmitter.trigger(
        new HistoryChangedEvent(this.isUndoStackEmpty, this.isRedoStackEmpty),
      );
    }
  }

  private static pop(stack: HistoryDelta[]): HistoryDelta | null {
    if (!stack.length) {
      return null;
    }

    const entry = stack.pop();

    if (entry !== undefined) {
      return entry;
    }

    return null;
  }

  private static push(stack: HistoryDelta[], entry: HistoryDelta) {
    const inversedEntry = HistoryDelta.inverse(entry);
    return stack.push(inversedEntry);
  }
}
