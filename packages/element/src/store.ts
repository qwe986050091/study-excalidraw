import {
  assertNever,
  COLOR_PALETTE,
  isDevEnv,
  isTestEnv,
  randomId,
  Emitter,
  toIterable,
} from "@excalidraw/common";

import type App from "@excalidraw/excalidraw/components/App";

import type { DTO, ValueOf } from "@excalidraw/common/utility-types";

import type { AppState, ObservedAppState } from "@excalidraw/excalidraw/types";

import { deepCopyElement } from "./duplicate";
import { newElementWith } from "./mutateElement";

import { ElementsDelta, AppStateDelta, Delta } from "./delta";

import {
  syncInvalidIndicesImmutable,
  hashElementsVersion,
  hashString,
  isInitializedImageElement,
  isImageElement,
} from "./index";

import type { ApplyToOptions } from "./delta";

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
  SceneElementsMap,
} from "./types";

/**
 * Store：把“当前场景状态”转成“可撤销的增量”的捕获系统。
 *
 * 它解决的是时序问题：一次用户操作会连续改元素、改 AppState，React 还会
 * 批量/异步提交。如果每改一个字段就记一条历史，撤销会碎成渣。Store 的做法：
 * - 每次 `commit` 时，把当前元素集合与 AppState 和上一次快照做 diff；
 * - diff 结果先包装成 `StoreChange`（引用级比较）和 `StoreDelta`（字段级
 *   added/removed/updated）；
 * - 只有 `IMMEDIATELY` 才发 `DurableIncrement` 并让 History 记录；
 *   `NEVER` / `EVENTUALLY` 只发 ephemeral increment。
 *
 * 三种 action 的区别就是“快照什么时候前进”：
 * - IMMEDIATELY：本次提交立即成为新基线，并进 undo 栈；
 * - NEVER：成为新基线但不进 undo 栈（远端更新、初始化）；
 * - EVENTUALLY：不进基线也不进 undo 栈，等下一次 IMMEDIATELY 一起结算。
 *
 * 读这一文件时先看 `commit`，再看 `processAction` 的 switch，最后看
 * `StoreSnapshot.maybeClone` / `detectChangedElements` 的 diff 口径。
 */
export const CaptureUpdateAction = {
  /**
   * Immediately undoable.
   *
   * Use for updates which should be captured.
   * Should be used for most of the local updates, except ephemerals such as dragging or resizing.
   *
   * These updates will _immediately_ make it to the local undo / redo stacks.
   */
  IMMEDIATELY: "IMMEDIATELY",
  /**
   * Never undoable.
   *
   * Use for updates which should never be recorded, such as remote updates
   * or scene initialization.
   *
   * These updates will _never_ make it to the local undo / redo stacks.
   */
  NEVER: "NEVER",
  /**
   * Eventually undoable.
   *
   * Use for updates which should not be captured immediately - likely
   * exceptions which are part of some async multi-step process. Otherwise, all
   * such updates would end up being captured with the next
   * `CaptureUpdateAction.IMMEDIATELY` - triggered either by the next `updateScene`
   * or internally by the editor.
   *
   * These updates will _eventually_ make it to the local undo / redo stacks.
   */
  EVENTUALLY: "EVENTUALLY",
} as const;

export type CaptureUpdateActionType = ValueOf<typeof CaptureUpdateAction>;

type MicroActionsQueue = (() => void)[];

/**
 * Store which captures the observed changes and emits them as `StoreIncrement` events.
 */
export class Store {
  // for internal use by history
  public readonly onDurableIncrementEmitter = new Emitter<[DurableIncrement]>();
  // for public use as part of onIncrement API
  public readonly onStoreIncrementEmitter = new Emitter<
    [DurableIncrement | EphemeralIncrement]
  >();

  private scheduledMacroActions: Set<CaptureUpdateActionType> = new Set();
  private scheduledMicroActions: MicroActionsQueue = [];

  private _snapshot = StoreSnapshot.empty();

  public get snapshot() {
    return this._snapshot;
  }

