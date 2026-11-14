# Excalidraw 核心链路阅读指南

> 对应上游提交：`82d5847e`（2026-11-12，depth=1 clone）。
> 注释口径：DENSITY-CALIBER v1（X = 整行注释行 ÷ 代码行，Y = 非空注释行 ÷ 代码行）。
> 本仓只做阅读与注释，不改上游代码逻辑。

## 0. 这份指南解决什么问题

Excalidraw 的代码量集中在几个“编排层”大文件里：`packages/excalidraw/components/App.tsx`
约 10,500 行，`packages/element/src/binding.ts` 约 3,900 行，
`packages/excalidraw/renderer/interactiveScene.ts` 约 2,400 行。直接按目录顺序读，
很容易陷进 React 生命周期和 DOM 事件，却始终没建立“元素为什么长这样”的模型。

本指南给出一条从**数据模型**到**渲染/交互/协作**的阅读顺序，并在每个节点标出
读完后应该能回答的问题。源码里的中文注释按同一条链路补充，可以对照阅读。

---

## 1. 前置知识

不要求精通，但至少要知道这些概念在解决什么问题：

| 主题 | 需要知道的部分 | 在 Excalidraw 里的落点 |
|---|---|---|
| TypeScript 泛型与 branded type | `Readonly<T>`、交叉类型、`MakeBrand` | `types.ts` 的 `Ordered` / `NonDeleted` |
| React 类组件与 ref | `setState`、`componentDidUpdate`、`useRef` | `App.tsx` 的编排、画布组件的 ref |
| Canvas 2D | `save/restore`、`setTransform`、`scale`、`globalAlpha` | `renderer/staticScene.ts`、`interactiveScene.ts` |
| roughjs | `Drawable` 与 seed 决定手绘纹理 | 元素 `seed`、`ShapeCache` |
| fractional index | 用字符串/数字槽位在任意两项间插入 | 元素 `index`、`syncInvalidIndices` |
| 协作冲突裁决 | 不是 CRDT；是“版本号 + 随机 tie-break” | `data/reconcile.ts` |
| socket.io / Firebase 事务 | 实时广播与异步持久化的区别 | `collab/Collab.tsx`、`collab/Portal.tsx`、`data/firebase.ts` |

**重要**：Excalidraw 没有使用 Yjs/CRDT。协作是“每个元素带 `version` 与
`versionNonce`，双方各自 reconcile”的模型。不要用 CRDT 的直觉去理解它。

---

## 2. 从哪个文件开始读（以及为什么不从 App.tsx 开始）

**建议起点：`packages/element/src/types.ts`。**

最容易想到的入口是 `packages/excalidraw/index.tsx` 或 `components/App.tsx`，但不建议：

- `App.tsx` 是编排层，同时管 UI 状态、指针手势、历史、文件 IO、协作回调；
  它假设你已经知道 `version`/`versionNonce`/`isDeleted`/`index` 的语义。
- 先读它会把“为什么一次拖拽只产生一条历史”“为什么远端更新不进 undo 栈”
  这类问题留成悬念，后面每个文件都要重新建立上下文。
- `index.tsx` 只是导出与挂载，几乎不含链路信息。

先读 `types.ts`，建立四个不变量，再往下走：

1. **元素是普通可序列化对象**，没有 computed 字段；渲染缓存挂在对象外。
2. **`version` 单调递增，`versionNonce` 每次修改随机**；两者共同决定冲突胜负。
3. **删除是软删除**：`isDeleted = true` 且推进版本，元素仍留在集合里当墓碑。
4. **`index` 是排序键**，不是数组下标；跨端顺序由它决定。

读完 `types.ts` 后按第 3 节 A 段继续，不要跳回 `App.tsx`。

---

## 3. 分段路线

### A. 元素模型与不可变更新（建议 1~2 小时）

| 顺序 | 文件 | 重点 | 读完能回答 |
|---|---|---|---|
| A1 | `packages/element/src/types.ts` | 元素联合类型、`version`/`versionNonce`、`isDeleted`、`index`、绑定类型 | 一个元素在磁盘/网络上长什么样？ |
| A2 | `packages/element/src/mutateElement.ts` | `mutateElement` 就地改 + 推进版本；`newElementWith` 不可变副本 | 为什么类型是 Readonly 还能改？谁负责版本？ |
| A3 | `packages/element/src/Scene.ts` | 元素数组 + id Map + 派生视图；`replaceAllElements`、`getSelectedElements` 缓存 | 当前帧的元素集合如何索引？sceneNonce 是什么？ |
| A4 | `packages/element/src/store.ts` | `CaptureUpdateAction`、`commit`、快照 diff、增量发射 | 一次手势为什么只记一条历史？快照何时前进？ |
| A5 | `packages/element/src/delta.ts` | `ElementsDelta` 三桶、`calculate`、`applyTo`、`resolveConflicts` | 正反两向的字段级增量如何表达删除？ |
| A6 | `packages/excalidraw/data/reconcile.ts` | 逐元素裁决：version 大者胜、同 version 取 versionNonce 小者 | 两个 peer 同时改同一元素会怎样？ |

