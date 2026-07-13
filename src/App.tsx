import './App.css'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import type { AppSettings } from '../electron/types'
import { getApi } from './neoDeskPetApi'
import { getWindowType } from './windowType'

function loadClassicScript(path: string): Promise<void> {
  const src = new URL(path, document.baseURI).href
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = false
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener('error', () => reject(new Error(`Failed to load ${path}`)), { once: true })
    document.head.appendChild(script)
  })
}

const PetWindow = lazy(async () => {
  await Promise.all([
    loadClassicScript('./lib/live2d.min.js'),
    loadClassicScript('./lib/live2dcubismcore.min.js'),
  ])
  return import('./windows/PetWindowEntry')
})
const ChatWindow = lazy(() => import('./windows/ChatWindow').then((module) => ({ default: module.ChatWindow })))
const SettingsWindow = lazy(() => import('./windows/SettingsWindow').then((module) => ({ default: module.SettingsWindow })))
const MemoryConsoleWindow = lazy(() =>
  import('./windows/MemoryConsoleWindow').then((module) => ({ default: module.MemoryConsoleWindow })),
)
const OrbApp = lazy(() => import('./orb/OrbApp').then((module) => ({ default: module.OrbApp })))
const OrbMenuWindow = lazy(() => import('./orb/OrbMenuWindow').then((module) => ({ default: module.OrbMenuWindow })))

function App() {
  const windowType = getWindowType()
  const api = useMemo(() => getApi(), [])
  const needsSettings = windowType === 'settings' || windowType === 'memory'

  const [settings, setSettings] = useState<AppSettings | null>(null)

  useEffect(() => {
    if (!api || !needsSettings) return
    api.getSettings().then(setSettings).catch((err) => console.error(err))
    return api.onSettingsChanged(setSettings)
  }, [api, needsSettings])

  let content

  if (windowType === 'chat') content = <ChatWindow api={api} />
  else if (windowType === 'settings') content = <SettingsWindow api={api} settings={settings} />
  else if (windowType === 'memory') content = <MemoryConsoleWindow api={api} settings={settings} />
  else if (windowType === 'orb') content = <OrbApp api={api} />
  else if (windowType === 'orb-menu') content = <OrbMenuWindow api={api} />
  else content = <PetWindow />

  return <Suspense fallback={null}>{content}</Suspense>
}

export default App
