import { useEffect, useState } from 'react'
import type { SettingsSecretTarget } from '../../../electron/types'
import { getApi } from '../../neoDeskPetApi'

type Props = {
  api: ReturnType<typeof getApi>
  target: SettingsSecretTarget
  hasValue: boolean
  placeholder: string
  ariaLabel: string
}

export function SecretSettingInput(props: Props) {
  const { api, target, hasValue, placeholder, ariaLabel } = props
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!dirty) setDraft('')
  }, [dirty, hasValue, target])

  const save = async (value: string) => {
    if (!api) return
    setSaving(true)
    try {
      await api.setSecret(target, value)
      setDraft('')
      setDirty(false)
    } catch (error) {
      console.error(`[Settings] Failed to save secret ${target}:`, error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="ndp-row">
      <input
        className="ndp-input"
        type="password"
        aria-label={ariaLabel}
        value={draft}
        disabled={saving}
        placeholder={hasValue ? '已配置；输入新值可替换' : placeholder}
        onChange={(event) => {
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
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void save('')}
        >
          清除
        </button>
      )}
    </div>
  )
}
