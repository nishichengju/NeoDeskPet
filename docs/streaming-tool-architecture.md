# NeoDeskPet 流式工具调用架构改造方案（单条消息不断流）

日期：2026-01-04  
执行者：Codex  
项目：`NeoDeskPet-electron`

## 1. 背景与痛点

当前体验在“需要工具”的请求上容易出现：
- 首字延迟：在真正开始输出回复前，先走一段阻塞式“规划/决策”。
- 断流感：用户体感是“第一段对话 → [工具调用] → 第二段对话”，并且第一段不一定能触发 Live2D。
- Live2D 不稳定：依赖文本标签解析/模型元数据/触发时机，导致偶发不触发。

目标是对齐参考项目的“不断流”体验：从首字开始流式输出，中途穿插多个工具卡片，工具完成后继续在同一条消息里流式追加内容。

## 2. 目标（必须满足）

1) **只有一条 assistant 消息**：一次用户输入只生成 1 条 assistant 消息，后续仅更新该消息的 blocks。  
2) **首字即流式**：无论是否需要工具，都从第一个 token 开始展示。  
3) **工具卡片可多张**：中途可插入多个工具卡片；默认折叠；显示“调用中(参数)”→“结果(折叠)”→继续输出。  
4) **Live2D 更稳定**：Live2D 以“工具”的形式触发（也显示为一张工具卡片）；允许回复中途触发。  
5) **模式保留三档**：`native` / `text` / `auto`；在 gcli2api 不兼容 tools/tool_calls 时，`native/auto` 允许直接报错并提示用户切换模式（不自动降级）。  

非目标（本次不做）：
- 不引入新的安全/权限体系、不做沙箱策略设计。
- 不追求一次 HTTP 请求就完成全部（允许多次调用 LLM，但对 UI 表现为“不断流”）。

## 3. 参考实现（证据与可复用思路）

### 3.1 Operit：原生 tools 的流式聚合（delta.tool_calls）

位置：`G:/DeskPet/Operit-main1.7.0/app/src/main/java/com/ai/assistance/operit/api/chat/llmprovider/OpenAIProvider.kt`

关键点：
- 同时处理 `delta.content` 与 `delta.tool_calls`（流式增量拼接 arguments）。
- 当 `finish_reason == "tool_calls"` 时，对最后一个工具调用做收尾并进入工具处理流程。

相关片段（索引）：
- `processResponseChunk(...)`：`delta.optJSONArray("tool_calls")` + `finish_reason` 处理
- `handleFinishReason(...)`：`finishReason == "tool_calls"` 分支

### 3.2 VCPToolBox：多次 AI 调用但对外保持单条 SSE（不断流）

位置：`G:/DeskPet/reference/VCPToolBox-main/modules/chatCompletionHandler.js`

关键点：
- 第一次 AI 调用：转发流到客户端，同时在服务端累积全文用于解析工具请求块。
- 解析 `<<<[TOOL_REQUEST]>>>...<<<[END_TOOL_REQUEST]>>>`，执行工具后，继续发起下一次 `stream:true` AI 调用。
- 多次 AI 调用共享同一个 HTTP 响应流（对客户端表现为持续 SSE，不断开）。

相关片段（索引）：
- VCP loop：解析 TOOL_REQUEST 并执行工具
- `// --- Make next AI call (stream: true) ---`：继续请求并继续写 SSE

## 4. NeoDeskPet 现状（与改造入口）

已存在的能力（可复用）：
- `toolCallingMode: 'auto' | 'native' | 'text'`：`NeoDeskPet-electron/electron/types.ts`
- 文本协议 TOOL_REQUEST 解析与执行：`NeoDeskPet-electron/electron/taskService.ts`（`TOOL_REQUEST_START/END` 等）
- OpenAI-compatible chat/completions：`NeoDeskPet-electron/src/services/aiService.ts`（目前偏“只收 content”，未完整支持 tool_calls SSE 聚合）

当前阻塞/断流的根因：
- 对“是否需要工具”的决策放在前置 planner 回合（非流式），导致首字延迟与两段式体验。

## 5. 目标架构：Streaming Turn Runner（状态机）

核心：用一个“回合运行器”统一管理 **流式输出 + 工具调用 + 继续生成**，并把 UI 更新收敛为对“同一条消息”的增量更新。

### 5.1 概念与职责

Streaming Turn Runner：
- 输入：用户文本/图片、历史消息、当前模式（native/text/auto）、工具定义集合、取消信号。
- 输出：事件流（text delta、tool card 更新、错误、完成）。

工具执行器（Tool Executor）：
- 输入：工具名、参数
- 输出：工具结果（成功/失败/摘要/完整输出）

Live2D 工具（必须新增，且也走工具卡片）：
- `live2d.expression(name: string)`
- `live2d.motion(group: string, index?: number)`

### 5.2 UI 数据模型（建议）

单条 assistant 消息：
- `blocks[]` 由以下 block 组成：
  - `text`：一个（或少量）用于承载流式追加的自然语言输出
  - `tool_use`：多个，用于每次工具调用的卡片