  public set snapshot(snapshot: StoreSnapshot) {
    this._snapshot = snapshot;
  }

  constructor(private readonly app: App) {}

  /**
   * 登记一个“宏动作”，在本次 commit 时统一结算。
   *
   * 同一个 commit 周期里允许多次登记，最终只会执行优先级最高的一个：
   * IMMEDIATELY > NEVER > EVENTUALLY（见 getScheduledMacroAction）。
   * 这就是“一次手势里的多次修改合并成一条历史”的实现点。
   */
  public scheduleAction(action: CaptureUpdateActionType) {
    this.scheduledMacroActions.add(action);
    this.satisfiesScheduledActionsInvariant();
  }

  /**
   * Use to schedule a delta calculation, which will consquentially be emitted as `DurableStoreIncrement` and pushed in the undo stack.
   */
  // TODO: Suspicious that this is called so many places. Seems error-prone.
  public scheduleCapture() {
    this.scheduleAction(CaptureUpdateAction.IMMEDIATELY);
  }

  /**
   * Schedule special "micro" actions, to-be executed before the next commit, before it executes a scheduled "macro" action.
   */
  public scheduleMicroAction(
    params:
      | {
          action: CaptureUpdateActionType;
          elements: readonly ExcalidrawElement[] | undefined;
          appState: AppState | ObservedAppState | undefined;
        }
      | {
          action: typeof CaptureUpdateAction.IMMEDIATELY;
          change: StoreChange;
          delta: StoreDelta;
        }
      | {
          action:
            | typeof CaptureUpdateAction.NEVER
            | typeof CaptureUpdateAction.EVENTUALLY;
          change: StoreChange;
        },
  ) {
    const { action } = params;

    let change: StoreChange;

    if ("change" in params) {
      change = params.change;
    } else {
      // immediately create an immutable change of the scheduled updates,
      // compared to the current state, so that they won't mutate later on during batching
      // also, we have to compare against the current state,
      // as comparing against the snapshot might include yet uncomitted changes (i.e. async freedraw / text / image, etc.)
      const currentSnapshot = StoreSnapshot.create(
        this.app.scene.getElementsMapIncludingDeleted(),
        this.app.state,
      );

      const scheduledSnapshot = currentSnapshot.maybeClone(
        action,
        // let's sync invalid indices first, so that we could detect this change
        // also have the synced elements immutable, so that we don't mutate elements,
        // that are already in the scene, otherwise we wouldn't see any change
        params.elements
          ? syncInvalidIndicesImmutable(params.elements)
          : undefined,
        params.appState,
      );

      change = StoreChange.create(currentSnapshot, scheduledSnapshot);
    }

    const delta = "delta" in params ? params.delta : undefined;

    this.scheduledMicroActions.push(() =>
      this.processAction({
        action,
        change,
        delta,
      }),
    );
  }

  /**
   * 每次 React 提交后由 App.componentDidUpdate 调用。
   *
   * 顺序不能反：先 flush 所有 micro action（历史回放会用它们携带现成的
   * change/delta），再执行唯一的 macro action。micro action 里如果已经带
   * `delta`，就跳过重复计算——这正是“撤销不要把刚撤销的 delta 再记一遍”
   * 的防线（History.record 会拒绝 HistoryDelta 实例）。
   */
  public commit(
    elements: SceneElementsMap | undefined,
    appState: AppState | ObservedAppState | undefined,
  ): void {
    // execute all scheduled micro actions first
    // similar to microTasks, there can be many
    this.flushMicroActions();

    try {
      // execute a single scheduled "macro" function
      // similar to macro tasks, there can be only one within a single commit (loop)
      const action = this.getScheduledMacroAction();
      this.processAction({ action, elements, appState });
    } finally {
      this.satisfiesScheduledActionsInvariant();
      // defensively reset all scheduled "macro" actions, possibly cleans up other runtime garbage
      this.scheduledMacroActions = new Set();
    }
  }

  /**
   * Clears the store instance.
   */
  public clear(): void {
    this.snapshot = StoreSnapshot.empty();
    this.scheduledMacroActions = new Set();
  }

