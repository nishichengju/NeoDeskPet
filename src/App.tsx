import './App.css'
import type { AppSettings } from '../electron/types'
import { getApi } from './neoDeskPetApi'
import { OrbApp } from './orb/OrbApp'
import { OrbMenuWindow } from './orb/OrbMenuWindow'
import { getWindowType } from './windowType'
import { MemoryConsoleWindow } from './windows/MemoryConsoleWindow'
import { useEffect, useMemo, useState } from 'react'
import { PetWindow } from './windows/PetWindow'
import { ChatWindow } from './windows/ChatWindow'
import { SettingsWindow } from './windows/SettingsWindow'

function App() {
  const windowType = getWindowType()
  const api = useMemo(() => getApi(), [])

  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    if (!api) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api])

  if (windowType === 'chat') {
    return <ChatWindow api={api} />
  }

  if (windowType === 'settings') {
    return <SettingsWindow api={api} settings={settings} />
  }

  if (windowType === 'memory') {
    return <MemoryConsoleWindow api={api} settings={settings} />
  }

  if (windowType === 'orb') {
    return <OrbApp api={api} />
  }

  if (windowType === 'orb-menu') {
    return <OrbMenuWindow api={api} />
  }

  return <PetWindow />
}

export default App
