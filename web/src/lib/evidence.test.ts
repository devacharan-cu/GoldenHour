import { describe, expect, it } from 'vitest'
import { CHUNK_SIZE, classifyFile, formatBytes, MAX_BYTES, splitBytes } from './evidence'
import { formatReceipt, parseReceipt, randomSecret, sha256Hex } from './crypto'
import { MemoryStore, UploadQueue, type QueueItem } from './uploadQueue'

const MB = 1024 * 1024

describe('file validation', () => {
  it('accepts each supported media type and names its kind', () => {
    expect(classifyFile({ name: 'a.jpg', type: 'image/jpeg', size: 1000 })).toEqual({ ok: true, kind: 'image', mime: 'image/jpeg' })
    expect(classifyFile({ name: 'a.png', type: 'image/png', size: 1000 })).toMatchObject({ ok: true, kind: 'image' })
    expect(classifyFile({ name: 'a.webp', type: 'image/webp', size: 1000 })).toMatchObject({ ok: true, kind: 'image' })
    expect(classifyFile({ name: 'history.pdf', type: 'application/pdf', size: 1000 })).toMatchObject({ ok: true, kind: 'document' })
    expect(classifyFile({ name: 'note.webm', type: 'audio/webm;codecs=opus', size: 1000 })).toEqual({ ok: true, kind: 'audio', mime: 'audio/webm' })
    expect(classifyFile({ name: 'note.m4a', type: 'audio/mp4', size: 1000 })).toMatchObject({ ok: true, kind: 'audio' })
    expect(classifyFile({ name: 'clip.mp4', type: 'video/mp4', size: 1000 })).toMatchObject({ ok: true, kind: 'video' })
    expect(classifyFile({ name: 'clip.mov', type: 'video/quicktime', size: 1000 })).toMatchObject({ ok: true, kind: 'video' })
  })
  it('falls back to the file extension when the browser gives no type', () => {
    expect(classifyFile({ name: 'scan.PDF', type: '', size: 10 })).toMatchObject({ ok: true, kind: 'document' })
    expect(classifyFile({ name: 'photo.jpeg', type: '', size: 10 })).toMatchObject({ ok: true, kind: 'image' })
  })
  it('rejects unsupported and dangerous types with a clear reason', () => {
    for (const [name, type] of [['x.gif', 'image/gif'], ['x.svg', 'image/svg+xml'], ['x.html', 'text/html'], ['x.exe', 'application/x-msdownload'], ['x.zip', 'application/zip'], ['x.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]) {
      const r = classifyFile({ name, type, size: 10 })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/not supported|could not be recognised/)
    }
    expect(classifyFile({ name: 'mystery', type: '', size: 10 })).toMatchObject({ ok: false })
  })
  it('enforces per-type size limits and empty files', () => {
    expect(classifyFile({ name: 'a.jpg', type: 'image/jpeg', size: MAX_BYTES.image })).toMatchObject({ ok: true })
    const big = classifyFile({ name: 'a.jpg', type: 'image/jpeg', size: MAX_BYTES.image + 1 })
    expect(big.ok).toBe(false)
    if (!big.ok) expect(big.reason).toMatch(/at most 5\.0 MB/)
    expect(classifyFile({ name: 'a.mp4', type: 'video/mp4', size: 15 * MB + 1 })).toMatchObject({ ok: false })
    expect(classifyFile({ name: 'a.pdf', type: 'application/pdf', size: 8 * MB + 1 })).toMatchObject({ ok: false })
    expect(classifyFile({ name: 'a.webm', type: 'audio/webm', size: 10 * MB + 1 })).toMatchObject({ ok: false })
    expect(classifyFile({ name: 'a.pdf', type: 'application/pdf', size: 0 })).toMatchObject({ ok: false, reason: 'This file is empty.' })
  })
  it('keeps voice recordings that browsers label as video/webm as audio', () => {
    expect(classifyFile({ name: 'voice-note.webm', type: 'video/webm', size: 10 })).toMatchObject({ kind: 'audio' })
    expect(classifyFile({ name: 'clip.webm', type: 'video/webm', size: 10 })).toMatchObject({ kind: 'video' })
  })
  it('formats sizes for people', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3.5 * MB)).toBe('3.5 MB')
  })
})

describe('chunking', () => {
  it('splits into full chunks plus a remainder and reassembles exactly', () => {
    const data = new Uint8Array(CHUNK_SIZE * 2 + 123)
    for (let i = 0; i < data.length; i++) data[i] = i % 251
    const parts = splitBytes(data)
    expect(parts.map((p) => p.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 123])
    const joined = new Uint8Array(data.length)
    let o = 0
    for (const p of parts) { joined.set(p, o); o += p.length }
    expect(Buffer.compare(joined, data)).toBe(0) // a byte compare: deep-equality on 1.4M elements is needlessly slow
  })
  it('stays under the Firestore document limit', () => { expect(CHUNK_SIZE).toBeLessThan(1_048_576 - 4096) })
  it('hashes deterministically', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(await sha256Hex(new Uint8Array([97, 98, 99]))).toBe(await sha256Hex('abc'))
  })
})