  /**
   * Performs delta & change calculation and emits a durable increment.
   *
   * @emits StoreIncrement.
   */
  private emitDurableIncrement(
    snapshot: StoreSnapshot,
    change: StoreChange | undefined = undefined,
    delta: StoreDelta | undefined = undefined,
  ) {
    const prevSnapshot = this.snapshot;

    let storeChange: StoreChange;
    let storeDelta: StoreDelta;

    if (change) {
      storeChange = change;
    } else {
      storeChange = StoreChange.create(prevSnapshot, snapshot);
    }

    if (delta) {
      // we might have the delta already (i.e. when applying history entry), thus we don't need to calculate it again
      // using the same instance, since in history we have a check against `HistoryEntry`, so that we don't re-record the same delta again
      storeDelta = delta;
    } else {
      storeDelta = StoreDelta.calculate(prevSnapshot, snapshot);
    }

    if (!storeDelta.isEmpty()) {
      const increment = new DurableIncrement(storeChange, storeDelta);

      this.onDurableIncrementEmitter.trigger(increment);
      this.onStoreIncrementEmitter.trigger(increment);
    }
  }

  /**
   * Performs change calculation and emits an ephemeral increment.
   *
   * @emits EphemeralStoreIncrement
   */
  private emitEphemeralIncrement(
    snapshot: StoreSnapshot,
    change: StoreChange | undefined = undefined,
  ) {
    let storeChange: StoreChange;

    if (change) {
      storeChange = change;
    } else {
      const prevSnapshot = this.snapshot;
      storeChange = StoreChange.create(prevSnapshot, snapshot);
    }

    const increment = new EphemeralIncrement(storeChange);

    // Notify listeners with the increment
    this.onStoreIncrementEmitter.trigger(increment);
  }

  private applyChangeToSnapshot(change: StoreChange) {
    const prevSnapshot = this.snapshot;
    const nextSnapshot = this.snapshot.applyChange(change);

    if (prevSnapshot === nextSnapshot) {
      return null;
    }

    return nextSnapshot;
  }

  /**
   * Clones the snapshot if there are changes detected.
   */
  private maybeCloneSnapshot(
    action: CaptureUpdateActionType,
    elements: SceneElementsMap | undefined,
    appState: AppState | ObservedAppState | undefined,
  ) {
    if (!elements && !appState) {
      return null;
    }

    const prevSnapshot = this.snapshot;
    const nextSnapshot = this.snapshot.maybeClone(action, elements, appState);

    if (prevSnapshot === nextSnapshot) {
      return null;
    }

    return nextSnapshot;
  }

  private flushMicroActions() {
    for (const microAction of this.scheduledMicroActions) {
      try {
        microAction();
      } catch (error) {
        console.error(`Failed to execute scheduled micro action`, error);
      }
    }

    this.scheduledMicroActions = [];
  }

