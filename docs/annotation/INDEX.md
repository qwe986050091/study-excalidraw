# 注释索引与验收台账

- 上游：`excalidraw/excalidraw`，提交 `82d5847e`（2026-11-12），`--depth 1`
- 口径：DENSITY-CALIBER v1
  - X = 整行注释行 ÷ 代码行
  - Y = （注释行 − 空注释行）÷ 代码行
  - 代码行 = 总行 − 空行 − 注释行
- 范围：核心链路 26 个文件；不逐行翻译，覆盖入口/状态机/关键算法/易错分支。

## 1. 链路映射

| 链路 | 文件 |
|---|---|
| A 元素模型与不可变更新 | `element/src/types.ts`、`mutateElement.ts`、`Scene.ts`、`store.ts`、`delta.ts`、`excalidraw/data/reconcile.ts` |
| B 历史与撤销 | `excalidraw/history.ts`、`excalidraw/actions/actionHistory.tsx` |
| C 渲染管线 | `excalidraw/scene/types.ts`、`scene/Renderer.ts`、`renderer/staticScene.ts`、`renderer/helpers.ts`、`renderer/interactiveScene.ts`、`viewport.ts`、`components/canvases/StaticCanvas.tsx`、`InteractiveCanvas.tsx` |
| D 交互层 | `excalidraw/components/App.selection.ts`、`App.selectionTool.ts`、`element/src/transformHandles.ts`、`resizeElements.ts`、`excalidraw/snapping.ts`、`element/src/binding.ts` |
| E 协作同步 | `excalidraw-app/collab/Collab.tsx`、`data/index.ts`、`data/firebase.ts`（`Portal.tsx` 为传输层，按需阅读） |

## 2. 逐文件密度（实测）

| 链路 | 文件 | 代码行 | 注释行 | X | Y |
|---|---|---|---:|---:|---:|---:|
| A | packages/element/src/types.ts | 346 | 157 | 45.38% | 45.38% |
| A | packages/element/src/mutateElement.ts | 153 | 52 | 33.99% | 33.99% |
| A | packages/element/src/Scene.ts | 332 | 102 | 30.72% | 30.72% |
| A | packages/element/src/store.ts | 722 | 219 | 30.33% | 30.33% |
| A | packages/element/src/delta.ts | 1668 | 607 | 36.39% | 36.33% |
| A | packages/excalidraw/data/reconcile.ts | 91 | 42 | 46.15% | 46.15% |
| B | packages/excalidraw/history.ts | 198 | 67 | 33.84% | 33.84% |
| B | packages/excalidraw/actions/actionHistory.tsx | 133 | 48 | 36.09% | 36.09% |
| C | packages/excalidraw/scene/types.ts | 154 | 64 | 41.56% | 41.56% |
| C | packages/excalidraw/scene/Renderer.ts | 349 | 139 | 39.83% | 39.83% |
| C | packages/excalidraw/renderer/staticScene.ts | 558 | 210 | 37.63% | 37.63% |
| C | packages/excalidraw/renderer/helpers.ts | 115 | 48 | 41.74% | 40.87% |
| C | packages/excalidraw/renderer/interactiveScene.ts | 1869 | 577 | 30.87% | 30.87% |
| C | packages/excalidraw/viewport.ts | 390 | 128 | 32.82% | 32.56% |
| C | packages/excalidraw/components/canvases/StaticCanvas.tsx | 111 | 62 | 55.86% | 55.86% |
| C | packages/excalidraw/components/canvases/InteractiveCanvas.tsx | 280 | 90 | 32.14% | 32.14% |
| D | packages/excalidraw/components/App.selection.ts | 567 | 175 | 30.86% | 30.86% |
| D | packages/excalidraw/components/App.selectionTool.ts | 1244 | 390 | 31.35% | 31.35% |
| D | packages/element/src/transformHandles.ts | 314 | 130 | 41.40% | 41.40% |
| D | packages/element/src/resizeElements.ts | 1428 | 430 | 30.11% | 30.11% |
| D | packages/excalidraw/snapping.ts | 1192 | 368 | 30.87% | 30.87% |
| D | packages/element/src/binding.ts | 2923 | 961 | 32.88% | 32.88% |
| E | excalidraw-app/collab/Collab.tsx | 920 | 322 | 35.00% | 35.00% |
| E | excalidraw-app/data/index.ts | 260 | 116 | 44.62% | 44.62% |
| E | excalidraw-app/data/firebase.ts | 265 | 114 | 43.02% | 43.02% |
| E | packages/element/src/newElement.ts | 622 | 206 | 33.12% | 33.12% |
| **合计** | **26 个文件** | **17,204** | **5,824** | **33.85%** | **33.85%** |

- 全部文件 X ≥ 30%，最低为 `resizeElements.ts` 的 30.11%。
- X 与 Y 的差额仅来自 `helpers.ts`（1 行空注释）与 `delta.ts`（1 行空注释），
  其余文件 X = Y。

## 3. 校验

| 项 | 结果 |
|---|---|
| 语法解析（prettier `--no-config` 逐文件 parse） | 26/26 通过 |
| 代码行改动 | 无；`git diff --numstat` 的 deletions 仅出现在 6 个文件，均为替换上游英文注释，代码行未删除 |
| 空 `//` 凑数 | 无；仅 2 行历史空注释 |
| 「谁在用它」断言 | 写前均已 grep 调用点；`Collab.syncElements` 的调用方更正为 `excalidraw-app/App.tsx` 的 `onChange` |

## 4. 状态

- [x] 核心链路注释（26 文件）
- [x] `READING-GUIDE.md`
- [x] 本地 commit `d99d56d`
- [ ] 推送私有仓 `study-excalidraw`（GitHub 账号级限流，等待恢复）

## 5. 推送快照排除项

- 排除 `.github/workflows/`（12 个上游 CI 配置）：当前 gh token 无 `workflow`
  scope，GitHub 会拒绝包含 workflow 文件的推送；这些 CI 配置与源码阅读链路无关。
- 为此推送快照使用独立的 root commit（分支 `study`），不包含上游提交历史；
  本地 `master` 的注释提交 `d99d56d` 与上游 `origin` 均未改动。
