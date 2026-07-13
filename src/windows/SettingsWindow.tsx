import type { AppSettings } from '../../electron/types'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAvailableModels, parseModelMetadata, scanAvailableModels, type Live2DModelInfo } from '../live2d/live2dModels'
import { getApi } from '../neoDeskPetApi'
import type { SettingsConfirmAction, SettingsConfirmOptions } from './settings/settingsConfirm'
import {
  SETTINGS_NAV_GROUPS,
  searchSettings,
  type SettingsSearchEntry,
  type SettingsViewId,
} from './settings/settingsNavigation'

const AISettingsTab = lazy(() => import('./settings/AiTab').then((module) => ({ default: module.AISettingsTab })))
const AsrSettingsTab = lazy(() => import('./settings/AsrTab').then((module) => ({ default: module.AsrSettingsTab })))
const BubbleSettingsTab = lazy(() => import('./settings/BubbleTab').then((module) => ({ default: module.BubbleSettingsTab })))
const ChatUiSettingsTab = lazy(() => import('./settings/ChatUiTab').then((module) => ({ default: module.ChatUiSettingsTab })))
const Live2DSettingsTab = lazy(() => import('./settings/Live2DTab').then((module) => ({ default: module.Live2DSettingsTab })))
const NovelAISettingsTab = lazy(() => import('./settings/NovelAITab').then((module) => ({ default: module.NovelAISettingsTab })))
const PersonaSettingsTab = lazy(() => import('./settings/PersonaTab').then((module) => ({ default: module.PersonaSettingsTab })))
const TaskPanelSettingsTab = lazy(() =>
  import('./settings/TaskPanelTab').then((module) => ({ default: module.TaskPanelSettingsTab })),
)
const ToolsSettingsTab = lazy(() => import('./settings/ToolsTab').then((module) => ({ default: module.ToolsSettingsTab })))
const TtsSettingsTab = lazy(() => import('./settings/TtsTab').then((module) => ({ default: module.TtsSettingsTab })))
const WorldBookSettingsTab = lazy(() =>
  import('./settings/WorldBookTab').then((module) => ({ default: module.WorldBookSettingsTab })),
)

type SettingsSaveState =
  | { state: 'idle'; message: '' }
  | { state: 'saving'; message: '保存中' }
  | { state: 'saved'; message: '已保存' }
  | { state: 'error'; message: string }

const MUTATION_PREFIXES = ['set', 'save', 'delete', 'create', 'update', 'apply', 'clear']

function isSettingsMutation(name: string): boolean {
  return MUTATION_PREFIXES.some((prefix) => name.startsWith(prefix))
}

function normalizeAnchorText(value: string): string {
  return value.replace(/\s+/g, '').toLocaleLowerCase()
}

