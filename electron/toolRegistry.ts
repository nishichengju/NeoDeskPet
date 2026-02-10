import type { ToolSettings } from './types'

export type ToolRiskLevel = 'low' | 'medium' | 'high'
export type ToolCostLevel = 'low' | 'medium' | 'high'

export type ToolExample = {
  title: string
  input: unknown
}

export type ToolDefinition = {
  // 内部工具 ID（TaskService step.tool 使用这个）
  name: string
  // LLM tool-calling 的 function name（为兼容 OpenAI 规范：不使用 "."）
  callName: string
  description: string
  // OpenAI-compatible JSON Schema（chat/completions tools.parameters）
  inputSchema: Record<string, unknown>
  examples: ToolExample[]
  risk: ToolRiskLevel
  cost: ToolCostLevel
  tags: string[]
  version: string
}

export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'browser.fetch',
    callName: 'ndp_browser_fetch',
    description: '用 HTTP GET 抓取网页文本（更快、更低延迟），可选去除 HTML 标签并截断预览。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http/https URL' },
        maxChars: { type: 'integer', description: '输出最大字符数（默认 5000）', minimum: 200, maximum: 20000 },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 15000）', minimum: 1000, maximum: 120000 },
        stripHtml: { type: 'boolean', description: '是否去除 HTML 标签（默认 false）' },
        headers: { type: 'object', description: '附加请求头（仅支持 string 值）' },
      },
      required: ['url'],
    },
    examples: [
      { title: '抓取并去除 HTML', input: { url: 'https://example.com', stripHtml: true, maxChars: 2400 } },
      { title: '带超时与自定义 header', input: { url: 'https://example.com', timeoutMs: 20000, headers: { 'accept-language': 'zh-CN' } } },
    ],
    risk: 'low',
    cost: 'low',
    tags: ['browser', 'http', 'fast'],
    version: '1.0',
  },
  {
    name: 'browser.open',
    callName: 'ndp_browser_open',
    description: '用系统默认浏览器（或指定浏览器）打开网页链接，通常用于“只打开网站/保持登录态”。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http/https URL' },
        appPath: { type: 'string', description: '可选：指定浏览器可执行文件路径（不传则用系统默认浏览器）' },
        args: { type: 'array', items: { type: 'string' }, description: '可选：启动参数（会追加在 url 之前/之后由工具实现决定）' },
      },
      required: ['url'],
    },
    examples: [
      { title: '用默认浏览器打开', input: { url: 'https://www.bilibili.com/' } },
      {
        title: '用指定浏览器打开（示例）',
        input: { url: 'https://www.bilibili.com/', appPath: 'C:\\\\Path\\\\To\\\\Browser.exe', args: ['--new-window'] },
      },
    ],
    risk: 'low',
    cost: 'low',
    tags: ['browser', 'open'],
    version: '1.0',
  },
  {
    name: 'browser.playwright',
    callName: 'ndp_browser_playwright',
    description:
      '用 Playwright 打开动态网页并可选截图/执行交互。默认只返回 title/url（除非显式传 extract 才提取正文）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http/https URL' },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 45000）', minimum: 1000, maximum: 180000 },
        headless: { type: 'boolean', description: '是否无头（默认 true）' },
        channel: { type: 'string', description: '浏览器 channel（Windows 推荐 msedge）' },
        profile: { type: 'string', description: '持久化 profile 名（默认 default）' },
        screenshot: {
          type: 'object',
          additionalProperties: false,
          description: '截图设置（不传则不截图）',
          properties: {
            path: { type: 'string', description: '保存路径（相对 userData 或绝对）' },
            fullPage: { type: 'boolean', description: '是否全页截图（默认 false）' },
          },
        },
        extract: {
          type: 'object',
          additionalProperties: false,
          description: '正文提取（不传则不提取，仅打开/截图）',
          properties: {
            selector: { type: 'string', description: 'CSS selector（默认 body）' },
            format: { type: 'string', description: 'innerText | text | html（默认 innerText）' },
            maxChars: { type: 'integer', description: '输出最大字符数（默认 2000）', minimum: 80, maximum: 10000 },
            optional: { type: 'boolean', description: '提取失败是否忽略（默认 false）' },
          },
        },
        actions: {
          type: 'array',
          description: '交互动作列表（最多 30 条）',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'waitMs | waitForLoad | click | fill | press | waitFor' },
              ms: { type: 'integer', description: 'waitMs 的毫秒数' },
              state: { type: 'string', description: 'waitForLoad 的 state：load|domcontentloaded|networkidle' },
              selector: { type: 'string', description: 'click/fill/press/waitFor 的 CSS selector' },
              text: { type: 'string', description: 'fill 的文本' },
              key: { type: 'string', description: 'press 的按键（默认 Enter）' },
            },
          },
        },
      },
      required: ['url'],
    },
    examples: [
      {
        title: '仅打开并截图（不提取正文）',
        input: { url: 'https://www.bilibili.com/', channel: 'msedge', screenshot: { path: 'task-output/bili.png', fullPage: false } },
      },
      {
        title: '打开并提取正文预览',
        input: { url: 'https://example.com', extract: { selector: 'body', format: 'innerText', maxChars: 1200 } },
      },
    ],
    risk: 'medium',
    cost: 'high',
    tags: ['browser', 'automation', 'dynamic'],
    version: '1.0',
  },
  {
    name: 'file.write',
    callName: 'ndp_file_write',
    description: '写入文本到本地文件（默认写到 userData/task-output/）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '相对 userData 或绝对路径（与 filename 二选一）' },
        filename: { type: 'string', description: '仅文件名（会自动写入 task-output/ 目录）' },
        content: { type: 'string', description: '写入内容（默认空字符串）' },
        append: { type: 'boolean', description: '是否追加写入（默认 false）' },
        encoding: { type: 'string', description: '编码（默认 utf8）' },
      },
    },
    examples: [
      { title: '写入相对路径', input: { path: 'task-output/hello.txt', content: 'Hello' } },
      { title: '按文件名写入', input: { filename: 'note.txt', content: '一段内容', append: false } },
    ],
    risk: 'medium',
    cost: 'low',
    tags: ['file', 'io'],
    version: '1.0',
  },
  {
    name: 'cli.exec',
    callName: 'ndp_cli_exec',
    description: '执行命令并返回 stdout/stderr（支持 cmd/args 或直接字符串命令）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        cmd: { type: 'string', description: '可执行文件（如 powershell/cmd.exe）' },
        args: { type: 'array', items: { type: 'string' }, description: '命令行参数数组' },
        cwd: { type: 'string', description: '工作目录（默认当前目录）' },
        env: { type: 'object', description: '附加环境变量（仅支持 string 值）' },
        encoding: {
          type: 'string',
          description:
            "stdout/stderr 解码编码（默认 auto：优先 utf8；Windows 下若检测到乱码会回退 gbk/utf16le）。可选：'auto'|'utf8'|'gbk'|'utf16le'",
        },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 90000）', minimum: 1000, maximum: 600000 },
        line: { type: 'string', description: '快捷模式：直接传一条命令行字符串（Windows 下会用 cmd.exe /c）' },
      },
    },
    examples: [
      { title: 'PowerShell 获取版本', input: { cmd: 'powershell', args: ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'] } },
      { title: '直接执行一条命令', input: { line: 'dir' } },
    ],
    risk: 'high',
    cost: 'medium',
    tags: ['cli', 'process'],
    version: '1.0',
  },
  {
    name: 'llm.summarize',
    callName: 'ndp_llm_summarize',
    description: '调用 LLM 做信息整理/总结（默认使用 AI 设置里的 baseUrl/apiKey/model）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '要总结的内容' },
        system: { type: 'string', description: '可选 system prompt（不传则用默认总结模板）' },
        maxTokens: { type: 'integer', description: '最大输出 token（默认 1200）', minimum: 64, maximum: 8192 },
        temperature: { type: 'number', description: '温度（默认使用 AI 设置）', minimum: 0, maximum: 2 },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 60000）', minimum: 2000, maximum: 180000 },
        baseUrl: { type: 'string', description: '可选覆盖 baseUrl' },
        apiKey: { type: 'string', description: '可选覆盖 apiKey' },
        model: { type: 'string', description: '可选覆盖 model' },
      },
      required: ['prompt'],
    },
    examples: [{ title: '总结一段文本', input: { prompt: '请总结这段内容：……', maxTokens: 800 } }],
    risk: 'low',
    cost: 'high',
    tags: ['llm', 'summary'],
    version: '1.0',
  },
  {
    name: 'llm.chat',
    callName: 'ndp_llm_chat',
    description: '调用 LLM 生成一段回复（默认使用 AI 设置里的 baseUrl/apiKey/model）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '对话内容' },
        system: { type: 'string', description: '可选 system prompt（不传则用默认桌宠口吻）' },
        maxTokens: { type: 'integer', description: '最大输出 token（默认 1200）', minimum: 64, maximum: 8192 },
        temperature: { type: 'number', description: '温度（默认使用 AI 设置）', minimum: 0, maximum: 2 },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 60000）', minimum: 2000, maximum: 180000 },
        baseUrl: { type: 'string', description: '可选覆盖 baseUrl' },
        apiKey: { type: 'string', description: '可选覆盖 apiKey' },
        model: { type: 'string', description: '可选覆盖 model' },
      },
      required: ['prompt'],
    },
    examples: [{ title: '生成一句回复', input: { prompt: '主人问：今天做什么好？' } }],
    risk: 'low',
    cost: 'high',
    tags: ['llm', 'chat'],
    version: '1.0',
  },
  {
    name: 'media.video_qa',
    callName: 'ndp_media_video_qa',
    description: '对本地视频进行“分段抽帧”并用视觉模型回答问题（会产生多次 API 调用，成本较高）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        videoPath: { type: 'string', description: '本地视频绝对路径（例如 C:\\\\path\\\\video.mp4）' },
        question: { type: 'string', description: '要问的视频内容问题（例如：视频里有几条狗？）' },
        segmentSeconds: { type: 'integer', description: '每段秒数（默认 20）', minimum: 5, maximum: 120 },
        framesPerSegment: { type: 'integer', description: '每段抽帧数量（默认 3）', minimum: 1, maximum: 8 },
        maxSegments: { type: 'integer', description: '最多处理多少段（默认 8）', minimum: 1, maximum: 60 },
        startSeconds: { type: 'number', description: '从视频第几秒开始（默认 0）', minimum: 0, maximum: 1000000000 },
        timeoutMs: { type: 'integer', description: '总超时毫秒（默认 120000）', minimum: 5000, maximum: 600000 },
        baseUrl: { type: 'string', description: '可选覆盖 baseUrl（需支持 vision 输入）' },
        apiKey: { type: 'string', description: '可选覆盖 apiKey' },
        model: { type: 'string', description: '可选覆盖 model（需支持 vision 输入）' },
        temperature: { type: 'number', description: '温度（默认使用 AI 设置）', minimum: 0, maximum: 2 },
        maxTokensPerSegment: { type: 'integer', description: '每段最大输出 token（默认 320）', minimum: 64, maximum: 2048 },
        maxTokensFinal: { type: 'integer', description: '汇总最大输出 token（默认 420）', minimum: 64, maximum: 4096 },
      },
      required: ['videoPath', 'question'],
    },
    examples: [
      {
        title: '分段问答：统计狗的数量',
        input: { videoPath: 'C:\\\\Videos\\\\demo.mp4', question: '视频里有几条狗？', segmentSeconds: 15, framesPerSegment: 3, maxSegments: 6 },
      },
    ],
    risk: 'low',
    cost: 'high',
    tags: ['media', 'video', 'vision', 'qa'],
    version: '1.0',
  },
  {
    name: 'workflow.mmvector_video_qa',
    callName: 'ndp_workflow_mmvector_video_qa',
    description: '一键：先用 mmvector 搜索视频，再对命中的视频做分段问答（需要 MCP mmvector + 视觉模型）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        searchQuery: { type: 'string', description: '用于 mmvector 的文本搜索（例如：狗狗视频）' },
        question: { type: 'string', description: '要问的视频内容问题（例如：视频里有几条狗？）' },
        topK: { type: 'integer', description: 'mmvector 搜索返回数量（默认 3）', minimum: 1, maximum: 20 },
        minScore: { type: 'number', description: 'mmvector 最小相似度（可选）', minimum: 0, maximum: 1 },

        segmentSeconds: { type: 'integer', description: '每段秒数（默认 20）', minimum: 5, maximum: 120 },
        framesPerSegment: { type: 'integer', description: '每段抽帧数量（默认 3）', minimum: 1, maximum: 8 },
        maxSegments: { type: 'integer', description: '最多处理多少段（默认 8）', minimum: 1, maximum: 60 },
        startSeconds: { type: 'number', description: '从视频第几秒开始（默认 0）', minimum: 0, maximum: 1000000000 },

        timeoutMs: { type: 'integer', description: '总超时毫秒（默认 180000）', minimum: 5000, maximum: 600000 },
        baseUrl: { type: 'string', description: '可选覆盖 baseUrl（需支持 vision 输入）' },
        apiKey: { type: 'string', description: '可选覆盖 apiKey' },
        model: { type: 'string', description: '可选覆盖 model（需支持 vision 输入）' },
        temperature: { type: 'number', description: '温度（默认使用 AI 设置）', minimum: 0, maximum: 2 },
        maxTokensPerSegment: { type: 'integer', description: '每段最大输出 token（默认 320）', minimum: 64, maximum: 2048 },
        maxTokensFinal: { type: 'integer', description: '汇总最大输出 token（默认 420）', minimum: 64, maximum: 4096 },
      },
      required: ['searchQuery', 'question'],
    },
    examples: [
      {
        title: '搜视频并问答：统计狗的数量与品种',
        input: { searchQuery: '狗狗视频', question: '视频里有几条狗？分别是什么品种？', topK: 3, segmentSeconds: 15, framesPerSegment: 3 },
      },
    ],
    risk: 'low',
    cost: 'high',
    tags: ['workflow', 'mcp', 'media', 'video', 'vision', 'qa'],
    version: '1.0',
  },
  {
    name: 'live2d.getCapabilities',
    callName: 'ndp_live2d_get_capabilities',
    description: '获取当前 Live2D 模型的参数清单（param id + min/max/default 等），用于让 Agent 生成可执行的参数脚本。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        maxParams: { type: 'integer', description: '最多返回多少个参数（默认 240）', minimum: 1, maximum: 800 },
      },
    },
    examples: [{ title: '获取参数能力清单', input: {} }],
    risk: 'low',
    cost: 'low',
    tags: ['live2d', 'capabilities', 'params'],
    version: '1.0',
  },
  {
    name: 'live2d.applyParamScript',
    callName: 'ndp_live2d_apply_param_script',
    description:
      '向 Live2D 桌宠发送“参数脚本”并执行（支持 patch/tween/sequence/wait/reset/pulse）。注意：口型/呼吸/鼠标追踪等内置效果会覆盖同名参数，避免被 LLM 控制。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', description: 'queue=追加；replace=中断并替换', enum: ['queue', 'replace'] },
        script: { description: '参数脚本（单个 op 或 op 数组）', anyOf: [{ type: 'object' }, { type: 'array' }] },
      },
      required: ['script'],
    },
    examples: [
      {
        title: '眨眼（示例）',
        input: {
          mode: 'replace',
          script: {
            op: 'sequence',
            steps: [
              { op: 'tween', to: { ParamEyeLOpen: 0 }, durationMs: 80, ease: 'inOut', holdMs: 40 },
              { op: 'tween', to: { ParamEyeLOpen: 1 }, durationMs: 120, ease: 'out' },
            ],
          },
        },
      },
      {
        title: '单眼 wink（pulse 宏示例）',
        input: {
          mode: 'replace',
          script: {
            op: 'pulse',
            id: 'ParamEyeLOpen',
            down: 0,
            up: 1,
            downMs: 100,
            holdMs: 150,
            upMs: 100,
          },
        },
      },
    ],
    risk: 'low',
    cost: 'low',
    tags: ['live2d', 'params', 'animation'],
    version: '1.0',
  },
  {
    name: 'delay.sleep',
    callName: 'ndp_delay_sleep',
    description: '暂停一段时间（用于等待页面/节流）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ms: { type: 'integer', description: '毫秒数（默认 200）', minimum: 0, maximum: 300000 },
      },
    },
    examples: [{ title: '等待 1 秒', input: { ms: 1000 } }],
    risk: 'low',
    cost: 'low',
    tags: ['delay'],
    version: '1.0',
  },
]

