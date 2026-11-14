/**
 * 本文件是“不可变更新”链路的核心：元素/应用状态的一切变更都被压缩成
 * 字段级增量（Delta），而不是保存整份快照。
 *
 * 位置关系：
 * - store.ts 在提交时用 `ElementsDelta.calculate` 比较前后两份快照，生成
 *   增量并压进 History；
 * - history.ts 撤销/重做时调用 `applyTo` 把增量正/反向应用到当前快照；
 * - 协作场景复用同一套增量结构做合并与冲突解决。
 *
 * 三条不变量贯穿全文件，改动时必须同时满足：
 * 1. 增量只描述“哪些字段变了”，不持有对象引用；
 * 2. applyTo 永不修改入参集合（先复制到 nextElements 再写）；
 * 3. deleted/inserted 是同一组字段的正反两向值，缺一不可，否则无法回滚。
 */
import {
  arrayToMap,
  arrayToObject,
  assertNever,
  isDevEnv,
  isShallowEqual,
  isTestEnv,
  randomInteger,
} from "@excalidraw/common";

import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
  ExcalidrawLinearElement,
  ExcalidrawTextElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
  Ordered,
  OrderedExcalidrawElement,
  SceneElementsMap,
} from "@excalidraw/element/types";

import type {
  DTO,
  Mutable,
  SubtypeOf,
  ValueOf,
} from "@excalidraw/common/utility-types";

import type {
  AppState,
  ObservedAppState,
  ObservedElementsAppState,
  ObservedStandaloneAppState,
} from "@excalidraw/excalidraw/types";

import { getObservedAppState } from "./store";

import {
  BoundElement,
  BindableElement,
  bindingProperties,
  updateBoundElements,
} from "./binding";
import { LinearElementEditor } from "./linearElementEditor";
import { mutateElement, newElementWith } from "./mutateElement";
import { getBoundTextElementId, redrawTextBoundingBox } from "./textElement";
import {
  hasBoundTextElement,
  isArrowElement,
  isBindableElement,
  isBoundToContainer,
  isTextElement,
} from "./typeChecks";

import { getNonDeletedGroupIds } from "./groups";

import { orderByFractionalIndex, syncMovedIndices } from "./fractionalIndex";

import { StoreSnapshot } from "./store";

import { Scene } from "./Scene";

import type { BindableProp, BindingProp } from "./binding";

import type { ElementUpdate } from "./mutateElement";
import type { RenderEnvironment } from "./renderEnvironment";

/**
 * Represents the difference between two objects of the same type.
 *
 * Both `deleted` and `inserted` partials represent the same set of added, removed or updated properties, where:
 * - `deleted` is a set of all the deleted values
 * - `inserted` is a set of all the inserted (added, updated) values
 *
 * Keeping it as pure object (without transient state, side-effects, etc.), so we won't have to instantiate it on load.
 *
 * 中文：对象级增量的最小单位。`deleted`/`inserted` 的 key 集合总是相同的
 * （postProcess 会维护这一点），只是取值分别来自“前”和“后”。构造函数私有，
 * 只能通过 create/calculate/empty 进入，保证每个实例形态一致、可安全序列化
 * （DTO 直接就是这两个部分对象）。
 */
export class Delta<T> {
  private constructor(
    public readonly deleted: Partial<T>,
    public readonly inserted: Partial<T>,
  ) {}

  /**
   * 构造增量，可选对 deleted/inserted 各做一次转换。
   *
   * @param modifier 对部分对象做变换（如 stripIrrelevantProps 剔除 id/updated）
   * @param modifierOptions 指定只作用于哪一侧；默认两侧都作用
   * @returns 新的 Delta，不修改入参
   */
  public static create<T>(
    deleted: Partial<T>,
    inserted: Partial<T>,
    modifier?: (
      delta: Partial<T>,
      partialType: "deleted" | "inserted",
    ) => Partial<T>,
    modifierOptions?: "deleted" | "inserted" | "both",
  ) {
    const modifiedDeleted =
      modifier && modifierOptions !== "inserted"
        ? modifier(deleted, "deleted")
        : deleted;
    const modifiedInserted =
      modifier && modifierOptions !== "deleted"
        ? modifier(inserted, "inserted")
        : inserted;

    return new Delta(modifiedDeleted, modifiedInserted);
  }

  /**
   * Calculates the delta between two objects.
   *
   * @param prevObject - The previous state of the object.
   * @param nextObject - The next state of the object.
   *
   * @returns new delta instance.
   *
   * 中文：先用引用相等快速短路（同一对象必然无差异）；否则对 key 做浅层
   * 比较。`postProcess` 用于修正引用类型字段（数组/Map）的差量——普通比较
   * 只能发现引用变了，无法给出“增删了哪些条目”。
   */
  public static calculate<T extends { [key: string]: any }>(
    prevObject: T,
    nextObject: T,
    modifier?: (partial: Partial<T>) => Partial<T>,
    postProcess?: (
      deleted: Partial<T>,
      inserted: Partial<T>,
    ) => [Partial<T>, Partial<T>],
  ): Delta<T> {
    if (prevObject === nextObject) {
      return Delta.empty();
    }

    const deleted = {} as Partial<T>;
    const inserted = {} as Partial<T>;

    // O(n^3) here for elements, but it's not as bad as it looks:
    // - we do this only on store recordings, not on every frame (not for ephemerals)
    // - we do this only on previously detected changed elements
    // - we do shallow compare only on the first level of properties (not going any deeper)
    // - # of properties is reasonably small
    for (const key of this.getDifferences(prevObject, nextObject)) {
      deleted[key as keyof T] = prevObject[key];
      inserted[key as keyof T] = nextObject[key];
    }

    const [processedDeleted, processedInserted] = postProcess
      ? postProcess(deleted, inserted)
      : [deleted, inserted];

    return Delta.create(processedDeleted, processedInserted, modifier);
  }

  /**
   * 空增量（两侧都没有 key）。所有“无变化”分支都返回它，避免到处 new。
   */
  public static empty() {
    return new Delta({}, {});
  }

  /**
   * 两侧都没有 key 即视为空。只看 deleted 是否为空不够：某些中间态可能
   * 只有 inserted（如新建时 deleted 被 strip 掉），因此必须两侧都检查。
   */
  public static isEmpty<T>(delta: Delta<T>): boolean {
    return (
      !Object.keys(delta.deleted).length && !Object.keys(delta.inserted).length
    );
  }

  /**
   * Merges two deltas into a new one.
   *
   * 中文：同名 key 后者覆盖前者（squash 语义：时间上更晚的值胜出）。
   * 第三个参数让调用方额外合并一份“派生增量”（如 boundElements 的
   * 数组差量），避免调用方再手动 create 一次。
   */
  public static merge<T>(
    delta1: Delta<T>,
    delta2: Delta<T>,
    delta3: Delta<T> = Delta.empty(),
  ) {
    return Delta.create(
      { ...delta1.deleted, ...delta2.deleted, ...delta3.deleted },
      { ...delta1.inserted, ...delta2.inserted, ...delta3.inserted },
    );
  }

  /**
   * Merges deleted and inserted object partials.
   *
   * 中文：先浅拷贝 prev，按 removed 删 key，再按 added 覆盖。
   * 顺序不能反：先删后加才能让“删掉的 key 又在 added 里出现”时保留新值；
   * 先加后删会把刚写进去的值删掉。
   */
  public static mergeObjects<T extends { [key: string]: unknown }>(
    prev: T,
    added: T,
    removed: T = {} as T,
  ) {
    const cloned = { ...prev };

    for (const key of Object.keys(removed)) {
      delete cloned[key];
    }

    return { ...cloned, ...added };
  }

  /**
   * Merges deleted and inserted array partials.
   *
   * 中文：数组按 predicate 提取的身份（默认是元素自身）转成对象再做 key 合并，
   * 最后转回数组。只做集合层面增删，不保证顺序——需要顺序的地方不能用它
   * （例如 points）。
   */
  public static mergeArrays<T>(
    prev: readonly T[] | null,
    added: readonly T[] | null | undefined,
    removed: readonly T[] | null | undefined,
    predicate?: (value: T) => string,
  ) {
    return Object.values(
      Delta.mergeObjects(
        arrayToObject(prev ?? [], predicate),
        arrayToObject(added ?? [], predicate),
        arrayToObject(removed ?? [], predicate),
      ),
    );
  }

  /**
   * Diff object partials as part of the `postProcess`.
   *
   * 中文：把“对象引用变了”细化成“对象里哪些 key 增/删了”。
   * 处理三种情况：两侧都是对象（逐 key 求差）、两侧值相同（直接移除该
   * property）、其余保持原样。差量为空时也要删掉 property，否则会留下
   * “有 key 但无实际差异”的伪变更，导致 undo 栈多出空条目。
   */
  public static diffObjects<T, K extends keyof T, V extends ValueOf<T[K]>>(
    deleted: Partial<T>,
    inserted: Partial<T>,
    property: K,
    setValue: (prevValue: V | undefined) => V,
  ) {
    if (!deleted[property] && !inserted[property]) {
      return;
    }

    const isDeletedObject =
      deleted[property] !== null && typeof deleted[property] === "object";
    const isInsertedObject =
      inserted[property] !== null && typeof inserted[property] === "object";

    if (isDeletedObject || isInsertedObject) {
      type RecordLike = Record<string, V | undefined>;

      const deletedObject: RecordLike = deleted[property] ?? {};
      const insertedObject: RecordLike = inserted[property] ?? {};

      const deletedDifferences = Delta.getLeftDifferences(
        deletedObject,
        insertedObject,
      ).reduce((acc, curr) => {
        acc[curr] = setValue(deletedObject[curr]);
        return acc;
      }, {} as RecordLike);

      const insertedDifferences = Delta.getRightDifferences(
        deletedObject,
        insertedObject,
      ).reduce((acc, curr) => {
        acc[curr] = setValue(insertedObject[curr]);
        return acc;
      }, {} as RecordLike);

      if (
        Object.keys(deletedDifferences).length ||
        Object.keys(insertedDifferences).length
      ) {
        Reflect.set(deleted, property, deletedDifferences);
        Reflect.set(inserted, property, insertedDifferences);
      } else {
        Reflect.deleteProperty(deleted, property);
        Reflect.deleteProperty(inserted, property);
      }
    } else if (deleted[property] === inserted[property]) {
      Reflect.deleteProperty(deleted, property);
      Reflect.deleteProperty(inserted, property);
    }
  }

