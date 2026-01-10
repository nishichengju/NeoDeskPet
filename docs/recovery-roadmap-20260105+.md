# NeoDeskPet 丢失功能找回路线图（参考 2026-01-05+ 操作日志）

日期：2026-01-06  
执行者：Codex  
项目：`NeoDeskPet-electron`  
依据：`NeoDeskPet-electron/.codex/operations-log.md`（从 `## 2026-01-05` 起）

## 0. 本次约束（按你的要求）

1) 识图相关：**先不改、不扩展**（包括截图→喂图、看图提示词、视觉管线、watch 等）  
2) Live2D：动作/表情触发方式与现状保持一致（不改触发协议、不新增硬编码动作表情映射）

## 1. 先说结论：目前“丢失”的本质

你这几天看到的“功能没了/不见了/变慢了”，常见原因不是“代码消失”，而是：

- 运行的不是你期待的那一套代码（例如被 `git restore .` 回退、或启动了旧的 `dist-electron`）  
- AppData 配置（`%APPDATA%\\neodeskpet-electron\\neodeskpet-settings.json`）被删除/损坏，导致 UI 开关回到默认  
- 你在日志里记录过的功能，其实现可能在某个分支/备份里，但没被合到你当前运行的版本

本路线图的目的：把 1 月 5 日之后日志里明确提到的“增量功能”逐项对齐回来，并给出可验收的恢复步骤。

## 2. 目标：把哪些功能“找回来”

以下条目来自 `operations-log.md` 的 2026-01-05+ 部分。每个条目包含：

- 日志目标（当时要解决什么）
- 当前分支现状（是否已经存在/是否不一致）
- 恢复方案（要改哪些文件）
- 验收方式（怎么确认恢复成功）

### P0（优先级最高）：避免“配置一坏就炸”导致反复掉功能

日志背景：你已经经历过 settings JSON 损坏（BOM/乱码/非 JSON）导致应用直接起不来。

当前现状：已做基础容错（坏 JSON 回退 defaults），但建议把“恢复流程”文档化并固定下来。

恢复方案（不改功能，只加兜底与自检）：
- 统一给出“检查当前运行版本/配置是否生效”的步骤（见第 4 节）

验收：
- 即使 `neodeskpet-settings.json` 被写坏，应用也能启动并提示回退默认（而不是直接崩溃）

### P1：聊天界面工具卡片默认折叠（避免刷屏）

日志线索：你多次提到“疯狂出工具卡片”“希望默认折叠”，并且 VCP 的体验也是“默认折叠，必要时展开”。

当前现状（不一致）：
- `src/App.tsx` 的 `<details className="ndp-tooluse" open={open}>` 默认 `open=true`（没有记录时也会展开）。
- 代码位置：`NeoDeskPet-electron/src/App.tsx` 约 `toolUseOpenByTaskId` 逻辑处。

恢复方案：
- 默认值改为折叠：当 `toolUseOpenByTaskId[taskId]` 未设置时，`open` 应为 `false`。
- 保持可用性：用户点开后记住该 taskId 的 open 状态；新 task 默认折叠。

验收：
- 触发任意工具任务时，聊天消息里工具卡片默认是折叠状态；点击后可展开看到 in/out/err。

### P1：桌宠任务面板“最近任务短暂显示”（60s）与 DONE 自动消失

日志目标（2026-01-05）：
- 解决“任务面板完全看不见”：如果任务瞬间从 running→done/failed，面板不渲染会让人以为没触发。
- 方案：当没有进行中任务时，短暂显示最近终态任务（默认 60s）。

当前现状（缺失）：
- PetWindow 只展示 `pending/running/paused`：`const visibleTasks = tasks.filter(...)`（终态不展示）。
- 代码位置：`NeoDeskPet-electron/src/App.tsx`（PetWindow 内任务面板渲染）。

恢复方案（保持 Live2D 不动）：
- 增加 `recentTerminalTasks` 计算：
  - 当 `visibleTasks` 为空时，从 `done/failed/canceled` 里筛选 `now - updatedAt <= 60000` 的任务作为短暂展示。
- 同时解决你近期提到的 “DONE 完了能不能自己消失”：
  - 任务进入终态后，超过 60s 不再出现在桌宠面板；
  - 或者（更干脆）在终态后自动调用 `dismissTask`（但这会改动“任务历史保留策略”，需你确认是否要自动清理记录）。

验收：
- 触发一个很快结束的任务：即使瞬间 done，也能在桌宠面板出现（最多 60s）。
- 60s 后任务面板自动恢复为空（不再长期挂着 DONE/FAILED）。

### P1：MCP 配置 `streamable_http` 支持（解决 “command 不能为空”）

日志目标（2026-01-06，日志中有相关描述但在截断处）：
- 让工具中心/MCP 配置兼容 `{type:'streamable_http', url:'...'}` 这种外部常见配置写法。

当前现状（缺失）：
- 当前类型与实现只支持 `stdio`：
  - `electron/types.ts`: `export type McpTransport = 'stdio'`
  - `electron/mcpManager.ts`: 使用 `StdioClientTransport`
  - UI 提示：`仅支持 stdio`

