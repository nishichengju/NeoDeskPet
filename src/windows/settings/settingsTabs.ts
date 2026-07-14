export function getSettingsTabTargetIndex(
  currentIndex: number,
  tabCount: number,
  key: string,
): number | null {
  if (tabCount <= 0 || currentIndex < 0 || currentIndex >= tabCount) return null
  if (key === 'Home') return 0
  if (key === 'End') return tabCount - 1
  if (key === 'ArrowLeft') return (currentIndex - 1 + tabCount) % tabCount
  if (key === 'ArrowRight') return (currentIndex + 1) % tabCount
  return null
}
