import { distanceKm } from './geo'
import type { Case } from './types'

export const DUPLICATE_RADIUS_KM = 0.4
export const DUPLICATE_WINDOW_MS = 20 * 60 * 1000

/** Other open cases that look like the same incident: nearby, recent, same type or both unspecified. */
export function findDuplicates(c: Case, others: Case[]): Case[] {
  if (c.duplicateDismissed || c.duplicateOf || c.status === 'closed') return []
  return others.filter(
    (o) =>
      o.id !== c.id &&
      o.status !== 'closed' &&
      !o.duplicateOf &&
      Math.abs(o.createdAtMs - c.createdAtMs) <= DUPLICATE_WINDOW_MS &&
      distanceKm(o, c) <= DUPLICATE_RADIUS_KM &&
      (o.type === c.type || o.type === 'other' || c.type === 'other'),
  )
}
