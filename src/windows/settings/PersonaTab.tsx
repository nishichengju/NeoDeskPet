import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, Persona, PersonaSummary } from '../../../electron/types'
import { getApi } from '../../neoDeskPetApi'

export function PersonaSettingsTab(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const activePersonaId = settings?.activePersonaId ?? 'default'
  const memoryEnabled = settings?.memory?.enabled ?? true
  const includeSharedOnRetrieve = settings?.memory?.includeSharedOnRetrieve ?? true
  const vectorDedupeThreshold = settings?.memory?.vectorDedupeThreshold ?? 0.9

  const autoExtractEnabled = settings?.memory?.autoExtractEnabled ?? false
  const autoExtractEveryEffectiveMessages = settings?.memory?.autoExtractEveryEffectiveMessages ?? 20
  const autoExtractMaxEffectiveMessages = settings?.memory?.autoExtractMaxEffectiveMessages ?? 60
  const autoExtractCooldownMs = settings?.memory?.autoExtractCooldownMs ?? 120000
  const autoExtractUseCustomAi = settings?.memory?.autoExtractUseCustomAi ?? false
  const autoExtractAiBaseUrl = settings?.memory?.autoExtractAiBaseUrl ?? ''
  const autoExtractAiApiKey = settings?.memory?.autoExtractAiApiKey ?? ''
  const autoExtractAiModel = settings?.memory?.autoExtractAiModel ?? ''
  const autoExtractAiTemperature = settings?.memory?.autoExtractAiTemperature ?? 0.2
  const autoExtractAiMaxTokens = settings?.memory?.autoExtractAiMaxTokens ?? 1600

  const tagEnabled = settings?.memory?.tagEnabled ?? true
  const tagMaxExpand = settings?.memory?.tagMaxExpand ?? 6

  const vectorEnabled = settings?.memory?.vectorEnabled ?? false
  const vectorEmbeddingModel = settings?.memory?.vectorEmbeddingModel ?? 'text-embedding-3-small'
  const vectorMinScore = settings?.memory?.vectorMinScore ?? 0.35
  const vectorTopK = settings?.memory?.vectorTopK ?? 20
  const vectorScanLimit = settings?.memory?.vectorScanLimit ?? 2000
  const vectorUseCustomAi = settings?.memory?.vectorUseCustomAi ?? false
  const vectorAiBaseUrl = settings?.memory?.vectorAiBaseUrl ?? ''
  const vectorAiApiKey = settings?.memory?.vectorAiApiKey ?? ''

  const mmVectorEnabled = settings?.memory?.mmVectorEnabled ?? false
  const mmVectorEmbeddingModel = settings?.memory?.mmVectorEmbeddingModel ?? 'qwen3-vl-embedding-8b'
  const mmVectorUseCustomAi = settings?.memory?.mmVectorUseCustomAi ?? false
  const mmVectorAiBaseUrl = settings?.memory?.mmVectorAiBaseUrl ?? ''
  const mmVectorAiApiKey = settings?.memory?.mmVectorAiApiKey ?? ''

  const kgEnabled = settings?.memory?.kgEnabled ?? false
  const kgIncludeChatMessages = settings?.memory?.kgIncludeChatMessages ?? false
  const kgUseCustomAi = settings?.memory?.kgUseCustomAi ?? true
  const kgAiBaseUrl = settings?.memory?.kgAiBaseUrl ?? ''
  const kgAiApiKey = settings?.memory?.kgAiApiKey ?? ''
  const kgAiModel = settings?.memory?.kgAiModel ?? 'gpt-4o-mini'
  const kgAiTemperature = settings?.memory?.kgAiTemperature ?? 0.2
  const kgAiMaxTokens = settings?.memory?.kgAiMaxTokens ?? 1200

  const [personas, setPersonas] = useState<PersonaSummary[]>([])
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [subTab, setSubTab] = useState<'persona' | 'memory' | 'recall' | 'textVector' | 'mmVector' | 'manage'>('persona')
  const [memScope, setMemScope] = useState<'persona' | 'shared' | 'all'>('persona')
  const [memRole, setMemRole] = useState<'all' | 'user' | 'assistant' | 'note'>('all')
  const [memQuery, setMemQuery] = useState('')
  const [memItems, setMemItems] = useState<Array<{ rowid: number; createdAt: number; role: string | null; kind: string; scope: string; content: string }>>([])
  const [memTotal, setMemTotal] = useState(0)
  const [memOffset, setMemOffset] = useState(0)
  const [memNewText, setMemNewText] = useState('')
  const [memNewScope, setMemNewScope] = useState<'persona' | 'shared'>('persona')
  const saveTimerRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    if (!api) return
    const list = await api.listPersonas()
    setPersonas(list)
  }, [api])

  const refreshMemoryList = useCallback(async () => {
    if (!api) return
    const res = await api.listMemory({
      personaId: activePersonaId,
      scope: memScope,
      role: memRole,
      query: memQuery.trim() || undefined,
      limit: 50,
      offset: memOffset,
    })
    setMemTotal(res.total)
    setMemItems(res.items)
  }, [api, activePersonaId, memScope, memRole, memQuery, memOffset])

  useEffect(() => {
    if (!api) return
    void refresh().catch((err) => console.error('[Persona] listPersonas failed:', err))
  }, [api, refresh])

  useEffect(() => {
    void (async () => {
      if (!api) return
      const p = await api.getPersona(activePersonaId)
      setCurrentPersona(p)
      setDraftName(p?.name ?? '')
      setDraftPrompt(p?.prompt ?? '')
      setMemScope('persona')
      setMemRole('all')
      setMemQuery('')
      setMemOffset(0)
    })().catch((err) => console.error('[Persona] getPersona failed:', err))
  }, [api, activePersonaId])

  useEffect(() => {
    if (!api) return
    void refreshMemoryList().catch((err) => console.error('[Memory] list failed:', err))
  }, [api, refreshMemoryList])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [])

  const scheduleSavePrompt = useCallback(
    (personaId: string, prompt: string) => {
      if (!api) return
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        void api
          .updatePersona(personaId, { prompt })
          .then((p) => setCurrentPersona(p))
          .catch((err) => console.error('[Persona] updatePersona failed:', err))
      }, 450)
    },
    [api],
  )

  const scheduleSavePersonaFlags = useCallback(
    (personaId: string, patch: { captureEnabled?: boolean; captureUser?: boolean; captureAssistant?: boolean; retrieveEnabled?: boolean }) => {
      if (!api) return
      void api
        .updatePersona(personaId, patch)
        .then((p) => setCurrentPersona(p))
        .catch((err) => console.error('[Persona] updatePersona flags failed:', err))
    },
    [api],
  )

  const onChangePersona = useCallback(
    async (personaId: string) => {
      if (!api) return
      await api.setActivePersonaId(personaId)
    },
    [api],
  )

  const onToggleGlobalMemory = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      await api.setMemorySettings({ enabled })
    },
    [api],
  )

  const onToggleIncludeShared = useCallback(
    async (enabled: boolean) => {
      if (!api) return
      await api.setMemorySettings({ includeSharedOnRetrieve: enabled })
    },
    [api],
  )

  const onSetAutoExtractSettings = useCallback(
    async (patch: Partial<AppSettings['memory']>) => {
      if (!api) return
      await api.setMemorySettings(patch)
    },
    [api],
  )

  const onCreatePersona = useCallback(async () => {
    if (!api) return
    const created = await api.createPersona('新角色')
    await refresh()
    await api.setActivePersonaId(created.id)
  }, [api, refresh])

  const onRenamePersona = useCallback(async () => {
    if (!api) return
    if (!currentPersona) return
    const nextName = draftName.trim()
    if (!nextName) return
    await api.updatePersona(currentPersona.id, { name: nextName })
    await refresh()
  }, [api, currentPersona, draftName, refresh])

  const onDeletePersona = useCallback(async () => {
    if (!api) return
    if (!currentPersona) return
    if (currentPersona.id === 'default') return
    const ok = window.confirm(`确定删除角色「${currentPersona.name}」？\n该操作会删除人设配置；聊天会话仍会保留在本地。`)
    if (!ok) return
    await api.deletePersona(currentPersona.id)
    await refresh()
    await api.setActivePersonaId('default')
  }, [api, currentPersona, refresh])

  const onAddManualMemory = useCallback(async () => {
    if (!api) return
    const content = memNewText.trim()
    if (!content) return
    await api.upsertManualMemory({ personaId: activePersonaId, scope: memNewScope, content })
    setMemNewText('')
    setMemOffset(0)
    await refreshMemoryList()
  }, [api, activePersonaId, memNewScope, memNewText, refreshMemoryList])

  const onDeleteMemory = useCallback(
    async (rowid: number) => {
      if (!api) return
      const ok = window.confirm('确定删除这条记忆？')
      if (!ok) return
      await api.deleteMemory({ rowid })
      await refreshMemoryList()
    },
    [api, refreshMemoryList],
  )

  if (!api) {
    return (
      <div className="ndp-settings-section">
        <h3>角色</h3>
        <p className="ndp-setting-hint">API 未就绪，请稍后再试。</p>
      </div>
    )
  }

  return (
    <div className="ndp-settings-section">
      <div className="ndp-settings-subtabs">
        <button className={`ndp-tab-btn ${subTab === 'persona' ? 'active' : ''}`} onClick={() => setSubTab('persona')}>
          角色
        </button>
        <button className={`ndp-tab-btn ${subTab === 'memory' ? 'active' : ''}`} onClick={() => setSubTab('memory')}>
          记忆
        </button>
        <button className={`ndp-tab-btn ${subTab === 'recall' ? 'active' : ''}`} onClick={() => setSubTab('recall')}>
          召回
        </button>
        <button className={`ndp-tab-btn ${subTab === 'textVector' ? 'active' : ''}`} onClick={() => setSubTab('textVector')}>
          文本向量
        </button>
        <button className={`ndp-tab-btn ${subTab === 'mmVector' ? 'active' : ''}`} onClick={() => setSubTab('mmVector')}>
          多模态向量
        </button>
        <button className={`ndp-tab-btn ${subTab === 'manage' ? 'active' : ''}`} onClick={() => setSubTab('manage')}>
          管理
        </button>
      </div>

      {subTab === 'persona' ? (
        <>
          <h3>角色</h3>

          <div className="ndp-setting-item">
            <label>当前角色</label>
            <div className="ndp-row">
              <select className="ndp-select" value={activePersonaId} onChange={(e) => void onChangePersona(e.target.value)}>
                {personas.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="ndp-btn" onClick={() => void onCreatePersona()}>
                新建
              </button>
              <button className="ndp-btn" disabled={!currentPersona || currentPersona.id === 'default'} onClick={() => void onDeletePersona()}>
                删除
              </button>
            </div>
            <p className="ndp-setting-hint">每个角色的长期记忆与会话列表隔离；公共事实层后续再加。</p>
          </div>

          <div className="ndp-setting-item">
            <label>角色名称</label>
            <div className="ndp-row">
              <input className="ndp-input" value={draftName} onChange={(e) => setDraftName(e.target.value)} />
              <button className="ndp-btn" disabled={!currentPersona} onClick={() => void onRenamePersona()}>
                保存
              </button>
            </div>
          </div>

          <div className="ndp-setting-item">
            <label>人设补充提示词</label>
            <textarea
              className="ndp-textarea"
              rows={10}
              value={draftPrompt}
              placeholder="写下这个角色的口癖、价值观、禁忌、关系设定等（会追加到全局 systemPrompt 后）"
              onChange={(e) => {
                const next = e.target.value
                setDraftPrompt(next)
                if (currentPersona) scheduleSavePrompt(currentPersona.id, next)
              }}
            />
            <p className="ndp-setting-hint">建议只写“稳定约束”。对话原文会自动写入长期记忆库用于召回。</p>
          </div>
        </>
      ) : null}

      {subTab === 'memory' ? <h3>记忆开关</h3> : null}

      {subTab === 'memory' ? (
        <>
          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input type="checkbox" checked={memoryEnabled} onChange={(e) => void onToggleGlobalMemory(e.target.checked)} />
              <span>启用长期记忆（全局）</span>
            </label>
            <p className="ndp-setting-hint">关闭后不会再记录新内容，也不会将记忆注入到提示词。</p>
          </div>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={includeSharedOnRetrieve}
                onChange={(e) => void onToggleIncludeShared(e.target.checked)}
              />
              <span>检索时包含共享记忆（默认）</span>
            </label>
          </div>
        </>
      ) : null}

      {subTab === 'textVector' ? (
        <>
          <h3>向量去重</h3>

          <div className="ndp-setting-item">
            <label>向量去重阈值（越高越保守）</label>
            <input
              className="ndp-input"
              type="number"
              min={0.1}
              max={0.99}
              step={0.01}
              value={vectorDedupeThreshold}
              onChange={(e) => void onSetAutoExtractSettings({ vectorDedupeThreshold: Number(e.target.value) })}
            />
            <p className="ndp-setting-hint">每次写入记忆时：先用 embeddings 做相似度匹配，命中相似条目就立即合并，不新增重复记录。</p>
          </div>
        </>
      ) : null}

      {subTab === 'recall' ? (
        <>
          <h3>召回增强（M5）</h3>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={tagEnabled}
                onChange={(e) => void onSetAutoExtractSettings({ tagEnabled: e.target.checked })}
              />
              <span>启用 Tag 网络（模糊问法扩展，本地低延迟）</span>
            </label>
            <p className="ndp-setting-hint">把重点词拆成轻量 Tag，用于模糊问法的扩展与召回。</p>
          </div>

          <div className="ndp-setting-item">
            <label>Tag 扩展数（0=不扩展）</label>
            <input
              className="ndp-input"
              type="number"
              min={0}
              max={40}
              value={tagMaxExpand}
              onChange={(e) => void onSetAutoExtractSettings({ tagMaxExpand: Number(e.target.value) })}
            />
          </div>
        </>
      ) : null}

      {subTab === 'textVector' ? (
        <>
          <h3>文本向量召回（M5）</h3>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={vectorEnabled}
                onChange={(e) => void onSetAutoExtractSettings({ vectorEnabled: e.target.checked })}
              />
              <span>启用向量召回（更强，需 embeddings API）</span>
            </label>
            <p className="ndp-setting-hint">启用后会在后台逐步补齐你的记忆嵌入，不会阻塞聊天。</p>
          </div>

      <div className="ndp-setting-item">
        <label>embeddings 模型</label>
        <input
          className="ndp-input"
          value={vectorEmbeddingModel}
          placeholder="例如：text-embedding-3-small"
          onChange={(e) => void onSetAutoExtractSettings({ vectorEmbeddingModel: e.target.value })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>向量最低相似度（0~1）</label>
        <input
          className="ndp-input"
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={vectorMinScore}
          onChange={(e) => void onSetAutoExtractSettings({ vectorMinScore: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>向量 TopK</label>
        <input
          className="ndp-input"
          type="number"
          min={1}
          max={100}
          value={vectorTopK}
          onChange={(e) => void onSetAutoExtractSettings({ vectorTopK: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>向量扫描上限（降低延迟）</label>
        <input
          className="ndp-input"
          type="number"
          min={200}
          max={200000}
          value={vectorScanLimit}
          onChange={(e) => void onSetAutoExtractSettings({ vectorScanLimit: Number(e.target.value) })}
        />
        <p className="ndp-setting-hint">数值越大→召回上限更高，但也会更慢。建议先从 2000 开始。</p>
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={vectorUseCustomAi}
            onChange={(e) => void onSetAutoExtractSettings({ vectorUseCustomAi: e.target.checked })}
          />
          <span>向量使用单独 API Key/BaseUrl</span>
        </label>
        {!vectorUseCustomAi ? <p className="ndp-setting-hint">当前将使用聊天的 API Key/BaseUrl。</p> : null}
      </div>

      {vectorUseCustomAi ? (
        <>
          <div className="ndp-setting-item">
            <label>embeddings BaseUrl</label>
            <input
              className="ndp-input"
              value={vectorAiBaseUrl}
              placeholder="例如：https://api.openai.com/v1"
              onChange={(e) => void onSetAutoExtractSettings({ vectorAiBaseUrl: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>embeddings API Key</label>
            <input
              className="ndp-input"
              type="password"
              value={vectorAiApiKey}
              placeholder="sk-..."
              onChange={(e) => void onSetAutoExtractSettings({ vectorAiApiKey: e.target.value })}
            />
          </div>
        </>
      ) : null}
        </>
      ) : null}

      {subTab === 'mmVector' ? (
        <>
          <h3>多模态向量（按需）</h3>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={mmVectorEnabled}
                onChange={(e) => void onSetAutoExtractSettings({ mmVectorEnabled: e.target.checked })}
              />
              <span>启用多模态向量（图片/视频）</span>
            </label>
            <p className="ndp-setting-hint">建议按需手动开启：服务成本高，不常开时保持关闭即可。</p>
          </div>

          <div className="ndp-setting-item">
            <label>多模态 embeddings 模型</label>
            <input
              className="ndp-input"
              value={mmVectorEmbeddingModel}
              placeholder="例如：qwen3-vl-embedding-8b"
              onChange={(e) => void onSetAutoExtractSettings({ mmVectorEmbeddingModel: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input
                type="checkbox"
                checked={mmVectorUseCustomAi}
                onChange={(e) => void onSetAutoExtractSettings({ mmVectorUseCustomAi: e.target.checked })}
              />
              <span>多模态向量使用单独 API Key/BaseUrl</span>
            </label>
            {!mmVectorUseCustomAi ? <p className="ndp-setting-hint">当前将使用聊天的 API Key/BaseUrl。</p> : null}
          </div>

          {mmVectorUseCustomAi ? (
            <>
              <div className="ndp-setting-item">
                <label>多模态 embeddings BaseUrl</label>
                <input
                  className="ndp-input"
                  value={mmVectorAiBaseUrl}
                  placeholder="例如：http://127.0.0.1:8000/v1"
                  onChange={(e) => void onSetAutoExtractSettings({ mmVectorAiBaseUrl: e.target.value })}
                />
              </div>

              <div className="ndp-setting-item">
                <label>多模态 embeddings API Key</label>
                <input
                  className="ndp-input"
                  type="password"
                  value={mmVectorAiApiKey}
                  placeholder="留空则不发送 Authorization"
                  onChange={(e) => void onSetAutoExtractSettings({ mmVectorAiApiKey: e.target.value })}
                />
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {subTab === 'recall' ? <h3>图谱层（M6，可选）</h3> : null}

      {subTab === 'recall' ? (
        <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={kgEnabled} onChange={(e) => void onSetAutoExtractSettings({ kgEnabled: e.target.checked })} />
          <span>启用 KG（实体/关系）召回</span>
        </label>
        <p className="ndp-setting-hint">开启后会在后台用 LLM 抽取实体/关系，并在召回时用“图谱证据”补命中（仍以低延迟为优先）。</p>
        </div>
      ) : null}

      {subTab === 'recall' ? (
        <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={kgIncludeChatMessages}
            onChange={(e) => void onSetAutoExtractSettings({ kgIncludeChatMessages: e.target.checked })}
            disabled={!kgEnabled}
          />
          <span>抽取 chat_message（更全但更噪）</span>
        </label>
        </div>
      ) : null}

      {subTab === 'recall' ? (
        <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={kgUseCustomAi}
            onChange={(e) => void onSetAutoExtractSettings({ kgUseCustomAi: e.target.checked })}
            disabled={!kgEnabled}
          />
          <span>KG 抽取使用单独 API</span>
        </label>
        </div>
      ) : null}

      {subTab === 'recall' && kgEnabled && kgUseCustomAi ? (
        <>
          <div className="ndp-setting-item">
            <label>KG BaseUrl</label>
            <input
              className="ndp-input"
              value={kgAiBaseUrl}
              placeholder="例如：https://api.openai.com/v1"
              onChange={(e) => void onSetAutoExtractSettings({ kgAiBaseUrl: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG API Key</label>
            <input
              className="ndp-input"
              type="password"
              value={kgAiApiKey}
              placeholder="sk-..."
              onChange={(e) => void onSetAutoExtractSettings({ kgAiApiKey: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG 模型</label>
            <input
              className="ndp-input"
              value={kgAiModel}
              placeholder="例如：gpt-4o-mini"
              onChange={(e) => void onSetAutoExtractSettings({ kgAiModel: e.target.value })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG Temperature</label>
            <input
              className="ndp-input"
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={kgAiTemperature}
              onChange={(e) => void onSetAutoExtractSettings({ kgAiTemperature: Number(e.target.value) })}
            />
          </div>

          <div className="ndp-setting-item">
            <label>KG MaxTokens</label>
            <input
              className="ndp-input"
              type="number"
              min={200}
              max={8000}
              value={kgAiMaxTokens}
              onChange={(e) => void onSetAutoExtractSettings({ kgAiMaxTokens: Number(e.target.value) })}
            />
          </div>
        </>
      ) : null}

      {subTab === 'memory' ? (
        <>
          <h3>自动提炼</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={autoExtractEnabled}
            onChange={(e) => void onSetAutoExtractSettings({ autoExtractEnabled: e.target.checked })}
          />
          <span>对话超过阈值自动提炼（写入长期记忆）</span>
        </label>
        <p className="ndp-setting-hint">
          计数采用“有效消息”：会把连续的助手分句（例如 TTS 分句产生的多条助手消息）合并为 1 条来计算，避免过于频繁提炼。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>每新增多少条有效消息触发一次</label>
        <input
          className="ndp-input"
          type="number"
          min={2}
          max={2000}
          value={autoExtractEveryEffectiveMessages}
          onChange={(e) => void onSetAutoExtractSettings({ autoExtractEveryEffectiveMessages: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>提炼窗口：最多取最近多少条有效消息</label>
        <input
          className="ndp-input"
          type="number"
          min={10}
          max={2000}
          value={autoExtractMaxEffectiveMessages}
          onChange={(e) => void onSetAutoExtractSettings({ autoExtractMaxEffectiveMessages: Number(e.target.value) })}
        />
      </div>

      <div className="ndp-setting-item">
        <label>自动提炼最小间隔（秒）</label>
        <input
          className="ndp-input"
          type="number"
          min={0}
          max={3600}
          value={Math.round(autoExtractCooldownMs / 1000)}
          onChange={(e) => void onSetAutoExtractSettings({ autoExtractCooldownMs: Number(e.target.value) * 1000 })}
        />
      </div>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input
            type="checkbox"
            checked={autoExtractUseCustomAi}
            onChange={(e) => void onSetAutoExtractSettings({ autoExtractUseCustomAi: e.target.checked })}
          />
          <span>自动提炼使用单独的 LLM 配置（不影响聊天主模型）</span>
        </label>
      </div>

      {autoExtractUseCustomAi && (
        <div className="ndp-setting-item">
          <label>自动提炼 LLM 配置</label>
          <div className="ndp-setting-hint">留空表示继承聊天主模型对应字段。</div>
          <div className="ndp-setting-item">
            <label>Base URL</label>
            <input
              className="ndp-input"
              placeholder="例如：https://api.openai.com/v1"
              value={autoExtractAiBaseUrl}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiBaseUrl: e.target.value })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>API Key</label>
            <input
              className="ndp-input"
              type="password"
              placeholder="留空则继承聊天主模型"
              value={autoExtractAiApiKey}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiApiKey: e.target.value })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>Model</label>
            <input
              className="ndp-input"
              placeholder="例如：gpt-4o-mini"
              value={autoExtractAiModel}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiModel: e.target.value })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>Temperature</label>
            <input
              className="ndp-input"
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={autoExtractAiTemperature}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiTemperature: Number(e.target.value) })}
            />
          </div>
          <div className="ndp-setting-item">
            <label>Max Tokens</label>
            <input
              className="ndp-input"
              type="number"
              min={128}
              max={64000}
              step={128}
              value={autoExtractAiMaxTokens}
              onChange={(e) => void onSetAutoExtractSettings({ autoExtractAiMaxTokens: Number(e.target.value) })}
            />
          </div>
        </div>
      )}

          <div className="ndp-setting-item">
            <label>当前角色：写入 / 召回</label>
            <div className="ndp-setting-item">
              <label className="ndp-checkbox-label">
                <input
                  type="checkbox"
                  checked={currentPersona?.captureEnabled ?? true}
                  onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { captureEnabled: e.target.checked })}
                />
                <span>允许写入该角色的长期记忆</span>
              </label>
            </div>
            <div className="ndp-setting-item">
              <label className="ndp-checkbox-label">
                <input
                  type="checkbox"
                  checked={currentPersona?.captureUser ?? true}
                  onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { captureUser: e.target.checked })}
                />
                <span>记录用户消息</span>
              </label>
            </div>
            <div className="ndp-setting-item">
              <label className="ndp-checkbox-label">
                <input
                  type="checkbox"
                  checked={currentPersona?.captureAssistant ?? true}
                  onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { captureAssistant: e.target.checked })}
                />
                <span>记录 AI 消息</span>
              </label>
            </div>
            <div className="ndp-setting-item">
              <label className="ndp-checkbox-label">
                <input
                  type="checkbox"
                  checked={currentPersona?.retrieveEnabled ?? true}
                  onChange={(e) => currentPersona && scheduleSavePersonaFlags(currentPersona.id, { retrieveEnabled: e.target.checked })}
                />
                <span>允许该角色参与召回注入</span>
              </label>
            </div>
          </div>
        </>
      ) : null}

      {subTab === 'manage' ? (
        <>
          <h3>记忆管理</h3>

          <div className="ndp-setting-item">
            <label>手动添加</label>
            <div className="ndp-row">
              <select className="ndp-select" value={memNewScope} onChange={(e) => setMemNewScope(e.target.value as 'persona' | 'shared')}>
                <option value="persona">当前角色</option>
                <option value="shared">共享</option>
              </select>
              <button className="ndp-btn" onClick={() => void onAddManualMemory()} disabled={!memNewText.trim()}>
                添加
              </button>
            </div>
            <textarea
              className="ndp-textarea ndp-textarea-compact"
              rows={3}
              value={memNewText}
              placeholder="写一条手动记忆（例如：长期设定、重要事实、约束）"
              onChange={(e) => setMemNewText(e.target.value)}
            />
          </div>

          <div className="ndp-setting-item">
            <label>筛选</label>
            <div className="ndp-row">
              <select
                className="ndp-select"
                value={memScope}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'persona' || v === 'shared' || v === 'all') setMemScope(v)
                  setMemOffset(0)
                }}
              >
                <option value="persona">当前角色</option>
                <option value="shared">共享</option>
                <option value="all">当前角色 + 共享</option>
              </select>
              <select
                className="ndp-select"
                value={memRole}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === 'all' || v === 'user' || v === 'assistant' || v === 'note') setMemRole(v)
                  setMemOffset(0)
                }}
              >
                <option value="all">全部</option>
                <option value="user">用户</option>
                <option value="assistant">AI</option>
                <option value="note">笔记</option>
              </select>
            </div>
            <div className="ndp-row" style={{ marginTop: 10 }}>
              <input className="ndp-input" value={memQuery} placeholder="关键词（LIKE）" onChange={(e) => setMemQuery(e.target.value)} />
              <button
                className="ndp-btn"
                onClick={() => {
                  setMemOffset(0)
                  void refreshMemoryList()
                }}
              >
                搜索
              </button>
            </div>
            <p className="ndp-setting-hint">共 {memTotal} 条</p>
          </div>

          <div className="ndp-setting-item">
            <label>列表</label>
            <div className="ndp-memory-list">
              {memItems.length === 0 && <div className="ndp-setting-hint">暂无记录</div>}
              {memItems.map((m) => (
                <div key={m.rowid} className="ndp-memory-item">
                  <div className="ndp-memory-meta">
                    <span>#{m.rowid}</span>
                    <span>{new Date(m.createdAt).toLocaleString()}</span>
                    <span>{m.scope}</span>
                    <span>{m.role ?? 'note'}</span>
                    <span>{m.kind}</span>
                  </div>
                  <div className="ndp-memory-content">{m.content}</div>
                  <div className="ndp-memory-actions">
                    <button className="ndp-btn" onClick={() => void onDeleteMemory(m.rowid)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="ndp-row" style={{ marginTop: 10 }}>
              <button className="ndp-btn" disabled={memOffset === 0} onClick={() => setMemOffset((o) => Math.max(0, o - 50))}>
                上一页
              </button>
              <button className="ndp-btn" disabled={memOffset + 50 >= memTotal} onClick={() => setMemOffset((o) => o + 50)}>
                下一页
              </button>
              <button className="ndp-btn" onClick={() => void refreshMemoryList()}>
                刷新
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