  /**
   * Diff array partials as part of the `postProcess`.
   *
   * 中文：与 diffObjects 同构，但先用 groupBy 把数组元素映射成对象 key，
   * 求差后再过滤回原始数组，从而保留元素本身（不是只保留 id）。
   * boundElements 就是靠这个把“整个数组换引用”变成“增删了哪几个绑定”。
   */
  public static diffArrays<T, K extends keyof T, V extends T[K]>(
    deleted: Partial<T>,
    inserted: Partial<T>,
    property: K,
    groupBy: (value: V extends ArrayLike<infer T> ? T : never) => string,
  ) {
    if (!deleted[property] && !inserted[property]) {
      return;
    }

    if (Array.isArray(deleted[property]) || Array.isArray(inserted[property])) {
      const deletedArray = (
        Array.isArray(deleted[property]) ? deleted[property] : []
      ) as [];
      const insertedArray = (
        Array.isArray(inserted[property]) ? inserted[property] : []
      ) as [];

      const deletedDifferences = arrayToObject(
        Delta.getLeftDifferences(
          arrayToObject(deletedArray, groupBy),
          arrayToObject(insertedArray, groupBy),
        ),
        (x) => x,
      );
      const insertedDifferences = arrayToObject(
        Delta.getRightDifferences(
          arrayToObject(deletedArray, groupBy),
          arrayToObject(insertedArray, groupBy),
        ),
        (x) => x,
      );

      if (
        Object.keys(deletedDifferences).length ||
        Object.keys(insertedDifferences).length
      ) {
        const deletedValue = deletedArray.filter(
          (x) => deletedDifferences[groupBy ? groupBy(x) : String(x)],
        );
        const insertedValue = insertedArray.filter(
          (x) => insertedDifferences[groupBy ? groupBy(x) : String(x)],
        );

        Reflect.set(deleted, property, deletedValue);
        Reflect.set(inserted, property, insertedValue);
      } else {
        Reflect.deleteProperty(deleted, property);
        Reflect.deleteProperty(inserted, property);
      }
    }
  }

  /**
   * Compares if object1 contains any different value compared to the object2.
   *
   * 中文：左连接语义——只检查 object1 自己的 key。object1 多出的 key
   * （object2 没有）也算差异；object2 独有的 key 不算。
   */
  public static isLeftDifferent<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ): boolean {
    const anyDistinctKey = this.distinctKeysIterator(
      "left",
      object1,
      object2,
      skipShallowCompare,
    ).next().value;

    return !!anyDistinctKey;
  }

  /**
   * Compares if object2 contains any different value compared to the object1.
   *
   * 中文：右连接语义，与 isLeftDifferent 镜像。AppStateDelta 判断“应用
   * 增量后是否有变化”时用它，因为关心的正是 inserted（新值）侧。
   */
  public static isRightDifferent<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ): boolean {
    const anyDistinctKey = this.distinctKeysIterator(
      "right",
      object1,
      object2,
      skipShallowCompare,
    ).next().value;

    return !!anyDistinctKey;
  }

  /**
   * Compares if shared properties of object1 and object2 contain any different value (aka inner join).
   *
   * 中文：只看两侧共有 key。applyLatestChanges 用它判断“回填之后增量是否
   * 还包含真实差异”——某一侧独有的 key 不应阻止增量被保留或丢弃。
   */
  public static isInnerDifferent<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ): boolean {
    const anyDistinctKey = !!this.distinctKeysIterator(
      "inner",
      object1,
      object2,
      skipShallowCompare,
    ).next().value;

    return !!anyDistinctKey;
  }

  /**
   * Compares if any properties of object1 and object2 contain any different value (aka full join).
   *
   * 中文：并集语义，任一 key 不同即返回 true。calculate 用它收集字段差量。
   */
  public static isDifferent<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ): boolean {
    const anyDistinctKey = !!this.distinctKeysIterator(
      "full",
      object1,
      object2,
      skipShallowCompare,
    ).next().value;

    return !!anyDistinctKey;
  }

  /**
   * Returns sorted object1 keys that have distinct values.
   *
   * 中文：返回排好序的 key 列表，便于序列化/比较结果稳定（不依赖
   * Object.keys 的插入顺序）。debug 与测试断言都依赖这个顺序。
   */
  public static getLeftDifferences<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ) {
    return Array.from(
      this.distinctKeysIterator("left", object1, object2, skipShallowCompare),
    ).sort();
  }

  /**
   * Returns sorted object2 keys that have distinct values.
   *
   * 中文：与 getLeftDifferences 镜像，取 object2 的 key 集合。
   */
  public static getRightDifferences<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ) {
    return Array.from(
      this.distinctKeysIterator("right", object1, object2, skipShallowCompare),
    ).sort();
  }

  /**
   * Returns sorted keys of shared object1 and object2 properties that have distinct values (aka inner join).
   *
   * 中文：共有 key 的差异列表，用于“只关心交集”的保守比较。
   */
  public static getInnerDifferences<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ) {
    return Array.from(
      this.distinctKeysIterator("inner", object1, object2, skipShallowCompare),
    ).sort();
  }

  /**
   * Returns sorted keys that have distinct values between object1 and object2 (aka full join).
   *
   * 中文：calculate 的主入口；返回并集差异 key，顺序稳定。
   */
  public static getDifferences<T extends {}>(
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ) {
    return Array.from(
      this.distinctKeysIterator("full", object1, object2, skipShallowCompare),
    ).sort();
  }

  /**
   * Iterator comparing values of object properties based on the passed joining strategy.
   *
   * @yields keys of properties with different values
   *
   * WARN: it's based on shallow compare performed only on the first level and doesn't go deeper than that.
   *
   * 中文：生成器形式的差异迭代器，四个 join 模式共用同一套 key 选择逻辑。
   * `skipShallowCompare` 为 true 时连“对象内容看起来相同但引用不同”也算
   * 变化——同步场景需要它来感知引用替换，历史记录则不需要。
   * 注意先比较引用（value1 !== value2）才做浅比较，避免对相同值做无谓开销。
   */
  private static *distinctKeysIterator<T extends {}>(
    join: "left" | "right" | "inner" | "full",
    object1: T,
    object2: T,
    skipShallowCompare = false,
  ) {
    if (object1 === object2) {
      return;
    }

    let keys: string[] = [];

    if (join === "left") {
      keys = Object.keys(object1);
    } else if (join === "right") {
      keys = Object.keys(object2);
    } else if (join === "inner") {
      keys = Object.keys(object1).filter((key) => key in object2);
    } else if (join === "full") {
      keys = Array.from(
        new Set([...Object.keys(object1), ...Object.keys(object2)]),
      );
    } else {
      assertNever(
        join,
        `Unknown distinctKeysIterator's join param "${join}"`,
        true,
      );
    }

    for (const key of keys) {
      const value1 = object1[key as keyof T];
      const value2 = object2[key as keyof T];

      if (value1 !== value2) {
        if (
          !skipShallowCompare &&
          typeof value1 === "object" &&
          typeof value2 === "object" &&
          value1 !== null &&
          value2 !== null &&
          isShallowEqual(value1, value2)
        ) {
          continue;
        }

        yield key;
      }
    }
  }
}

/**
 * Encapsulates a set of application-level `Delta`s.
 */
export interface DeltaContainer<T> {
  /**
   * Inverses the `Delta`s while creating a new `DeltaContainer` instance.
   */
  inverse(): DeltaContainer<T>;

  /**
   * Applies the `Delta`s to the previous object.
   *
   * @returns a tuple of the next object `T` with applied `Delta`s, and `boolean`, indicating whether the applied deltas resulted in a visible change.
   */
  applyTo(previous: T, ...options: unknown[]): [T, boolean];

  /**
   * Squashes the current delta with the given one.
   */
  squash(delta: DeltaContainer<T>): this;

  /**
   * Checks whether all `Delta`s are empty.
   */
  isEmpty(): boolean;
}

/**
 * 应用状态的增量容器。
 *
 * 状态本身是扁平的（AppState 字段），但其中 `selectedElementIds` /
 * `selectedGroupIds` / `lockedMultiSelections` 是“集合型字段”，不能整体
 * 覆盖（否则多人同时选择会互相吞掉），所以 postProcess 会把这些字段再
 * 差分成 per-id 的子对象，squash/applyTo 里也要对它们做特殊合并。
 *
 * 与 ElementsDelta 一样，一个 AppStateDelta 同时可用于前进和后退。
 */
export class AppStateDelta implements DeltaContainer<AppState> {
  private constructor(public delta: Delta<ObservedAppState>) {}

  /**
   * 用已算好的 Delta 构造容器（restore 路径）。
   */
  public static create(delta: Delta<ObservedAppState>): AppStateDelta {
    return new AppStateDelta(delta);
  }

  /**
   * 计算两个 ObservedAppState 之间的增量。
   *
   * `orderAppStateKeys` 让 key 顺序稳定，从而使增量可哈希/可比对；
   * `postProcess` 负责把集合型字段细化成逐 id 的差量。
   */
  public static calculate<T extends ObservedAppState>(
    prevAppState: T,
    nextAppState: T,
  ): AppStateDelta {
    const delta = Delta.calculate(
      prevAppState,
      nextAppState,
      // making the order of keys in deltas stable for hashing purposes
      AppStateDelta.orderAppStateKeys,
      AppStateDelta.postProcess,
    );

    return new AppStateDelta(delta);
  }

  /**
   * 从序列化 DTO 恢复。DTO 已经过 JSON 往返，直接包一层即可，
   * 不需要也不能重算（重算会丢失原始字段顺序/未变更标记）。
   */
  public static restore(appStateDeltaDTO: DTO<AppStateDelta>): AppStateDelta {
    const { delta } = appStateDeltaDTO;
    return new AppStateDelta(delta);
  }

  /** 无变更的空容器，作为合并与比较的初值 */
  public static empty() {
    return new AppStateDelta(Delta.create({}, {}));
  }

  /**
   * 交换 deleted/inserted 得到反向增量。
   *
   * 这是“双向 time-travel”的实现：撤销就是把同一份增量倒着应用。
   */
  public inverse(): AppStateDelta {
    const inversedDelta = Delta.create(this.delta.inserted, this.delta.deleted);
    return new AppStateDelta(inversedDelta);
  }

