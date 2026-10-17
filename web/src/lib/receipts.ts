// Receipts the reporter was shown, kept on this device only so they can reopen their reports. They are secrets: they are
// removed on sign-out together with everything else (see wipeLocalData) and are never sent anywhere except to claim a case.
const KEY = 'gh-receipts'

export interface SavedReceipt { caseId: string; receipt: string; createdAtMs: number; label: string }

export function loadReceipts(): SavedReceipt[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '[]'); return Array.isArray(v) ? v.filter((r) => r && typeof r.caseId === 'string' && typeof r.receipt === 'string') : [] } catch { return [] }
}

export function saveReceipt(r: SavedReceipt): void {
  try {
    const rest = loadReceipts().filter((x) => x.caseId !== r.caseId)
    localStorage.setItem(KEY, JSON.stringify([r, ...rest].slice(0, 20)))
  } catch { /* storage unavailable: the receipt is still shown on screen */ }
}

export function receiptFor(caseId: string): SavedReceipt | undefined {
  return loadReceipts().find((r) => r.caseId === caseId)
}

export const receiptLink = (receipt: string) => `${window.location.origin}/#/r/${receipt}`
