# NeoDeskPet 工具调用“全流式体验”改造（对齐 VCPToolBox）

日期：2026-01-06  
执行者：Codex  
项目：`NeoDeskPet-electron`

## 1. 你现在问的结论：是不是“全流式”？

结论：**不是**。

当前（`codex-snapshot`）存在你说的“一条非流式一条流式”的割裂：

- **普通对话**：`chat/completions` 走 SSE 流式，首字很快出现。  
  代码：`NeoDeskPet-electron/src/services/aiService.ts` 的 `chatStream(...)`

- **工具 Agent（agent.run）**：目前是**非流式**（一次性 `fetch` 拿完整 JSON），所以会出现“首字慢、过程慢、工具卡片刷屏但不像流式”。  
  代码：`NeoDeskPet-electron/electron/taskService.ts` 的 `runAgentRunTool(...)`，内部 `callLlmNative(...) / callLlmText(...)` 都是 `await fetch(...).json()`，没有 SSE 解析。

## 2. VCPToolBox 为什么看起来“全流式”

VCPToolBox 的关键不在于“只调用一次 LLM”，而在于：

1) 每一轮都用 `stream:true` 向模型发起流式请求  
2) 工具执行后再发起下一轮流式请求  
3) **但服务端对客户端保持同一条 SSE 响应不断开**，把多轮内容持续写入同一条流中  

参考路径：`G:/DeskPet/reference/VCPToolBox-main/modules/chatCompletionHandler.js`

## 3. NeoDeskPet 的目标（对齐 VCP 的“体感”）

把工具 Agent 的体验做成：

- 首字仍然流式出现（不再等整段返回）
- 工具卡片在**同一条消息/同一次任务**里追加（默认折叠）
- 工具执行中 UI 可见进度；工具完成后继续追加自然语言
- 多工具、多轮调用不会“停不下来”（`MaxTurns/MaxToolCalls` + 可选强制收尾）
- 模式保留：`native/text/auto`；auto 可以“仅本次降级”，但不偷偷改用户设置

注意：协议层面对于“本地工具”基本不可能真正做到“模型一次请求就拿到工具结果并继续生成”，因为工具结果需要回填到 messages 后再继续下一轮模型调用。VCP 也是多轮调用，只是把多轮“包装成一条不断开的 SSE”。

## 4. 改造方案（推荐：main 进程实现 VCP 式循环流式）

### 4.1 需要新增/替换的能力

在 `NeoDeskPet-electron/electron/taskService.ts` 的 `runAgentRunTool(...)` 中：

1) 把 `callLlmNative(...)` 改成 `callLlmNativeStream(...)`
2) 把 `callLlmText(...)` 改成 `callLlmTextStream(...)`

它们要做的事：

- 以 SSE 方式读取 `chat/completions`，边读边增量更新：
  - `draftReply`（给任务面板/聊天界面展示“正在生成”）
  - `toolRuns`（一出现工具调用就先插入卡片，状态=running）
  - `live2dExpression/live2dMotion`（如果你还保留标签触发）

### 4.2 事件/状态写入策略（尽量复用现有字段）

你现有的增量字段已经很接近“全流式 UI”：

- `draftReply`：流式文本（可多次更新）
- `toolRuns[]`：工具卡片（running/done/error + input/output preview）
- `live2dExpression/live2dMotion`：中途更新即可触发 Live2D

建议做一个节流（你现在已有 `lastProgressAt < 250ms` 的逻辑），避免 UI 更新过密。

### 4.3 循环流式主流程（pseudocode）

```pseudocode
function runAgentRunTool(request, mode):
  messages = [system, extraContext, user(request)]
  toolRuns = []
  draftReply = ""

  for turn in 1..MaxTurns:
    if mode == native:
      stream chat.completions with tools/tool_choice=auto
      while sse chunk:
        if delta.content:
          draftReply += delta.content
          writeProgress(draftReply)
        if delta.tool_calls:
          upsertToolRuns(running, args_delta)
          writeProgress(toolRuns)
      if got tool_calls:
        execute tools sequentially:
          set toolRuns[i]=running
          result = executeTool(...)
          set toolRuns[i]=done/error + outputPreview
          append tool result into messages as tool message (native) or as TOOL_RESULT block (text)
        continue loop (next turn)
      else:
        finalize and return (draftReply)

    if mode == text:
      stream chat.completions without tools
      while sse chunk:
        draftReplyVisible = stripToolRequestBlocksForDisplay(draftReply + delta.content)
        writeProgress(draftReplyVisible)
      parse TOOL_REQUEST blocks from full contentText
      if no tool requests: return
      execute tools -> append TOOL_RESULT blocks -> continue loop
```

### 4.4 “强制收尾”（你说的 C）

当满足任一条件时，强制收尾（不给模型再调用工具）：

- `toolCallsTotal >= MaxToolCalls`
- `turn >= MaxTurns`
- 工具连续失败/重复调用（可选：基于 dedupeKey）

收尾方式：

- 追加一条 `system`：禁止再调用工具，只基于已有 TOOL_RESULT/工具消息输出最终自然语言回复
- 再启动一轮**流式**生成，把输出继续追加到 `draftReply`，最后写 `finalReply`

## 5. 验收用例（今天就能测）

1) 普通对话：首字流式、无工具卡片  
2) 单工具：首字流式 → 工具卡片 running → done/error → 文本继续追加 → 结束  
3) 多工具：同一条任务里多卡片，默认折叠，顺序合理  
4) native/text/auto：三档都能跑；native 不兼容时报错或按策略降级（按你现在的设定）  
5) 取消：点击“停止/终止”后，模型流与当前工具都能尽快中止

## 6. 下一步最小改动清单（按文件）

- `NeoDeskPet-electron/electron/taskService.ts`
  - 给 `callLlmNative/callLlmText` 加流式版本（SSE 解析）
  - 让 `appendDraft(...) / upsertToolRun(...)` 在流式 delta 到达时被调用
- （可选）`NeoDeskPet-electron/src/services/streamingTurnRunner.ts`
  - 如果你要复用现有 SSE 解析器，把它迁到 main 侧（或抽成共享 util），避免重复写解析逻辑