  /**
   * 把新的增量合并进当前实例（原地修改并返回 this）。
   *
   * 为什么不能简单 `Delta.merge` 了事：集合型字段的子对象也要按 per-id
   * 合并。否则“先删 A 再删 B”的两次操作会被后一次整体覆盖，撤销时只
   * 恢复 B。这里把三组集合字段的 deleted/inserted 分别 mergeObjects，
   * 其余字段仍走普通的后者覆盖。
   */
  public squash(delta: AppStateDelta): this {
    if (delta.isEmpty()) {
      return this;
    }

    // 逐 id 合并：同一 id 在新增量里再次出现时以新值为准
    const mergedDeletedSelectedElementIds = Delta.mergeObjects(
      this.delta.deleted.selectedElementIds ?? {},
      delta.delta.deleted.selectedElementIds ?? {},
    );

    const mergedInsertedSelectedElementIds = Delta.mergeObjects(
      this.delta.inserted.selectedElementIds ?? {},
      delta.delta.inserted.selectedElementIds ?? {},
    );

    const mergedDeletedSelectedGroupIds = Delta.mergeObjects(
      this.delta.deleted.selectedGroupIds ?? {},
      delta.delta.deleted.selectedGroupIds ?? {},
    );

    const mergedInsertedSelectedGroupIds = Delta.mergeObjects(
      this.delta.inserted.selectedGroupIds ?? {},
      delta.delta.inserted.selectedGroupIds ?? {},
    );

    const mergedDeletedLockedMultiSelections = Delta.mergeObjects(
      this.delta.deleted.lockedMultiSelections ?? {},
      delta.delta.deleted.lockedMultiSelections ?? {},
    );

    const mergedInsertedLockedMultiSelections = Delta.mergeObjects(
      this.delta.inserted.lockedMultiSelections ?? {},
      delta.delta.inserted.lockedMultiSelections ?? {},
    );

    const mergedInserted: Partial<ObservedAppState> = {};
    const mergedDeleted: Partial<ObservedAppState> = {};

    if (
      Object.keys(mergedDeletedSelectedElementIds).length ||
      Object.keys(mergedInsertedSelectedElementIds).length
    ) {
      mergedDeleted.selectedElementIds = mergedDeletedSelectedElementIds;
      mergedInserted.selectedElementIds = mergedInsertedSelectedElementIds;
    }

    if (
      Object.keys(mergedDeletedSelectedGroupIds).length ||
      Object.keys(mergedInsertedSelectedGroupIds).length
    ) {
      mergedDeleted.selectedGroupIds = mergedDeletedSelectedGroupIds;
      mergedInserted.selectedGroupIds = mergedInsertedSelectedGroupIds;
    }

    if (
      Object.keys(mergedDeletedLockedMultiSelections).length ||
      Object.keys(mergedInsertedLockedMultiSelections).length
    ) {
      mergedDeleted.lockedMultiSelections = mergedDeletedLockedMultiSelections;
      mergedInserted.lockedMultiSelections =
        mergedInsertedLockedMultiSelections;
    }

    this.delta = Delta.merge(
      this.delta,
      delta.delta,
      Delta.create(mergedDeleted, mergedInserted),
    );

    return this;
  }

  public applyTo(
    appState: AppState,
    nextElements: SceneElementsMap,
  ): [AppState, boolean] {
    try {
      // 集合型字段先单独取出：它们要基于当前 AppState 做增删，而不是
      // 直接把 partial 展开覆盖。
      const {
        selectedElementIds: deletedSelectedElementIds = {},
        selectedGroupIds: deletedSelectedGroupIds = {},
        lockedMultiSelections: deletedLockedMultiSelections = {},
      } = this.delta.deleted;

      const {
        selectedElementIds: insertedSelectedElementIds = {},
        selectedGroupIds: insertedSelectedGroupIds = {},
        lockedMultiSelections: insertedLockedMultiSelections = {},
        selectedLinearElement: insertedSelectedLinearElement,
        ...directlyApplicablePartial
      } = this.delta.inserted;

      const mergedSelectedElementIds = Delta.mergeObjects(
        appState.selectedElementIds,
        insertedSelectedElementIds,
        deletedSelectedElementIds,
      );

      const mergedSelectedGroupIds = Delta.mergeObjects(
        appState.selectedGroupIds,
        insertedSelectedGroupIds,
        deletedSelectedGroupIds,
      );

      const mergedLockedMultiSelections = Delta.mergeObjects(
        appState.lockedMultiSelections,
        insertedLockedMultiSelections,
        deletedLockedMultiSelections,
      );

      const selectedLinearElement =
        // LinearElementEditor 需要持有元素的最新实例与全量 map，所以必须
        // 在应用完 elements delta 之后重建；元素不存在则退化为 null。
        insertedSelectedLinearElement &&
        nextElements.has(insertedSelectedLinearElement.elementId)
          ? new LinearElementEditor(
              nextElements.get(
                insertedSelectedLinearElement.elementId,
              ) as NonDeleted<ExcalidrawLinearElement>,
              nextElements,
              insertedSelectedLinearElement.isEditing,
            )
          : null;

      const nextAppState = {
        ...appState,
        ...directlyApplicablePartial,
        selectedElementIds: mergedSelectedElementIds,
        selectedGroupIds: mergedSelectedGroupIds,
        lockedMultiSelections: mergedLockedMultiSelections,
        selectedLinearElement:
          typeof insertedSelectedLinearElement !== "undefined"
            ? selectedLinearElement
            : appState.selectedLinearElement,
      };

      const constainsVisibleChanges = this.filterInvisibleChanges(
        appState,
        nextAppState,
        nextElements,
      );

      // 返回 bool 而不是抛错：History 需要据此决定这一条记录是否值得
      // 保留。filterInvisibleChanges 可能已经就地清掉了指向已删除元素的
      // 选择状态，所以即使返回 false，nextAppState 也应被采用。
      return [nextAppState, constainsVisibleChanges];
    } catch (e) {
      // shouldn't really happen, but just in case
      console.error(`Couldn't apply appstate change`, e);

      if (isTestEnv() || isDevEnv()) {
        throw e;
      }

      return [appState, false];
    }
  }

  public isEmpty(): boolean {
    return Delta.isEmpty(this.delta);
  }

  /**
   * Mutates `nextAppState` be filtering out state related to deleted elements.
   *
   * @returns `true` if a visible change is found, `false` otherwise.
   */
  private filterInvisibleChanges(
    prevAppState: AppState,
    nextAppState: AppState,
    nextElements: SceneElementsMap,
  ): boolean {
    // 先把两类字段分开比较：standalone（不依赖元素的）与 elements（依赖
    // 元素的）。只有后者需要逐项确认对应元素仍然可见。
    // TODO: #7348 we could still get an empty undo/redo, as we assume that previous appstate does not contain references to deleted elements
    // which is not always true - i.e. now we do cleanup appstate during history, but we do not do it during remote updates
    const prevObservedAppState = getObservedAppState(prevAppState);
    const nextObservedAppState = getObservedAppState(nextAppState);

    const containsStandaloneDifference = Delta.isRightDifferent(
      AppStateDelta.stripElementsProps(prevObservedAppState),
      AppStateDelta.stripElementsProps(nextObservedAppState),
    );

    const containsElementsDifference = Delta.isRightDifferent(
      AppStateDelta.stripStandaloneProps(prevObservedAppState),
      AppStateDelta.stripStandaloneProps(nextObservedAppState),
    );

    if (!containsStandaloneDifference && !containsElementsDifference) {
      // no change in appstate was detected
      return false;
    }

    const visibleDifferenceFlag = {
      value: containsStandaloneDifference,
    };

    if (containsElementsDifference) {
      // filter invisible changes on each iteration
      const changedElementsProps = Delta.getRightDifferences(
        AppStateDelta.stripStandaloneProps(prevObservedAppState),
        AppStateDelta.stripStandaloneProps(nextObservedAppState),
      ) as Array<keyof ObservedElementsAppState>;

      let nonDeletedGroupIds = new Set<string>();

      if (
        changedElementsProps.includes("editingGroupId") ||
        changedElementsProps.includes("selectedGroupIds")
      ) {
        // this one iterates through all the non deleted elements, so make sure it's not done twice
        nonDeletedGroupIds = getNonDeletedGroupIds(nextElements);
      }

      // check whether delta properties are related to the existing non-deleted elements
      // 每个元素相关字段单独校验；不合法（指向已删除/不存在元素）时
      // 直接把它从 nextAppState 里抹掉，并让 visibleDifferenceFlag 保持
      // 原值——这样“只改了一个无效选择”的记录会被判定为不可见变更。
      for (const key of changedElementsProps) {
        switch (key) {
          case "selectedElementIds":
            nextAppState[key] = AppStateDelta.filterSelectedElements(
              nextAppState[key],
              nextElements,
              visibleDifferenceFlag,
            );

            break;
          case "selectedGroupIds":
            nextAppState[key] = AppStateDelta.filterSelectedGroups(
              nextAppState[key],
              nonDeletedGroupIds,
              visibleDifferenceFlag,
            );

            break;
          case "croppingElementId": {
            const croppingElementId = nextAppState[key];

            if (!croppingElementId) {
              // previously there was a croppingElementId (assuming visible), now there is none
              visibleDifferenceFlag.value = true;
            } else {
              const element = nextElements.get(croppingElementId);

              if (element && !element.isDeleted) {
                visibleDifferenceFlag.value = true;
              } else {
                nextAppState[key] = null;
              }
            }

            break;
          }
          case "editingGroupId":
            const editingGroupId = nextAppState[key];

            if (!editingGroupId) {
              // previously there was an editingGroup (assuming visible), now there is none
              visibleDifferenceFlag.value = true;
            } else if (nonDeletedGroupIds.has(editingGroupId)) {
              // previously there wasn't an editingGroup, now there is one which is visible
              visibleDifferenceFlag.value = true;
            } else {
              // there was assigned an editingGroup now, but it's related to deleted element
              nextAppState[key] = null;
            }

            break;
          case "selectedLinearElement":
            const nextLinearElement = nextAppState[key];

            if (!nextLinearElement) {
              // previously there was a linear element (assuming visible), now there is none
              visibleDifferenceFlag.value = true;
            } else {
              const element = nextElements.get(nextLinearElement.elementId);

              if (element && !element.isDeleted) {
                // previously there wasn't a linear element, now there is one which is visible
                visibleDifferenceFlag.value = true;
              } else {
                // there was assigned a linear element now, but it's deleted
                nextAppState[key] = null;
              }
            }

            break;
          case "lockedMultiSelections":
            const prevLockedUnits = prevAppState[key] || {};
            const nextLockedUnits = nextAppState[key] || {};

            // TODO: this seems wrong, we are already doing this comparison generically above,
            // hence instead we should check whether elements are actually visible,
            // so that once these changes are applied they actually result in a visible change to the user
            if (!isShallowEqual(prevLockedUnits, nextLockedUnits)) {
              visibleDifferenceFlag.value = true;
            }
            break;
          case "activeLockedId":
            const prevHitLockedId = prevAppState[key] || null;
            const nextHitLockedId = nextAppState[key] || null;

            // TODO: this seems wrong, we are already doing this comparison generically above,
            // hence instead we should check whether elements are actually visible,
            // so that once these changes are applied they actually result in a visible change to the user
            if (prevHitLockedId !== nextHitLockedId) {
              visibleDifferenceFlag.value = true;
            }
            break;
          default:
            assertNever(
              key,
              `Unknown ObservedElementsAppState's key "${key}"`,
              true,
            );
        }
      }
    }

    return visibleDifferenceFlag.value;
  }

