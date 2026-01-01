import { Menu, Tray, app, nativeImage } from 'electron'
import path from 'node:path'
import type { WindowManager } from './windowManager'
import { getSettings, setSettings } from './store'

export function createTray(windowManager: WindowManager): Tray {
  // Create a simple colored icon for the tray
  // Windows tray icons work best with PNG format at 16x16 or 32x32
  let icon: Electron.NativeImage

  // Try to load PNG icon first, fallback to creating one programmatically
  const pngIconPath = path.join(process.env.VITE_PUBLIC ?? '', 'tray-icon.png')
  const loadedIcon = nativeImage.createFromPath(pngIconPath)

  if (!loadedIcon.isEmpty()) {
    // Resize to appropriate tray size for Windows
    icon = loadedIcon.resize({ width: 16, height: 16 })
  } else {
    // Create a simple icon programmatically if no icon file exists
    // This creates a 16x16 purple circle icon
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
    return Menu.buildFromTemplate([
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
    ])
  }

  tray.setToolTip('NeoDeskPet')
  tray.setContextMenu(buildMenu())

  tray.on('right-click', () => {
    tray.popUpContextMenu(buildMenu())
  })

  tray.on('click', () => {
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
  // Create a 16x16 PNG with transparency
  // Using a simple data URL approach for a colored circle
  const size = 16

  // Create canvas-like pixel data for a simple circle icon
  // Format: RGBA (4 bytes per pixel)
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
        // Inside circle - purple/blue gradient
        const t = dist / radius
        pixels[idx] = Math.round(102 + t * 50) // R
        pixels[idx + 1] = Math.round(126 - t * 30) // G
        pixels[idx + 2] = Math.round(234 - t * 30) // B
        pixels[idx + 3] = 255 // A (fully opaque)
      } else {
        // Outside circle - fully transparent
        pixels[idx] = 0
        pixels[idx + 1] = 0
        pixels[idx + 2] = 0
        pixels[idx + 3] = 0
      }
    }
  }

  return nativeImage.createFromBuffer(pixels, {
    width: size,
    height: size,
  })
}