  /**
   * 一次提交的最终分派点。
   *
   * 关键点：
   * - `EVENTUALLY` 且没有订阅者时直接返回：不 clone 快照，省掉整棵元素
   *   集合的深拷贝（热路径优化，不是语义差异）；
   * - `maybeCloneSnapshot` 返回同一实例表示“没检测到变化”，直接退出，
   *   因此空操作不会产生空历史；
   * - `finally` 里更新快照：IMMEDIATELY / NEVER 前进基线，EVENTUALLY 不
   *   前进（留到下一次真正 capture 时一起算）。
   */
  private processAction(
    params:
      | {
          action: CaptureUpdateActionType;
          elements: SceneElementsMap | undefined;
          appState: AppState | ObservedAppState | undefined;
        }
      | {
          action: CaptureUpdateActionType;
          change: StoreChange;
          delta: StoreDelta | undefined;
        },
  ) {
    const { action } = params;

    // perf. optimisation, since "EVENTUALLY" does not update the snapshot,
    // so if nobody is listening for increments, we don't need to even clone the snapshot
    // as it's only needed for `StoreChange` computation inside `EphemeralIncrement`
    if (
      action === CaptureUpdateAction.EVENTUALLY &&
      !this.onStoreIncrementEmitter.subscribers.length
    ) {
      return;
    }

    let nextSnapshot: StoreSnapshot | null;

    if ("change" in params) {
      nextSnapshot = this.applyChangeToSnapshot(params.change);
    } else {
      nextSnapshot = this.maybeCloneSnapshot(
        action,
        params.elements,
        params.appState,
      );
    }

    if (!nextSnapshot) {
      // don't continue if there is not change detected
      return;
    }

    const change = "change" in params ? params.change : undefined;
    const delta = "delta" in params ? params.delta : undefined;

    try {
      switch (action) {
        // only immediately emits a durable increment
        case CaptureUpdateAction.IMMEDIATELY:
          this.emitDurableIncrement(nextSnapshot, change, delta);
          break;
        // both never and eventually emit an ephemeral increment
        case CaptureUpdateAction.NEVER:
        case CaptureUpdateAction.EVENTUALLY:
          this.emitEphemeralIncrement(nextSnapshot, change);
          break;
        default:
          assertNever(action, `Unknown store action`);
      }
    } finally {
      // update the snapshot no-matter what, as it would mess up with the next action
      switch (action) {
        // both immediately and never update the snapshot, unlike eventually
        case CaptureUpdateAction.IMMEDIATELY:
        case CaptureUpdateAction.NEVER:
          this.snapshot = nextSnapshot;
          break;
      }
    }
  }

  /**
   * Returns the scheduled macro action.
   */
  private getScheduledMacroAction() {
    let scheduledAction: CaptureUpdateActionType;

    if (this.scheduledMacroActions.has(CaptureUpdateAction.IMMEDIATELY)) {
      // Capture has a precedence over update, since it also performs snapshot update
      scheduledAction = CaptureUpdateAction.IMMEDIATELY;
    } else if (this.scheduledMacroActions.has(CaptureUpdateAction.NEVER)) {
      // Update has a precedence over none, since it also emits an (ephemeral) increment
      scheduledAction = CaptureUpdateAction.NEVER;
    } else {
      // Default is to emit ephemeral increment and don't update the snapshot
      scheduledAction = CaptureUpdateAction.EVENTUALLY;
    }

    return scheduledAction;
  }

  /**
   * Ensures that the scheduled actions invariant is satisfied.
   */
  private satisfiesScheduledActionsInvariant() {
    if (
      !(
        this.scheduledMacroActions.size >= 0 &&
        this.scheduledMacroActions.size <=
          Object.keys(CaptureUpdateAction).length
      )
    ) {
      const message = `There can be at most three store actions scheduled at the same time, but there are "${this.scheduledMacroActions.size}".`;
      console.error(message, this.scheduledMacroActions.values());

      if (isTestEnv() || isDevEnv()) {
        throw new Error(message);
      }
    }
  }
}

/**
 * Repsents a change to the store containing changed elements and appState.
 */
export class StoreChange {
  // so figuring out what has changed should ideally be just quick reference checks
  // TODO: we might need to have binary files here as well, in order to be drop-in replacement for `onChange`
  private constructor(
    public readonly elements: Record<string, OrderedExcalidrawElement>,
    public readonly appState: Partial<ObservedAppState>,
  ) {}

  public static create(
    prevSnapshot: StoreSnapshot,
    nextSnapshot: StoreSnapshot,
  ) {
    const changedElements = nextSnapshot.getChangedElements(prevSnapshot);
    const changedAppState = nextSnapshot.getChangedAppState(prevSnapshot);

    return new StoreChange(changedElements, changedAppState);
  }
}

/**
 * Encpasulates any change to the store (durable or ephemeral).
 */
export abstract class StoreIncrement {
  protected constructor(
    public readonly type: "durable" | "ephemeral",
    public readonly change: StoreChange,
  ) {}

  public static isDurable(
    increment: StoreIncrement,
  ): increment is DurableIncrement {
    return increment.type === "durable";
  }