  /**
   * 过滤选中 id：只保留仍存在且未删除的元素。
   *
   * @param visibleDifferenceFlag 被就地修改为 true 当且仅当至少有一个
   *   选中 id 对应可见元素（供调用方判定整条增量是否值得入历史）
   */
  private static filterSelectedElements(
    selectedElementIds: AppState["selectedElementIds"],
    elements: SceneElementsMap,
    visibleDifferenceFlag: { value: boolean },
  ) {
    const ids = Object.keys(selectedElementIds);

    if (!ids.length) {
      // previously there were ids (assuming related to visible elements), now there are none
      visibleDifferenceFlag.value = true;
      return selectedElementIds;
    }

    const nextSelectedElementIds = { ...selectedElementIds };

    for (const id of ids) {
      const element = elements.get(id);

      if (element && !element.isDeleted) {
        // there is a selected element id related to a visible element
        visibleDifferenceFlag.value = true;
      } else {
        delete nextSelectedElementIds[id];
      }
    }

    return nextSelectedElementIds;
  }

  /**
   * 过滤选中组：只保留至少还有一个非删除成员的组。
   *
   * `nonDeletedGroupIds` 由调用方预先算好，避免在循环里重复遍历全场景。
   */
  private static filterSelectedGroups(
    selectedGroupIds: AppState["selectedGroupIds"],
    nonDeletedGroupIds: Set<string>,
    visibleDifferenceFlag: { value: boolean },
  ) {
    const ids = Object.keys(selectedGroupIds);

    if (!ids.length) {
      // previously there were ids (assuming related to visible groups), now there are none
      visibleDifferenceFlag.value = true;
      return selectedGroupIds;
    }

    const nextSelectedGroupIds = { ...selectedGroupIds };

    for (const id of Object.keys(nextSelectedGroupIds)) {
      if (nonDeletedGroupIds.has(id)) {
        // there is a selected group id related to a visible group
        visibleDifferenceFlag.value = true;
      } else {
        delete nextSelectedGroupIds[id];
      }
    }

    return nextSelectedGroupIds;
  }

  /**
   * 把 ObservedAppState 拆成“与元素无关”的部分。
   *
   * 这里用解构而非类型判断：字段列表必须与 ObservedElementsAppState
   * 的 key 完全一致，TS 的类型断言负责在编译期发现漏项。
   */
  private static stripElementsProps(
    delta: Partial<ObservedAppState>,
  ): Partial<ObservedStandaloneAppState> {
    // WARN: Do not remove the type-casts as they here to ensure proper type checks
    const {
      editingGroupId,
      selectedGroupIds,
      selectedElementIds,
      selectedLinearElement,
      croppingElementId,
      lockedMultiSelections,
      activeLockedId,
      ...standaloneProps
    } = delta as ObservedAppState;

    return standaloneProps as SubtypeOf<
      typeof standaloneProps,
      ObservedStandaloneAppState
    >;
  }

  /**
   * stripElementsProps 的反操作：只留下依赖元素的状态字段。
   *
   * 两个函数配合实现“两类字段分别比较”，中间用 assertNever 保证
   * 新增字段时不会漏分类（类型层面兜底）。
   */
  private static stripStandaloneProps(
    delta: Partial<ObservedAppState>,
  ): Partial<ObservedElementsAppState> {
    // WARN: Do not remove the type-casts as they here to ensure proper type checks
    const { name, viewBackgroundColor, ...elementsProps } =
      delta as ObservedAppState;

    return elementsProps as SubtypeOf<
      typeof elementsProps,
      ObservedElementsAppState
    >;
  }

  /**
   * It is necessary to post process the partials in case of reference values,
   * for which we need to calculate the real diff between `deleted` and `inserted`.
   */
  private static postProcess<T extends ObservedAppState>(
    deleted: Partial<T>,
    inserted: Partial<T>,
  ): [Partial<T>, Partial<T>] {
    try {
      Delta.diffObjects(
        deleted,
        inserted,
        "selectedElementIds",
        // ts language server has a bit trouble resolving this, so we are giving it a little push
        // 选中集合里每个 id 的值恒为 true，因此 setValue 直接返回 true
        (_) => true as ValueOf<T["selectedElementIds"]>,
      );
      Delta.diffObjects(
        deleted,
        inserted,
        "selectedGroupIds",
        (prevValue) => (prevValue ?? false) as ValueOf<T["selectedGroupIds"]>,
      );
      Delta.diffObjects(
        deleted,
        inserted,
        "lockedMultiSelections",
        (prevValue) => (prevValue ?? {}) as ValueOf<T["lockedMultiSelections"]>,
      );
    } catch (e) {
      // if postprocessing fails it does not make sense to bubble up, but let's make sure we know about it
      console.error(`Couldn't postprocess appstate change deltas.`);

      if (isTestEnv() || isDevEnv()) {
        throw e;
      }
    } finally {
      return [deleted, inserted];
    }
  }

  /**
   * 把部分对象的 key 按字典序重排，让增量在序列化后稳定可比。
   *
   * 依赖对象 key 的插入顺序：新对象按排序后的 key 逐个赋值，顺序即随之
   * 固定。不要改成 Map 或 sort 原对象，会破坏调用方的引用语义。
   */
  private static orderAppStateKeys(partial: Partial<ObservedAppState>) {
    const orderedPartial: { [key: string]: unknown } = {};

    for (const key of Object.keys(partial).sort()) {
      // relying on insertion order
      orderedPartial[key] = partial[key as keyof ObservedAppState];
    }

    return orderedPartial as Partial<ObservedAppState>;
  }
}

type ElementPartial<TElement extends ExcalidrawElement = ExcalidrawElement> =
  Omit<Partial<Ordered<TElement>>, "id" | "updated" | "seed">;

export type ApplyToOptions = {
  excludedProperties?: Set<keyof ElementPartial>;
  /**
   * measures the labels re-laid out after applying (bound texts, and the
   * labels of bound arrows) -- the editor passes the host's
   */
  renderEnvironment?: RenderEnvironment;
};

type ApplyToFlags = {
  containsVisibleDifference: boolean;
  containsZindexDifference: boolean;
  applyDirection: "forward" | "backward" | undefined;
};

/**
 * Elements change is a low level primitive to capture a change between two sets of elements.
 * It does so by encapsulating forward and backward `Delta`s, allowing to time-travel in both directions.
 *
 * 元素集合的字段级增量，History 与协作同步共用这一套结构。
 *
 * 三个桶不是“操作类型”，而是“元素的生命周期状态”：
 * - `added`：该元素从删除/不存在变为存在（isDeleted false）；
 * - `removed`：从存在变为删除（isDeleted true）——这就是删除墓碑的载体；
 * - `updated`：存在状态不变，只改了其他字段。
 * 每个桶里仍是一对 `deleted`/`inserted` 部分对象，代表“正向应用要写入/抹掉
 * 哪些字段”。因此同一个 delta 同时包含正向与反向信息，可以双向 time-travel。
 *
 * 不变量（validate 会检查）：
 * - 每个元素 id 只能出现在一个桶里；
 * - version 必须是非负整数且 deleted/inserted 两侧不同；
 * - added 不能以“deleted.isDeleted === true”开头，removed 必须是
 *   false → true。否则冲突解决会拿到自相矛盾的状态。
 */
export class ElementsDelta implements DeltaContainer<SceneElementsMap> {
  private constructor(
    public readonly added: Record<string, Delta<ElementPartial>>,
    public readonly removed: Record<string, Delta<ElementPartial>>,
    public readonly updated: Record<string, Delta<ElementPartial>>,
  ) {}

  /**
   * 构造元素增量；`shouldRedistribute` 为 true 时按 delta 内容重新归类到
   * 三个桶（而不是相信调用方传入的桶）。
   *
   * 重新归类是 applyLatestChanges/squash 之后必须做的：回填最新值或合并
   * 增量可能把 `isDeleted` 翻转过，原来在 updated 桶里的条目实际已是
   * added/removed。dev/test 环境还会跑三个不变量校验，把不一致尽早暴露
   * 在本地而不是让协作端拿到坏数据。
   */
  public static create(
    added: Record<string, Delta<ElementPartial>>,
    removed: Record<string, Delta<ElementPartial>>,
    updated: Record<string, Delta<ElementPartial>>,
    options: {
      shouldRedistribute: boolean;
    } = {
      shouldRedistribute: false,
    },
  ) {
    let delta: ElementsDelta;

    if (options.shouldRedistribute) {
      const nextAdded: Record<string, Delta<ElementPartial>> = {};
      const nextRemoved: Record<string, Delta<ElementPartial>> = {};
      const nextUpdated: Record<string, Delta<ElementPartial>> = {};

      const deltas = [
        ...Object.entries(added),
        ...Object.entries(removed),
        ...Object.entries(updated),
      ];

      for (const [id, delta] of deltas) {
        if (this.satisfiesAddition(delta)) {
          nextAdded[id] = delta;
        } else if (this.satisfiesRemoval(delta)) {
          nextRemoved[id] = delta;
        } else {
          nextUpdated[id] = delta;
        }
      }

      delta = new ElementsDelta(nextAdded, nextRemoved, nextUpdated);
    } else {
      delta = new ElementsDelta(added, removed, updated);
    }

    if (isTestEnv() || isDevEnv()) {
      ElementsDelta.validate(delta, "added", this.satisfiesAddition);
      ElementsDelta.validate(delta, "removed", this.satisfiesRemoval);
      ElementsDelta.validate(delta, "updated", this.satisfiesUpdate);
    }

    return delta;
  }

