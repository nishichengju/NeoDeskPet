import { useMemo, useState } from 'react'
import type { AppSettings, WorldBookEntry, WorldBookSettings } from '../../../electron/types'
import { getApi } from '../../neoDeskPetApi'

function nowId(): string {
  if ('crypto' in globalThis && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function parseTags(text: string): string[] {
  const seen = new Set<string>()
  return String(text ?? '')
    .split(/[,，、\s]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => {
      const key = x.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 20)
}

function tagsToText(tags: string[]): string {
  return (Array.isArray(tags) ? tags : []).join(', ')
}

function createEntry(activePersonaId: string, tag?: string): WorldBookEntry {
  const now = Date.now()
  return {
    id: nowId(),
    title: '新设定',
    content: '',
    tags: tag ? [tag] : [],
    enabled: true,
    scope: 'global',
    personaId: activePersonaId,
    priority: 100,
    createdAt: now,
    updatedAt: now,
  }
}

function updateEntryTimestamp(entry: WorldBookEntry): WorldBookEntry {
  return { ...entry, updatedAt: Date.now() }
}

export function WorldBookSettingsTab(props: { api: ReturnType<typeof getApi>; settings: AppSettings | null }) {
  const { api, settings } = props
  const worldBook = settings?.worldBook
  const activePersonaId = settings?.activePersonaId ?? 'default'
  const entriesRaw = worldBook?.entries
  const activeTagIdsRaw = worldBook?.activeTagIds
  const entries = useMemo(() => (Array.isArray(entriesRaw) ? entriesRaw : []), [entriesRaw])
  const activeTagIds = useMemo(() => (Array.isArray(activeTagIdsRaw) ? activeTagIdsRaw : []), [activeTagIdsRaw])
  const enabled = worldBook?.enabled ?? true
  const maxChars = worldBook?.maxChars ?? 6000

  const allTags = useMemo(() => {
    const byKey = new Map<string, string>()
    for (const entry of entries) {
      for (const tag of entry.tags ?? []) {
        const clean = String(tag ?? '').trim()
        if (!clean) continue
        const key = clean.toLowerCase()
        if (!byKey.has(key)) byKey.set(key, clean)
      }
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  }, [entries])

  const [selectedId, setSelectedId] = useState('')
  const selected = entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null

  const persist = async (patch: Partial<WorldBookSettings>) => {
    if (!api) return
    await api.setWorldBookSettings(patch)
  }

  const setEntries = (nextEntries: WorldBookEntry[]) => persist({ entries: nextEntries })

  const updateSelected = (patch: Partial<WorldBookEntry>) => {
    if (!selected) return
    const next = entries.map((entry) => (entry.id === selected.id ? updateEntryTimestamp({ ...entry, ...patch }) : entry))
    void setEntries(next)
  }

  const addEntry = (tag?: string) => {
    const entry = createEntry(activePersonaId, tag)
    setSelectedId(entry.id)
    void setEntries([entry, ...entries])
  }

  const duplicateEntry = () => {
    if (!selected) return
    const now = Date.now()
    const copy: WorldBookEntry = {
      ...selected,
      id: nowId(),
      title: `${selected.title || '设定'} 副本`,
      createdAt: now,
      updatedAt: now,
    }
    setSelectedId(copy.id)
    void setEntries([copy, ...entries])
  }

  const deleteEntry = () => {
    if (!selected) return
    const ok = window.confirm(`确定删除设定「${selected.title || selected.id}」？`)
    if (!ok) return
    const next = entries.filter((entry) => entry.id !== selected.id)
    setSelectedId(next[0]?.id ?? '')
    void setEntries(next)
  }

  const toggleTag = (tag: string) => {
    const key = tag.toLowerCase()
    const exists = activeTagIds.some((x) => x.toLowerCase() === key)
    const next = exists ? activeTagIds.filter((x) => x.toLowerCase() !== key) : [...activeTagIds, tag]
    void persist({ activeTagIds: next })
  }

  const enableAllTags = () => void persist({ activeTagIds: allTags })
  const disableAllTags = () => void persist({ activeTagIds: [] })

  const activeEntryCount = useMemo(() => {
    const activeKeys = new Set(activeTagIds.map((x) => x.toLowerCase()))
    return entries.filter((entry) => {
      if (!entry.enabled) return false
      if (entry.scope === 'persona' && entry.personaId && entry.personaId !== activePersonaId) return false
      if (!entry.tags?.length) return true
      return entry.tags.some((tag) => activeKeys.has(tag.toLowerCase()))
    }).length
  }, [activePersonaId, activeTagIds, entries])

  if (!api) {
    return (
      <div className="ndp-settings-section">
        <h3>设定库</h3>
        <p className="ndp-setting-hint">API 未就绪，请稍后再试。</p>
      </div>
    )
  }

  return (
    <div className="ndp-settings-section">
      <h3>设定库（世界书）</h3>

      <div className="ndp-setting-item">
        <label className="ndp-checkbox-label">
          <input type="checkbox" checked={enabled} onChange={(e) => void persist({ enabled: e.target.checked })} />
          <span>启用设定库注入</span>
        </label>
        <p className="ndp-setting-hint">
          当前会注入 {activeEntryCount} 条设定。无标签条目视为常驻；带标签条目只有标签启用时才注入。
        </p>
      </div>

      <div className="ndp-setting-item">
        <label>最大注入字符数</label>
        <div className="ndp-row">
          <input
            className="ndp-input"
            type="number"
            min={500}
            max={30000}
            step={500}
            value={maxChars}
            onChange={(e) => void persist({ maxChars: parseInt(e.target.value || '6000') })}
          />
        </div>
        <p className="ndp-setting-hint">设定库会按优先级注入，超过上限的条目会被截断。</p>
      </div>

      <div className="ndp-setting-item">
        <label>标签快捷开关</label>
        <div className="ndp-setting-actions">
          <button className="ndp-btn" onClick={enableAllTags} disabled={allTags.length === 0}>
            全部启用
          </button>
          <button className="ndp-btn" onClick={disableAllTags} disabled={activeTagIds.length === 0}>
            全部关闭
          </button>
          <button className="ndp-btn" onClick={() => addEntry()}>
            新增设定
          </button>
        </div>
        <div className="ndp-setting-actions">
          {allTags.length === 0 ? <span className="ndp-setting-hint">还没有标签。给条目填写标签后会出现在这里。</span> : null}
          {allTags.map((tag) => {
            const active = activeTagIds.some((x) => x.toLowerCase() === tag.toLowerCase())
            return (
              <button key={tag} className={`ndp-btn ${active ? 'ndp-btn-primary' : ''}`} onClick={() => toggleTag(tag)}>
                {active ? '✓ ' : ''}
                {tag}
              </button>
            )
          })}
        </div>
      </div>

      <div className="ndp-setting-item">
        <label>条目列表</label>
        <div className="ndp-row">
          <select className="ndp-select" value={selected?.id ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
            {entries.length === 0 ? <option value="">（暂无设定）</option> : null}
            {entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.enabled ? '●' : '○'} {entry.title || '未命名'} {entry.tags.length ? `#${entry.tags.join(' #')}` : '#常驻'}
              </option>
            ))}
          </select>
        </div>
        <div className="ndp-setting-actions">
          <button className="ndp-btn" onClick={() => addEntry()}>
            新增
          </button>
          <button className="ndp-btn" onClick={duplicateEntry} disabled={!selected}>
            复制
          </button>
          <button className="ndp-btn ndp-btn-danger" onClick={deleteEntry} disabled={!selected}>
            删除
          </button>
        </div>
      </div>

      {selected ? (
        <>
          <div className="ndp-setting-item">
            <label className="ndp-checkbox-label">
              <input type="checkbox" checked={selected.enabled} onChange={(e) => updateSelected({ enabled: e.target.checked })} />
              <span>启用这个条目</span>
            </label>
          </div>

          <div className="ndp-setting-item">
            <label>标题</label>
            <input className="ndp-input" value={selected.title} onChange={(e) => updateSelected({ title: e.target.value })} />
          </div>

          <div className="ndp-setting-item">
            <label>标签</label>
            <input
              className="ndp-input"
              value={tagsToText(selected.tags)}
              placeholder="例如：日常, B站, 明澈设定"
              onChange={(e) => updateSelected({ tags: parseTags(e.target.value) })}
            />
            <p className="ndp-setting-hint">多个标签用空格、逗号或顿号分隔。无标签表示常驻设定。</p>
          </div>

          <div className="ndp-setting-item">
            <label>作用域</label>
            <select
              className="ndp-select"
              value={selected.scope === 'persona' ? 'persona' : 'global'}
              onChange={(e) =>
                updateSelected({
                  scope: e.target.value === 'persona' ? 'persona' : 'global',
                  personaId: e.target.value === 'persona' ? activePersonaId : undefined,
                })
              }
            >
              <option value="global">所有角色</option>
              <option value="persona">当前角色</option>
            </select>
            <p className="ndp-setting-hint">
              当前角色 ID：{activePersonaId}。选择“当前角色”后，该条只会注入当前角色的聊天。
            </p>
          </div>

          <div className="ndp-setting-item">
            <label>优先级</label>
            <input
              className="ndp-input"
              type="number"
              min={0}
              max={9999}
              value={selected.priority}
              onChange={(e) => updateSelected({ priority: parseInt(e.target.value || '100') })}
            />
            <p className="ndp-setting-hint">数字越小越先注入。超过最大字符数时，后面的条目会被截断。</p>
          </div>

          <div className="ndp-setting-item">
            <label>设定内容</label>
            <textarea
              className="ndp-textarea"
              rows={12}
              value={selected.content}
              placeholder="写入需要稳定生效的世界观、关系、称呼、行为偏好、场景规则等。"
              onChange={(e) => updateSelected({ content: e.target.value })}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}
