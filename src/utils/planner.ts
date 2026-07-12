// 规划器（planner）提示词与决策解析（自 App.tsx 拆出，纯函数）

import type {
  TaskCreateArgs,
} from '../../electron/types'
import { getBuiltinToolDefinitions } from '../../electron/toolRegistry'

export type PlannerDecision =
  | { type: 'create_task'; assistantReply: string; task: TaskCreateArgs }
  | { type: 'need_info'; assistantReply: string; questions?: string[] }
  | { type: 'chat'; assistantReply: string }

export function extractFirstJsonObject(text: string): string | null {
  const raw = String(text ?? '').trim()
  if (!raw) return null

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = (fenced?.[1] ?? raw).trim()

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return candidate.slice(start, end + 1)
}

export function normalizePlannerTask(raw: unknown): TaskCreateArgs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  if (!title) return null

  const queue = typeof obj.queue === 'string' ? obj.queue.trim() : undefined
  const why = typeof obj.why === 'string' ? obj.why.trim() : undefined

  const stepsRaw = Array.isArray(obj.steps) ? (obj.steps as unknown[]) : []
  const steps = stepsRaw.slice(0, 20).map((step) => {
    const s = step && typeof step === 'object' && !Array.isArray(step) ? (step as Record<string, unknown>) : {}
    const tool = typeof s.tool === 'string' ? s.tool.trim() : undefined
    const title = typeof s.title === 'string' ? s.title.trim() : tool ? tool : '步骤'

    let input: string | undefined
    if (typeof s.input === 'string') input = s.input
    else if (s.input && (typeof s.input === 'object' || Array.isArray(s.input))) {
      try {
        input = JSON.stringify(s.input)
      } catch {
        input = undefined
      }
    }

    return { title, tool, input }
  })

  return { queue: queue as TaskCreateArgs['queue'], title, why, steps }
}