  /**
   * 从 DTO 恢复元素增量。
   *
   * 注意没有传 shouldRedistribute：序列化时桶已经定好，重算既浪费也可能
   * 改变历史语义。校验仍在 create 内进行。
   */
  public static restore(elementsDeltaDTO: DTO<ElementsDelta>): ElementsDelta {
    const { added, removed, updated } = elementsDeltaDTO;
    return ElementsDelta.create(added, removed, updated);
  }

  /**
   * 三个桶的归类判据（只看 isDeleted 的翻转方向）。
   *
   * added：deleted 侧认为“已删除”、inserted 侧“未删除”——从墓碑复活。
   * removed：相反，从存在进入删除（删除墓碑）。
   * updated：两侧 isDeleted 的真假一致，只是其他字段变化。
   */
  private static satisfiesAddition = ({
    deleted,
    inserted,
  }: Delta<ElementPartial>) =>
    // dissallowing added as "deleted", which could cause issues when resolving conflicts
    deleted.isDeleted === true && !inserted.isDeleted;

  private static satisfiesRemoval = ({
    deleted,
    inserted,
  }: Delta<ElementPartial>) =>
    !deleted.isDeleted && inserted.isDeleted === true;

  private static satisfiesUpdate = ({
    deleted,
    inserted,
  }: Delta<ElementPartial>) => !!deleted.isDeleted === !!inserted.isDeleted;

  /**
   * 所有桶共有的不变量：version 必须是整数、非负、且两侧不相等。
   *
   * “两侧不等”是关键：version 相同意味着无法判断应用方向，冲突解决时
   * 会导致原地回环。applyDirection 的推断（见 createApplier）也依赖它。
   */
  private static satisfiesCommmonInvariants = ({
    deleted,
    inserted,
  }: Delta<ElementPartial>) =>
    !!(
      // versions are required integers
      (
        Number.isInteger(deleted.version) &&
        Number.isInteger(inserted.version) &&
        // versions should be positive, zero included
        deleted.version! >= 0 &&
        inserted.version! >= 0 &&
        // versions should never be the same
        deleted.version !== inserted.version
      )
    );

  /**
   * 同一个元素 id 只能出现在三个桶中的一个。
   *
   * 违反会造成 applyTo 时同一元素被应用两次，第二次基于第一次的结果，
   * 版本号与可见性判断都会失真。
   */
  private static satisfiesUniqueInvariants = (
    elementsDelta: ElementsDelta,
    id: string,
  ) => {
    const { added, removed, updated } = elementsDelta;
    // it's required that there is only one unique delta type per element
    return [added[id], removed[id], updated[id]].filter(Boolean).length === 1;
  };

  /**
   * 逐条校验某个桶的所有 delta，任一不满足就抛错。
   *
   * 只在 dev/test 调用：生产环境为性能跳过，但坏数据会在其它地方以
   * “撤销跳步/元素消失”的形式出现，所以本地必须尽早失败。
   */
  private static validate(
    elementsDelta: ElementsDelta,
    type: "added" | "removed" | "updated",
    satifiesSpecialInvariants: (delta: Delta<ElementPartial>) => boolean,
  ) {
    for (const [id, delta] of Object.entries(elementsDelta[type])) {
      if (
        !this.satisfiesCommmonInvariants(delta) ||
        !this.satisfiesUniqueInvariants(elementsDelta, id) ||
        !satifiesSpecialInvariants(delta)
      ) {
        console.error(
          `Broken invariant for "${type}" delta, element "${id}", delta:`,
          delta,
        );
        throw new Error(`ElementsDelta invariant broken for element "${id}".`);
      }
    }
  }

  /**
   * Calculates the `Delta`s between the previous and next set of elements.
   *
   * @param prevElements - Map representing the previous state of elements.
   * @param nextElements - Map representing the next state of elements.
   *
   * @returns `ElementsDelta` instance representing the `Delta` changes between the two sets of elements.
   *
   * 中文：三段式——先处理“旧有新无”（墓碑），再处理“新有旧无”（新建），
   * 最后才是两边都有的逐字段比较。前两段不能合并进第三段，因为它们的
   * deleted/inserted 不是由字段比较得出的，而是人为构造的。
   */
  public static calculate<T extends OrderedExcalidrawElement>(
    prevElements: Map<string, T>,
    nextElements: Map<string, T>,
  ): ElementsDelta {
    if (prevElements === nextElements) {
      return ElementsDelta.empty();
    }

    const added: Record<string, Delta<ElementPartial>> = {};
    const removed: Record<string, Delta<ElementPartial>> = {};
    const updated: Record<string, Delta<ElementPartial>> = {};

    // 旧集合里有、新集合里没有：构造一条“删除墓碑”delta。
    // 注意这里主动把 version 抬到 prevElement.version + 1，并换 versionNonce；
    // 否则远端会认为“删除”比它手里的旧版本还旧，从而把删除丢弃——墓碑必须
    // 赢过它要删除的那个版本。
    // this might be needed only in same edge cases, like during collab, when `isDeleted` elements get removed or when we (un)intentionally remove the elements
    for (const prevElement of prevElements.values()) {
      const nextElement = nextElements.get(prevElement.id);

      if (!nextElement) {
        const deleted = { ...prevElement } as ElementPartial;

        const inserted = {
          isDeleted: true,
          version: prevElement.version + 1,
          versionNonce: randomInteger(),
        } as ElementPartial;

        const delta = Delta.create(
          deleted,
          inserted,
          ElementsDelta.stripIrrelevantProps,
        );

        if (!prevElement.isDeleted) {
          removed[prevElement.id] = delta;
        } else {
          updated[prevElement.id] = delta;
        }
      }
    }

    for (const nextElement of nextElements.values()) {
      const prevElement = prevElements.get(nextElement.id);

      if (!prevElement) {
        const deleted = {
          isDeleted: true,
          version: nextElement.version - 1,
          versionNonce: randomInteger(),
        } as ElementPartial;

        const inserted = {
          ...nextElement,
        } as ElementPartial;

        const delta = Delta.create(
          deleted,
          inserted,
          ElementsDelta.stripIrrelevantProps,
        );

        // ignore updates which would "delete" already deleted element
        // 新建分支里 deleted 侧故意给 isDeleted:true + version-1，
        // 构成“从墓碑复活”的配对；若新元素本身就是删除态，说明只是
        // 补一条墓碑，归到 updated 而不是 added。
        if (!nextElement.isDeleted) {
          added[nextElement.id] = delta;
        } else {
          updated[nextElement.id] = delta;
        }

        continue;
      }

      // versionNonce 相同 = 同一个元素状态，无需比较字段。
      // 用 versionNonce 而不是 version 作为“是否同一状态”的快速判据，是因为
      // 撤销/重做会刻意排除 version 的恢复（见 history.ts 的 applyTo），
      // 此时 version 变了但内容可能没变。
      if (prevElement.versionNonce !== nextElement.versionNonce) {
        const delta = Delta.calculate<ElementPartial>(
          prevElement,
          nextElement,
          ElementsDelta.stripIrrelevantProps,
          ElementsDelta.postProcess,
        );

        if (
          // making sure we don't get here some non-boolean values (i.e. undefined, null, etc.)
          typeof prevElement.isDeleted === "boolean" &&
          typeof nextElement.isDeleted === "boolean" &&
          prevElement.isDeleted !== nextElement.isDeleted
        ) {
          // notice that other props could have been updated as well
          if (prevElement.isDeleted && !nextElement.isDeleted) {
            added[nextElement.id] = delta;
          } else {
            removed[nextElement.id] = delta;
          }

          continue;
        }

        updated[nextElement.id] = delta;
      }
    }

    return ElementsDelta.create(added, removed, updated);
  }

  /** 三个桶都为空即无变更；供 History 跳过空提交 */
  public static empty() {
    return ElementsDelta.create({}, {}, {});
  }

  /**
   * 反向增量：交换每个 delta 的 deleted/inserted，并交换 added 与 removed。
   *
   * 桶也要交换：正向的“新建”反向就是“删除墓碑”。不交换会直接违反
   * satisfiesAddition/Removal 的不变量。
   */
  public inverse(): ElementsDelta {
    const inverseInternal = (deltas: Record<string, Delta<ElementPartial>>) => {
      const inversedDeltas: Record<string, Delta<ElementPartial>> = {};

      for (const [id, { inserted, deleted }] of Object.entries(deltas)) {
        inversedDeltas[id] = Delta.create({ ...inserted }, { ...deleted });
      }

      return inversedDeltas;
    };

    const added = inverseInternal(this.added);
    const removed = inverseInternal(this.removed);
    const updated = inverseInternal(this.updated);

    // notice we inverse removed with added not to break the invariants
    return ElementsDelta.create(removed, added, updated);
  }

  public isEmpty(): boolean {
    // 与 Delta.isEmpty 同理：三个桶任何一个非空都算有变更
    return (
      Object.keys(this.added).length === 0 &&
      Object.keys(this.removed).length === 0 &&
      Object.keys(this.updated).length === 0
    );
  }