export function getBuiltinToolDefinitions(): ToolDefinition[] {
  return [...BUILTIN_TOOL_DEFINITIONS]
}

export function getDefaultAgentToolDefinitions(): ToolDefinition[] {
  // Agent 自己就是 LLM，因此默认不把 llm.* 暴露为可调用工具，避免“套娃调用”导致延迟与成本飙升
  return BUILTIN_TOOL_DEFINITIONS.filter((t) => !t.name.startsWith('llm.'))
}

export function getToolGroupId(toolName: string): string {
  const name = (toolName ?? '').trim()
  if (!name) return 'other'

  // MCP：按 server 分组（mcp.<serverId>.<toolName>）
  if (name.startsWith('mcp.')) {
    const parts = name.split('.').filter(Boolean)
    const serverId = parts.length >= 2 ? parts[1] : ''
    if (serverId) return `mcp.${serverId}`
    return 'mcp'
  }

  const dot = name.indexOf('.')
  const prefix = dot >= 0 ? name.slice(0, dot) : name
  const groupId = prefix.trim()
  return groupId || 'other'
}

export function isToolEnabled(toolName: string, toolSettings?: ToolSettings | null): boolean {
  const s = toolSettings ?? null
  if (s && s.enabled === false) return false

  const name = (toolName ?? '').trim()
  if (!name) return false

  const toolOverride = s?.tools?.[name]
  if (typeof toolOverride === 'boolean') return toolOverride

  const groupId = getToolGroupId(name)
  const groupOverride = s?.groups?.[groupId]
  if (typeof groupOverride === 'boolean') return groupOverride

  return true
}

