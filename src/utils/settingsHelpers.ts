// 设置窗口多个 Tab 共用的纯工具函数/常量。
// 抽出以避免 App.tsx 与 settings/*Tab.tsx 重复定义。

export const OPEN_TYPELESS_ASR_DEFAULT_WS_URL = 'ws://127.0.0.1:8000/demo/ws/realtime'

export function isOpenTypelessAsrWsUrl(rawUrl: string): boolean {
  try {
    const u = new URL(String(rawUrl ?? '').trim())
    return (u.protocol === 'ws:' || u.protocol === 'wss:') && /^\/demo\/ws\/realtime\/?$/.test(u.pathname)
  } catch {
    return false
  }
}

export function clampIntValue(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}