describe('receipts', () => {
  it('round-trips and accepts a pasted link or a prefixed code', () => {
    const secret = randomSecret()
    expect(secret).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const code = formatReceipt('a1B2c3D4e5F6g7H8i9J0', secret)
    expect(parseReceipt(code)).toEqual({ caseId: 'a1B2c3D4e5F6g7H8i9J0', secret })
    expect(parseReceipt(`https://goldenhour-46131.web.app/#/r/${code}`)).toEqual({ caseId: 'a1B2c3D4e5F6g7H8i9J0', secret })
    expect(parseReceipt(`GH-${code}`)).toEqual({ caseId: 'a1B2c3D4e5F6g7H8i9J0', secret })
    expect(parseReceipt('  ' + code + '\n')).toMatchObject({ secret })
  })
  it('rejects malformed codes', () => {
    for (const bad of ['', 'abc', 'a1B2c3D4e5F6g7H8i9J0', 'a1B2c3D4e5F6g7H8i9J0.short', '../etc/passwd', 'a1B2c3D4e5F6g7H8i9J0.' + 'x'.repeat(80)]) expect(parseReceipt(bad)).toBeNull()
  })
  it('generates unguessable, unique secrets', () => {
    const s = new Set(Array.from({ length: 200 }, () => randomSecret()))
    expect(s.size).toBe(200)
  })
})

describe('upload queue states', () => {
  const base = { caseId: 'c1', uid: 'u1', role: 'reporter' as const, evidenceId: 'e1', name: 'a.jpg', mime: 'image/jpeg', kind: 'image' as const, size: 3, origin: 'file' as const }
  const blob = () => new Blob([new Uint8Array([1, 2, 3])])

  it('marks a file uploaded only after the uploader confirms, reporting progress on the way', async () => {
    const progress: number[] = []
    const q = new UploadQueue(new MemoryStore(), async (_i, data, on) => { expect(data.length).toBe(3); on(1, 2); progress.push(1); on(2, 2) })
    const item = await q.add({ ...base, id: 'i1' }, blob())
    expect(item.state).toBe('queued')
    const seen: string[] = []
    q.subscribe(() => seen.push(q.forCase('c1')[0].state))
    await q.process()
    expect(q.forCase('c1')[0]).toMatchObject({ state: 'uploaded', done: 2, total: 2, attempts: 1, error: null })
    expect(seen).toContain('uploading')
    expect(seen.at(-1)).toBe('uploaded')
  })
  it('keeps files queued on the device while offline and never claims they were sent', async () => {
    let online = false
    let sent = 0
    const q = new UploadQueue(new MemoryStore(), async () => { sent++ }, () => online)
    await q.add({ ...base, id: 'i1' }, blob())
    await q.process()
    expect(q.snapshot()[0].state).toBe('queued')
    expect(sent).toBe(0)
    online = true
    await q.process()
    expect(q.snapshot()[0].state).toBe('uploaded')
    expect(sent).toBe(1)
  })
  it('records a failure with a readable reason, and retry sends it again', async () => {
    let fail = true
    const q = new UploadQueue(new MemoryStore(), async () => { if (fail) throw Object.assign(new Error('x'), { code: 'permission-denied' }) })
    await q.add({ ...base, id: 'i1' }, blob())
    await q.process()
    expect(q.snapshot()[0]).toMatchObject({ state: 'failed' })
    expect(q.snapshot()[0].error).toMatch(/refused this file/)
    fail = false
    await q.retry('i1')
    expect(q.snapshot()[0].state).toBe('queued')
    await q.process()
    expect(q.snapshot()[0]).toMatchObject({ state: 'uploaded', attempts: 2 })
  })
  it('reports a network failure as retryable, and a removed file as gone', async () => {
    const store = new MemoryStore()
    const q = new UploadQueue(store, async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }) })
    await q.add({ ...base, id: 'i1' }, blob())
    await q.process()
    expect(q.snapshot()[0].error).toMatch(/No connection/)
    await store.dropBlob('i1')
    await q.retry('i1')
    await q.process()
    expect(q.snapshot()[0].error).toMatch(/no longer on this device/)
  })
  it('lets a person remove a file before it is sent', async () => {
    const q = new UploadQueue(new MemoryStore(), async () => undefined)
    await q.add({ ...base, id: 'i1' }, blob())
    await q.remove('i1')
    expect(q.snapshot()).toEqual([])
  })
  it('restores queued work for the same person after a reload, but never for someone else, and wipes on sign-out', async () => {
    const store = new MemoryStore()
    const first = new UploadQueue(store, async () => undefined)
    await first.add({ ...base, id: 'i1' }, blob())
    await store.put({ ...(await store.all())[0], state: 'uploading' } as QueueItem)
    const mine = new UploadQueue(store, async () => undefined)
    await mine.restore('u1')
    expect(mine.snapshot()[0].state).toBe('queued') // a half-finished upload starts again
    const theirs = new UploadQueue(store, async () => undefined)
    await theirs.restore('someone-else')
    expect(theirs.snapshot()).toEqual([])
    await mine.wipe()
    expect(await store.all()).toEqual([])
  })
})
