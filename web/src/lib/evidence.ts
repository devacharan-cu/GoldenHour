import { Bytes, collection, doc, getDoc, getDocs, orderBy, query, setDoc, updateDoc, writeBatch, type Firestore } from 'firebase/firestore'
import { sha256Hex } from './crypto'
import type { Evidence, EvidenceKind } from './types'
import type { Actor } from './workflow'

// Cloud Storage for Firebase needs the paid Blaze plan, so evidence is stored as binary chunks in Firestore, behind the
// same security rules as the case itself. Files are size-capped, checksummed and (for photos) compressed on the device.

export const CHUNK_SIZE = 716_800 // 700 KiB, safely under Firestore's 1 MiB document limit
export const MAX_BYTES: Record<EvidenceKind, number> = { image: 5 * 1024 * 1024, document: 8 * 1024 * 1024, audio: 10 * 1024 * 1024, video: 15 * 1024 * 1024 }
export const MAX_FILES_PER_REPORT = 10

export const ALLOWED_MIME: Record<EvidenceKind, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  document: ['application/pdf'],
  audio: ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/opus'],
  video: ['video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp'],
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf',
  webm: 'audio/webm', ogg: 'audio/ogg', oga: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/opus',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp',
}

export const KIND_LABEL: Record<EvidenceKind, string> = { image: 'Photo', document: 'Document', audio: 'Audio', video: 'Video' }

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export type Classified = { ok: true; kind: EvidenceKind; mime: string } | { ok: false; reason: string }

/** Decide what a picked file is, and whether it may be attached. Pure, so it is unit-tested. */
export function classifyFile(f: { name: string; type: string; size: number }): Classified {
  let mime = (f.type || '').split(';')[0].trim().toLowerCase()
  if (!mime) mime = EXT_MIME[f.name.split('.').pop()?.toLowerCase() ?? ''] ?? ''
  // A recording from a browser is often labelled video/webm even when it holds only audio; trust the extension hint for webm audio names.
  if (mime === 'video/webm' && /^(voice|audio|recording)/i.test(f.name)) mime = 'audio/webm'
  const kind = (Object.keys(ALLOWED_MIME) as EvidenceKind[]).find((k) => ALLOWED_MIME[k].includes(mime))
  if (!kind) return { ok: false, reason: mime ? `${mime} files are not supported. Use a photo (JPEG, PNG, WebP), PDF, audio or video file.` : 'This file type could not be recognised.' }
  if (f.size <= 0) return { ok: false, reason: 'This file is empty.' }
  if (f.size > MAX_BYTES[kind]) return { ok: false, reason: `${KIND_LABEL[kind]} files can be at most ${formatBytes(MAX_BYTES[kind])}. This one is ${formatBytes(f.size)}.` }
  return { ok: true, kind, mime }
}

export function splitBytes(buf: Uint8Array, size = CHUNK_SIZE): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, Math.min(buf.length, i + size)))
  return out
}

/**
 * Shrink a photo on the device before upload (long edge 2048 px, JPEG). Phone photos are often 4 to 8 MB; this keeps
 * them a fraction of that. Falls back to the original file if the browser cannot decode it.
 */
export async function compressImage(file: File, maxEdge = 2048, quality = 0.82): Promise<File> {
  if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height))
    if (scale === 1 && file.size < 1.5 * 1024 * 1024 && file.type === 'image/jpeg') { bmp.close(); return file }
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    bmp.close()
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}

export interface UploadMeta { name: string; mime: string; kind: EvidenceKind; origin: Evidence['origin'] }
export type Progress = (done: number, total: number) => void

/**
 * Upload one file as chunks. Safe to call again after a failure: it keeps the same evidence id and writes only the
 * chunks that are missing. Resolves only once the server has confirmed every chunk and the final "ready" flag.
 */
export async function uploadEvidence(db: Firestore, actor: Actor, caseId: string, evidenceId: string, data: Uint8Array, meta: UploadMeta, onProgress: Progress = () => undefined, now = Date.now()): Promise<void> {
  const sha256 = await sha256Hex(data)
  const chunks = splitBytes(data)
  const metaRef = doc(db, 'cases', caseId, 'evidence', evidenceId)
  const existing = await getDoc(metaRef)
  if (existing.exists() && existing.data().status === 'ready') { onProgress(chunks.length, chunks.length); return }
  if (!existing.exists()) {
    await setDoc(metaRef, {
      name: meta.name.slice(0, 120), mime: meta.mime, kind: meta.kind, size: data.length, sha256, chunkCount: chunks.length, chunkSize: CHUNK_SIZE,
      status: 'uploading', uploaderUid: actor.uid, createdAtMs: now, origin: meta.origin,
    })
  }
  const have = new Set((await getDocs(collection(db, 'cases', caseId, 'evidence', evidenceId, 'chunks'))).docs.map((d) => Number(d.id)))
  let done = have.size
  onProgress(done, chunks.length)
  const todo = chunks.map((_, i) => i).filter((i) => !have.has(i))
  const workers = Array.from({ length: Math.min(3, todo.length) }, async () => {
    for (let i = todo.shift(); i !== undefined; i = todo.shift()) {
      await setDoc(doc(db, 'cases', caseId, 'evidence', evidenceId, 'chunks', String(i)), { i, data: Bytes.fromUint8Array(chunks[i]) })
      onProgress(++done, chunks.length)
    }
  })
  await Promise.all(workers)
  await updateDoc(metaRef, { status: 'ready' })
  const b = writeBatch(db)
  b.set(doc(collection(db, 'cases', caseId, 'events')), { kind: 'evidence', text: `Evidence added: ${meta.name} (${meta.kind}, ${formatBytes(data.length)})`, atMs: now, actorUid: actor.uid, actorRole: actor.role })
  await b.commit().catch(() => undefined) // the file itself is already safely stored; a missing log line must not fail the upload
}

/** Abandon an unfinished upload (the rules allow this only while it is still "uploading"). */
export async function discardUpload(db: Firestore, caseId: string, evidenceId: string): Promise<void> {
  const chunks = await getDocs(collection(db, 'cases', caseId, 'evidence', evidenceId, 'chunks'))
  const b = writeBatch(db)
  chunks.docs.forEach((d) => b.delete(d.ref))
  b.delete(doc(db, 'cases', caseId, 'evidence', evidenceId))
  await b.commit()
}

export class EvidenceIntegrityError extends Error {}

/** Reassemble a stored file and verify its checksum before anyone looks at it. */
export async function downloadEvidence(db: Firestore, caseId: string, ev: Pick<Evidence, 'id' | 'size' | 'sha256' | 'chunkCount' | 'mime'>): Promise<Blob> {
  const snap = await getDocs(query(collection(db, 'cases', caseId, 'evidence', ev.id, 'chunks'), orderBy('i')))
  if (snap.size !== ev.chunkCount) throw new EvidenceIntegrityError(`Expected ${ev.chunkCount} parts but found ${snap.size}`)
  const parts = snap.docs.map((d) => (d.data().data as Bytes).toUint8Array())
  const total = parts.reduce((n, p) => n + p.length, 0)
  if (total !== ev.size) throw new EvidenceIntegrityError('The stored file has the wrong size')
  const all = new Uint8Array(total)
  let off = 0
  for (const p of parts) { all.set(p, off); off += p.length }
  if ((await sha256Hex(all)) !== ev.sha256) throw new EvidenceIntegrityError('The stored file failed its checksum')
  return new Blob([all as unknown as ArrayBuffer], { type: ev.mime })
}