  public static isEphemeral(
    increment: StoreIncrement,
  ): increment is EphemeralIncrement {
    return increment.type === "ephemeral";
  }
}

/**
 * Represents a durable change to the store.
 */
export class DurableIncrement extends StoreIncrement {
  constructor(
    public readonly change: StoreChange,
    public readonly delta: StoreDelta,
  ) {
    super("durable", change);
  }
}

/**
 * Represents an ephemeral change to the store.
 */
export class EphemeralIncrement extends StoreIncrement {
  constructor(public readonly change: StoreChange) {
    super("ephemeral", change);
  }
}

/**
 * Represents a captured delta by the Store.
 */
export class StoreDelta {
  protected constructor(
    public readonly id: string,
    public readonly elements: ElementsDelta,
    public readonly appState: AppStateDelta,
  ) {}

  /**
   * Create a new instance of `StoreDelta`.
   */
  public static create(
    elements: ElementsDelta,
    appState: AppStateDelta,
    opts: {
      id: string;
    } = {
      id: randomId(),
    },
  ) {
    return new this(opts.id, elements, appState);
  }

  /**
   * Calculate the delta between the previous and next snapshot.
   */
  public static calculate(
    prevSnapshot: StoreSnapshot,
    nextSnapshot: StoreSnapshot,
  ) {
    const elementsDelta = nextSnapshot.metadata.didElementsChange
      ? ElementsDelta.calculate(prevSnapshot.elements, nextSnapshot.elements)
      : ElementsDelta.empty();

    const appStateDelta = nextSnapshot.metadata.didAppStateChange
      ? AppStateDelta.calculate(prevSnapshot.appState, nextSnapshot.appState)
      : AppStateDelta.empty();

    return this.create(elementsDelta, appStateDelta);
  }

  /**
   * Restore a store delta instance from a DTO.
   */
  public static restore(storeDeltaDTO: DTO<StoreDelta>) {
    const { id, elements, appState } = storeDeltaDTO;
    return new this(
      id,
      ElementsDelta.restore(elements),
      AppStateDelta.restore(appState),
    );
  }

  /**
   * Parse and load the delta from the remote payload.
   */
  public static load({
    id,
    elements: { added, removed, updated },
    appState: { delta: appStateDelta },
  }: DTO<StoreDelta>) {
    const elements = ElementsDelta.create(added, removed, updated);
    const appState = AppStateDelta.create(appStateDelta);

    return new this(id, elements, appState);
  }

  /**
   * Squash the passed deltas into the aggregated delta instance.
   */
  public static squash(...deltas: StoreDelta[]) {
    const aggregatedDelta = StoreDelta.empty();

    for (const delta of deltas) {
      aggregatedDelta.elements.squash(delta.elements);
      aggregatedDelta.appState.squash(delta.appState);
    }

    return aggregatedDelta;
  }

  /**
   * Inverse store delta, creates new instance of `StoreDelta`.
   */
  public static inverse(delta: StoreDelta) {
    return this.create(delta.elements.inverse(), delta.appState.inverse());
  }

  /**
   * Apply the delta to the passed elements and appState, does not modify the snapshot.
   */
  public static applyTo(
    delta: StoreDelta,
    elements: SceneElementsMap,
    appState: AppState,
    options?: ApplyToOptions,
  ): [SceneElementsMap, AppState, boolean] {
    const [nextElements, elementsContainVisibleChange] = delta.elements.applyTo(
      elements,
      StoreSnapshot.empty().elements,
      options,
    );

    const [nextAppState, appStateContainsVisibleChange] =
      delta.appState.applyTo(appState, nextElements);

    const appliedVisibleChanges =
      elementsContainVisibleChange || appStateContainsVisibleChange;

    return [nextElements, nextAppState, appliedVisibleChanges];
  }