每个 `tool_use` 卡片建议具备：
- `toolName`
- `status`: `running | success | error`
- `input`（参数字符串/结构化预览）
- `output`（完整输出，默认折叠）
- `error`（失败信息）
- `startedAt/endedAt`

### 5.3 三档模式的行为

#### native
- 对 LLM 发起 `stream:true + tools` 的请求。
- 流式解析：
  - 持续消费 `delta.content` → 立即追加到 text block（节流刷新）
  - 同时消费 `delta.tool_calls` → 聚合每个 tool_call 的 `{id,name,arguments}`（arguments 是增量字符串拼接）
- 终止条件：
  - `finish_reason == "tool_calls"`：进入“执行工具并继续生成”的循环
  - `finish_reason == "stop"/"length"`：回合完成

#### text
- 对 LLM 发起 `stream:true`（不依赖原生 tools）。
- 流式解析：
  - `delta.content` 持续追加到 text block（节流刷新）
  - 同时在后台累积“本回合完整文本”（用于解析 TOOL_REQUEST 块）
- 流结束后：
  - 从累积全文解析多个 `TOOL_REQUEST`（沿用现有解析器）
  - 逐个执行工具并生成 tool 卡片
  - 把工具结果写入下一次 LLM 调用的上下文（作为 user/tool 形式二选一，但需保持兼容）
  - 继续下一次 `stream:true`，继续追加到同一条消息

#### auto
- 默认先按 `native` 跑。
- 若遇到 gcli2api 的 tools/tool_calls 不兼容导致报错：直接报错并结束；提示用户切 `text`（不自动降级）。

## 6. 关键实现细节（避免“看起来能跑但体验不对”）

### 6.1 “不断流”的关键：UI 事件驱动，而不是“等工具做完再说”

必须做到：
- 首个 `delta.content` 到达就立刻刷新一次 UI（首字即时）
- 后续更新节流（例如 16ms 或 33ms flush），避免每个 token 触发渲染
- 当检测到工具调用：
  - 立即插入 `tool_use(status=running, input=...)` 卡片
  - 工具执行完成后更新同一张卡片为 `success/error` 并写入 output
  - 同时继续下一次 LLM 流式输出（仍追加到同一条消息的 text block）

### 6.2 native 的 tool_calls 聚合（必须支持流式增量）

参考 Operit 的做法：按 tool_calls 的 `index` 聚合，arguments 字符串是增量拼接；当切换 index 时要“收尾上一工具”的结构化解析。

### 6.3 Live2D 工具化（更稳）

把 Live2D 触发从“解析文本标签”改成“工具调用”：
- 模型要触发表情/动作时直接调用工具。
- 工具调用一到达就触发 IPC：`live2d:triggerExpression` / `live2d:triggerMotion`。
- 同时把该调用作为一张 tool 卡片显示（默认折叠，显示 name + 参数 + 状态）。

### 6.4 多工具卡片（并发/串行策略）

策略建议（先简单、可预测）：
- 先串行执行：一张卡片完成再执行下一张（UI 清晰）
- 允许未来扩展为并行执行（需要更复杂的依赖/顺序控制）

## 7. 兼容性与失败处理（符合你的偏好：直接报错）

gcli2api 在 `native` 不兼容 tools/tool_calls 时：
- 直接把错误显示到当前这条 assistant 消息的末尾（或单独一个错误 block）
- 引导用户切换 `toolCallingMode=text`

取消/中止：
- 用户点“停止”时应中止当前 fetch/流读取与正在执行的工具（若工具支持取消）。

## 8. 测试与验收（建议）

最小验收用例（人工 + 自动皆可）：
1) 纯聊天：首字即出、持续流式、仅一条消息。
2) 单工具：首字即出 → 插入 1 张工具卡片（运行中）→ 完成后卡片变 success → 继续流式追加 → 仍是一条消息。
3) 多工具：同一条消息里出现多张卡片，默认折叠，顺序与输出合理。
4) Live2D：中途任意时刻 tool_call 触发，卡片可见且模型动作/表情即时生效。
5) `native` 报错：直接显示错误并提示切 `text`，不自动降级。

## 9. 迁移计划（建议分阶段）

阶段 A（先让体验对齐“不断流”）：
- 引入 Streaming Turn Runner
- `text` 模式先跑通（利用现有 TOOL_REQUEST 解析器）

阶段 B（补齐 native 的完美流式 tools）：
- 实现 `delta.tool_calls` 的完整流式聚合
- `finish_reason == "tool_calls"` → 工具执行 → 继续下一次流式生成

阶段 C（Live2D 工具化）：
- 新增 `live2d.expression/motion` 工具定义与执行器
- UI 以工具卡片呈现

## 10. 待确认（已确认/未确认）

已确认：
- 上游：gcli2api
- 模式：`native/text/auto` 三档都要，且不兼容 tools/tool_calls 时直接报错提示用户切换
- Live2D：表情/动作即可；允许回复中途触发；并显示为工具卡片
- UI：一条 assistant 消息；多个工具卡片默认折叠

未确认（实现时可能需要再问一次）：
- Live2D 工具卡片的“输出字段”展示粒度（是否只显示 name/参数/状态，还是也要记录触发时间等）

