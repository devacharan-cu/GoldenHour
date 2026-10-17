import { CASE_TYPES } from './capabilities'
import type { Case } from './types'

const STATUS_FILTER: Record<string, (c: Case) => boolean> = {
  all: () => true,
  open: (c) => c.status !== 'closed',
  closed: (c) => c.status === 'closed',
  completed: (c) => c.status === 'closed' && !!c.arrivalConfirmedAtMs,
  cancelled: (c) => c.status === 'closed' && !c.arrivalConfirmedAtMs,
}

export const searchText = (c: Case) => [c.id, c.brief, CASE_TYPES[c.type].label, c.selectedHospitalName, c.ambulanceCallSign, c.closeReason, c.status].filter(Boolean).join(' ').toLowerCase()

/** Pure filter, so it is unit-tested. */
export function filterCases(rows: Case[], f: { q: string; status: string; type: string; severity: string; from: string; to: string }): Case[] {
  const q = f.q.trim().toLowerCase()
  const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : 0
  const to = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : Infinity
  return rows.filter((c) =>
    (STATUS_FILTER[f.status] ?? STATUS_FILTER.all)(c) &&
    (f.type === 'all' || c.type === f.type) &&
    (f.severity === 'all' || String(c.severity) === f.severity) &&
    c.createdAtMs >= from && c.createdAtMs <= to &&
    (!q || searchText(c).includes(q)),
  )
}

