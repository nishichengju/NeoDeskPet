import { useEffect, useState } from 'react'
import type { SettingsSecretTarget } from '../../../electron/types'
import { getLiveRegionProps } from '../../components/liveRegion'
import { getApi } from '../../neoDeskPetApi'

type Props = {
  api: ReturnType<typeof getApi>
  target: SettingsSecretTarget
  hasValue: boolean
  placeholder: string
  ariaLabel: string
  ariaDescribedBy?: string
  onEdit?: () => void
}

export function SecretSettingInput(props: Props) {
  const { api, target, hasValue, placeholder, ariaLabel, ariaDescribedBy, onEdit } = props
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const saveErrorId = `ndp-secret-${target}-error`
  const describedBy = [ariaDescribedBy, saveError ? saveErrorId : ''].filter(Boolean).join(' ') || undefined

  useEffect(() => {
    if (!dirty) setDraft('')
  }, [dirty, hasValue, target])

  const save = async (value: string) => {
    if (!api) return
    setSaving(true)
    setSaveError('')
    try {
      await api.setSecret(target, value)
      setDraft('')
      setDirty(false)
    } catch (error) {
      console.warn(`[Settings] Failed to save secret ${target}:`, error)
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <div className="ndp-row">
        <input
          className="ndp-input"
          type="password"
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          aria-invalid={Boolean(saveError)}
          value={draft}
          disabled={saving}
          placeholder={hasValue ? '已配置；输入新值可替换' : placeholder}
          onChange={(event) => {
            onEdit?.()
            setSaveError('')
            setDraft(event.target.value)
            setDirty(true)
          }}
          onBlur={() => {
            if (dirty) void save(draft)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
        />
        {(hasValue || dirty) && (
          <button
            type="button"
            className="ndp-btn"
            disabled={saving}
            aria-describedby={saveError ? saveErrorId : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void save('')}
          >
            清除
          </button>
        )}
      </div>
      {saveError ? (
        <p id={saveErrorId} className="ndp-setting-hint ndp-setting-error" {...getLiveRegionProps('assertive')}>
          密钥保存失败：{saveError}
        </p>
      ) : null}
    </>
  )
}
