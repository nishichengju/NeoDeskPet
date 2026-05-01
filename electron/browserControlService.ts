import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { BrowserContext, Page } from 'playwright-core'

export type BrowserTargetKind = 'playwright'

export type BrowserTabSummary = {
  id: string
  title: string
  url: string
  active: boolean
  target: BrowserTargetKind
  profile: string
}

export type BrowserCommonOptions = {
  profile?: string
  channel?: string
  headless?: boolean
  timeoutMs?: number
}

export type BrowserScanOptions = BrowserCommonOptions & {
  tabId?: string
  url?: string
  textOnly?: boolean
  tabsOnly?: boolean
  selector?: string
  maxChars?: number
}

export type BrowserExecJsOptions = BrowserCommonOptions & {
  tabId?: string
  url?: string
  script: string
  noMonitor?: boolean
  maxChars?: number
}

export type BrowserPlaywrightAction = {
  type?: string
  ms?: number
  state?: string
  selector?: string
  text?: string
  key?: string
}

export type BrowserExtractOptions = {
  selector?: string
  format?: string
  maxChars?: number
  optional?: boolean
}

export type BrowserScreenshotOptions = {
  path?: string
  fullPage?: boolean
}

export type BrowserScreenshotToolOptions = BrowserCommonOptions & BrowserScreenshotOptions & {
  tabId?: string
  url?: string
  taskId?: string
}

export type BrowserCloseTabsOptions = BrowserCommonOptions & {
  tabIds?: string[]
  closeInactive?: boolean
  closeBlank?: boolean
  urlIncludes?: string[]
  titleIncludes?: string[]
  keepActive?: boolean
}

export type BrowserPlaywrightOptions = BrowserCommonOptions & {
  url: string
  taskId?: string
  actions?: BrowserPlaywrightAction[]
  extract?: BrowserExtractOptions | null
  screenshot?: BrowserScreenshotOptions | null
  waitIfPaused?: () => Promise<void>
  isCanceled?: () => boolean
  signal?: AbortSignal
}

type ManagedContext = {
  profile: string
  context: BrowserContext
  activePage?: Page
  registeredPages: WeakSet<Page>
  closed: boolean
}

type SerializedScan = {
  text: string
  html: string
  stats: {
    links: number
    buttons: number
    inputs: number
  }
}

const DEFAULT_PROFILE = 'default'
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_SCAN_MAX_CHARS = 8_000
const HARD_SCAN_MAX_CHARS = 20_000
const DEFAULT_EXEC_MAX_CHARS = 8_000
const ACTION_SETTLE_TIMEOUT_MS = 3_000

