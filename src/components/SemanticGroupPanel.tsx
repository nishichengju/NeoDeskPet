import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  SemanticGroup,
  SemanticGroupActivation,
  SemanticGroupLearnedWord,
  SemanticGroupSummary,
} from '../../electron/types'
import { getApi } from '../neoDeskPetApi'

type Props = {
  api: ReturnType<typeof getApi>
}

/**
 * 语义组管理面板
 * 用于创建、编辑、删除语义组，预览激活效果
 */
export function SemanticGroupPanel(props: Props) {
  const { api } = props

  // State
  const [groups, setGroups] = useState<SemanticGroupSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>('')

  // 自学习设置（用于提示/默认值）
  const [learningEnabled, setLearningEnabled] = useState(false)
  const [suggestMinCount, setSuggestMinCount] = useState(3)
  const [suggestLimit, setSuggestLimit] = useState(12)

  // 编辑状态
  const [selectedGroup, setSelectedGroup] = useState<SemanticGroup | null>(null)
  const [editMode, setEditMode] = useState<'view' | 'edit' | 'create'>('view')
  const [editName, setEditName] = useState('')
  const [editWords, setEditWords] = useState('')
  const [editWeight, setEditWeight] = useState(1.0)
  const [saving, setSaving] = useState(false)

  // 自学习建议
  const [suggestions, setSuggestions] = useState<SemanticGroupLearnedWord[]>([])
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState('')
  const [suggestSelected, setSuggestSelected] = useState<Set<string>>(() => new Set())

  // 测试激活
  const [testText, setTestText] = useState('')
  const [testResult, setTestResult] = useState<SemanticGroupActivation[]>([])
  const [testing, setTesting] = useState(false)

  // 预计算向量
  const [precomputing, setPrecomputing] = useState(false)
  const [precomputeResult, setPrecomputeResult] = useState<string>('')

  // 加载语义组列表
  const fetchGroups = useCallback(async () => {
    if (!api) return
    setLoading(true)
    setError('')
    try {
      const list = await api.listSemanticGroups()
      setGroups(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void fetchGroups()
  }, [fetchGroups])

  // 读取 settings，用于自学习提示与默认阈值
  useEffect(() => {
    if (!api) return
    let disposed = false

    const sync = (s: AppSettings) => {
      setLearningEnabled(s.memory?.semanticGroupLearningEnabled ?? false)
      setSuggestMinCount(s.memory?.semanticGroupLearningMinCount ?? 3)
      setSuggestLimit(s.memory?.semanticGroupLearningMaxSuggestions ?? 12)
    }

    void api
      .getSettings()
      .then((s) => {
        if (disposed) return
        sync(s)
      })
      .catch(() => {
        // ignore
      })

    const off = api.onSettingsChanged((s) => sync(s))
    return () => {
      disposed = true
      off()
    }
  }, [api])

  const fetchSuggestions = useCallback(
    async (groupName: string) => {
      if (!api) return
      const name = groupName.trim()
      if (!name) return
      setSuggestLoading(true)
      setSuggestError('')
      try {
        const res = await api.listSemanticGroupSuggestions({ name, minCount: suggestMinCount, limit: suggestLimit })
        setSuggestions(res)
        setSuggestSelected(new Set())
      } catch (err) {
        setSuggestError(err instanceof Error ? err.message : String(err))
        setSuggestions([])
        setSuggestSelected(new Set())
      } finally {
        setSuggestLoading(false)
      }
    },
    [api, suggestMinCount, suggestLimit],
  )

  // 选择语义组
  const onSelectGroup = useCallback(
    async (name: string) => {
      if (!api) return
      const group = await api.getSemanticGroup(name)
      setSelectedGroup(group)
      setEditMode('view')
      if (group) {
        setEditName(group.name)
        setEditWords(group.words.join('\n'))
        setEditWeight(group.weight)
        void fetchSuggestions(group.name)
      } else {
        setSuggestions([])
        setSuggestSelected(new Set())
      }
    },
    [api, fetchSuggestions]
  )

  // 开始创建
  const onStartCreate = useCallback(() => {
    setSelectedGroup(null)
    setEditMode('create')
    setEditName('')
    setEditWords('')
    setEditWeight(1.0)
  }, [])

  // 保存（创建或更新）
  const onSave = useCallback(async () => {
    if (!api) return
    setSaving(true)
    setError('')
    try {
      const wordsArray = editWords
        .split('\n')
        .map((w) => w.trim())
        .filter(Boolean)

      if (editMode === 'create') {
        if (!editName.trim()) {
          setError('请输入组名')
          return
        }
        await api.createSemanticGroup({
          name: editName.trim(),
          words: wordsArray,
          weight: editWeight,
        })
      } else if (editMode === 'edit' && selectedGroup) {
        await api.updateSemanticGroup({
          name: selectedGroup.name,
          words: wordsArray,
          weight: editWeight,
        })
      }
      await fetchGroups()
      setEditMode('view')
      if (editMode === 'create') {
        await onSelectGroup(editName.trim())
      } else if (selectedGroup) {
        await onSelectGroup(selectedGroup.name)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [api, editMode, editName, editWords, editWeight, selectedGroup, fetchGroups, onSelectGroup])

  // 删除
  const onDelete = useCallback(async () => {
    if (!api || !selectedGroup) return
    if (!window.confirm(`确定要删除语义组 "${selectedGroup.name}" 吗？`)) return
    try {
      await api.deleteSemanticGroup(selectedGroup.name)
      setSelectedGroup(null)
      setEditMode('view')
      await fetchGroups()
      setSuggestions([])
      setSuggestSelected(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [api, selectedGroup, fetchGroups])

  const onApplySuggestions = useCallback(async () => {
    if (!api || !selectedGroup) return
    const words = Array.from(suggestSelected.values()).map((w) => w.trim()).filter(Boolean)
    if (words.length === 0) {
      setSuggestError('请先勾选要应用的词元')
      return
    }
    setSuggestError('')
    try {
      const updated = await api.applySemanticGroupSuggestions({ name: selectedGroup.name, words })
      if (updated) setSelectedGroup(updated)
      await fetchGroups()
      await fetchSuggestions(selectedGroup.name)
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : String(err))
    }
  }, [api, selectedGroup, suggestSelected, fetchGroups, fetchSuggestions])

  // 预计算向量
  const onPrecompute = useCallback(async () => {
    if (!api) return
    setPrecomputing(true)
    setPrecomputeResult('')
    try {
      const result = await api.precomputeSemanticGroupVectors()
      if (result.error) {
        setPrecomputeResult(`❌ ${result.error}`)
      } else if (result.updated === 0 && result.total > 0) {
        setPrecomputeResult(`✓ ${result.total} 个语义组向量已是最新`)
      } else {
        setPrecomputeResult(`✓ 成功预计算 ${result.updated}/${result.total} 个语义组向量`)
      }
      await fetchGroups()
      // 刷新当前选中的语义组详情
      if (selectedGroup) {
        const updated = await api.getSemanticGroup(selectedGroup.name)
        if (updated) {
          setSelectedGroup(updated)
        }
        void fetchSuggestions(selectedGroup.name)
      }
    } catch (err) {
      setPrecomputeResult(`❌ 失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setPrecomputing(false)
    }
  }, [api, fetchGroups, fetchSuggestions, selectedGroup])

  // 测试激活
  const onTestActivation = useCallback(async () => {
    if (!api || !testText.trim()) return
    setTesting(true)
    try {
      const result = await api.detectSemanticGroupActivations(testText)
      setTestResult(result)
    } catch (err) {
      console.error(err)
      setTestResult([])
    } finally {
      setTesting(false)
    }
  }, [api, testText])

  return (
    <div className="ndp-settings-section">
      <h3>语义组管理</h3>

      {error && (
        <div style={{ color: 'rgba(255, 150, 150, 0.95)', marginBottom: 10 }}>{error}</div>
      )}

      {/* 操作栏 */}
      <div className="ndp-row" style={{ marginBottom: 12 }}>
        <button className="ndp-btn" onClick={onStartCreate}>
          新建语义组
        </button>
        <button className="ndp-btn" onClick={onPrecompute} disabled={precomputing}>
          {precomputing ? '预计算中...' : '预计算所有向量'}
        </button>
        <button className="ndp-btn" onClick={() => void fetchGroups()} disabled={loading}>
          刷新
        </button>
        {precomputeResult && (
          <span
            style={{
              marginLeft: 10,
              fontSize: 12,
              color: precomputeResult.startsWith('❌')
                ? 'rgba(255, 150, 150, 0.95)'
                : 'rgba(150, 255, 150, 0.95)',
            }}
          >
            {precomputeResult}
          </span>
        )}
      </div>

      {/* 语义组列表 */}
      <div style={{ display: 'flex', gap: 16, minHeight: 300 }}>
        {/* 左侧列表 */}
        <div style={{ flex: '0 0 200px', maxHeight: 400, overflowY: 'auto' }}>
          {loading && <div style={{ color: 'rgba(255, 255, 255, 0.6)' }}>加载中...</div>}
          {!loading && groups.length === 0 && (
            <div style={{ color: 'rgba(255, 255, 255, 0.6)' }}>暂无语义组</div>
          )}
          {groups.map((g) => (
            <div
              key={g.name}
              className="ndp-memory-item"
              style={{
                cursor: 'pointer',
                marginBottom: 6,
                padding: '8px 10px',
                background:
                  selectedGroup?.name === g.name
                    ? 'rgba(102, 126, 234, 0.3)'
                    : 'rgba(255, 255, 255, 0.05)',
                borderRadius: 6,
              }}
              onClick={() => void onSelectGroup(g.name)}
            >
              <div style={{ fontWeight: 500 }}>{g.name}</div>
              <div
                style={{
                  fontSize: 11,
                  color: 'rgba(255, 255, 255, 0.55)',
                  marginTop: 2,
                }}
              >
                词数: {g.wordCount} | 权重: {g.weight.toFixed(1)} | 激活: {g.activationCount}
              </div>
            </div>
          ))}
        </div>

        {/* 右侧详情 */}
        <div style={{ flex: 1 }}>
          {editMode === 'view' && !selectedGroup && (
            <div style={{ color: 'rgba(255, 255, 255, 0.6)' }}>点击左侧语义组查看详情，或新建一个</div>
          )}

          {(editMode === 'edit' || editMode === 'create') && (
            <div>
              <div className="ndp-setting-item" style={{ marginBottom: 10 }}>
                <label>组名</label>
                <input
                  className="ndp-input"
                  style={{ width: '100%' }}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  disabled={editMode === 'edit'}
                  placeholder="例如：塔罗占卜、日常问候"
                />
              </div>

              <div className="ndp-setting-item" style={{ marginBottom: 10 }}>
                <label>词元列表（每行一个）</label>
                <textarea
                  className="ndp-input"
                  style={{ width: '100%', height: 120, whiteSpace: 'pre-wrap' }}
                  value={editWords}
                  onChange={(e) => setEditWords(e.target.value)}
                  placeholder={`愚者\n魔术师\n女教皇\n...`}
                />
              </div>

              <div className="ndp-setting-item" style={{ marginBottom: 10 }}>
                <label>权重 (0.1 - 10.0)</label>
                <input
                  className="ndp-input"
                  type="number"
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={editWeight}
                  onChange={(e) => setEditWeight(Number(e.target.value))}
                  style={{ width: 100 }}
                />
              </div>

              <div className="ndp-row">
                <button className="ndp-btn" onClick={() => void onSave()} disabled={saving}>
                  {saving ? '保存中...' : editMode === 'create' ? '创建' : '保存修改'}
                </button>
                <button
                  className="ndp-btn"
                  onClick={() => {
                    setEditMode('view')
                    if (selectedGroup) {
                      setEditName(selectedGroup.name)
                      setEditWords(selectedGroup.words.join('\n'))
                      setEditWeight(selectedGroup.weight)
                    }
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {editMode === 'view' && selectedGroup && (
            <div>
              <div style={{ marginBottom: 10 }}>
                <strong>{selectedGroup.name}</strong>
                <span
                  style={{
                    marginLeft: 10,
                    fontSize: 12,
                    color: 'rgba(255, 255, 255, 0.55)',
                  }}
                >
                  权重: {selectedGroup.weight.toFixed(1)} | 激活次数: {selectedGroup.activationCount}
                </span>
              </div>

              <div style={{ marginBottom: 10 }}>
                <label style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.72)' }}>
                  核心词元 ({selectedGroup.words.length})
                </label>
                <div
                  style={{
                    background: 'rgba(0, 0, 0, 0.2)',
                    padding: 8,
                    borderRadius: 4,
                    fontSize: 12,
                    lineHeight: 1.6,
                    maxHeight: 100,
                    overflowY: 'auto',
                  }}
                >
                  {selectedGroup.words.join(' · ') || '(无)'}
                </div>
              </div>

              {selectedGroup.autoLearned.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.72)' }}>
                    自学习词元 ({selectedGroup.autoLearned.length})
                  </label>
                  <div
                    style={{
                      background: 'rgba(102, 126, 234, 0.1)',
                      padding: 8,
                      borderRadius: 4,
                      fontSize: 12,
                      lineHeight: 1.6,
                      maxHeight: 80,
                      overflowY: 'auto',
                    }}
                  >
                    {selectedGroup.autoLearned.join(' · ')}
                  </div>
                </div>
              )}

              <div style={{ marginBottom: 10, fontSize: 12, color: 'rgba(255, 255, 255, 0.55)' }}>
                <span>向量: {selectedGroup.vectorId ? '已计算' : '未计算'}</span>
                <span style={{ marginLeft: 12 }}>
                  最后激活: {selectedGroup.lastActivatedAt ? new Date(selectedGroup.lastActivatedAt).toLocaleString() : '-'}
                </span>
              </div>

              <div className="ndp-row">
                <button className="ndp-btn" onClick={() => setEditMode('edit')}>
                  编辑
                </button>
                <button className="ndp-btn" onClick={() => void onDelete()}>
                  删除
                </button>
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.72)', marginBottom: 6 }}>
                  自学习建议（{suggestions.length}）
                  {!learningEnabled ? <span style={{ marginLeft: 8, color: 'rgba(255, 200, 120, 0.95)' }}>未开启</span> : null}
                  {suggestLoading ? <span style={{ marginLeft: 8 }}>加载中…</span> : null}
                </div>

                {!learningEnabled ? (
                  <div style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.55)', lineHeight: 1.5 }}>
                    需要在“设置 → 记忆 → 语义组（M7）”开启自学习后，建议计数才会增长。
                  </div>
                ) : null}

                <div className="ndp-row" style={{ marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.55)' }}>minCount</span>
                    <input
                      className="ndp-input"
                      style={{ width: 90 }}
                      type="number"
                      min={1}
                      max={50}
                      value={suggestMinCount}
                      onChange={(e) => setSuggestMinCount(Number(e.target.value))}
                    />
                    <span style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.55)' }}>limit</span>
                    <input
                      className="ndp-input"
                      style={{ width: 90 }}
                      type="number"
                      min={1}
                      max={50}
                      value={suggestLimit}
                      onChange={(e) => setSuggestLimit(Number(e.target.value))}
                    />
                  </div>
                  <button className="ndp-btn" onClick={() => void fetchSuggestions(selectedGroup.name)} disabled={!api}>
                    刷新
                  </button>
                  <button className="ndp-btn" onClick={() => void onApplySuggestions()} disabled={!api || suggestSelected.size === 0}>
                    应用到自学习词元
                  </button>
                </div>

                {suggestError ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255, 180, 180, 0.95)', whiteSpace: 'pre-wrap' }}>
                    {suggestError}
                  </div>
                ) : null}

                {suggestions.length === 0 ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255, 255, 255, 0.55)' }}>暂无建议</div>
                ) : (
                  <div style={{ marginTop: 8, background: 'rgba(0, 0, 0, 0.18)', borderRadius: 6, padding: 8 }}>
                    {suggestions.map((s) => {
                      const checked = suggestSelected.has(s.word)
                      const last = s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '-'
                      return (
                        <label key={s.word} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '4px 2px' }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSuggestSelected((prev) => {
                                const next = new Set(prev)
                                if (e.currentTarget.checked) next.add(s.word)
                                else next.delete(s.word)
                                return next
                              })
                            }}
                          />
                          <span style={{ color: 'rgba(255, 255, 255, 0.9)', fontWeight: 600 }}>{s.word}</span>
                          <span style={{ color: 'rgba(255, 255, 255, 0.55)' }}>count:{s.count}</span>
                          <span style={{ marginLeft: 'auto', color: 'rgba(255, 255, 255, 0.45)' }}>last:{last}</span>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 测试激活 */}
      <div style={{ marginTop: 20 }}>
        <h4 style={{ fontSize: 13, marginBottom: 8 }}>测试语义组激活</h4>
        <div className="ndp-row" style={{ marginBottom: 8 }}>
          <input
            className="ndp-input"
            style={{ flex: 1 }}
            placeholder="输入一段文本测试激活效果..."
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void onTestActivation()}
          />
          <button className="ndp-btn" onClick={() => void onTestActivation()} disabled={testing}>
            {testing ? '检测中...' : '检测激活'}
          </button>
        </div>
        {testResult.length > 0 && (
          <div
            style={{
              background: 'rgba(0, 0, 0, 0.2)',
              padding: 10,
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            {testResult.map((r, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <strong>{r.groupName}</strong>
                <span style={{ marginLeft: 8, color: 'rgba(255, 255, 255, 0.72)' }}>
                  激活强度: {(r.strength * 100).toFixed(1)}%
                </span>
                <span style={{ marginLeft: 8, color: 'rgba(102, 126, 234, 0.95)' }}>
                  匹配: {r.matchedWords.join(', ')}
                </span>
              </div>
            ))}
          </div>
        )}
        {testResult.length === 0 && testText.trim() && !testing && (
          <div style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.55)' }}>暂无激活的语义组</div>
        )}
      </div>
    </div>
  )
}