export function parsePlannerDecision(text: string): PlannerDecision | null {
  const jsonStr = extractFirstJsonObject(text)
  if (!jsonStr) return null

  let obj: unknown
  try {
    obj = JSON.parse(jsonStr) as unknown
  } catch {
    return null
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const root = obj as Record<string, unknown>
  const type = typeof root.type === 'string' ? root.type.trim() : ''
  const assistantReply = typeof root.assistantReply === 'string' ? root.assistantReply.trim() : ''

  if (type === 'need_info') {
    const qRaw = Array.isArray(root.questions) ? (root.questions as unknown[]) : []
    const questions = qRaw.filter((x) => typeof x === 'string').map((x) => String(x).trim()).filter(Boolean)
    return {
      type: 'need_info',
      assistantReply: assistantReply || (questions[0] ? questions.join('\n') : '我还需要你补充一些信息。'),
      questions: questions.length ? questions : undefined,
    }
  }

  if (type === 'create_task') {
    const task = normalizePlannerTask(root.task)
    if (!task) return null
    return {
      type: 'create_task',
      assistantReply: assistantReply || `好的，我会开始执行：${task.title}`,
      task,
    }
  }

  if (type === 'chat') {
    return { type: 'chat', assistantReply: assistantReply || '' }
  }

  return null
}

export function isToolCapabilityQuestion(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (!raw) return false
  return /(?:你|桌宠|明澈).{0,8}(?:能做什么|会做什么|有什么能力|有哪些工具|工具列表|怎么用工具|支持哪些工具)/u.test(raw)
}

export function requestLikelyNeedsToolAction(text: string): boolean {
  const raw = String(text ?? '').trim()
  if (!raw || isToolCapabilityQuestion(raw)) return false

  const actionPatterns = [
    /(?:截图|截屏|当前画面|当前页面|当前视频|播放.{0,8}内容|看剧|识图|看图|分析.{0,8}(?:图片|截图|画面|视频))/u,
    /(?:搜索|搜一下|帮我搜|查一下|查询|查找|检索|最新|实时|新闻|官网|价格|定价|来源|链接)/u,
    /(?:打开|进入|点击|填写|提交|登录|下载|安装|运行|执行|调用|读取|读一下|写入|保存|创建|生成文件|修改|修复|复制|移动|压缩|解压)/u,
    /(?:调用工具|用工具|别只说|不要只说|实际操作|帮我弄|处理一下)/u,
  ]
  return actionPatterns.some((re) => re.test(raw))
}

export function buildPlannerSystemPrompt(opts?: {
  systemPrompt?: string
  toolNames?: string[]
  expressions?: string[]
  motions?: string[]
}): string {
  const lines: string[] = []
  lines.push('你是 NeoDeskPet 的“任务规划器（Planner）”。你的工作是：根据用户的自然语言请求，决定是否要创建“可执行任务（Task）”，并输出严格 JSON。')
  const systemPrompt = (opts?.systemPrompt ?? '').trim()
  if (systemPrompt) {
    lines.push('')
    lines.push('桌宠人设（assistantReply 必须遵循）：')
    lines.push(systemPrompt)
  }

  const expressions = (opts?.expressions ?? []).filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  const motions = (opts?.motions ?? []).filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
  if (expressions.length > 0 || motions.length > 0) {
    lines.push('')
    lines.push('Live2D 可用表情/动作（可选，不需要就不要写标签）：')
    if (expressions.length > 0) lines.push(`- 表情：${expressions.slice(0, 20).join('、')}`)
    if (motions.length > 0) lines.push(`- 动作组：${motions.slice(0, 10).join('、')}`)
    lines.push('可以在 assistantReply 的开头或第一句末尾（前20字）选择性加标签：')
    lines.push('- [表情:表情名称]')
    lines.push('- [动作:动作组名称]')
    lines.push('要点：')
    lines.push('- 如果 assistantReply 非空，建议根据语气选择 1 个表情标签（可选）。')
    lines.push('- 不需要变化就不要写标签，没有标签就不会触发。')
    lines.push('- 如果写了标签，名称必须从上面可用列表中选，禁止编造。')
    lines.push('- 为降低界面延迟，尽量前置标签（前20字）。')
  }

  const toolNames = (opts?.toolNames ?? getBuiltinToolDefinitions().map((t) => t.name))
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)

  lines.push('')
  lines.push('你只能输出一个 JSON 对象，禁止输出 Markdown、代码块、解释文字。')
  lines.push('')
  lines.push('优化目标：优先选择“延迟最低且成功率高”的方案；只有在必要时才用更重的工具。')
  lines.push('')
  lines.push('你有三种输出类型：')
  lines.push('1) create_task：当用户想让桌宠做事（抓取网页/截图/运行命令/写文件/总结等）时。')
  lines.push('2) need_info：当信息不足以执行时（例如“抓取B站”但没有 URL/关键词/目标）。你要用一句话追问。')
  lines.push('3) chat：普通闲聊/不需要工具时。')
  lines.push('')
  lines.push('输出 JSON 结构：')
  lines.push('- create_task:')
  lines.push(
    '  {"type":"create_task","assistantReply":"...","task":{"queue":"browser|file|cli|chat|learning|play|other","title":"...","why":"...","steps":[{"title":"...","tool":"...","input":"..."}]}}',
  )
  lines.push('- need_info:')
  lines.push('  {"type":"need_info","assistantReply":"...","questions":["..."]}')
  lines.push('- chat:')
  lines.push('  {"type":"chat","assistantReply":"..."}')
  lines.push('')
  lines.push(`工具列表（step.tool 只能从这里选）：${toolNames.join(', ')}`)
  lines.push('')
  lines.push('各工具输入约定（step.input 必须是字符串；如果是 JSON，请把 JSON stringify 成字符串）：')
  lines.push('- browser.fetch：{"url":"https://...","maxChars":5000,"timeoutMs":15000,"stripHtml":false}')
  lines.push('- browser.open：{"url":"https://...","appPath":"(可选)指定浏览器exe","args":["(可选)启动参数"]}（仅“打开网站/保持登录态”优先用这个）')
  lines.push(
    '- browser.playwright：{"url":"https://...","headless":true,"profile":"default","screenshot":{"path":"browser-screenshots/current.png","fullPage":false},"extract":{"selector":"body","format":"innerText|text|html","maxChars":1200,"optional":true},"actions":[{"type":"waitMs","ms":1200},{"type":"click","selector":"..."},{"type":"fill","selector":"...","text":"..."},{"type":"press","selector":"...","key":"Enter"},{"type":"waitForLoad","state":"networkidle"}]}（无头模式不要传 channel，默认使用与 Playwright 版本匹配的 Chromium；省略 extract 表示不提取页面文本）',
  )
  lines.push('- file.write：{"path":"task-output/xxx.txt"} 或 {"filename":"xxx.txt","content":"...","append":false,"encoding":"utf8"}')
  lines.push('- cli.exec："dir"（字符串命令）或 {"cmd":"powershell","args":["-NoProfile","-Command","..."]}')
  lines.push('- llm.summarize / llm.chat：{"prompt":"...","system":"(可选)","maxTokens":1200}')
  lines.push('- screen.capture：{"target":"primary|cursor|all|display","displayIndex":0,"path":"screenshots/current.png"}（截取真实桌面/显示器；网页标签页截图用 browser.screenshot）')
  lines.push('- image.generate：{"prompt":"1girl, solo, soft lighting","width":1024,"height":1024}（用户明确要求生图时使用 NovelAI 生成本地图片）')
  lines.push('- image.generate 的 prompt 使用英文 NovelAI tags，逗号分隔；按“质量词/主体/桌宠外观/表情动作/服装/场景光线/构图风格”组织。固定正反提示词会由工具自动拼接。')
  lines.push('- image.inspect：{"path":"<逐字复制上一工具返回的 path>","prompt":"描述图片内容","maxTokens":600}（仅在需要独立识图或视觉回注不可用时使用；path 必须来自 screen.capture/browser.screenshot/image.generate 的输出，禁止编造）')
  lines.push('- delay.sleep：{"ms":200}')
  lines.push('')
  lines.push('策略：')
  lines.push('- 能直接执行就 create_task；缺信息就 need_info；都不是就 chat。')
  lines.push('- 行动请求：用户明确要求截图、识图、搜索/查询最新信息、打开并操作网页、读取/写入/修改文件、运行命令、下载/安装/执行程序时，优先输出 create_task；但普通聊天、解释、角色互动、情绪交流或不需要真实工具结果的请求应输出 chat。')
  lines.push('- 如果用户是在询问“你能做什么/有哪些工具/工具列表/能力说明”，一律输出 chat：列出可用工具与典型用法示例，不要创建任务、更不要实际执行。')
  lines.push('- 抓取/总结网页：优先 browser.fetch（更快）；遇到动态/需要登录/需要点击交互，才用 browser.playwright。')
  lines.push('- 仅“打开某网站”且不需要后续操作时才用 browser.open；需要搜索/点击/截图/登录/读取页面状态时用 browser.playwright。')
  lines.push('- 用户要求“截图当前屏幕/桌面/前台画面”时，使用 screen.capture；用户要求截内置浏览器标签页时，使用 browser.screenshot。')
  lines.push('- 用户明确要求“生图/画一张/生成图片/NovelAI 生成”时，使用 image.generate；不要在后台循环或批量自动生图。')
  lines.push('- 生图 prompt 不要输出解释或 Markdown；只把整理后的 NovelAI tags 放进 image.generate.prompt。')
  lines.push('- 用户要求“看截图/识图/分析画面”时，先用 screen.capture/browser.screenshot/image.generate 拿到真实图片；图片只会登记为视觉产物，不会自动查看，后续由对话代理按需选择 vision.look。')
  lines.push('- assistantReply 用中文，简短说明你要做什么/需要什么，并尽量点出将使用的 tool。语气/人设只允许来自“桌宠人设”。')
  return lines.join('\n')
}