  /**
   * Apply latest (remote) changes to the delta, creates new instance of `StoreDelta`.
   */
  public static applyLatestChanges(
    delta: StoreDelta,
    prevElements: SceneElementsMap,
    nextElements: SceneElementsMap,
    modifierOptions?: "deleted" | "inserted",
  ): StoreDelta {
    return this.create(
      delta.elements.applyLatestChanges(
        prevElements,
        nextElements,
        modifierOptions,
      ),
      delta.appState,
      {
        id: delta.id,
      },
    );
  }

  public static empty() {
    return StoreDelta.create(ElementsDelta.empty(), AppStateDelta.empty());
  }

  public isEmpty() {
    return this.elements.isEmpty() && this.appState.isEmpty();
  }
}

/**
 * Represents a snapshot of the captured or updated changes in the store,
 * used for producing deltas and emitting `DurableStoreIncrement`s.
 */
export class StoreSnapshot {
  private _lastChangedElementsHash: number = 0;
  private _lastChangedAppStateHash: number = 0;

  private constructor(
    public readonly elements: SceneElementsMap,
    public readonly appState: ObservedAppState,
    public readonly metadata: {
      didElementsChange: boolean;
      didAppStateChange: boolean;
      isEmpty?: boolean;
    } = {
      didElementsChange: false,
      didAppStateChange: false,
      isEmpty: false,
    },
  ) {}

  public static create(
    elements: SceneElementsMap,
    appState: AppState | ObservedAppState,
    metadata: {
      didElementsChange: boolean;
      didAppStateChange: boolean;
    } = {
      didElementsChange: false,
      didAppStateChange: false,
    },
  ) {
    return new StoreSnapshot(
      elements,
      isObservedAppState(appState) ? appState : getObservedAppState(appState),
      metadata,
    );
  }

  public static empty() {
    return new StoreSnapshot(
      new Map() as SceneElementsMap,
      getDefaultObservedAppState(),
      {
        didElementsChange: false,
        didAppStateChange: false,
        isEmpty: true,
      },
    );
  }

  public getChangedElements(prevSnapshot: StoreSnapshot) {
    const changedElements: Record<string, OrderedExcalidrawElement> = {};

    for (const prevElement of toIterable(prevSnapshot.elements)) {
      const nextElement = this.elements.get(prevElement.id);

      if (!nextElement) {
        changedElements[prevElement.id] = newElementWith(prevElement, {
          isDeleted: true,
        });
      }
    }

    for (const nextElement of toIterable(this.elements)) {
      // Due to the structural clone inside `maybeClone`, we can perform just these reference checks
      if (prevSnapshot.elements.get(nextElement.id) !== nextElement) {
        changedElements[nextElement.id] = nextElement;
      }
    }

    return changedElements;
  }

  public getChangedAppState(
    prevSnapshot: StoreSnapshot,
  ): Partial<ObservedAppState> {
    return Delta.getRightDifferences(
      prevSnapshot.appState,
      this.appState,
    ).reduce(
      (acc, key) =>
        Object.assign(acc, {
          [key]: this.appState[key as keyof ObservedAppState],
        }),
      {} as Partial<ObservedAppState>,
    );
  }

  public isEmpty() {
    return this.metadata.isEmpty;
  }

  /**
   * Apply the change and return a new snapshot instance.
   */
  public applyChange(change: StoreChange): StoreSnapshot {
    const nextElements = new Map(this.elements) as SceneElementsMap;

    for (const [id, changedElement] of Object.entries(change.elements)) {
      nextElements.set(id, changedElement);
    }

    const nextAppState = getObservedAppState({
      ...this.appState,
      ...change.appState,
    });

    return StoreSnapshot.create(nextElements, nextAppState, {
      // by default we assume that change is different from what we have in the snapshot
      // so that we trigger the delta calculation and if it isn't different, delta will be empty
      didElementsChange: Object.keys(change.elements).length > 0,
      didAppStateChange: Object.keys(change.appState).length > 0,
    });
  }