function clampText(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const s = String(text ?? '').trim()
  if (s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}…`
}

function safeProfileName(raw: unknown): string {
  const s = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_PROFILE
  return s.replace(/[<>:"/\\|?*]+/g, '_') || DEFAULT_PROFILE
}

function normalizeTimeoutMs(value: unknown): number {
  return typeof value === 'number' ? Math.max(1_000, Math.min(180_000, Math.trunc(value))) : DEFAULT_TIMEOUT_MS
}

function normalizeMaxChars(value: unknown, fallback: number): number {
  return typeof value === 'number' ? Math.max(200, Math.min(HARD_SCAN_MAX_CHARS, Math.trunc(value))) : fallback
}

function normalizeExtractMaxChars(value: unknown): number {
  return typeof value === 'number' ? Math.max(80, Math.min(10_000, Math.trunc(value))) : 2_000
}

function resolveChannel(raw: unknown): { channel: string | undefined; implicitDefault: boolean } {
  if (typeof raw === 'string' && raw.trim()) return { channel: raw.trim(), implicitDefault: false }
  if (process.platform === 'win32') return { channel: 'msedge', implicitDefault: true }
  return { channel: undefined, implicitDefault: false }
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

function isBlankPageUrl(url: string): boolean {
  return !url || url === 'about:blank'
}

function buildTabId(profile: string, index: number): string {
  return `playwright:${profile}:${index}`
}

function parseTabId(tabId: string): { profile: string; index: number } | null {
  const m = /^playwright:([^:]+):(\d+)$/.exec(tabId.trim())
  if (!m) return null
  return { profile: m[1], index: Number(m[2]) }
}

async function serializePage(page: Page, selector: string, textOnly: boolean): Promise<SerializedScan> {
  return await page.evaluate(
    ({ selector: innerSelector, textOnly: innerTextOnly }) => {
      const root = innerSelector ? document.querySelector(innerSelector) : document.body || document.documentElement
      if (!root) return { text: '', html: '', stats: { links: 0, buttons: 0, inputs: 0 } }

      const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'TEMPLATE', 'PARAM', 'SOURCE', 'COLGROUP', 'COL'])
      const blockTags = new Set(['ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'])
      const MAX_DEPTH = 9
      const MAX_NODES = 1_200
      const MAX_LINES = 900
      const MAX_HTML_PARTS = 500
      const MAX_CHILDREN = 70
      const MAX_TEXT = 260
      const seenElements = new WeakSet<Element>()
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0) return false
        if (el.getAttribute('aria-hidden') === 'true' && rect.width <= 1 && rect.height <= 1) return false
        return (rect.width > 1 && rect.height > 1) || ['OPTION', 'TITLE'].includes(el.tagName)
      }
      const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()
      const shorten = (value: string, max = MAX_TEXT): string => {
        const text = normalize(value)
        return text.length > max ? `${text.slice(0, max)}…` : text
      }
      const attr = (el: Element, name: string): string => normalize(el.getAttribute(name) || '')
      const labelOf = (el: Element): string => {
        const direct = normalize(attr(el, 'aria-label') || attr(el, 'title') || attr(el, 'placeholder') || attr(el, 'alt') || attr(el, 'name'))
        if (direct) return direct
        const id = attr(el, 'id')
        if (id) {
          const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)
          if (label) return shorten(label.textContent || '', 120)
        }
        return shorten(el.textContent || '', 140)
      }
      const selectorHint = (el: Element): string => {
        const id = attr(el, 'id')
        const name = attr(el, 'name')
        const role = attr(el, 'role')
        const cls = normalize(Array.from(el.classList || []).slice(0, 3).join('.'))
        return [id ? `#${id}` : '', name ? `name=${name}` : '', role ? `role=${role}` : '', cls ? `.${cls}` : ''].filter(Boolean).join(' ')
      }
      const lines: string[] = []
      const htmlParts: string[] = []
      let links = 0
      let buttons = 0
      let inputs = 0
      let visited = 0

      const emit = (depth: number, kind: string, value: string): void => {
        if (lines.length >= MAX_LINES) return
        const text = shorten(value)
        if (!text) return
        const indent = '  '.repeat(Math.min(depth, 5))
        lines.push(`${indent}- ${kind}: ${text}`)
      }

      const visit = (node: Element, depth: number): void => {
        if (visited >= MAX_NODES || lines.length >= MAX_LINES) return
        if (seenElements.has(node)) return
        seenElements.add(node)
        visited += 1
        if (ignoredTags.has(node.tagName) || !isVisible(node)) return
        const tag = node.tagName.toLowerCase()
        const tagName = node.tagName
        const text = shorten(node.textContent || '')
        const indent = '  '.repeat(Math.min(depth, 4))
        const hint = selectorHint(node)

        if (tag === 'a') {
          links += 1
          const href = (node as HTMLAnchorElement).href || node.getAttribute('href') || ''
          const label = labelOf(node) || '(无文本)'
          emit(depth, 'link', `${label}${href ? ` -> ${href}` : ''}${hint ? ` [${hint}]` : ''}`)
        } else if (tag === 'button' || attr(node, 'role') === 'button' || /(^|\s)(btn|button)(\s|$|-|_)/i.test(node.className || '')) {
          buttons += 1
          const label = labelOf(node) || '(无文本)'
          emit(depth, 'button', `${(node as HTMLButtonElement).disabled ? '[disabled] ' : ''}${label}${hint ? ` [${hint}]` : ''}`)
        } else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          inputs += 1
          const input = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
          const type = tag === 'input' ? normalize((input as HTMLInputElement).type || attr(node, 'type') || 'text') : tag
          const label = labelOf(node) || '(未命名)'
          const value = 'value' in input ? normalize(input.value) : ''
          const checked = tag === 'input' && ['checkbox', 'radio'].includes(type) && (input as HTMLInputElement).checked
          const selected = tag === 'select' ? normalize((input as HTMLSelectElement).selectedOptions?.[0]?.textContent || value) : ''
          emit(depth, tag, `${label}${hint ? ` [${hint}]` : ''} type=${type}${value ? ` value="${shorten(value, 120)}"` : ''}${selected ? ` selected="${shorten(selected, 120)}"` : ''}${checked ? ' checked' : ''}${(input as HTMLInputElement).disabled ? ' disabled' : ''}`)
        } else if (/^h[1-6]$/.test(tag)) {
          emit(depth, tag, text)
        } else if (['p', 'summary', 'figcaption', 'label'].includes(tag) && text) {
          emit(depth, tag, text)
        } else if (tag === 'li' && text && node.querySelectorAll('a,button,input,textarea,select,[role="button"]').length === 0) {
          emit(depth, 'item', text)
        } else if (depth <= 2 && blockTags.has(tagName) && text && node.children.length <= 1) {
          emit(depth, 'section', text)
        } else if (depth <= 3 && text && node.children.length === 0) {
          emit(depth, 'text', text)
        }

        if (!innerTextOnly && htmlParts.length < MAX_HTML_PARTS) {
          const attrs = ['id', 'class', 'role', 'aria-label', 'placeholder', 'name']
            .map((name) => {
              const v = node.getAttribute(name)
              return v ? `${name}="${normalize(v).slice(0, 80)}"` : ''
            })
            .filter(Boolean)
            .join(' ')
          const preview = text ? ` ${text.slice(0, 160)}` : ''
          htmlParts.push(`${indent}<${tag}${attrs ? ` ${attrs}` : ''}>${preview}`)
        }

        if (depth >= MAX_DEPTH) {
          if (node.children.length > 0) emit(depth, 'omitted_depth', `${node.children.length} children`)
          return
        }

        const rawChildren = Array.from(node.children).filter((child) => !ignoredTags.has(child.tagName))
        const priorityChildren = rawChildren.filter((child) =>
          /^(A|BUTTON|INPUT|TEXTAREA|SELECT|H1|H2|H3|H4|H5|H6|IFRAME)$/.test(child.tagName) ||
          attr(child, 'role') === 'button' ||
          child.shadowRoot,
        )
        const normalChildren = rawChildren.filter((child) => !priorityChildren.includes(child))
        const children = [...priorityChildren, ...normalChildren].slice(0, MAX_CHILDREN)
        for (const child of children) visit(child, depth + 1)
        if (rawChildren.length > children.length) emit(depth, 'omitted_children', String(rawChildren.length - children.length))

        const shadowRoot = (node as HTMLElement).shadowRoot
        if (shadowRoot) {
          emit(depth, 'shadow-root', `${tag}${hint ? ` [${hint}]` : ''}`)
          for (const child of Array.from(shadowRoot.children).slice(0, 40)) visit(child, depth + 1)
        }

        if (tagName === 'IFRAME') {
          const frame = node as HTMLIFrameElement
          emit(depth, 'iframe', frame.src || attr(node, 'src') || '(inline)')
          try {
            const body = frame.contentDocument?.body
            if (body) visit(body, depth + 1)
          } catch {
            emit(depth, 'iframe_omitted', 'cross-origin')
          }
        }
      }

      visit(root, 0)
      if (lines.length >= MAX_LINES) lines.push(`- omitted_lines: reached ${MAX_LINES}`)
      const plainText = normalize((root as HTMLElement).innerText || root.textContent || '')
      const text = lines.length > 0 ? lines.join('\n') : plainText
      return { text, html: innerTextOnly ? '' : htmlParts.join('\n'), stats: { links, buttons, inputs } }
    },
    { selector, textOnly },
  )
}