export function filterToolDefinitionsBySettings(defs: ToolDefinition[], toolSettings?: ToolSettings | null): ToolDefinition[] {
  return (defs ?? []).filter((d) => isToolEnabled(d.name, toolSettings))
}

export function findToolByName(name: string): ToolDefinition | null {
  const needle = (name ?? '').trim()
  if (!needle) return null
  return BUILTIN_TOOL_DEFINITIONS.find((t) => t.name === needle) ?? null
}

export function findToolByCallName(callName: string): ToolDefinition | null {
  const needle = (callName ?? '').trim()
  if (!needle) return null

  const exact = BUILTIN_TOOL_DEFINITIONS.find((t) => t.callName === needle) ?? null
  if (exact) return exact

  // Gemini(OpenAI-compat) 可能会返回类似 "default_api:ndp_xxx" 的前缀
  if (needle.includes(':')) {
    const tail = needle.split(':').pop()?.trim() ?? ''
    if (tail && tail !== needle) return BUILTIN_TOOL_DEFINITIONS.find((t) => t.callName === tail) ?? null
  }

  return null
}

export type OpenAIFunctionToolSpec = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export function toOpenAITools(defs: ToolDefinition[] = BUILTIN_TOOL_DEFINITIONS): OpenAIFunctionToolSpec[] {
  return defs.map((t) => ({
    type: 'function',
    function: {
      name: t.callName,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}
