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
    description:
      '用系统默认浏览器（或指定浏览器）打开网页链接，只适合用户明确要求“只打开网页”。该浏览器不可被后续自动化控制；涉及搜索、点击、打开结果、截图、提取时不要用它。',
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
      '兼容入口：用可控的 Playwright 浏览器打开或复用指定 URL，并可选截图/执行交互。凡是需要搜索、点击、打开结果、截图或提取页面状态的网页任务，优先使用它，不要用 browser.open。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'http/https URL' },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 45000）', minimum: 1000, maximum: 180000 },
        headless: { type: 'boolean', description: '是否无头（默认 true）' },
        channel: { type: 'string', description: '浏览器 channel；无头模式留空以使用配套 Chromium，仅有界面登录时可传 msedge' },
        profile: { type: 'string', description: '持久化 profile 名（默认 default）' },
        screenshot: {
          type: 'object',
          additionalProperties: false,
          description: '截图设置（不传则不截图）',
          properties: {
            path: { type: 'string', description: '保存路径（限 userData/task-output 或 browser-screenshots）' },
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
        input: { url: 'https://www.bilibili.com/', screenshot: { path: 'browser-screenshots/bili.png', fullPage: false } },
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
    name: 'browser.tabs',
    callName: 'ndp_browser_tabs',
    description: '列出桌宠内置浏览器控制服务当前可见的标签页，默认只返回低 token 的 title/url/id。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile: { type: 'string', description: '持久化 profile 名（默认 default）' },
        channel: { type: 'string', description: '浏览器 channel；无头模式留空以使用配套 Chromium，仅有界面登录时可传 msedge' },
        headless: { type: 'boolean', description: '是否无头（默认 true；手动登录时传 false）' },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 45000）', minimum: 1000, maximum: 180000 },
      },
    },
    examples: [{ title: '列出默认 profile 标签页', input: { profile: 'default' } }],
    risk: 'low',
    cost: 'low',
    tags: ['browser', 'tabs', 'automation'],
    version: '1.0',
  },
  {
    name: 'browser.scan',
    callName: 'ndp_browser_scan',
    description:
      '低 token 扫描动态网页或桌宠内置 Playwright 当前活动标签页，返回 title/url/标签页信息和裁剪后的可见文本/简化结构；不等于系统浏览器前台页。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: '可选 http/https URL；传入时会打开或复用该页面' },
        tabId: { type: 'string', description: '可选标签页 ID，来自 browser.tabs/browser.scan 返回值' },
        profile: { type: 'string', description: '持久化 profile 名（默认 default）' },
        channel: { type: 'string', description: '浏览器 channel；无头模式留空以使用配套 Chromium，仅有界面登录时可传 msedge' },
        headless: { type: 'boolean', description: '是否无头（默认 true；手动登录时传 false）' },
        tabsOnly: { type: 'boolean', description: '只返回标签页列表，不读取页面内容' },
        textOnly: { type: 'boolean', description: '只返回可见文本摘要（默认 true）' },
        selector: { type: 'string', description: '可选 CSS selector，仅扫描该区域' },
        maxChars: { type: 'integer', description: '输出最大字符数（默认 8000，硬上限 20000）', minimum: 200, maximum: 20000 },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 45000）', minimum: 1000, maximum: 180000 },
      },
    },
    examples: [
      { title: '扫描 B站首页', input: { url: 'https://www.bilibili.com/', profile: 'bili', maxChars: 8000 } },
      { title: '只看标签页', input: { profile: 'default', tabsOnly: true } },
    ],
    risk: 'low',
    cost: 'medium',
    tags: ['browser', 'scan', 'automation', 'low-token'],
    version: '1.0',
  },
  {
    name: 'browser.exec_js',
    callName: 'ndp_browser_exec_js',
    description:
      '在桌宠内置浏览器标签页执行 JavaScript，用于读取页面状态、填表、点击、搜索、滚动等精确操作；若脚本打开新标签页，结果会自动指向新的活动标签页。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        script: { type: 'string', description: '要在页面中执行的 JavaScript；最后一行表达式会自动 return' },
        url: { type: 'string', description: '可选 http/https URL；传入时会打开或复用该页面再执行' },
        tabId: { type: 'string', description: '可选标签页 ID，来自 browser.tabs/browser.scan 返回值' },
        profile: { type: 'string', description: '持久化 profile 名（默认 default）' },
        channel: { type: 'string', description: '浏览器 channel；无头模式留空以使用配套 Chromium，仅有界面登录时可传 msedge' },
        headless: { type: 'boolean', description: '是否无头（默认 true；手动登录时传 false）' },
        noMonitor: { type: 'boolean', description: '纯读取时设为 true，跳过页面变化摘要' },
        maxChars: { type: 'integer', description: '输出最大字符数（默认 8000，硬上限 20000）', minimum: 200, maximum: 20000 },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 45000）', minimum: 1000, maximum: 180000 },
      },
      required: ['script'],
    },
    examples: [
      { title: '读取页面标题', input: { url: 'https://example.com', script: 'document.title', noMonitor: true } },
      {
        title: '在 B站搜索',
        input: {
          url: 'https://www.bilibili.com/',
          profile: 'bili',
          script:
            "const input = document.querySelector('input[type=search], input.nav-search-input'); input.value = '桌宠'; input.dispatchEvent(new Event('input', { bubbles: true })); input.form?.requestSubmit?.(); return location.href;",
        },
      },
    ],
    risk: 'medium',
    cost: 'medium',
    tags: ['browser', 'javascript', 'automation'],
    version: '1.0',
  },
  {
    name: 'browser.screenshot',
    callName: 'ndp_browser_screenshot',
    description:
      '对桌宠内置 Playwright 浏览器的当前活动标签页或指定 tabId 截图，只返回本地文件路径和页面元数据；不会因为截图而重新打开 URL，也不等于系统浏览器前台页。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabId: { type: 'string', description: '可选标签页 ID；不传则使用 BrowserControlService 当前活动标签页' },
        profile: { type: 'string', description: '持久化 profile 名（默认 default）' },
        channel: { type: 'string', description: '浏览器 channel；无头模式留空以使用配套 Chromium，仅有界面登录时可传 msedge' },
        headless: { type: 'boolean', description: '是否无头（默认 true）' },
        path: { type: 'string', description: '保存路径（限 userData/task-output 或 browser-screenshots）；不传则写入 task-output' },
        fullPage: { type: 'boolean', description: '是否全页截图（默认 false）' },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 45000）', minimum: 1000, maximum: 180000 },
      },
    },
    examples: [
      { title: '截图当前活动标签页', input: { profile: 'bili', path: 'browser-screenshots/bili-current.png' } },
      { title: '截图指定标签页', input: { profile: 'bili', tabId: 'playwright:bili:2', fullPage: false } },
    ],
    risk: 'low',
    cost: 'medium',
    tags: ['browser', 'screenshot', 'automation'],
    version: '1.0',
  },
  {
    name: 'screen.capture',
    callName: 'ndp_screen_capture',
    description:
      '截取真实桌面屏幕/显示器/区域并保存为 PNG；适合用户要求“截图当前屏幕/桌面/前台画面”。截图只登记为视觉产物，不会自动查看；需要理解画面时再调用 vision.look。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: {
          type: 'string',
          enum: ['primary', 'cursor', 'all', 'display'],
          description: '截图目标：primary=主屏（默认），cursor=鼠标所在屏，all=全部虚拟桌面，display=指定显示器',
        },
        displayIndex: { type: 'integer', description: 'target=display 时按显示器序号选择（0 开始）', minimum: 0 },
        displayId: {
          anyOf: [{ type: 'string' }, { type: 'integer' }],
          description: 'target=display 时按显示器名选择（例如 \\\\.\\DISPLAY1），也可传数字字符串作为序号',
        },
        region: {
          type: 'object',
          additionalProperties: false,
          description: '可选截图区域；默认坐标相对目标左上角，absolute=true 时使用屏幕绝对坐标',
          properties: {
            x: { type: 'integer', description: '区域左上角 x' },
            y: { type: 'integer', description: '区域左上角 y' },
            width: { type: 'integer', description: '区域宽度', minimum: 1 },
            height: { type: 'integer', description: '区域高度', minimum: 1 },
            absolute: { type: 'boolean', description: '是否使用屏幕绝对坐标（默认 false）' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
        path: { type: 'string', description: '保存路径（限 userData/screenshots）；不传则写入 screenshots/<taskId>-<time>.png' },
        returnDataUrl: { type: 'boolean', description: '是否同时返回 dataUrl（默认 false；通常不需要，避免输出过大）' },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 30000）', minimum: 1000, maximum: 120000 },
      },
    },
    examples: [
      { title: '截取主屏', input: { target: 'primary' } },
      { title: '截取鼠标所在屏幕并指定保存路径', input: { target: 'cursor', path: 'screenshots/current.png' } },
      { title: '截取主屏局部区域', input: { target: 'primary', region: { x: 100, y: 100, width: 800, height: 500 } } },
    ],
    risk: 'medium',
    cost: 'low',
    tags: ['screen', 'screenshot', 'image'],
    version: '1.0',
  },
  {
    name: 'browser.close_tabs',
    callName: 'ndp_browser_close_tabs',
    description:
      '关闭桌宠内置 Playwright 浏览器标签页，用于清理历史残留标签。默认保留当前活动标签页；可按 tabId、非活动页、空白页、URL/title 片段关闭。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tabIds: { type: 'array', items: { type: 'string' }, description: '要关闭的标签页 ID，来自 browser.tabs' },
        closeInactive: { type: 'boolean', description: '关闭除当前活动页以外的所有标签页' },
        closeBlank: { type: 'boolean', description: '关闭 about:blank 等空白页' },
        urlIncludes: { type: 'array', items: { type: 'string' }, description: '关闭 URL 包含这些片段的标签页' },
        titleIncludes: { type: 'array', items: { type: 'string' }, description: '关闭标题包含这些片段的标签页' },
        keepActive: { type: 'boolean', description: '是否保留当前活动页（默认 true）' },
        profile: { type: 'string', description: '持久化 profile 名（默认 default）' },
        channel: { type: 'string', description: '浏览器 channel；无头模式留空以使用配套 Chromium，仅有界面登录时可传 msedge' },
        headless: { type: 'boolean', description: '是否无头（默认 true）' },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 45000）', minimum: 1000, maximum: 180000 },
      },
    },
    examples: [
      { title: '关闭非活动旧标签', input: { profile: 'default', closeInactive: true, keepActive: true } },
      { title: '关闭测试残留页', input: { profile: 'default', urlIncludes: ['example.com'], keepActive: true } },
    ],
    risk: 'medium',
    cost: 'low',
    tags: ['browser', 'tabs', 'cleanup'],
    version: '1.0',
  },
  {
    name: 'browser.close',
    callName: 'ndp_browser_close',
    description:
      '立即关闭桌宠管理的 Playwright 浏览器上下文和相关浏览器进程。默认关闭 default profile 的无头上下文；allModes 可关闭该 profile 的所有模式，allContexts 可关闭全部 profile。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        profile: { type: 'string', description: '持久化 profile 名（默认 default）' },
        channel: { type: 'string', description: '精确关闭某 channel；无头默认模式通常留空' },
        headless: { type: 'boolean', description: '精确关闭无头/有界面上下文（默认 true）' },
        allModes: { type: 'boolean', description: '关闭指定 profile 的全部 headless/channel 模式' },
        allContexts: { type: 'boolean', description: '关闭所有 profile 的全部浏览器上下文' },
      },
    },
    examples: [
      { title: '关闭默认无头浏览器', input: { profile: 'default' } },
      { title: '关闭某 profile 的全部模式', input: { profile: 'bili', allModes: true } },
    ],
    risk: 'medium',
    cost: 'low',
    tags: ['browser', 'cleanup', 'close'],
    version: '1.0',
  },
  {
    name: 'skill.list',
    callName: 'ndp_skill_list',
    description: '列出当前已加载的 Skills、命令映射与冲突诊断信息（受设置里的 Skill 开关/目录影响）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        includeCommands: { type: 'boolean', description: '是否返回 slash 命令映射（默认 true）' },
        maxItems: { type: 'integer', description: '最多返回多少条 skill（默认 100）', minimum: 1, maximum: 500 },
      },
    },
    examples: [{ title: '列出当前技能', input: { includeCommands: true, maxItems: 50 } }],
    risk: 'low',
    cost: 'low',
    tags: ['skill', 'list', 'inspect'],
    version: '1.0',
  },
  {
    name: 'skill.refresh',
    callName: 'ndp_skill_refresh',
    description: '刷新 Skill 注册表缓存（安装/修改技能后无需重启即可生效）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    examples: [{ title: '刷新技能缓存', input: {} }],
    risk: 'low',
    cost: 'low',
    tags: ['skill', 'refresh'],
    version: '1.0',
  },
  {
    name: 'skill.install',
    callName: 'ndp_skill_install',
    description: '从 Git 仓库安装 Skill 到托管目录（支持 clone；已存在时可 pull 更新），安装后自动刷新 Skill 缓存。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        repoUrl: { type: 'string', description: 'Git 仓库 URL（推荐 https://github.com/...）' },
        dirName: { type: 'string', description: '可选：目标目录名（不传则由仓库名推断）' },
        branch: { type: 'string', description: '可选：指定分支 clone/pull' },
        updateIfExists: { type: 'boolean', description: '目录已存在时是否 git pull 更新（默认 true）' },
      },
      required: ['repoUrl'],
    },
    examples: [
      { title: '安装 GitHub Skill', input: { repoUrl: 'https://github.com/owner/repo' } },
      { title: '指定目录并更新已有仓库', input: { repoUrl: 'https://github.com/owner/repo', dirName: 'my-skill', updateIfExists: true } },
    ],
    risk: 'medium',
    cost: 'medium',
    tags: ['skill', 'install', 'git'],
    version: '1.0',
  },
  {
    name: 'file.read',
    callName: 'ndp_file_read',
    description: '读取本地文本文件（只读，受限目录白名单：工作区与 userData）。适合读取日志、配置、生成结果等文本。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '文件路径（相对工作区或绝对路径）' },
        maxChars: { type: 'integer', description: '返回最大字符数（默认 12000）', minimum: 100, maximum: 60000 },
        offset: { type: 'integer', description: '从第几个字符开始读取（默认 0）', minimum: 0, maximum: 5000000 },
        encoding: { type: 'string', description: '文本编码（默认 utf8，支持 utf8/utf16le）' },
      },
      required: ['path'],
    },
    examples: [
      { title: '读取工作区文件', input: { path: 'electron/store.ts', maxChars: 4000 } },
      { title: '读取日志后半段', input: { path: 'task-output/run.log', offset: 8000, maxChars: 6000 } },
    ],
    risk: 'low',
    cost: 'low',
    tags: ['file', 'read', 'io'],
    version: '1.0',
  },
  {
    name: 'skill.read',
    callName: 'ndp_skill_read',
    description:
      '读取 Skill（技能）文件内容（UTF-8，限定在工作区 skills/ 或托管 skill 目录）。优先使用 name 读取，避免路径错误。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '技能名（推荐），例如 code-review 或 web-research' },
        path: { type: 'string', description: '可选：技能文件路径（仅允许位于 skills 目录内）' },
        stripFrontmatter: { type: 'boolean', description: '是否移除 YAML frontmatter（默认 true）' },
        maxChars: { type: 'integer', description: '返回内容最大字符数（默认 16000）', minimum: 200, maximum: 60000 },
      },
    },
    examples: [
      { title: '按技能名读取（推荐）', input: { name: 'code-review' } },
      { title: '读取并保留 frontmatter', input: { name: 'web-research', stripFrontmatter: false, maxChars: 24000 } },
    ],
    risk: 'low',
    cost: 'low',
    tags: ['skill', 'file', 'read'],
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
    name: 'cli.exec_stream',
    callName: 'ndp_cli_exec_stream',
    description:
      '流式执行命令并在进程未退出前返回部分输出（支持 start/poll/stop）。适合会先输出提示/二维码路径、再长时间等待的脚本。Windows 下复杂命令优先用 cmd+args 调 powershell -NoProfile -Command，避免 line/cmd.exe 引号转义问题；运行 .py 必须显式写 python，不要用 & 直接执行 .py。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', description: 'start | poll | stop（默认 start）' },
        sessionId: { type: 'string', description: 'poll/stop 使用的会话 ID' },
        cmd: { type: 'string', description: 'start: 可执行文件（如 powershell）' },
        args: { type: 'array', items: { type: 'string' }, description: 'start: 命令参数数组' },
        line: { type: 'string', description: 'start: 一条命令行字符串（与 cmd/args 二选一）' },
        cwd: { type: 'string', description: 'start: 工作目录（默认当前目录）' },
        env: { type: 'object', description: 'start: 附加环境变量（仅支持 string 值）' },
        encoding: { type: 'string', description: "输出解码（默认 utf8；支持 utf8/gbk/utf16le）" },
        timeoutMs: { type: 'integer', description: 'start: 进程总超时（默认 600000）', minimum: 1000, maximum: 3600000 },
        yieldTimeoutMs: { type: 'integer', description: 'start/poll: 本次等待输出的最长时长（默认 3000）', minimum: 0, maximum: 120000 },
        waitForText: { type: 'string', description: 'start/poll: 等待某段文本出现后立即返回（如 QR_CODE_READY:）' },
        waitForRegex: { type: 'string', description: 'start/poll: 等待正则匹配（JS regex source）' },
        returnOnFirstOutput: { type: 'boolean', description: 'start/poll: 有任何新输出就返回（默认 true）' },
      },
    },
    examples: [
      {
        title: '启动并等待二维码路径输出',
        input: {
          action: 'start',
          cmd: 'powershell',
          args: ['-NoProfile', '-Command', "$env:PYTHONIOENCODING='utf-8'; python -u scripts/download_and_chunk.py BV1xxx"],
          cwd: 'C:\\\\Users\\\\Administrator\\\\.neodeskpet\\\\skills\\\\bilibili-subtitle-download-skill',
          encoding: 'utf8',
          waitForText: 'QR_CODE_READY:',
          yieldTimeoutMs: 20000,
          timeoutMs: 600000,
        },
      },
      { title: '轮询会话输出', input: { action: 'poll', sessionId: 'cli_stream_xxx', yieldTimeoutMs: 2000 } },
      { title: '停止会话', input: { action: 'stop', sessionId: 'cli_stream_xxx' } },
    ],
    risk: 'high',
    cost: 'medium',
    tags: ['cli', 'process', 'stream'],
    version: '1.0',
  },
  {
    name: 'cli.exec',
    callName: 'ndp_cli_exec',
    description: '执行命令并返回 stdout/stderr（支持 cmd/args 或直接字符串命令）。Windows 运行 .py 必须显式写 python，不要用 & 直接执行 .py。',
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
    name: 'image.generate',
    callName: 'ndp_image_generate',
    description:
      '使用 NovelAI Image Generation API 根据文本提示生成图片，保存为本地 PNG 并返回 paths；仅在用户明确要求生图时调用，不用于后台批量自动生成。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: { type: 'string', description: '正向提示词；可由 AI 先整理成 NovelAI tags 后传入' },
        negativePrompt: { type: 'string', description: '可选临时额外反向提示词；会拼接到固定负面提示词后面，通常不用传' },
        promptPresetId: { type: 'string', description: '可选覆盖：使用设置页保存的提示词预设 ID' },
        fixedPositivePrompt: { type: 'string', description: '可选覆盖：临时固定正面提示词，会拼接到 prompt 前面' },
        fixedNegativePrompt: { type: 'string', description: '可选覆盖：临时固定负面提示词，会拼接到 negativePrompt 前面' },
        maxPromptChars: { type: 'integer', description: '可选覆盖：提示词占用显示上限', minimum: 128, maximum: 12000 },
        model: { type: 'string', description: '可选覆盖模型 ID，例如 nai-diffusion-4-5-curated' },
        sampler: { type: 'string', description: '可选覆盖采样器，例如 k_euler_ancestral' },
        noiseSchedule: { type: 'string', description: '可选覆盖噪点表/noise schedule，例如 karras' },
        width: { type: 'integer', description: '宽度，自动按 64 像素对齐', minimum: 64, maximum: 4096 },
        height: { type: 'integer', description: '高度，自动按 64 像素对齐', minimum: 64, maximum: 4096 },
        steps: { type: 'integer', description: '步数', minimum: 1, maximum: 80 },
        scale: { type: 'number', description: 'Prompt Guidance', minimum: 0, maximum: 30 },
        cfgRescale: { type: 'number', description: 'Prompt Guidance Rescale', minimum: 0, maximum: 1 },
        nSamples: { type: 'integer', description: '生成张数；会增加 NovelAI Anlas 消耗', minimum: 1, maximum: 8 },
        seed: { type: 'integer', description: '种子；-1 或不传表示由服务端随机', minimum: -1, maximum: 4294967295 },
        outputDir: { type: 'string', description: '相对 userData 的输出目录，默认 generated-images' },
        cloudQueueEnabled: { type: 'boolean', description: '可选覆盖：是否通过 NovelAI 云端队列协调同一个 key 的共享使用' },
        cloudQueueUrl: { type: 'string', description: '可选覆盖：云端队列服务地址，例如 https://st-chatu-novelai-queue.hf.space' },
        cloudQueueUserId: { type: 'string', description: '可选覆盖：队列用户 ID；不传则使用设置或本机匿名 ID' },
        cloudQueueGreeting: { type: 'string', description: '可选覆盖：队列个性语，服务端限制 15 字符' },
        cloudQueuePollIntervalMs: { type: 'integer', description: '可选覆盖：排队轮询间隔毫秒', minimum: 500, maximum: 10000 },
        cloudQueueTimeoutMs: { type: 'integer', description: '可选覆盖：最长排队等待毫秒', minimum: 15000, maximum: 1800000 },
        extraParams: {
          type: 'object',
          description: '高级 NovelAI parameters 覆盖口，例如 v4_prompt、reference_image、skip_cfg_above_sigma 等；MVP 不提供 UI。',
          additionalProperties: true,
        },
        timeoutMs: { type: 'integer', description: '超时毫秒，默认 300000', minimum: 5000, maximum: 600000 },
      },
      required: ['prompt'],
    },
    examples: [
      {
        title: '生成一张默认尺寸图片',
        input: { prompt: '1girl, solo, blue eyes, white dress, soft lighting', width: 1024, height: 1024 },
      },
      {
        title: '指定种子和张数',
        input: { prompt: 'landscape, floating island, sunset, detailed', nSamples: 2, seed: 123456789 },
      },
    ],
    risk: 'medium',
    cost: 'high',
    tags: ['image', 'generation', 'novelai'],
    version: '1.0',
  },
  {
    name: 'vision.look',
    callName: 'ndp_vision_look',
    description:
      '查看当前会话视觉目录中的一张或多张图片。只在确实需要依据图片内容回答时调用；用户只是称赞、闲聊、要求继续但没有要求看图时不要调用。artifactIds 必须逐字复制视觉目录中的 ID，可按用户指定顺序查看或比较。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        artifactIds: {
          type: 'array',
          description: '要查看的视觉产物 ID，按需要查看/比较的顺序填写',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 8,
        },
        question: {
          type: 'string',
          description: '希望从图片中确认的问题；比较多图时写清比较维度',
        },
      },
      required: ['artifactIds'],
    },
    examples: [
      { title: '查看第二张图', input: { artifactIds: ['vis_example_run_2'], question: '描述这张图的主体、姿势和服装' } },
      {
        title: '比较两张图',
        input: { artifactIds: ['vis_example_run_1', 'vis_example_run_3'], question: '比较构图、光线和角色姿势' },
      },
    ],
    risk: 'low',
    cost: 'high',
    tags: ['image', 'vision', 'inspect'],
    version: '1.0',
  },
  {
    name: 'image.inspect',
    callName: 'ndp_image_inspect',
    description:
      '兼容性的本地图片识别工具，供手动任务或旧流程使用。对当前会话里已经登记的图片应优先调用 vision.look，不要猜测本地路径。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '图片路径；支持应用数据目录、工作区、Temp、AppData、桌面、下载或图片目录中的本地图片' },
        prompt: { type: 'string', description: '识图问题或描述要求（默认：描述图片内容）' },
        maxTokens: { type: 'integer', description: '最大输出 token（默认 600）', minimum: 64, maximum: 4096 },
        timeoutMs: { type: 'integer', description: '超时毫秒（默认 60000）', minimum: 2000, maximum: 180000 },
      },
      required: ['path'],
    },
    examples: [],
    risk: 'low',
    cost: 'high',
    tags: ['image', 'vision', 'inspect'],
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
  // cli.exec 仅保留给内部兼容路径；对 Agent 默认只暴露流式版本 cli.exec_stream，避免交互脚本长时间阻塞且拿不到中途输出
  return BUILTIN_TOOL_DEFINITIONS.filter(
    (t) => !t.name.startsWith('llm.') && t.name !== 'cli.exec' && t.name !== 'image.inspect',
  )
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