  /**
   * Efficiently clone the existing snapshot, only if we detected changes.
   *
   * @returns same instance if there are no changes detected, new instance otherwise.
   */
  public maybeClone(
    action: CaptureUpdateActionType,
    elements: SceneElementsMap | undefined,
    appState: AppState | ObservedAppState | undefined,
  ) {
    const options = {
      shouldCompareHashes: false,
    };

    if (action === CaptureUpdateAction.EVENTUALLY) {
      // actions that do not update the snapshot immediately, must be additionally checked for changes against the latest hash
      // as we are always comparing against the latest snapshot, so they would emit elements or appState as changed on every component update
      // instead of just the first time the elements or appState actually changed
      options.shouldCompareHashes = true;
    }

    const nextElementsSnapshot = this.maybeCreateElementsSnapshot(
      elements,
      options,
    );
    const nextAppStateSnapshot = this.maybeCreateAppStateSnapshot(
      appState,
      options,
    );

    let didElementsChange = false;
    let didAppStateChange = false;

    if (this.elements !== nextElementsSnapshot) {
      didElementsChange = true;
    }

    if (this.appState !== nextAppStateSnapshot) {
      didAppStateChange = true;
    }

    if (!didElementsChange && !didAppStateChange) {
      return this;
    }

    const snapshot = new StoreSnapshot(
      nextElementsSnapshot,
      nextAppStateSnapshot,
      {
        didElementsChange,
        didAppStateChange,
      },
    );

    return snapshot;
  }

  private maybeCreateAppStateSnapshot(
    appState: AppState | ObservedAppState | undefined,
    options: {
      shouldCompareHashes: boolean;
    } = {
      shouldCompareHashes: false,
    },
  ): ObservedAppState {
    if (!appState) {
      return this.appState;
    }

    // Not watching over everything from the app state, just the relevant props
    const nextAppStateSnapshot = !isObservedAppState(appState)
      ? getObservedAppState(appState)
      : appState;

    const didAppStateChange = this.detectChangedAppState(
      nextAppStateSnapshot,
      options,
    );

    if (!didAppStateChange) {
      return this.appState;
    }

    return nextAppStateSnapshot;
  }

  private maybeCreateElementsSnapshot(
    elements: SceneElementsMap | undefined,
    options: {
      shouldCompareHashes: boolean;
    } = {
      shouldCompareHashes: false,
    },
  ): SceneElementsMap {
    if (!elements) {
      return this.elements;
    }

    const changedElements = this.detectChangedElements(elements, options);

    if (!changedElements?.size) {
      return this.elements;
    }

    const elementsSnapshot = this.createElementsSnapshot(changedElements);
    return elementsSnapshot;
  }

  private detectChangedAppState(
    nextObservedAppState: ObservedAppState,
    options: {
      shouldCompareHashes: boolean;
    } = {
      shouldCompareHashes: false,
    },
  ): boolean | undefined {
    if (this.appState === nextObservedAppState) {
      return;
    }

    const didAppStateChange = Delta.isRightDifferent(
      this.appState,
      nextObservedAppState,
    );

    if (!didAppStateChange) {
      return;
    }

    const changedAppStateHash = hashString(
      JSON.stringify(nextObservedAppState),
    );

    if (
      options.shouldCompareHashes &&
      this._lastChangedAppStateHash === changedAppStateHash
    ) {
      return;
    }

    this._lastChangedAppStateHash = changedAppStateHash;

    return didAppStateChange;
  }

