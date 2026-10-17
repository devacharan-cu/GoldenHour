import type { EvidenceKind } from './types'

/**
 * A device-side queue for evidence files. A file is only "uploaded" after the server confirmed every part; until then it
 * is queued (on this device only), uploading, or failed. The queue survives a reload (IndexedDB) so closing the tab does
 * not silently drop evidence, and it is wiped on sign-out so the next person on the device never sees it.
 */
export type UploadState = 'queued' | 'uploading' | 'uploaded' | 'failed'

export interface QueueItem {
  id: string
  caseId: string
  uid: string
  /** Who is attaching it, for the audit trail: a reporter, or a dispatcher logging a phoned-in call. */
  role: 'reporter' | 'dispatcher'
  evidenceId: string
  name: string
  mime: string
  kind: EvidenceKind
  size: number
  origin: 'camera' | 'recorder' | 'file'
  state: UploadState
  done: number
  total: number
  error: string | null
  attempts: number
  createdAtMs: number
}

export interface QueueStore {
  put(item: QueueItem, blob?: Blob): Promise<void>
  getBlob(id: string): Promise<Blob | undefined>
  dropBlob(id: string): Promise<void>
  all(): Promise<QueueItem[]>
  clear(): Promise<void>
}

export class MemoryStore implements QueueStore {
  private items = new Map<string, QueueItem>()
  private blobs = new Map<string, Blob>()
  async put(item: QueueItem, blob?: Blob) { this.items.set(item.id, { ...item }); if (blob) this.blobs.set(item.id, blob) }
  async getBlob(id: string) { return this.blobs.get(id) }
  async dropBlob(id: string) { this.blobs.delete(id) }
  async all() { return [...this.items.values()].map((i) => ({ ...i })) }
  async clear() { this.items.clear(); this.blobs.clear() }
}

const DB_NAME = 'gh-uploads'
export class IdbStore implements QueueStore {
  private open(): Promise<IDBDatabase> {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1)
      r.onupgradeneeded = () => { r.result.createObjectStore('items', { keyPath: 'id' }); r.result.createObjectStore('blobs') }
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
  }
  private async tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.open()
    return new Promise((res, rej) => {
      const t = db.transaction(stores, mode)
      const req = fn(t)
      t.oncomplete = () => { db.close(); res(req ? (req as IDBRequest<T>).result : undefined) }
      t.onerror = () => { db.close(); rej(t.error) }
    })
  }
  async put(item: QueueItem, blob?: Blob) { await this.tx(['items', 'blobs'], 'readwrite', (t) => { t.objectStore('items').put(item); if (blob) t.objectStore('blobs').put(blob, item.id) }) }
  async getBlob(id: string) { return (await this.tx<Blob>(['blobs'], 'readonly', (t) => t.objectStore('blobs').get(id))) ?? undefined }
  async dropBlob(id: string) { await this.tx(['blobs'], 'readwrite', (t) => { t.objectStore('blobs').delete(id) }) }
  async all() { return ((await this.tx<QueueItem[]>(['items'], 'readonly', (t) => t.objectStore('items').getAll())) ?? []) as QueueItem[] }
  async clear() { await this.tx(['items', 'blobs'], 'readwrite', (t) => { t.objectStore('items').clear(); t.objectStore('blobs').clear() }) }
}

export type Uploader = (item: QueueItem, data: Uint8Array, onProgress: (done: number, total: number) => void) => Promise<void>

export class UploadQueue {
  private items = new Map<string, QueueItem>()
  private listeners = new Set<() => void>()
  private running = false
  private store: QueueStore
  private uploader: Uploader
  private isOnline: () => boolean
  private caseReady: (item: QueueItem) => Promise<boolean>
  /** `caseReady` lets the queue wait until the server actually has the case, so evidence is never sent for a report that is still only on this device. */
  constructor(store: QueueStore, uploader: Uploader, isOnline: () => boolean = () => true, caseReady: (item: QueueItem) => Promise<boolean> = async () => true) {
    this.store = store
    this.uploader = uploader
    this.isOnline = isOnline
    this.caseReady = caseReady
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private emit() { this.listeners.forEach((f) => f()) }
  snapshot(): QueueItem[] { return [...this.items.values()].sort((a, b) => a.createdAtMs - b.createdAtMs) }
  forCase(caseId: string): QueueItem[] { return this.snapshot().filter((i) => i.caseId === caseId) }

  /** Reload what a previous page left behind. Items that were mid-upload go back to "queued". */
  async restore(uid: string): Promise<void> {
    for (const i of await this.store.all()) {
      if (i.uid !== uid) continue
      this.items.set(i.id, i.state === 'uploading' ? { ...i, state: 'queued' } : i)
    }
    this.emit()
  }

  async add(item: Omit<QueueItem, 'state' | 'done' | 'total' | 'error' | 'attempts' | 'createdAtMs'>, blob: Blob, now = Date.now()): Promise<QueueItem> {
    const full: QueueItem = { ...item, state: 'queued', done: 0, total: 1, error: null, attempts: 0, createdAtMs: now }
    this.items.set(full.id, full)
    await this.store.put(full, blob)
    this.emit()
    return full
  }

  async retry(id: string): Promise<void> {
    const i = this.items.get(id)
    if (!i || i.state !== 'failed') return
    await this.update(i, { state: 'queued', error: null })
  }

  async remove(id: string): Promise<void> {
    this.items.delete(id)
    await this.store.dropBlob(id)
    this.emit()
  }

  private async update(i: QueueItem, patch: Partial<QueueItem>) {
    const next = { ...i, ...patch }
    this.items.set(i.id, next)
    await this.store.put(next)
    this.emit()
  }

  /** Upload everything queued, one at a time. Does nothing offline; nothing is marked uploaded until the server confirmed it. */
  async process(): Promise<void> {
    if (this.running || !this.isOnline()) return
    this.running = true
    try {
      for (const i of this.snapshot().filter((x) => x.state === 'queued')) {
        if (!this.isOnline()) break
        if (!(await this.caseReady(i).catch(() => false))) continue // the report itself has not reached the server yet
        const blob = await this.store.getBlob(i.id)
        if (!blob) { await this.update(i, { state: 'failed', error: 'The file is no longer on this device. Attach it again.' }); continue }
        await this.update(i, { state: 'uploading', attempts: i.attempts + 1, error: null })
        try {
          const data = new Uint8Array(await blob.arrayBuffer())
          await this.uploader(this.items.get(i.id)!, data, (done, total) => { const cur = this.items.get(i.id); if (cur) { this.items.set(i.id, { ...cur, done, total }); this.emit() } })
          await this.update(this.items.get(i.id)!, { state: 'uploaded', error: null })
          await this.store.dropBlob(i.id)
        } catch (e) {
          await this.update(this.items.get(i.id)!, { state: 'failed', error: friendlyUploadError(e) })
        }
      }
    } finally {
      this.running = false
    }
  }

  async wipe(): Promise<void> {
    this.items.clear()
    await this.store.clear()
    this.emit()
  }
}

export function friendlyUploadError(e: unknown): string {
  const msg = (e as { code?: string; message?: string })
  if (msg.code === 'permission-denied') return 'The server refused this file. It may be too large, an unsupported type, or the case is closed.'
  if (msg.code === 'unavailable' || /network|offline/i.test(msg.message ?? '')) return 'No connection. It will retry when you are back online.'
  return msg.message ?? 'Upload failed.'
}