async function executePageScript(page: Page, script: string): Promise<unknown> {
  return await page.evaluate(async (code) => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    const source = String(code ?? '').trim()
    if (!source) return null
    const lines = source.split(/\r?\n/)
    let lastIndex = lines.length - 1
    while (lastIndex >= 0 && !lines[lastIndex].trim()) lastIndex -= 1
    const lastLine = lastIndex >= 0 ? lines[lastIndex].trim() : ''
    const shouldAutoReturn =
      lastLine &&
      !/^(return\b|throw\b|if\b|for\b|while\b|switch\b|try\b|catch\b|finally\b|const\b|let\b|var\b|class\b|function\b|async\b|await\b|}\s*[);]?$)/.test(
        lastLine,
      )
    if (shouldAutoReturn) lines[lastIndex] = `${lines[lastIndex].match(/^\s*/)?.[0] ?? ''}return ${lines[lastIndex].trim()}`
    return await new AsyncFunction(lines.join('\n'))()
  }, script)
}

export class BrowserControlService {
  private readonly contexts = new Map<string, Promise<ManagedContext>>()

  constructor(private readonly userDataDir: string) {}

  async close(): Promise<void> {
    const entries = [...this.contexts.values()]
    this.contexts.clear()
    await Promise.all(
      entries.map(async (contextPromise) => {
        const managed = await contextPromise.catch(() => null)
        await managed?.context.close().catch(() => undefined)
      }),
    )
  }

