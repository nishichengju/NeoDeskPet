import { Menu, Tray, app, nativeImage } from 'electron'
import path from 'node:path'
import type { WindowManager } from './windowManager'
import { getSettings, setSettings } from './store'

export function createTray(windowManager: WindowManager): Tray {
  // Windows 托盘图标优先使用 PNG（16x16 或 32x32）
  let icon: Electron.NativeImage
  const pngIconPath = path.join(process.env.VITE_PUBLIC ?? '', 'tray-icon.png')
  const loadedIcon = nativeImage.createFromPath(pngIconPath)

  if (!loadedIcon.isEmpty()) {
    icon = loadedIcon.resize({ width: 16, height: 16 })
  } else {
    icon = createDefaultTrayIcon()
  }

  const tray = new Tray(icon)

  const broadcastSettingsChanged = () => {
    const settings = getSettings()
    for (const win of windowManager.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('settings:changed', settings)
    }
  }

  const buildMenu = () => {
    const settings = getSettings()
    const template: Electron.MenuItemConstructorOptions[] = []

    // 主界面模式切换：Live2D / 悬浮球 / 隐藏（仅托盘）
    if (settings.displayMode !== 'live2d') {
      template.push({
        label: '切换到 Live2D 桌宠',
        click: () => {
          windowManager.setDisplayMode('live2d')
          broadcastSettingsChanged()
        },
      })
    }
    if (settings.displayMode !== 'orb') {
      template.push({
        label: '切换到 悬浮球',
        click: () => {
          windowManager.setDisplayMode('orb')
          broadcastSettingsChanged()
        },
      })
    }
    if (settings.displayMode !== 'hidden') {
      template.push({
        label: '隐藏（仅托盘）',
        click: () => {
          windowManager.setDisplayMode('hidden')
          broadcastSettingsChanged()
        },
      })
    }

    template.push({ type: 'separator' })

    template.push(
      { label: '显示桌宠', click: () => windowManager.showPet() },
      { label: '打开聊天', click: () => windowManager.ensureChatWindow() },
      { label: '打开设置', click: () => windowManager.ensureSettingsWindow() },
      { type: 'separator' },
      {
        label: '置顶显示',
        type: 'checkbox',
        checked: settings.alwaysOnTop,
        click: (item) => {
          windowManager.setAlwaysOnTop(item.checked)
          broadcastSettingsChanged()
        },
      },
      {
        label: '点击穿透（托盘可关闭）',
        type: 'checkbox',
        checked: settings.clickThrough,
        click: (item) => {
          windowManager.setClickThrough(item.checked)
          broadcastSettingsChanged()
        },
      },
      {
        label: 'TTS 语音播报',
        type: 'checkbox',
        checked: settings.tts?.enabled ?? false,
        click: (item) => {
          const current = getSettings()
          setSettings({ tts: { ...current.tts, enabled: item.checked } })
          broadcastSettingsChanged()
        },
      },
      { type: 'separator' },
      { label: '全部隐藏', click: () => windowManager.hideAll() },
      { label: '退出', click: () => app.quit() },
    )

    return Menu.buildFromTemplate(template)
  }

  tray.setToolTip('NeoDeskPet')
  tray.setContextMenu(buildMenu())

  tray.on('right-click', () => {
    tray.popUpContextMenu(buildMenu())
  })

  tray.on('click', () => {
    const mode = getSettings().displayMode
    if (mode === 'orb') {
      const orb = windowManager.ensureOrbWindow()
      if (orb.isVisible()) orb.hide()
      else windowManager.showOrb()
      return
    }

    const pet = windowManager.ensurePetWindow()
    if (pet.isVisible()) pet.hide()
    else windowManager.showPet()
  })

  return tray
}

/**
 * Create a simple default tray icon programmatically
 * This creates a 16x16 icon with a purple/blue gradient circle
 */
function createDefaultTrayIcon(): Electron.NativeImage {
  const size = 16
  const pixels = Buffer.alloc(size * size * 4)

  const centerX = size / 2
  const centerY = size / 2
  const radius = size / 2 - 1

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4
      const dx = x - centerX + 0.5
      const dy = y - centerY + 0.5
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist <= radius) {
        const t = dist / radius
        pixels[idx] = Math.round(102 + t * 50)
        pixels[idx + 1] = Math.round(126 - t * 30)
        pixels[idx + 2] = Math.round(234 - t * 30)
        pixels[idx + 3] = 255
      } else {
        pixels[idx] = 0
        pixels[idx + 1] = 0
        pixels[idx + 2] = 0
        pixels[idx + 3] = 0
      }
    }
  }

  return nativeImage.createFromBuffer(pixels, { width: size, height: size })
}