  /**
   * Update delta/s based on the existing elements.
   *
   * @param nextElements current elements
   * @param modifierOptions defines which of the delta (`deleted` or `inserted`) will be updated
   * @returns new instance with modified delta/s
   */
  /**
   * 用“当前最新元素”回填 delta 里的非差异字段。
   *
   * 场景：撤销一个很早以前的 delta 时，元素的其他字段可能已被别的操作
   * 改过。直接写回旧值会把这些后续修改一并抹掉。这里只保留 delta 真正
   * 涉及到的 key，但取值从最新元素拿，从而只回滚“这一笔改动”。
   * `modifierOptions` 指定更新 deleted 侧还是 inserted 侧（历史两个方向
   * 的语义不同）。`boundElements` 例外：它存的是引用集合的差量，不能整体
   * 从最新值覆盖，否则会丢绑定修复信息。
   */
  public applyLatestChanges(
    prevElements: SceneElementsMap,
    nextElements: SceneElementsMap,
    modifierOptions?: "deleted" | "inserted",
  ): ElementsDelta {
    const modifier =
      (
        prevElement: OrderedExcalidrawElement | undefined,
        nextElement: OrderedExcalidrawElement | undefined,
      ) =>
      (partial: ElementPartial, partialType: "deleted" | "inserted") => {
        let element: OrderedExcalidrawElement | undefined;

        switch (partialType) {
          case "deleted":
            element = prevElement;
            break;
          case "inserted":
            element = nextElement;
            break;
        }

        // the element wasn't found -> don't update the partial
        if (!element) {
          console.error(
            `Element not found when trying to apply latest changes`,
          );
          return partial;
        }

        const latestPartial: { [key: string]: unknown } = {};

        for (const key of Object.keys(partial) as Array<keyof typeof partial>) {
          // do not update following props:
          // - `boundElements`, as it is a reference value which is postprocessed to contain only deleted/inserted keys
          switch (key) {
            case "boundElements":
              latestPartial[key] = partial[key];
              break;
            default:
              latestPartial[key] = element[key];
          }
        }

        return latestPartial;
      };

    const applyLatestChangesInternal = (
      deltas: Record<string, Delta<ElementPartial>>,
    ) => {
      const modifiedDeltas: Record<string, Delta<ElementPartial>> = {};

      for (const [id, delta] of Object.entries(deltas)) {
        const prevElement = prevElements.get(id);
        const nextElement = nextElements.get(id);

        let latestDelta: Delta<ElementPartial> | null = null;

        if (prevElement || nextElement) {
          latestDelta = Delta.create(
            delta.deleted,
            delta.inserted,
            modifier(prevElement, nextElement),
            modifierOptions,
          );
        } else {
          latestDelta = delta;
        }

        // it might happen that after applying latest changes the delta itself does not contain any changes
        if (Delta.isInnerDifferent(latestDelta.deleted, latestDelta.inserted)) {
          modifiedDeltas[id] = latestDelta;
        }
      }

      return modifiedDeltas;
    };

    const added = applyLatestChangesInternal(this.added);
    const removed = applyLatestChangesInternal(this.removed);
    const updated = applyLatestChangesInternal(this.updated);

    return ElementsDelta.create(added, removed, updated, {
      shouldRedistribute: true, // redistribute the deltas as `isDeleted` could have been updated
    });
  }

  /**
   * 把增量应用到元素集合，返回新集合——不修改入参。
   *
   * 事务语义：先在 `nextElements`（始终新建的 Map）上依次应用 added /
   * removed / updated，再 resolveConflicts 处理“同一元素被多条 delta 同时
   * 命中”的情况；任何一步失败都不会半写回原集合。
   *
   * `snapshot` 是回退源：如果 delta 里引用的元素在目标集合中缺失（典型是
   * 已被 force delete），从快照里补回旧值，避免产生空洞。
   */
  public applyTo(
    elements: SceneElementsMap,
    snapshot: StoreSnapshot["elements"] = StoreSnapshot.empty().elements,
    options?: ApplyToOptions,
  ): [SceneElementsMap, boolean] {
    let nextElements = new Map(elements) as SceneElementsMap;
    let changedElements: Map<string, OrderedExcalidrawElement>;

    const flags: ApplyToFlags = {
      containsVisibleDifference: false,
      containsZindexDifference: false,
      applyDirection: undefined,
    };

    // mimic a transaction by applying deltas into `nextElements` (always new instance, no mutation)
    try {
      const applyDeltas = ElementsDelta.createApplier(
        elements,
        nextElements,
        snapshot,
        flags,
        options,
      );

      const addedElements = applyDeltas(this.added);
      const removedElements = applyDeltas(this.removed);
      const updatedElements = applyDeltas(this.updated);

      const affectedElements = this.resolveConflicts(
        elements,
        nextElements,
        flags.applyDirection,
      );

      // TODO: #7348 validate elements semantically and syntactically the changed elements, in case they would result data integrity issues
      changedElements = new Map([
        ...addedElements,
        ...removedElements,
        ...updatedElements,
        ...affectedElements,
      ]);
    } catch (e) {
      console.error(`Couldn't apply elements delta`, e);

      if (isTestEnv() || isDevEnv()) {
        throw e;
      }

      // should not really happen, but just in case we cannot apply deltas, let's return the previous elements with visible change set to `true`
      // even though there is obviously no visible change, returning `false` could be dangerous, as i.e.:
      // in the worst case, it could lead into iterating through the whole stack with no possibility to redo
      // instead, the worst case when returning `true` is an empty undo / redo
      return [elements, true];
    }

    try {
      // Whether this delta results in a visible change is decided from the
      // *applied* result, not from the property patches: binding repair and
      // layout (text bounding boxes, bound arrows) run below and can move
      // elements the delta never named, and an `isDeleted` flip or a
      // `boundElements` edit is not visible by itself — deleting a note's
      // empty label is the canonical case. History relies on this answer to
      // skip such entries on undo/redo (see `History`'s apply loop).
      //
      // `idsToCheck` is every element whose "before" and "after" get
      // compared: the changed elements plus what layout can move for them —
      // a text's container, and everything in `boundElements` (a container's
      // label and arrows). The set is walked as it grows, so an arrow added
      // for its container brings in its own label in turn. The dev/test
      // assertion after the redraw verifies the set is complete.
      const idsToCheck = new Set(changedElements.keys());
      // Unchanged elements are shared between `elements` and `nextElements`,
      // and layout mutates them in place — their "before" must be a shallow
      // copy taken now. Changed elements already have a fresh instance in
      // `nextElements`, so the instance in `elements` is their "before" as
      // is. Only `idsToCheck` is saved; the whole scene is never copied.
      const previousElements = new Map<string, OrderedExcalidrawElement>();
      for (const id of idsToCheck) {
        const previous = elements.get(id);
        const next = nextElements.get(id);
        for (const element of [previous, next]) {
          if (element) {
            if (isTextElement(element) && element.containerId) {
              idsToCheck.add(element.containerId);
            }
            for (const binding of element.boundElements ?? []) {
              idsToCheck.add(binding.id);
            }
          }
        }
        if (previous) {
          previousElements.set(
            id,
            previous === next ? { ...previous } : previous,
          );
        }
      }

      // the following reorder performs mutations, but only on new instances of changed elements,
      // unless something goes really bad and it fallbacks to fixing all invalid indices
      nextElements = ElementsDelta.reorderElements(
        nextElements,
        changedElements,
        flags,
      );

      // Guard for `idsToCheck`: layout bumps the version of everything it
      // mutates, so an element whose version moved during the redraw but was
      // never collected is a layout dependency the expansion above does not
      // know about — and a visible change that undo would silently skip.
      // Fail loudly instead (dev and tests only; this is a scene-wide pass).
      const versionsBeforeRedraw =
        isTestEnv() || isDevEnv()
          ? new Map(
              Array.from(nextElements, ([id, element]) => [
                id,
                element.version,
              ]),
            )
          : undefined;

      ElementsDelta.redrawElements(
        nextElements,
        changedElements,
        options?.renderEnvironment,
      );

      if (versionsBeforeRedraw) {
        for (const [id, element] of nextElements) {
          if (
            versionsBeforeRedraw.get(id) !== element.version &&
            !idsToCheck.has(id)
          ) {
            throw new Error(
              `Redrawn element "${id}" is missing from idsToCheck`,
            );
          }
        }
      }

      if (!flags.containsVisibleDifference) {
        for (const id of idsToCheck) {
          if (
            ElementsDelta.checkForVisibleDifference(
              previousElements.get(id),
              nextElements.get(id),
              previousElements,
              nextElements,
            )
          ) {
            flags.containsVisibleDifference = true;
            break;
          }
        }
      }
    } catch (e) {
      flags.containsVisibleDifference = true;
      console.error(
        `Couldn't mutate elements after applying elements change`,
        e,
      );

      if (isTestEnv() || isDevEnv()) {
        throw e;
      }
    }

    return [nextElements, flags.containsVisibleDifference];
  }

  public squash(delta: ElementsDelta): this {
    if (delta.isEmpty()) {
      return this;
    }

    const { added, removed, updated } = delta;

    /**
     * boundElements 是引用数组，不能像普通字段那样后者覆盖：两次绑定
     * 修复后的 delta 需要合并“新增的绑定”和“移除的绑定”，否则会丢掉
     * 中间态。按 id 去重合并，返回 undefined 表示两侧都没变化。
     */
    const mergeBoundElements = (
      prevDelta: Delta<ElementPartial>,
      nextDelta: Delta<ElementPartial>,
    ) => {
      const mergedDeletedBoundElements =
        Delta.mergeArrays(
          prevDelta.deleted.boundElements ?? [],
          nextDelta.deleted.boundElements ?? [],
          undefined,
          (x) => x.id,
        ) ?? [];

      const mergedInsertedBoundElements =
        Delta.mergeArrays(
          prevDelta.inserted.boundElements ?? [],
          nextDelta.inserted.boundElements ?? [],
          undefined,
          (x) => x.id,
        ) ?? [];

      if (
        !mergedDeletedBoundElements.length &&
        !mergedInsertedBoundElements.length
      ) {
        return;
      }

      return Delta.create(
        {
          boundElements: mergedDeletedBoundElements,
        },
        {
          boundElements: mergedInsertedBoundElements,
        },
      );
    };

    for (const [id, nextDelta] of Object.entries(added)) {
      // 同一元素可能已在别的桶里（先删后加等组合），所以三个桶一起查
      const prevDelta = this.added[id] ?? this.removed[id] ?? this.updated[id];

      if (!prevDelta) {
        this.added[id] = nextDelta;
      } else {
        const mergedDelta = mergeBoundElements(prevDelta, nextDelta);
        delete this.removed[id];
        delete this.updated[id];

        this.added[id] = Delta.merge(prevDelta, nextDelta, mergedDelta);
      }
    }

    for (const [id, nextDelta] of Object.entries(removed)) {
      const prevDelta = this.added[id] ?? this.removed[id] ?? this.updated[id];

      if (!prevDelta) {
        this.removed[id] = nextDelta;
      } else {
        const mergedDelta = mergeBoundElements(prevDelta, nextDelta);
        delete this.added[id];
        delete this.updated[id];

        this.removed[id] = Delta.merge(prevDelta, nextDelta, mergedDelta);
      }
    }

    for (const [id, nextDelta] of Object.entries(updated)) {
      const prevDelta = this.added[id] ?? this.removed[id] ?? this.updated[id];

      if (!prevDelta) {
        this.updated[id] = nextDelta;
      } else {
        const mergedDelta = mergeBoundElements(prevDelta, nextDelta);
        const updatedDelta = Delta.merge(prevDelta, nextDelta, mergedDelta);

        if (prevDelta === this.added[id]) {
          this.added[id] = updatedDelta;
        } else if (prevDelta === this.removed[id]) {
          this.removed[id] = updatedDelta;
        } else {
          this.updated[id] = updatedDelta;
        }
      }
    }

    if (isTestEnv() || isDevEnv()) {
      ElementsDelta.validate(this, "added", ElementsDelta.satisfiesAddition);
      ElementsDelta.validate(this, "removed", ElementsDelta.satisfiesRemoval);
      ElementsDelta.validate(this, "updated", ElementsDelta.satisfiesUpdate);
    }

    return this;
  }

