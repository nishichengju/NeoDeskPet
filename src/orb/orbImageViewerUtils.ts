export function moveOrbImageViewerIndex(index: number, offset: number, total: number): number {
  if (total <= 0) return 0
  const normalizedIndex = Math.max(0, Math.min(Math.trunc(index), total - 1))
  const next = normalizedIndex + Math.trunc(offset)
  return ((next % total) + total) % total
}

export function applyOrbImageViewerWheelScale(scale: number, deltaY: number): number {
  const factor = deltaY < 0 ? 1.1 : 0.9
  return Math.max(0.2, Math.min(6, scale * factor))
}
