import { useEffect, useSyncExternalStore } from 'react'
import { doc, getDocFromServer } from 'firebase/firestore'
import { db } from './firebase'
import { uploadEvidence } from './evidence'
import { MemoryStore, ResilientStore, UploadQueue, type QueueItem } from './uploadQueue'

const confirmedCases = new Set<string>()

/**
 * The one upload queue for this browser. Evidence files wait here, on the device, until the server has confirmed every
 * part of them. It is wiped on sign-out (see wipeLocalData) so the next person on the device never sees it.
 */
export const uploadQueue = new UploadQueue(
  typeof indexedDB === 'undefined' ? new MemoryStore() : new ResilientStore(),
  (item, data, onProgress) =>
    uploadEvidence(db, { uid: item.uid, role: item.role }, item.caseId, item.evidenceId, data, { name: item.name, mime: item.mime, kind: item.kind, origin: item.origin }, onProgress),
  () => navigator.onLine,
  async (item) => {
    if (confirmedCases.has(item.caseId)) return true
    try { await getDocFromServer(doc(db, 'cases', item.caseId)); confirmedCases.add(item.caseId); return true } catch { return false }
  },
)

let snapshot: QueueItem[] = []
uploadQueue.subscribe(() => { snapshot = uploadQueue.snapshot() })

/** Live view of the queue, and the triggers that keep it moving: new files, regained connection, and a slow heartbeat for retries. */
export function useUploadQueue(uid: string | null): QueueItem[] {
  const items = useSyncExternalStore(
    (cb) => uploadQueue.subscribe(cb),
    () => snapshot,
  )
  useEffect(() => {
    if (!uid) return
    let live = true
    void uploadQueue.restore(uid).then(() => { if (live) void uploadQueue.process() })
    const go = () => void uploadQueue.process()
    window.addEventListener('online', go)
    const t = setInterval(go, 6000)
    const unsub = uploadQueue.subscribe(go)
    return () => { live = false; window.removeEventListener('online', go); clearInterval(t); unsub() }
  }, [uid])
  return uid ? items.filter((i) => i.uid === uid) : []
}