这一段的核心闭环：

```
用户操作 → 就地 mutate（version+1, versionNonce 随机）
        → React 提交 → Store.commit
        → 与上次快照 diff → StoreDelta（added/removed/updated）
        → IMMEDIATELY 时发 DurableIncrement → History.record
```

### B. 变更历史与撤销重做（约 30 分钟）

| 顺序 | 文件 | 重点 |
|---|---|---|
| B1 | `packages/excalidraw/history.ts` | `HistoryDelta` 反向应用；**回放排除 version/versionNonce**；`record` 拒绝重复记录 |
| B2 | `packages/excalidraw/actions/actionHistory.tsx` | 手势进行中禁止撤销；成功回放返回 `captureUpdate: NEVER` |

读完后应能解释：为什么撤销之后元素内容回到过去，但版本号继续向前？
答案：否则协同方会认为这次撤销是过期更新并丢弃它。

### C. 渲染管线（约 1~2 小时）

| 顺序 | 文件 | 重点 |
|---|---|---|
| C1 | `packages/excalidraw/scene/types.ts` | 渲染输入契约：`StaticSceneRenderConfig`、`RenderableElementsMap` |
| C2 | `packages/excalidraw/scene/Renderer.ts` | 视口裁剪；frame 悬停时的临时排序；memoize key |
| C3 | `packages/excalidraw/renderer/staticScene.ts` | 全量重绘可见元素；`bootstrapCanvas`；普通元素与 embeddable 两趟 |
| C4 | `packages/excalidraw/renderer/helpers.ts` | 设备像素吸附；画布初始化顺序 |
| C5 | `packages/excalidraw/viewport.ts` | 聚焦缩放推导；`zoomToFitBounds`；滚动锁定 |
| C6 | `packages/excalidraw/components/canvases/StaticCanvas.tsx` | props → canvas 尺寸 → 触发绘制；memo 比较 |
| C7 | `packages/excalidraw/renderer/interactiveScene.ts` | 交互覆盖层；手柄按 zoom 反算；动画状态帧间传递 |
| C8 | `packages/excalidraw/components/canvases/InteractiveCanvas.tsx` | AnimationController 循环；协作光标反向索引 |

**这里没有脏矩形。** 静态画布每帧重绘 `visibleElements`；性能来自
视口裁剪 + 元素级 `ShapeCache` + 每个 canvas 独立的 rAF 节流。
所谓“重绘范围”就是 `Renderer.getRenderableElements()` 的结果，不要去搜 dirtyRect。

### D. 交互层（约 1~2 小时）

| 顺序 | 文件 | 重点 |
|---|---|---|
| D1 | `packages/excalidraw/components/App.selection.ts` | 选择状态的纯函数；组展开；frame 优先于子元素 |
| D2 | `packages/excalidraw/components/App.selectionTool.ts` | pointerdown 决定分支；拖拽阈值；alt-click 循环选择；框选模式 |
| D3 | `packages/element/src/transformHandles.ts` | 手柄位置；手柄尺寸 ÷ zoom；按元素类型省略手柄 |
| D4 | `packages/element/src/resizeElements.ts` | 手势起点快照；负宽高翻转；绑定文本最小尺寸；多选整体映射 |
| D5 | `packages/excalidraw/snapping.ts` | point/gap snap；两遍吸附；`SNAP_DISTANCE / zoom`；SnapCache 生命周期 |
| D6 | `packages/element/src/binding.ts` | 固定点绑定；`updateBoundPoint` 轮廓求交；删除后清理绑定 |

交互层的统一原则：**pointerdown 只做判断并记录状态，pointermove 不再重新判断
用户意图**。所有临时几何都写在元素上，但历史在 pointerup 后由 Store 统一 capture。

### E. 协作同步（约 1 小时，可选）

| 顺序 | 文件 | 重点 |
|---|---|---|
| E1 | `excalidraw-app/collab/Collab.tsx` | restore → reconcile → bumpElementVersions；`CaptureUpdateAction.NEVER`；回声抑制 |
| E2 | `excalidraw-app/collab/Portal.tsx` | socket 事件与加密广播；INIT/UPDATE/MOUSE_LOCATION 等消息类型 |
| E3 | `excalidraw-app/data/index.ts` | `isSyncableElement`：24h 内的删除墓碑仍参与同步 |
| E4 | `excalidraw-app/data/firebase.ts` | 保存走事务：读库存 → restore → reconcile → 写回 |
| E5 | `packages/excalidraw/data/reconcile.ts` | 与 A6 同一套裁决规则，实时与持久化共用 |