  /**
   * 元素变化检测——Store 的 diff 口径。
   *
   * 两轮扫描：
   * 1. 旧快照里有、新集合里没有 → 视为删除，用 newElementWith 生成
   *    `isDeleted: true` 的墓碑并 bump version；
   * 2. 新集合里引用不同、或 version 更大 → 视为新增/更新。
   *    未初始化的图片元素被跳过：它们的 status/fileId 还在异步补齐，
   *    此时记历史会得到半成品。
   *
   * 只做引用比较和 version 比较，不做深比较；能这么做的前提是
   * `maybeClone` 已经对变化元素做了深拷贝，后续就地 mutate 不会改到快照。
   */
  private detectChangedElements(
    nextElements: SceneElementsMap,
    options: {
      shouldCompareHashes: boolean;
    } = {
      shouldCompareHashes: false,
    },
  ): SceneElementsMap | undefined {
    if (this.elements === nextElements) {
      return;
    }

    const changedElements: SceneElementsMap = new Map() as SceneElementsMap;

    for (const prevElement of toIterable(this.elements)) {
      const nextElement = nextElements.get(prevElement.id);

      if (!nextElement) {
        // element was deleted
        changedElements.set(
          prevElement.id,
          newElementWith(prevElement, { isDeleted: true }),
        );
      }
    }

    for (const nextElement of toIterable(nextElements)) {
      const prevElement = this.elements.get(nextElement.id);

      if (
        !prevElement || // element was added
        prevElement.version < nextElement.version // element was updated
      ) {
        if (
          isImageElement(nextElement) &&
          !isInitializedImageElement(nextElement)
        ) {
          // ignore any updates on uninitialized image elements
          continue;
        }

        changedElements.set(nextElement.id, nextElement);
      }
    }

    if (!changedElements.size) {
      return;
    }

    const changedElementsHash = hashElementsVersion(changedElements);

    if (
      options.shouldCompareHashes &&
      this._lastChangedElementsHash === changedElementsHash
    ) {
      return;
    }

    this._lastChangedElementsHash = changedElementsHash;

    return changedElements;
  }

  /**
   * 只深拷贝“变化的元素”，未变化元素继续共享引用。
   *
   * 这是整个捕获系统能跑在 60fps 交互上的原因：一次拖拽只改 1~N 个元素，
   * 快照里其余几千个元素仍是同一批对象。被拷贝的元素之后即使被就地
   * mutate，也只会影响新的工作副本，不会污染历史快照。
   */
  private createElementsSnapshot(changedElements: SceneElementsMap) {
    const clonedElements = new Map() as SceneElementsMap;

    for (const prevElement of toIterable(this.elements)) {
      // Clone previous elements, never delete, in case nextElements would be just a subset of previous elements
      // i.e. during collab, persist or whenenever isDeleted elements get cleared
      clonedElements.set(prevElement.id, prevElement);
    }

    for (const changedElement of toIterable(changedElements)) {
      // TODO: consider just creating new instance, once we can ensure that all reference properties on every element are immutable
      // TODO: consider creating a lazy deep clone, having a one-time-usage proxy over the snapshotted element and deep cloning only if it gets mutated
      clonedElements.set(changedElement.id, deepCopyElement(changedElement));
    }

    return clonedElements;
  }
}

// hidden non-enumerable property for runtime checks
const hiddenObservedAppStateProp = "__observedAppState";

const getDefaultObservedAppState = (): ObservedAppState => {
  return {
    name: null,
    editingGroupId: null,
    viewBackgroundColor: COLOR_PALETTE.white,
    selectedElementIds: {},
    selectedGroupIds: {},
    selectedLinearElement: null,
    croppingElementId: null,
    activeLockedId: null,
    lockedMultiSelections: {},
  };
};

export const getObservedAppState = (
  appState: AppState | ObservedAppState,
): ObservedAppState => {
  const observedAppState = {
    name: appState.name,
    editingGroupId: appState.editingGroupId,
    viewBackgroundColor: appState.viewBackgroundColor,
    selectedElementIds: appState.selectedElementIds,
    selectedGroupIds: appState.selectedGroupIds,
    croppingElementId: appState.croppingElementId,
    activeLockedId: appState.activeLockedId,
    lockedMultiSelections: appState.lockedMultiSelections,
    selectedLinearElement: appState.selectedLinearElement
      ? {
          elementId: appState.selectedLinearElement.elementId,
          isEditing: !!appState.selectedLinearElement.isEditing,
        }
      : null,
  };

  Reflect.defineProperty(observedAppState, hiddenObservedAppStateProp, {
    value: true,
    enumerable: false,
  });

  return observedAppState;
};

const isObservedAppState = (
  appState: AppState | ObservedAppState,
): appState is ObservedAppState =>
  !!Reflect.get(appState, hiddenObservedAppStateProp);
