export type LiveRegionPriority = 'polite' | 'assertive'

export function getLiveRegionProps(priority: LiveRegionPriority) {
  return priority === 'assertive'
    ? { role: 'alert' as const, 'aria-live': 'assertive' as const, 'aria-atomic': true }
    : { role: 'status' as const, 'aria-live': 'polite' as const, 'aria-atomic': true }
}