export function SettingsWindow(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const [activeView, setActiveView] = useState<SettingsViewId>('live2d')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchIndex, setSearchIndex] = useState(0)
  const [personaSubTab, setPersonaSubTab] = useState<'persona' | 'memory' | 'recall' | 'textVector' | 'mmVector' | 'manage'>('persona')
  const [pendingAnchor, setPendingAnchor] = useState<{ anchor: string; nonce: number } | null>(null)
  const [saveState, setSaveState] = useState<SettingsSaveState>({ state: 'idle', message: '' })
  const [confirmation, setConfirmation] = useState<SettingsConfirmOptions | null>(null)
  const [availableModels, setAvailableModels] = useState<Live2DModelInfo[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [selectedModelInfo, setSelectedModelInfo] = useState<Live2DModelInfo | null>(null)
  const lastModelScanAtRef = useRef(0)
  const saveSequenceRef = useRef(0)
  const saveResetTimerRef = useRef<number | null>(null)
  const confirmationResolverRef = useRef<((value: boolean) => void) | null>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLElement>(null)

  const petScale = settings?.petScale ?? 1.0
  const petOpacity = settings?.petOpacity ?? 1.0
  const live2dModelId = settings?.live2dModelId ?? 'haru'
  const live2dMouseTrackingEnabled = settings?.live2dMouseTrackingEnabled !== false
  const live2dIdleSwayEnabled = settings?.live2dIdleSwayEnabled !== false
  const aiSettings = settings?.ai
  const novelAISettings = settings?.novelai
  const bubbleSettings = settings?.bubble
  const chatUi = settings?.chatUi
  const ttsSettings = settings?.tts
  const asrSettings = settings?.asr

  const searchResults = useMemo(() => searchSettings(searchQuery), [searchQuery])
  const activeItem = useMemo(
    () => SETTINGS_NAV_GROUPS.flatMap((group) => group.items).find((item) => item.id === activeView),
    [activeView],
  )

  const trackedApi = useMemo(() => {
    if (!api) return null
    const cached = new Map<PropertyKey, unknown>()
    return new Proxy(api, {
      get(target, property, receiver) {
        const existing = cached.get(property)
        if (existing) return existing
        const value = Reflect.get(target, property, receiver)
        if (typeof value !== 'function') return value

        const bound = value.bind(target)
        if (typeof property !== 'string' || !isSettingsMutation(property)) {
          cached.set(property, bound)
          return bound
        }

        const wrapped = (...args: unknown[]) => {
          const sequence = ++saveSequenceRef.current
          if (saveResetTimerRef.current != null) window.clearTimeout(saveResetTimerRef.current)
          setSaveState({ state: 'saving', message: '保存中' })
          let result: unknown
          try {
            result = bound(...args)
          } catch (error) {
            if (sequence === saveSequenceRef.current) {
              setSaveState({ state: 'error', message: error instanceof Error ? error.message : String(error) })
            }
            throw error
          }
          return Promise.resolve(result).then(
            (resolved) => {
              if (sequence === saveSequenceRef.current) {
                setSaveState({ state: 'saved', message: '已保存' })
                saveResetTimerRef.current = window.setTimeout(() => {
                  setSaveState({ state: 'idle', message: '' })
                }, 1800)
              }
              return resolved
            },
            (error) => {
              if (sequence === saveSequenceRef.current) {
                setSaveState({ state: 'error', message: error instanceof Error ? error.message : String(error) })
              }
              throw error
            },
          )
        }
        cached.set(property, wrapped)
        return wrapped
      },
    }) as typeof api
  }, [api])

  useEffect(() => {
    return () => {
      if (saveResetTimerRef.current != null) window.clearTimeout(saveResetTimerRef.current)
      confirmationResolverRef.current?.(false)
    }
  }, [])

  const refreshModels = useCallback(
    async (opts?: { force?: boolean }) => {
      const now = Date.now()
      if (!opts?.force && now - lastModelScanAtRef.current < 800) return
      lastModelScanAtRef.current = now
      setIsLoadingModels(true)
      try {
        setAvailableModels(await scanAvailableModels())
      } catch (error) {
        console.error('[Settings] Failed to scan models:', error)
        setAvailableModels(getAvailableModels())
      } finally {
        setIsLoadingModels(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (activeView === 'live2d') void refreshModels({ force: availableModels.length === 0 })
  }, [activeView, availableModels.length, refreshModels])

  useEffect(() => {
    const model = availableModels.find((item) => item.id === live2dModelId)
    if (!model) {
      setSelectedModelInfo(null)
      return
    }
    setSelectedModelInfo(model)
    void parseModelMetadata(model.modelFile).then((metadata) => {
      setSelectedModelInfo({ ...model, ...metadata })
    })
  }, [availableModels, live2dModelId])

  useEffect(() => {
    setSearchIndex(0)
  }, [searchQuery])

  useEffect(() => {
    if (!pendingAnchor) return
    let canceled = false
    let attempts = 0
    let highlightTimer: number | null = null
    let retryTimer: number | null = null
    const locate = () => {
      if (canceled) return
      const content = contentRef.current
      if (!content) return
      const targetText = normalizeAnchorText(pendingAnchor.anchor)
      const candidates = Array.from(content.querySelectorAll<HTMLElement>('h3, label'))
      const label = candidates.find((candidate) => normalizeAnchorText(candidate.textContent ?? '').includes(targetText))
      if (!label && attempts < 8) {
        attempts += 1
        retryTimer = window.setTimeout(locate, 60)
        return
      }
      const target = label?.closest<HTMLElement>('.ndp-setting-item') ?? label
      if (!target) return
      target.scrollIntoView({ block: 'center' })
      target.classList.add('ndp-setting-search-hit')
      highlightTimer = window.setTimeout(() => target.classList.remove('ndp-setting-search-hit'), 1800)
    }
    requestAnimationFrame(locate)
    return () => {
      canceled = true
      if (highlightTimer != null) window.clearTimeout(highlightTimer)
      if (retryTimer != null) window.clearTimeout(retryTimer)
    }
  }, [activeView, pendingAnchor])

  const activateView = useCallback((view: SettingsViewId) => {
    setActiveView(view)
    setPendingAnchor(null)
    if (view === 'persona') setPersonaSubTab('persona')
    setSearchQuery('')
    setSearchOpen(false)
    contentRef.current?.scrollTo({ top: 0 })
  }, [])

  useEffect(() => {
    if (!api) return
    let active = true
    const off = api.onSettingsNavigate((target) => {
      activateView(target)
      void api.consumeSettingsNavigation()
    })
    void api.consumeSettingsNavigation().then((target) => {
      if (active && target) activateView(target)
    })
    return () => {
      active = false
      off()
    }
  }, [activateView, api])

  const selectSearchResult = useCallback((entry: SettingsSearchEntry) => {
    setActiveView(entry.view)
    if (entry.personaSubTab) setPersonaSubTab(entry.personaSubTab)
    setPendingAnchor({ anchor: entry.anchor, nonce: Date.now() })
    setSearchQuery(entry.label)
    setSearchOpen(false)
  }, [])

  const requestConfirmation = useCallback<SettingsConfirmAction>((options) => {
    confirmationResolverRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      confirmationResolverRef.current = resolve
      setConfirmation(options)
    })
  }, [])

  const settleConfirmation = useCallback((value: boolean) => {
    const resolve = confirmationResolverRef.current
    confirmationResolverRef.current = null
    setConfirmation(null)
    resolve?.(value)
  }, [])

  useEffect(() => {
    if (!confirmation) return
    confirmButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') settleConfirmation(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmation, settleConfirmation])

  const renderActiveView = () => {
    if (activeView === 'live2d') {
      return (
        <Live2DSettingsTab
          api={trackedApi}
          petScale={petScale}
          petOpacity={petOpacity}
          live2dModelId={live2dModelId}
          live2dMouseTrackingEnabled={live2dMouseTrackingEnabled}
          live2dIdleSwayEnabled={live2dIdleSwayEnabled}
          availableModels={availableModels}
          selectedModelInfo={selectedModelInfo}
          isLoadingModels={isLoadingModels}
          refreshModels={refreshModels}
        />
      )
    }
    if (activeView === 'bubble') return <BubbleSettingsTab api={trackedApi} bubbleSettings={bubbleSettings} />
    if (activeView === 'taskPanel') {
      return <TaskPanelSettingsTab api={trackedApi} taskPanelSettings={settings?.taskPanel} />
    }
    if (activeView.startsWith('ai')) {
      const view =
        activeView === 'aiConnection'
          ? 'connection'
          : activeView === 'aiGeneration'
            ? 'generation'
            : activeView === 'aiVision'
              ? 'vision'
              : 'agent'
      return (
        <AISettingsTab
          api={trackedApi}
          aiSettings={aiSettings}
          orchestrator={settings?.orchestrator}
          aiProfiles={settings?.aiProfiles}
          activeAiProfileId={settings?.activeAiProfileId}
          view={view}
        />
      )
    }
    if (activeView === 'novelai') return <NovelAISettingsTab api={trackedApi} settings={novelAISettings} />
    if (activeView === 'tools') return <ToolsSettingsTab api={trackedApi} settings={settings} />
    if (activeView === 'persona') {
      return (
        <PersonaSettingsTab
          api={trackedApi}
          settings={settings}
          confirmAction={requestConfirmation}
          requestedSubTab={personaSubTab}
        />
      )
    }
    if (activeView === 'worldBook') {
      return <WorldBookSettingsTab api={trackedApi} settings={settings} confirmAction={requestConfirmation} />
    }
    if (activeView === 'tts') return <TtsSettingsTab api={trackedApi} ttsSettings={ttsSettings} />
    if (activeView === 'asr') return <AsrSettingsTab api={trackedApi} asrSettings={asrSettings} />
    return <ChatUiSettingsTab api={trackedApi} chatUi={chatUi} />
  }

  return (
    <div className="ndp-settings-root" data-save-state={saveState.state}>
      <header className="ndp-settings-header">
        <div className="ndp-settings-title">
          <span className="ndp-settings-icon" aria-hidden="true">⚙</span>
          <span>设置</span>
          <span className={`ndp-settings-save-state ${saveState.state}`} role="status" aria-live="polite">
            {saveState.message}
          </span>
        </div>
        <div className="ndp-actions">
          <button className="ndp-btn" onClick={() => trackedApi?.openMemory()}>
            记忆控制台
          </button>
          <button className="ndp-btn ndp-btn-close" aria-label="关闭设置" onClick={() => trackedApi?.closeCurrent()}>
            ×
          </button>
        </div>
      </header>

      <div className="ndp-settings-layout">
        <aside className="ndp-settings-sidebar">
          <div className="ndp-settings-search-wrap">
            <input
              className="ndp-settings-search"
              type="search"
              value={searchQuery}
              aria-label="搜索设置"
              placeholder="搜索设置"
              onFocus={() => setSearchOpen(true)}
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setSearchOpen(true)
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && searchResults.length > 0) {
                  event.preventDefault()
                  setSearchIndex((index) => (index + 1) % searchResults.length)
                } else if (event.key === 'ArrowUp' && searchResults.length > 0) {
                  event.preventDefault()
                  setSearchIndex((index) => (index - 1 + searchResults.length) % searchResults.length)
                } else if (event.key === 'Enter' && searchResults.length > 0) {
                  event.preventDefault()
                  selectSearchResult(searchResults[searchIndex] ?? searchResults[0])
                } else if (event.key === 'Escape') {
                  setSearchOpen(false)
                }
              }}
            />
            {searchOpen && searchQuery.trim() ? (
              <div className="ndp-settings-search-results" role="listbox" aria-label="设置搜索结果">
                {searchResults.length > 0 ? (
                  searchResults.map((entry, index) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={index === searchIndex}
                      className={`ndp-settings-search-result ${index === searchIndex ? 'active' : ''}`}
                      onMouseEnter={() => setSearchIndex(index)}
                      onClick={() => selectSearchResult(entry)}
                    >
                      <span>{entry.label}</span>
                      <small>{entry.path}</small>
                    </button>
                  ))
                ) : (
                  <div className="ndp-settings-search-empty">没有匹配的设置</div>
                )}
              </div>
            ) : null}
          </div>

          <nav className="ndp-settings-nav" aria-label="设置分类">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div className="ndp-settings-nav-group" key={group.id}>
                <div className="ndp-settings-nav-label">{group.label}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`ndp-settings-nav-item ${activeView === item.id ? 'active' : ''}`}
                    aria-current={activeView === item.id ? 'page' : undefined}
                    title={item.summary}
                    onClick={() => activateView(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <main className="ndp-settings-content" ref={contentRef} tabIndex={-1}>
          <div className="ndp-settings-page-heading">{activeItem?.label ?? '设置'}</div>
          <Suspense fallback={null}>{renderActiveView()}</Suspense>
        </main>
      </div>

      {confirmation ? (
        <div className="ndp-settings-dialog-backdrop" onMouseDown={() => settleConfirmation(false)}>
          <div
            className="ndp-settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ndp-settings-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="ndp-settings-dialog-title">{confirmation.title}</h2>
            <p>{confirmation.message}</p>
            <div className="ndp-settings-dialog-actions">
              <button type="button" className="ndp-btn" onClick={() => settleConfirmation(false)}>
                取消
              </button>
              <button
                ref={confirmButtonRef}
                type="button"
                className={`ndp-btn ${confirmation.danger ? 'ndp-btn-danger' : ''}`}
                onClick={() => settleConfirmation(true)}
              >
                {confirmation.confirmLabel ?? '确认'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