协作链路与元素模型的关系可以一句话概括：
**协作不引入新的数据结构，只给元素模型增加了“版本如何裁决、墓碑保留多久”两条规则。**

---

## 4. 分支主题从哪跳

| 你想看…… | 跳到 | 说明 |
|---|---|---|
| 箭头为什么粘在矩形边上 | `element/src/binding.ts` 的 `updateBoundPoint` | 固定点 + 轮廓求交 |
| 拖拽时对齐线怎么来的 | `excalidraw/snapping.ts` 的 `snapDraggedElements` | 两遍计算，第二遍只为画线 |
| frame 裁剪/悬停预览 | `scene/Renderer.ts` + `element/src/frame.ts` | 先排序修正，再裁剪 |
| 导出图片为什么和屏幕不一样 | `renderer/staticScene.ts` 的 `isExporting` 分支 | 导出不吸附 scroll、不画 UI |
| 为什么撤销能同步给别人 | `history.ts` 的 `perform` + `store.scheduleMicroAction` | 撤销本身也是一条增量 |
| 为什么别人改的东西 Ctrl+Z 撤不掉 | `collab/Collab.tsx` 的 `handleRemoteSceneUpdate` | `CaptureUpdateAction.NEVER` |
| 元素刚创建时的版本号 | `element/src/newElement.ts` 的 `_newElementBase` | version=1，versionNonce=0 |
| 文本编辑器在哪画 | `components/App.tsx` 的文本编辑覆盖层 + `interactiveScene.ts` | 文本走 DOM，不走 canvas |
| 滚动锁定的橡皮筋 | `viewport.ts` 的 `DEFAULT_OVERSCROLL` | 屏幕像素，不随 zoom 变 |

---

## 5. 哪些可以跳过

首轮建立链路时可以完全跳过：

- `packages/excalidraw/locales/**`：纯翻译资源。
- `packages/excalidraw/components/**` 中除 `App.tsx`、`App.selection*.ts`、
  `canvases/*` 之外的 UI 组件（工具栏、侧边栏、对话框）。
- `packages/excalidraw/charts/**`、`packages/excalidraw/clipboard.ts`、
  `packages/excalidraw/data/*` 中除 `reconcile.ts` 之外的文件。
- `excalidraw-app/share/**`、`excalidraw-app/app-language/**`。
- 所有 `*.test.ts(x)`、`__snapshots__`、`examples/**`。
- `packages/element/src/transform.ts`：名字像“变换”，实际是
  “元素骨架/模板转正式元素”的构造函数，不属于交互变换链路。
  真正的手柄与缩放看 `transformHandles.ts` 与 `resizeElements.ts`。
- `packages/utils/**`、`packages/math/**`：需要时按函数名查即可。

---

## 6. 已知的坑（注释里也标了）

1. **“谁在用它”最容易写错。** 本仓注释里所有调用关系断言都回到调用点用
   grep 确认过；后续补注释时也请先查调用点，再写“XX 调用了它”。
2. `mutateElement` 不是不可变更新，它就地改对象并推进版本；真正不可变的是
   `newElementWith` 与 Store 快照。
3. `versionNonce` 不是“随机 ID”，它是 version 相同时的确定性 tie-break；
   比较方向必须所有 peer 一致。
4. `isDeleted` 不是硬删除；墓碑会在同步/持久化里保留 24 小时。
5. 静态画布没有脏矩形；不要按“局部重绘”去理解性能模型。
6. 协作不是 CRDT，没有 Yjs；合并规则就是 `reconcile.ts` 那几行。
7. `Scene.sceneNonce` 是渲染缓存令牌，不是元素版本号；拖拽中的新元素可能
   不 bump 它，所以 `Renderer` 对特定新元素额外拼 `versionNonce`。
8. `HistoryDelta` 回放时排除 `version/versionNonce`，这是撤销能被协同方
   接受的关键，不要“顺手补全”。

---

## 7. 注释密度与覆盖

已注释 26 个核心文件，全部按 DENSITY-CALIBER v1 达到 X ≥ 30%（Y 同步给出）。
逐文件数据见同目录 `INDEX.md`。注意：本仓的“深度注释”是**链路级 + 关键算法级**，
不是逐行翻译；大文件（`binding.ts`、`interactiveScene.ts`、`snapping.ts`、
`delta.ts`）重点覆盖入口、状态机与易错分支，未覆盖的纯样板代码可以按函数名跳读。