恢复方案（先做“能保存/能显示/能报错”，再做“能连通”）：
1) 类型层：扩展 transport union：`'stdio' | 'streamable_http'`
2) 配置层：`store.ts` 的 normalize 兼容 `type/url` 字段映射到内部结构（或单独加一套字段）
3) UI：工具中心增加 `streamable_http` 表单项（url + headers/token 等）
4) 运行层：mcpManager 增加对应的 transport（如果 SDK 不支持，需要用你现有的 MCP 连接实现；若暂不实现，至少在连接时明确报错“暂不支持该 transport”而不是保存阶段就拦掉）

验收：
- 用户粘贴如下配置后，工具中心能保存并显示，不再报“command 不能为空”：
  ```json
  {"type":"streamable_http","url":"https://.../mcp"}
  ```

### P2：记忆 embedding 去重（M5.5）+ 阈值可调

日志目标（2026-01-05）：
- 高并发对话下相同/高度相似的记忆大量重复写入；通过 embedding 相似度去重，并提供阈值调节。

当前现状（缺失/未对齐）：
- 当前 `memoryService.ts` 中没有完整的 “M5.5 写入侧去重 + 后台维护去重”实现痕迹（至少以关键字 `dedupe`/相关字段来看不在当前分支）。
- UI 中目前只有向量召回参数（`vectorMinScore/vectorTopK/vectorScanLimit`），不等价于“写入去重阈值”。

恢复方案（不依赖识图）：
1) 在 `electron/types.ts` 的 MemorySettings 增加 dedupe 配置（enabled + minScore + scanLimit）
2) 在 `electron/store.ts` 增加默认值与 normalize
3) 在 `electron/memoryService.ts`：
   - 写入侧精确去重：同 persona/kind/role 且 content 完全一致则 upsert/skip
   - 后台语义去重：对新写入条目进行 embedding 相似度检索，命中则合并并删除重复
4) 在 `src/App.tsx` 的记忆设置区增加阈值滑条/输入框（位置：设置页更合适，避免控制台分散）

验收：
- 连续多次写入相同内容：数据库条目数量不再线性增长（要么更新 existing，要么合并）。
- 调高/调低阈值会影响去重命中率（可通过 debug 日志观察）。

### P2：记忆控制台选中不抢光标（鼠标瞬移）

日志目标（2026-01-05）：
- 选中条目后不自动 focus 编辑框；只有用户本来就在编辑（编辑框已 focus）时，刷新列表才恢复 focus，并尽量 `preventScroll`。

当前现状（不一致）：
- 现在仍存在“选中条目就 focus”的逻辑：`useEffect([activeRowid]) -> activeEditRef.current?.focus()`。
- 代码位置：`NeoDeskPet-electron/src/windows/MemoryConsoleWindow.tsx`

恢复方案：
- 引入 `activeEditHadFocusRef`：
  - 记录切换条目前编辑框是否处于 focus；
  - 若否，则切换条目后不主动 focus；
  - 若是，则在必要时恢复 focus，并使用 `focus({preventScroll:true})`（浏览器支持时）。

验收：
- 用鼠标点选不同记忆条目时，光标不会被强行抢走；但当你本来就在编辑框打字时，刷新列表不会导致编辑框失焦。

## 3. 恢复顺序建议（不碰识图、Live2D 保持现状）

建议顺序（从“立刻缓解痛苦”到“长期治理”）：

1) 工具卡片默认折叠（P1）
2) 任务面板最近任务短暂展示 + DONE 自动消失（P1）
3) MCP `streamable_http` 先做“能配置/能显示/能报错”（P1）
4) 记忆控制台不抢光标（P2）
5) 记忆 embedding 去重（P2）

## 4. 自检清单：避免“我以为没了，其实是没跑到那版代码”

### 4.1 确认运行的是正确代码

- 开发模式：在 `G:\\DeskPet\\NeoDeskPet-electron` 执行 `npm run dev:reset` 后再测试。
- 生产模式：执行 `npm run build` 后使用新的产物启动（不要用旧的 dist/旧 exe）。

### 4.2 确认配置没被重置

检查 `%APPDATA%\\neodeskpet-electron\\neodeskpet-settings.json` 里这些关键字段：
- `orchestrator.toolCallingEnabled`
- `orchestrator.toolCallingMode`
- `tools.enabled`
- `mcp.enabled` 与 `mcp.servers`

### 4.3 快速判断“工具/任务面板是否真的在工作”

在聊天窗口 DevTools Console 里：

- `window.neoDeskPet.getSettings().then(console.log)`
- `window.neoDeskPet.listTasks().then(console.log)`
- `window.neoDeskPet.createTask({title:'任务面板测试',steps:[{title:'等1秒',tool:'delay.sleep',input:'{\"ms\":1000}'}]})`

## 5. 后续协作方式（你只要回答 3 个问题）

为了避免再次“改着改着乱套”，在开始恢复前我只需要你确认：

1) DONE 任务要不要自动从任务列表里“彻底清除记录”？还是只从桌宠面板消失但列表保留？  
2) MCP `streamable_http` 是只要“能配置+能调用”即可，还是也要在工具中心里显示 session/过期并可一键重连？  
3) 记忆 embedding 去重：去重命中后是“合并内容”还是“保留新条并删除旧条”？（日志里是合并+删重复）