  private static createApplier =
    (
      prevElements: SceneElementsMap,
      nextElements: SceneElementsMap,
      snapshot: StoreSnapshot["elements"],
      flags: ApplyToFlags,
      options?: ApplyToOptions,
    ) =>
    (deltas: Record<string, Delta<ElementPartial>>) => {
      // getter 负责“取元素”：目标集合 → 快照 → 现场新建，三级回退
      const getElement = ElementsDelta.createGetter(
        nextElements,
        snapshot,
        flags,
      );

      return Object.entries(deltas).reduce((acc, [id, delta]) => {
        const element = getElement(id, delta.inserted);

        if (element) {
          const nextElement = ElementsDelta.applyDelta(
            element,
            delta,
            flags,
            options,
          );

          nextElements.set(nextElement.id, nextElement);
          acc.set(nextElement.id, nextElement);

          if (!flags.applyDirection) {
            // 只根据第一个应用到的元素推断方向：version 变大是前进，
            // 变小是后退。这个方向会传给 resolveConflicts，决定冲突修复
            // 后的 version 是 +1 还是 -1。
            const prevElement = prevElements.get(id);

            if (prevElement) {
              flags.applyDirection =
                prevElement.version > nextElement.version
                  ? "backward"
                  : "forward";
            }
          }
        }

        return acc;
      }, new Map<string, OrderedExcalidrawElement>());
    };

  private static createGetter =
    (
      elements: SceneElementsMap,
      snapshot: StoreSnapshot["elements"],
      flags: ApplyToFlags,
    ) =>
    (id: string, partial: ElementPartial) => {
      // 三级回退的顺序不能改：先用当前集合（已有元素），再用快照（被
      // force delete 掉的元素），最后才凭空造一个。顺序反了会把最新
      // 元素覆盖成旧快照值。
      let element = elements.get(id);

      if (!element) {
        // always fallback to the local snapshot, in cases when we cannot find the element in the elements array
        element = snapshot.get(id);

        if (element) {
          // as the element was brought from the snapshot, it automatically results in a possible zindex difference
          // (whether it is *visible* is decided in `applyTo`, from the applied result)
          flags.containsZindexDifference = true;
        } else {
          // not in elements, not in snapshot? element might have been added remotely!
          element = newElementWith(
            { id, version: 1 } as OrderedExcalidrawElement,
            {
              ...partial,
            },
          );
        }
      }

      return element;
    };

  private static applyDelta(
    element: OrderedExcalidrawElement,
    delta: Delta<ElementPartial>,
    flags: ApplyToFlags,
    options?: ApplyToOptions,
  ) {
    const directlyApplicablePartial: Mutable<ElementPartial> = {};

    // some properties are not directly applicable, such as:
    // - boundElements which contains only diff)
    // - version & versionNonce, if we don't want to return to previous versions
    // 逐个 key 白名单式写入：boundElements 必须走下面的合并逻辑；
    // excludedProperties 让调用方（如协作同步）跳过版本字段，避免把
    // 对端版本号覆盖到本地。用 Reflect.set 而非解构，是为了兼容
    // 含特殊字符的 key 并保持类型宽松。
    for (const key of Object.keys(delta.inserted) as Array<
      keyof typeof delta.inserted
    >) {
      if (key === "boundElements") {
        continue;
      }

      if (options?.excludedProperties?.has(key)) {
        continue;
      }

      const value = delta.inserted[key];
      Reflect.set(directlyApplicablePartial, key, value);
    }

    if (
      delta.deleted.boundElements?.length ||
      delta.inserted.boundElements?.length
    ) {
      const mergedBoundElements = Delta.mergeArrays(
        element.boundElements,
        delta.inserted.boundElements,
        delta.deleted.boundElements,
        (x) => x.id,
      );

      Object.assign(directlyApplicablePartial, {
        boundElements: mergedBoundElements,
      });
    }

    // visibility is not decided here: `applyTo` compares the applied result
    // once layout has run, so that its effects count too
    if (!flags.containsZindexDifference) {
      flags.containsZindexDifference =
        delta.deleted.index !== delta.inserted.index;
    }

    return newElementWith(element, directlyApplicablePartial, true);
  }

  /**
   * Whether an element looks different after the delta — and the layout that
   * followed it — was applied. The input to history's "skip entries with no
   * visible change" loop.
   *
   * Both sides are first reduced to what actually paints:
   * - a missing or deleted element paints nothing;
   * - an empty text element paints nothing either — unless it carries arrow
   *   bindings (an arrow may end at it) or sits on an arrow (an empty label
   *   still cuts the arrow's gap);
   * so an empty label's deletion or restoration compares as nothing against
   * nothing. Two painting elements are then compared property by property:
   * - `version`, `versionNonce`, `updated`, `created` are metadata, and
   *   `index` is covered by the separate z-order check (`reorderElements`);
   * - `boundElements` is compared as `type:id` references with references to
   *   empty labels dropped, so adding or removing an empty label's reference
   *   is not visible on its own, and binding repair that rebuilt equal
   *   objects is not either;
   * - everything else counts. Nested arrays (`points`, binding fixed points)
   *   compare by reference, which can only over-report a change — the safe
   *   direction, where undo stops one entry early.
   *
   * `previousElements` holds only `idsToCheck` (see `applyTo`); the label
   * lookups it serves are for elements whose labels are in that set.
   */
  private static checkForVisibleDifference(
    previous: OrderedExcalidrawElement | undefined,
    next: OrderedExcalidrawElement | undefined,
    previousElements: ReadonlyMap<string, OrderedExcalidrawElement>,
    nextElements: ReadonlyMap<string, OrderedExcalidrawElement>,
  ) {
    const visibleElement = (
      element: OrderedExcalidrawElement | undefined,
      elements: ReadonlyMap<string, OrderedExcalidrawElement>,
    ) => {
      if (!element || element.isDeleted) {
        return null;
      }
      if (
        isTextElement(element) &&
        !element.text.trim() &&
        !element.boundElements?.length &&
        !isArrowElement(elements.get(element.containerId ?? ""))
      ) {
        return null;
      }

      return element;
    };

    const before = visibleElement(previous, previousElements);
    const after = visibleElement(next, nextElements);
    if (!before || !after) {
      return before !== after;
    }

    const visibleBindings = (
      element: OrderedExcalidrawElement,
      elements: ReadonlyMap<string, OrderedExcalidrawElement>,
    ) =>
      (element.boundElements ?? [])
        .filter((binding) => {
          const label = elements.get(binding.id);
          return (
            binding.type !== "text" ||
            isArrowElement(element) ||
            !label ||
            !isTextElement(label) ||
            !!label.text.trim()
          );
        })
        .map(({ id, type }) => `${type}:${id}`);

    return Delta.getDifferences(before, after).some((key) => {
      switch (key) {
        // Ordering is checked separately; the remaining fields are metadata.
        case "index":
        case "version":
        case "versionNonce":
        case "updated":
        case "created":
          return false;
        case "boundElements":
          return !isShallowEqual(
            visibleBindings(before, previousElements),
            visibleBindings(after, nextElements),
          );
        default:
          return true;
      }
    });
  }