  async listTabs(options: BrowserCommonOptions = {}): Promise<BrowserTabSummary[]> {
    const profile = safeProfileName(options.profile)
    const managed = this.contexts.has(profile) ? await this.ensureContext(options) : null
    if (!managed) return []
    return await this.summarizePages(managed)
  }

  async scan(options: BrowserScanOptions): Promise<string> {
    const profile = safeProfileName(options.profile)
    const maxChars = normalizeMaxChars(options.maxChars, DEFAULT_SCAN_MAX_CHARS)
    const managed = await this.ensureContext({ ...options, profile })
    const tabs = await this.summarizePages(managed)
    if (options.tabsOnly === true) {
      return clampText(JSON.stringify({ ok: true, activeTab: tabs.find((t) => t.active)?.id ?? null, tabs }, null, 2), maxChars)
    }

    const hasExplicitTarget =
      (typeof options.tabId === 'string' && options.tabId.trim()) || (typeof options.url === 'string' && options.url.trim())
    const page = await this.resolvePage(managed, options)
    if (!hasExplicitTarget && isBlankPageUrl(page.url())) {
      const currentTabs = await this.summarizePages(managed)
      return clampText(
        JSON.stringify(
          {
            ok: false,
            reason: 'no_active_nonblank_page',
            message:
              '当前 BrowserControlService profile 里没有可扫描的非空白活动页；“当前页”只表示桌宠内置 Playwright 标签页，不等于系统浏览器前台页。',
            activeTab: currentTabs.find((t) => t.active)?.id ?? null,
            tabs: currentTabs,
            hint: '先调用 browser.tabs 确认 tabId，或给 browser.scan 传入 url/tabId 后再扫描。',
          },
          null,
          2,
        ),
        maxChars,
      )
    }
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs)
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined)
    const title = await page.title().catch(() => '')
    const url = page.url()
    const selector = typeof options.selector === 'string' && options.selector.trim() ? options.selector.trim() : ''
    const textOnly = options.textOnly !== false
    const serialized = await serializePage(page, selector, textOnly)
    const content = textOnly ? serialized.text : serialized.html || serialized.text
    const result = {
      ok: true,
      tab: await this.summarizePage(managed, page),
      title,
      url,
      content: clampText(content, maxChars),
      stats: {
        ...serialized.stats,
        chars: content.length,
        truncated: content.trim().length > maxChars,
        textOnly,
      },
    }
    return JSON.stringify(result, null, 2)
  }

  async execJs(options: BrowserExecJsOptions): Promise<string> {
    const profile = safeProfileName(options.profile)
    const maxChars = normalizeMaxChars(options.maxChars, DEFAULT_EXEC_MAX_CHARS)
    const managed = await this.ensureContext({ ...options, profile })
    const page = await this.resolvePage(managed, options)
    const beforePages = new Set(this.openPages(managed))
    const beforeUrl = page.url()
    const before = options.noMonitor === true ? null : await this.readPageBasics(page)
    const data = await executePageScript(page, options.script)
    const finalPage = await this.waitForActionOutcome(managed, page, beforePages, beforeUrl, options.timeoutMs)
    const after = options.noMonitor === true ? null : await this.readPageBasics(finalPage)
    const sourceAfter = options.noMonitor === true || finalPage === page ? undefined : await this.readPageBasics(page).catch(() => undefined)
    const newTabs =
      options.noMonitor === true
        ? undefined
        : await this.summarizeNewPages(managed, [...this.openPages(managed)].filter((p) => !beforePages.has(p)))
    const result = {
      ok: true,
      tab: await this.summarizePage(managed, finalPage),
      result: data,
      delta:
        before && after
          ? {
              titleChanged: before.title !== after.title,
              urlChanged: before.url !== after.url,
              before,
              after,
              sourceAfter,
              activePageChanged: finalPage !== page,
              newTabs,
            }
          : undefined,
    }
    return clampText(JSON.stringify(result, null, 2), maxChars)
  }

  async screenshot(options: BrowserScreenshotToolOptions = {}): Promise<string> {
    const profile = safeProfileName(options.profile)
    const managed = await this.ensureContext({ ...options, profile })
    const page = await this.resolvePage(managed, options)
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs)
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => undefined)
    const shotPath = await this.takeScreenshot(page, options, options.taskId, timeoutMs)
    const result = {
      ok: true,
      tab: await this.summarizePage(managed, page),
      title: await page.title().catch(() => ''),
      url: page.url(),
      screenshot: shotPath,
    }
    return JSON.stringify(result, null, 2)
  }

  async closeTabs(options: BrowserCloseTabsOptions = {}): Promise<string> {
    const profile = safeProfileName(options.profile)
    const managed = this.contexts.has(profile) ? await this.ensureContext({ ...options, profile }) : null
    if (!managed) return JSON.stringify({ ok: true, closed: [], tabs: [] }, null, 2)

    const pages = this.openPages(managed)
    const active = this.preferredCurrentPage(managed, pages)
    const summaries = await this.summarizePages(managed)
    const tabIds = new Set((Array.isArray(options.tabIds) ? options.tabIds : []).filter((id) => typeof id === 'string' && id.trim()))
    const urlIncludes = (Array.isArray(options.urlIncludes) ? options.urlIncludes : []).filter((s) => typeof s === 'string' && s.trim())
    const titleIncludes = (Array.isArray(options.titleIncludes) ? options.titleIncludes : []).filter((s) => typeof s === 'string' && s.trim())
    const keepActive = options.keepActive !== false
    const hasSelector = tabIds.size > 0 || options.closeInactive === true || options.closeBlank === true || urlIncludes.length > 0 || titleIncludes.length > 0

    const selected: Array<{ page: Page; summary: BrowserTabSummary }> = []
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]
      const summary = summaries[index]
      if (!summary) continue
      const matches =
        tabIds.has(summary.id) ||
        (options.closeInactive === true && page !== active) ||
        (options.closeBlank === true && isBlankPageUrl(summary.url)) ||
        urlIncludes.some((needle) => summary.url.includes(needle)) ||
        titleIncludes.some((needle) => summary.title.includes(needle))
      if (!hasSelector || !matches) continue
      if (keepActive && page === active) continue
      selected.push({ page, summary })
    }

    for (const item of selected) {
      await item.page.close().catch(() => undefined)
    }

    if (!managed.activePage || managed.activePage.isClosed()) {
      managed.activePage = this.preferredCurrentPage(managed, this.openPages(managed))
    }

    return JSON.stringify({ ok: true, closed: selected.map((item) => item.summary), tabs: await this.summarizePages(managed) }, null, 2)
  }

  async runPlaywright(options: BrowserPlaywrightOptions): Promise<string> {
    const url = typeof options.url === 'string' ? options.url.trim() : ''
    if (!isHttpUrl(url)) throw new Error(`browser.playwright 需要有效 URL（http/https），当前：${url || '(空)'}`)

    const profile = safeProfileName(options.profile)
    const managed = await this.ensureContext({ ...options, profile })
    let page = await this.resolvePage(managed, { ...options, profile, url })
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs)
    const deadlineMs = Date.now() + timeoutMs

    // 取消时只关闭当前页，保留 persistent context，避免破坏其它标签页会话。
    const closePageOnAbort = () => {
      void page.close().catch(() => undefined)
    }
    if (options.signal) {
      if (options.signal.aborted) closePageOnAbort()
      else options.signal.addEventListener('abort', closePageOnAbort, { once: true })
    }

    try {
      for (const action of (options.actions ?? []).slice(0, 30)) {
        this.throwIfCanceled(options, deadlineMs)
        await options.waitIfPaused?.()
        this.throwIfCanceled(options, deadlineMs)
        const beforePages = new Set(this.openPages(managed))
        const beforeUrl = page.url()
        await this.runPlaywrightAction(page, action, timeoutMs, () => this.throwIfCanceled(options, deadlineMs))
        if (this.actionMayChangePage(action)) page = await this.waitForActionOutcome(managed, page, beforePages, beforeUrl, timeoutMs)
      }

      this.throwIfCanceled(options, deadlineMs)
      const title = await page.title().catch(() => '')
      const currentUrl = page.url() || url
      const extractPreview = await this.extractPage(page, options.extract, timeoutMs)
      const shotPath = await this.takeScreenshot(page, options.screenshot, options.taskId, timeoutMs)

      const lines: string[] = []
      if (title) lines.push(`title: ${title}`)
      lines.push(`url: ${currentUrl}`)
      lines.push(`tab: ${(await this.summarizePage(managed, page)).id}`)
      if (shotPath) lines.push(`screenshot: ${shotPath}`)
      if (extractPreview) lines.push(`extract(${this.normalizeExtractSelector(options.extract)}): ${extractPreview}`)
      return lines.join('\n')
    } finally {
      options.signal?.removeEventListener('abort', closePageOnAbort)
    }
  }

  private async ensureContext(options: BrowserCommonOptions): Promise<ManagedContext> {
    const profile = safeProfileName(options.profile)
    const existing = this.contexts.get(profile)
    if (existing) {
      const managed = await existing.catch((err) => {
        this.contexts.delete(profile)
        throw err
      })
      if (this.isContextUsable(managed)) return managed
      this.contexts.delete(profile)
    }

    const promise = this.createContext(profile, options).catch((err) => {
      this.contexts.delete(profile)
      throw err
    })
    this.contexts.set(profile, promise)
    return await promise
  }

  private async createContext(profile: string, options: BrowserCommonOptions): Promise<ManagedContext> {
    const pw = await import('playwright-core')
    const profileDir = path.join(this.userDataDir, 'playwright', profile)
    await fs.mkdir(profileDir, { recursive: true })
    const headless = options.headless === true
    const { channel, implicitDefault } = resolveChannel(options.channel)
    let context: BrowserContext
    try {
      context = await pw.chromium.launchPersistentContext(profileDir, {
        headless,
        channel,
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
      })
    } catch (error) {
      if (!implicitDefault) throw error
      context = await pw.chromium.launchPersistentContext(profileDir, {
        headless,
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
      })
    }
    const managed: ManagedContext = { profile, context, registeredPages: new WeakSet<Page>(), closed: false }
    context.once('close', () => {
      managed.closed = true
      void this.contexts.get(profile)?.then((current) => {
        if (current === managed) this.contexts.delete(profile)
      }, () => undefined)
    })
    context.on('page', (page) => {
      this.registerPage(managed, page, true)
    })
    for (const page of context.pages()) {
      this.registerPage(managed, page, !managed.activePage)
    }
    return managed
  }

  private async resolvePage(managed: ManagedContext, options: BrowserScanOptions | BrowserExecJsOptions | BrowserScreenshotToolOptions): Promise<Page> {
    const pages = this.openPages(managed)
    if (typeof options.tabId === 'string' && options.tabId.trim()) {
      const parsed = parseTabId(options.tabId)
      if (!parsed || parsed.profile !== managed.profile) throw new Error(`未知浏览器标签页：${options.tabId}`)
      const page = pages[parsed.index]
      if (!page) throw new Error(`浏览器标签页不存在：${options.tabId}`)
      if (typeof options.url === 'string' && options.url.trim()) await this.goto(page, options.url, options.timeoutMs)
      this.setActivePage(managed, page)
      return page
    }

    const url = typeof options.url === 'string' ? options.url.trim() : ''
    if (url) {
      const existing = pages.find((p) => p.url() === url)
      const page = existing ?? (pages[0] && pages[0].url() === 'about:blank' ? pages[0] : await managed.context.newPage())
      await this.goto(page, url, options.timeoutMs)
      this.setActivePage(managed, page)
      return page
    }

    const current = this.preferredCurrentPage(managed, pages)
    if (!current) {
      const page = await managed.context.newPage()
      this.registerPage(managed, page, true)
      return page
    }
    this.setActivePage(managed, current)
    return current
  }

  private openPages(managed: ManagedContext): Page[] {
    if (managed.closed) return []
    try {
      return managed.context.pages().filter((p) => !p.isClosed())
    } catch {
      managed.closed = true
      return []
    }
  }

  private isContextUsable(managed: ManagedContext): boolean {
    if (managed.closed) return false
    try {
      managed.context.pages()
      return true
    } catch {
      managed.closed = true
      return false
    }
  }

  private async waitForActionOutcome(
    managed: ManagedContext,
    sourcePage: Page,
    beforePages: Set<Page>,
    beforeUrl: string,
    timeoutMs?: number,
  ): Promise<Page> {
    const deadline = Date.now() + Math.min(ACTION_SETTLE_TIMEOUT_MS, normalizeTimeoutMs(timeoutMs))
    while (Date.now() < deadline) {
      const pages = this.openPages(managed)
      const newPages = pages.filter((page) => !beforePages.has(page) && !page.isClosed())
      const newPage = newPages[newPages.length - 1]
      if (newPage) {
        this.setActivePage(managed, newPage)
        await newPage.waitForLoadState('domcontentloaded', { timeout: Math.min(2_000, normalizeTimeoutMs(timeoutMs)) }).catch(() => undefined)
        return newPage
      }
      if (!sourcePage.isClosed() && sourcePage.url() !== beforeUrl) {
        this.setActivePage(managed, sourcePage)
        await sourcePage.waitForLoadState('domcontentloaded', { timeout: Math.min(2_000, normalizeTimeoutMs(timeoutMs)) }).catch(() => undefined)
        return sourcePage
      }
      await this.delay(100)
    }

    const active = managed.activePage && !managed.activePage.isClosed() ? managed.activePage : undefined
    if (active && active !== sourcePage && !beforePages.has(active)) return active
    return this.preferredCurrentPage(managed, this.openPages(managed)) ?? sourcePage
  }

  private actionMayChangePage(action: BrowserPlaywrightAction): boolean {
    return action.type === 'click' || action.type === 'press'
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  private async summarizeNewPages(managed: ManagedContext, pages: Page[]): Promise<BrowserTabSummary[]> {
    const all = this.openPages(managed)
    const summaries: BrowserTabSummary[] = []
    for (const page of pages) {
      if (page.isClosed()) continue
      summaries.push(await this.summarizePage(managed, page, all.indexOf(page)))
    }
    return summaries
  }

  private preferredCurrentPage(managed: ManagedContext, pages: Page[]): Page | undefined {
    const active = managed.activePage && !managed.activePage.isClosed() ? managed.activePage : undefined
    if (active && !isBlankPageUrl(active.url())) return active
    const nonBlank = pages.find((page) => !isBlankPageUrl(page.url()))
    return nonBlank ?? active ?? pages.find((p) => !p.isClosed())
  }

  private registerPage(managed: ManagedContext, page: Page, makeActive: boolean): void {
    if (managed.registeredPages.has(page)) {
      if (makeActive) this.setActivePage(managed, page)
      return
    }
    managed.registeredPages.add(page)
    page.on('popup', (popup) => {
      this.registerPage(managed, popup, true)
    })
    page.once('close', () => {
      if (managed.activePage === page) {
        managed.activePage = this.openPages(managed)[0]
      }
    })
    if (makeActive) this.setActivePage(managed, page)
  }

  private setActivePage(managed: ManagedContext, page: Page): void {
    if (!page.isClosed()) managed.activePage = page
  }

  private async goto(page: Page, url: string, timeoutMs?: number): Promise<void> {
    if (!isHttpUrl(url)) throw new Error(`需要有效 URL（http/https），当前：${url || '(空)'}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: normalizeTimeoutMs(timeoutMs) })
  }

  private throwIfCanceled(options: Pick<BrowserPlaywrightOptions, 'isCanceled'>, deadlineMs?: number): void {
    if (typeof options.isCanceled === 'function' && options.isCanceled()) throw new Error('canceled')
    if (typeof deadlineMs === 'number' && Date.now() > deadlineMs) throw new Error('playwright timeout')
  }

  private async runPlaywrightAction(page: Page, action: BrowserPlaywrightAction, timeoutMs: number, checkStop: () => void): Promise<void> {
    const type = typeof action?.type === 'string' ? action.type : ''
    if (!type) return

    if (type === 'waitMs') {
      const ms = typeof action?.ms === 'number' ? Math.max(0, Math.min(60_000, Math.trunc(action.ms))) : 500
      let remaining = ms
      while (remaining > 0) {
        checkStop()
        const step = Math.min(remaining, 500)
        await page.waitForTimeout(step)
        remaining -= step
      }
      checkStop()
      return
    }

    if (type === 'waitForLoad') {
      checkStop()
      const stateRaw = typeof action?.state === 'string' ? action.state : 'networkidle'
      const state = (['load', 'domcontentloaded', 'networkidle'].includes(stateRaw) ? stateRaw : 'networkidle') as
        | 'load'
        | 'domcontentloaded'
        | 'networkidle'
      await page.waitForLoadState(state, { timeout: timeoutMs })
      checkStop()
      return
    }

    const selector = typeof action?.selector === 'string' ? action.selector : ''
    if (!selector) return
    const loc = page.locator(selector).first()

    if (type === 'click') {
      checkStop()
      await loc.click({ timeout: timeoutMs })
      checkStop()
      return
    }
    if (type === 'fill') {
      checkStop()
      const text = typeof action?.text === 'string' ? action.text : ''
      await loc.fill(text, { timeout: timeoutMs })
      checkStop()
      return
    }
    if (type === 'press') {
      checkStop()
      const key = typeof action?.key === 'string' ? action.key : 'Enter'
      await loc.press(key, { timeout: timeoutMs })
      checkStop()
      return
    }
    if (type === 'waitFor') {
      checkStop()
      await loc.innerText({ timeout: timeoutMs })
      checkStop()
    }
  }

  private normalizeExtractSelector(extract?: BrowserExtractOptions | null): string {
    return extract && typeof extract.selector === 'string' ? extract.selector : 'body'
  }

  private async extractPage(page: Page, extract: BrowserExtractOptions | null | undefined, timeoutMs: number): Promise<string> {
    if (!extract) return ''

    const selector = this.normalizeExtractSelector(extract)
    const formatRaw = typeof extract.format === 'string' ? extract.format : 'innerText'
    const format = ['innerText', 'text', 'html'].includes(formatRaw) ? formatRaw : 'innerText'
    const maxChars = normalizeExtractMaxChars(extract.maxChars)

    try {
      const loc = page.locator(selector).first()
      let extracted = ''
      if (format === 'html') extracted = await loc.innerHTML({ timeout: timeoutMs })
      else if (format === 'text') extracted = (await loc.textContent({ timeout: timeoutMs })) ?? ''
      else extracted = await loc.innerText({ timeout: timeoutMs })
      return extracted ? clampText(extracted.slice(0, maxChars), maxChars) : ''
    } catch (err) {
      if (extract.optional === true) return ''
      throw err
    }
  }

  private async takeScreenshot(
    page: Page,
    screenshot: BrowserScreenshotOptions | null | undefined,
    taskId: string | undefined,
    timeoutMs: number,
  ): Promise<string> {
    if (!screenshot) return ''

    const rel =
      typeof screenshot.path === 'string' && screenshot.path.trim()
        ? screenshot.path.trim()
        : `task-output/${taskId || `browser-${Date.now().toString(36)}`}-shot.png`
    const fullPath = path.isAbsolute(rel) ? rel : path.join(this.userDataDir, rel)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await page.screenshot({ path: fullPath, fullPage: screenshot.fullPage === true, timeout: timeoutMs })
    return fullPath
  }

  private async summarizePages(managed: ManagedContext): Promise<BrowserTabSummary[]> {
    const pages = this.openPages(managed)
    const summaries: BrowserTabSummary[] = []
    for (let index = 0; index < pages.length; index += 1) {
      summaries.push(await this.summarizePage(managed, pages[index], index))
    }
    return summaries
  }

  private async summarizePage(managed: ManagedContext, page: Page, index?: number): Promise<BrowserTabSummary> {
    const pages = this.openPages(managed)
    const pageIndex = typeof index === 'number' ? index : Math.max(0, pages.indexOf(page))
    return {
      id: buildTabId(managed.profile, pageIndex),
      title: await page.title().catch(() => ''),
      url: page.url(),
      active: managed.activePage === page,
      target: 'playwright',
      profile: managed.profile,
    }
  }

  private async readPageBasics(page: Page): Promise<{ title: string; url: string }> {
    return { title: await page.title().catch(() => ''), url: page.url() }
  }
}

const services = new Map<string, BrowserControlService>()

export function getBrowserControlService(userDataDir: string): BrowserControlService {
  const key = path.resolve(userDataDir)
  const existing = services.get(key)
  if (existing) return existing
  const service = new BrowserControlService(key)
  services.set(key, service)
  return service
}

export async function closeAllBrowserControlServices(): Promise<void> {
  const all = [...services.values()]
  services.clear()
  await Promise.all(all.map((service) => service.close()))
}