  /**
   * Resolves conflicts for all previously added, removed and updated elements.
   * Updates the previous deltas with all the changes after conflict resolution.
   *
   * // TODO: revisit since some bound arrows seem to be often redrawn incorrectly
   *
   * @returns all elements affected by the conflict resolution
   */
  private resolveConflicts(
    prevElements: SceneElementsMap,
    nextElements: SceneElementsMap,
    applyDirection: "forward" | "backward" = "forward",
  ) {
    const nextAffectedElements = new Map<string, OrderedExcalidrawElement>();
    const updater = (
      element: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => {
      const nextElement = nextElements.get(element.id); // only ever modify next element!
      if (!nextElement) {
        return;
      }

      const prevElement = prevElements.get(element.id);
      const nextVersion =
        applyDirection === "forward"
          ? nextElement.version + 1
          : nextElement.version - 1;

      const elementUpdates = updates as ElementUpdate<OrderedExcalidrawElement>;

      let affectedElement: OrderedExcalidrawElement;

      if (prevElement === nextElement) {
        // create the new element instance in case we didn't modify the element yet
        // so that we won't end up in an incosistent state in case we would fail in the middle of mutations
        affectedElement = newElementWith(
          nextElement,
          {
            ...elementUpdates,
            version: nextVersion,
          },
          true,
        );
      } else {
        affectedElement = mutateElement(nextElement, nextElements, {
          ...elementUpdates,
          // don't modify the version further, if it's already different
          version:
            prevElement?.version !== nextElement.version
              ? nextElement.version
              : nextVersion,
        });
      }

      nextAffectedElements.set(affectedElement.id, affectedElement);
      nextElements.set(affectedElement.id, affectedElement);
    };

    // removed delta is affecting the bindings always, as all the affected elements of the removed elements need to be unbound
    for (const id of Object.keys(this.removed)) {
      ElementsDelta.unbindAffected(prevElements, nextElements, id, updater);
    }

    // added delta is affecting the bindings always, all the affected elements of the added elements need to be rebound
    for (const id of Object.keys(this.added)) {
      ElementsDelta.rebindAffected(prevElements, nextElements, id, updater);
    }

    // updated delta is affecting the binding only in case it contains changed binding or bindable property
    for (const [id] of Array.from(Object.entries(this.updated)).filter(
      ([_, delta]) =>
        Object.keys({ ...delta.deleted, ...delta.inserted }).find((prop) =>
          bindingProperties.has(prop as BindingProp | BindableProp),
        ),
    )) {
      const updatedElement = nextElements.get(id);
      if (!updatedElement || updatedElement.isDeleted) {
        // skip fixing bindings for updates on deleted elements
        continue;
      }

      ElementsDelta.rebindAffected(prevElements, nextElements, id, updater);
    }

    // filter only previous elements, which were now affected
    const prevAffectedElements = new Map(
      Array.from(prevElements).filter(([id]) => nextAffectedElements.has(id)),
    );

    // calculate complete deltas for affected elements, and squash them back to the current deltas
    this.squash(
      // technically we could do better here if perf. would become an issue
      ElementsDelta.calculate(prevAffectedElements, nextAffectedElements),
    );

    return nextAffectedElements;
  }

  /**
   * Non deleted affected elements of removed elements (before and after applying delta),
   * should be unbound ~ bindings should not point from non deleted into the deleted element/s.
   */
  /**
   * 处理删除元素的绑定清理（应用前 + 应用后各一次）。
   *
   * 传两次是因为元素实例可能在应用 delta 时被替换：prevElement 是被删
   * 之前的样子，nextElement 是删除态。两边的绑定都要解，否则会留下
   * “指向已删除元素”的单向绑定。
   */
  private static unbindAffected(
    prevElements: SceneElementsMap,
    nextElements: SceneElementsMap,
    id: string,
    updater: (
      element: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) {
    // the instance could have been updated, so make sure we are passing the latest element to each function below
    const prevElement = () => prevElements.get(id); // element before removal
    const nextElement = () => nextElements.get(id); // element after removal

    BoundElement.unbindAffected(nextElements, prevElement(), updater);
    BoundElement.unbindAffected(nextElements, nextElement(), updater);

    BindableElement.unbindAffected(nextElements, prevElement(), updater);
    BindableElement.unbindAffected(nextElements, nextElement(), updater);
  }

  /**
   * Non deleted affected elements of added or updated element/s (before and after applying delta),
   * should be rebound (if possible) with the current element ~ bindings should be bidirectional.
   */
  /**
   * 处理新增/更新元素的绑定重建，使绑定保持双向。
   *
   * 顺序有意为之：先解绑旧态（prev），再按新态（next）重绑——直接重绑
   * 会在旧绑定仍存在时产生重复条目。文本元素在 BindableElement 阶段
   * 只解绑不重绑：箭头绑定由 BoundElement 负责，文本没有 start/endBinding
   * 可用来重建（TODO #7348）。
   */
  private static rebindAffected(
    prevElements: SceneElementsMap,
    nextElements: SceneElementsMap,
    id: string,
    updater: (
      element: ExcalidrawElement,
      updates: ElementUpdate<ExcalidrawElement>,
    ) => void,
  ) {
    // the instance could have been updated, so make sure we are passing the latest element to each function below
    const prevElement = () => prevElements.get(id); // element before addition / update
    const nextElement = () => nextElements.get(id); // element after addition / update

    BoundElement.unbindAffected(nextElements, prevElement(), updater);
    BoundElement.rebindAffected(nextElements, nextElement(), updater);

    BindableElement.unbindAffected(
      nextElements,
      prevElement(),
      (element, updates) => {
        // we cannot rebind arrows with bindable element so we don't unbind them at all during rebind (we still need to unbind them on removal)
        // TODO: #7348 add startBinding / endBinding to the `BoundElement` context so that we could rebind arrows and remove this condition
        if (isTextElement(element)) {
          updater(element, updates);
        }
      },
    );
    BindableElement.rebindAffected(nextElements, nextElement(), updater);
  }

  /**
   * 应用 delta 之后的几何重算：文本包围盒与绑定箭头。
   *
   * 顺序不能反：先文本后箭头，因为箭头端点依赖文本/容器的最终尺寸。
   * 用临时 Scene 是因为此时可能没有可用的真实 Scene（历史回放中、
   * 服务端同步中），但重算 API 需要 Scene 接口。
   */
  public static redrawElements(
    nextElements: SceneElementsMap,
    changedElements: Map<string, OrderedExcalidrawElement>,
    renderEnvironment?: RenderEnvironment,
  ) {
    try {
      // we don't have an up-to-date scene, as we can be just in the middle of applying history entry
      // we also don't have a scene on the server
      // so we are creating a temp scene just to query and mutate elements
      const tempScene = new Scene(nextElements, { skipValidation: true });

      ElementsDelta.redrawTextBoundingBoxes(
        tempScene,
        changedElements,
        renderEnvironment,
      );

      // needs ordered nextElements to avoid z-index binding issues
      ElementsDelta.redrawBoundArrows(
        tempScene,
        changedElements,
        renderEnvironment,
      );
    } catch (e) {
      console.error(`Couldn't redraw elements`, e);

      if (isTestEnv() || isDevEnv()) {
        throw e;
      }
    } finally {
      return nextElements;
    }
  }

  /**
   * 收集需要在本次重算里更新包围盒的容器/文本配对。
   *
   * 两种方向都要处理：变更的是绑定文本（找容器）与变更的是容器（找
   * 绑定文本）。用 Map 以容器 id 去重，避免同一对在一次应用里重算两遍。
   * 任一一方已删除则跳过——重算没有意义，还可能把墓碑元素重新算活。
   */
  private static redrawTextBoundingBoxes(
    scene: Scene,
    changed: Map<string, OrderedExcalidrawElement>,
    renderEnvironment?: RenderEnvironment,
  ) {
    const elements = scene.getNonDeletedElementsMap();
    const boxesToRedraw = new Map<
      string,
      { container: OrderedExcalidrawElement; boundText: ExcalidrawTextElement }
    >();

    for (const element of changed.values()) {
      if (isBoundToContainer(element)) {
        const { containerId } = element as ExcalidrawTextElement;
        const container = containerId ? elements.get(containerId) : undefined;

        if (container) {
          boxesToRedraw.set(container.id, {
            container,
            boundText: element as ExcalidrawTextElement,
          });
        }
      }

      if (hasBoundTextElement(element)) {
        const boundTextElementId = getBoundTextElementId(element);
        const boundText = boundTextElementId
          ? elements.get(boundTextElementId)
          : undefined;

        if (boundText) {
          boxesToRedraw.set(element.id, {
            container: element,
            boundText: boundText as ExcalidrawTextElement,
          });
        }
      }
    }

    for (const { container, boundText } of boxesToRedraw.values()) {
      if (container.isDeleted || boundText.isDeleted) {
        // skip redraw if one of them is deleted, as it would not result in a meaningful redraw
        continue;
      }

      redrawTextBoundingBox(boundText, container, scene, renderEnvironment);
    }
  }

  /**
   * 箭头端点重算。只处理“未删除且可绑定”的元素（形状或箭头）。
   *
   * 这里传入了 changed 集合，updateBoundElements 可据此跳过未受影响的
   * 元素，避免历史回放时对全场景做精确绑定计算（昂贵）。
   */
  private static redrawBoundArrows(
    scene: Scene,
    changed: Map<string, OrderedExcalidrawElement>,
    renderEnvironment?: RenderEnvironment,
  ) {
    for (const element of changed.values()) {
      if (!element.isDeleted && isBindableElement(element)) {
        // TODO: with precise bindings this is quite expensive, so consider optimisation so it's only triggered when the arrow does not intersect (imprecise) element bounds
        updateBoundElements(
          element as NonDeletedExcalidrawElement, // NOTE: Assumed correct, no runtime check for isDeleted due to performance reasons
          scene,
          {
            changedElements: changed,
            renderEnvironment,
          },
        );
      }
    }
  }

  /**
   * 按 fractional index 重排元素，并修复被移动元素的 index 值。
   *
   * 仅在 flags.containsZindexDifference 时执行（index 真的变了）。只把
   * “移动且在 changed 集合里”的元素交给 syncMovedIndices，其余保持不变；
   * 若发现顺序差异则同时把 containsVisibleDifference 置 true，因为
   * z-order 变化对用户是可见的。
   */
  private static reorderElements(
    elements: SceneElementsMap,
    changed: Map<string, OrderedExcalidrawElement>,
    flags: {
      containsVisibleDifference: boolean;
      containsZindexDifference: boolean;
    },
  ) {
    if (!flags.containsZindexDifference) {
      return elements;
    }

    const unordered = Array.from(elements.values());
    const ordered = orderByFractionalIndex([...unordered]);
    const moved = Delta.getRightDifferences(unordered, ordered, true).reduce(
      (acc, arrayIndex) => {
        const candidate = unordered[Number(arrayIndex)];
        if (candidate && changed.has(candidate.id)) {
          acc.set(candidate.id, candidate);
        }

        return acc;
      },
      new Map(),
    );

    if (!flags.containsVisibleDifference && moved.size) {
      // we found a difference in order!
      flags.containsVisibleDifference = true;
    }

    // synchronize all elements that were actually moved
    // could fallback to synchronizing all invalid indices
    return arrayToMap(syncMovedIndices(ordered, moved)) as typeof elements;
  }

  /**
   * It is necessary to post process the partials in case of reference values,
   * for which we need to calculate the real diff between `deleted` and `inserted`.
   *
   * 中文：元素级 postProcess 只处理两个引用字段。
   * - boundElements：差分到 per-id，才能做双向回滚；
   * - points：刻意不做“无差异就删除”以外的处理。点在多人协作下没有
   *   fractional index 保证顺序一致，合并必然产生错位，所以宁可整段保留。
   */
  private static postProcess(
    deleted: ElementPartial,
    inserted: ElementPartial,
  ): [ElementPartial, ElementPartial] {
    try {
      Delta.diffArrays(deleted, inserted, "boundElements", (x) => x.id);

      // don't diff the points as:
      // - we can't ensure the multiplayer order consistency without fractional index on each point
      // - we prefer to not merge the points, as it might just lead to unexpected / incosistent results
      const deletedPoints =
        (
          deleted as ElementPartial<
            ExcalidrawFreeDrawElement | ExcalidrawLinearElement
          >
        ).points ?? [];

      const insertedPoints =
        (
          inserted as ElementPartial<
            ExcalidrawFreeDrawElement | ExcalidrawLinearElement
          >
        ).points ?? [];

      if (!Delta.isDifferent(deletedPoints, insertedPoints)) {
        // delete the points from delta if there is no difference, otherwise leave them as they were captured due to consistency
        Reflect.deleteProperty(deleted, "points");
        Reflect.deleteProperty(inserted, "points");
      }
    } catch (e) {
      // if postprocessing fails, it does not make sense to bubble up, but let's make sure we know about it
      console.error(`Couldn't postprocess elements delta.`);

      if (isTestEnv() || isDevEnv()) {
        throw e;
      }
    } finally {
      return [deleted, inserted];
    }
  }

  /**
   * 剔除不需要进增量的字段：id（桶的 key 已经是 id）与 updated
   * （时间戳每次都变，进增量会制造无意义的差异，撤销时也不该被回滚）。
   */
  private static stripIrrelevantProps(
    partial: Partial<OrderedExcalidrawElement>,
  ): ElementPartial {
    const { id, updated, ...strippedPartial } = partial;

    return strippedPartial;
  }
}
