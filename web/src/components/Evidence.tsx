import { useCallback, useEffect, useRef, useState } from 'react'
import { db } from '../lib/firebase'
import { classifyFile, compressImage, downloadEvidence, EvidenceIntegrityError, formatBytes, KIND_LABEL, MAX_BYTES, MAX_FILES_PER_REPORT } from '../lib/evidence'
import { useOnline } from '../lib/store'
import type { QueueItem } from '../lib/uploadQueue'
import type { Evidence, EvidenceKind } from '../lib/types'
import { DeviceStamp, Icon, KIND_ICON, Notice, Pill } from './ui'

const ORIGIN_LABEL = { camera: 'Taken with the camera', recorder: 'Recorded in the app', file: 'Chosen from files' } as const

// ---------------------------------------------------------------- viewing stored evidence

type BlobState = { status: 'idle' | 'loading' | 'ready' | 'error'; url?: string; error?: string }

function useEvidenceBlob(caseId: string, ev: Evidence, auto: boolean): BlobState & { load: () => void } {
  const [state, setState] = useState<BlobState>({ status: 'idle' })
  const urlRef = useRef<string | null>(null)
  const load = useCallback(() => {
    setState({ status: 'loading' })
    downloadEvidence(db, caseId, ev)
      .then((blob) => {
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = URL.createObjectURL(blob)
        setState({ status: 'ready', url: urlRef.current })
      })
      .catch((e: unknown) => {
        const code = (e as { code?: string }).code
        setState({
          status: 'error',
          error: code === 'permission-denied' ? 'You no longer have access to this file.' : e instanceof EvidenceIntegrityError ? `This file failed its integrity check, so it is not shown. ${e.message}.` : 'Could not load this file. Check your connection and try again.',
        })
      })
  }, [caseId, ev])
  useEffect(() => {
    if (auto && ev.status === 'ready') load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ev.id, ev.status, auto])
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current) }, [])
  return { ...state, load }
}

function EvidenceTile({ caseId, ev }: { caseId: string; ev: Evidence }) {
  const blob = useEvidenceBlob(caseId, ev, ev.kind === 'image')
  const ready = ev.status === 'ready'
  return (
    <li className="tile">
      <div className="tile-media">
        {!ready ? (
          <div className="tile-glyph"><Icon name="upload" size={40} />Still arriving</div>
        ) : blob.status === 'ready' && ev.kind === 'image' ? (
          <a href={blob.url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${ev.name} full size`} style={{ display: 'block', width: '100%', height: '100%' }}><img src={blob.url} alt={ev.name} /></a>
        ) : blob.status === 'ready' && ev.kind === 'audio' ? (
          <audio controls src={blob.url} aria-label={ev.name} />
        ) : blob.status === 'ready' && ev.kind === 'video' ? (
          <video controls playsInline src={blob.url} aria-label={ev.name} />
        ) : blob.status === 'ready' ? (
          <div className="tile-glyph"><Icon name="file" size={40} /><a className="btn btn-sm" href={blob.url} target="_blank" rel="noopener noreferrer" download={ev.name}>Open {KIND_LABEL[ev.kind].toLowerCase()}</a></div>
        ) : blob.status === 'loading' ? (
          <div className="tile-glyph"><span className="spin" />Loading and checking</div>
        ) : blob.status === 'error' ? (
          <div className="tile-glyph" role="alert"><Icon name="alert" size={40} />{blob.error}</div>
        ) : (
          <div className="tile-glyph"><Icon name={KIND_ICON[ev.kind]} size={40} /><button className="btn btn-sm" onClick={blob.load}>Load {KIND_LABEL[ev.kind].toLowerCase()}</button></div>
        )}
      </div>
      <div className="tile-body">
        <div className="tile-name">{ev.name}</div>
        <div className="row row-tight">
          <Pill>{KIND_LABEL[ev.kind]}</Pill><Pill>{formatBytes(ev.size)}</Pill>
          {blob.status === 'ready' && <Pill tone="go" title="The stored bytes matched their SHA-256 checksum">Checksum verified</Pill>}
          {blob.status === 'error' && <button className="btn btn-sm" onClick={blob.load}>Retry</button>}
        </div>
        <div className="fine">{ORIGIN_LABEL[ev.origin]}, {new Date(ev.createdAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
    </li>
  )
}

/** Everything attached to a case. Each file is fetched from the access-controlled store and checksum-verified before it is shown. */
export function EvidenceGallery({ caseId, items, expected = 0, empty = 'No files were attached to this report.', loading = false }: { caseId: string; items: Evidence[]; expected?: number; empty?: string; loading?: boolean }) {
  if (loading) return <div className="stack-sm" role="status" aria-label="Loading files"><div className="skeleton" style={{ height: 96 }} /><span className="sr-only">Loading files</span></div>
  const ready = items.filter((e) => e.status === 'ready').length
  return (
    <div className="stack-sm">
      {expected > 0 && ready < expected && <Notice tone="wait" title={`${ready} of ${expected} files have arrived`}>The reporter is still sending the rest. They appear here as they finish.</Notice>}
      {items.length === 0 ? (expected > 0 ? null : <p className="sub">{empty}</p>) : <ul className="tiles" aria-label="Attached evidence">{items.map((e) => <EvidenceTile key={e.id} caseId={caseId} ev={e} />)}</ul>}
    </div>
  )
}

// ---------------------------------------------------------------- choosing files before sending

export interface LocalFile { id: string; file: File; kind: EvidenceKind; mime: string; origin: 'camera' | 'recorder' | 'file'; previewUrl: string }

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf,audio/*,video/mp4,video/webm,video/quicktime,video/3gpp'
const MAX_RECORDING_SECONDS = 300
let counter = 0
const newId = () => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

function pickRecorderMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m))
}

export function EvidenceComposer({ files, onChange, disabled }: { files: LocalFile[]; onChange: (f: LocalFile[]) => void; disabled?: boolean }) {
  const [problems, setProblems] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [rec, setRec] = useState<{ seconds: number } | null>(null)
  const recorder = useRef<{ mr: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: ReturnType<typeof setInterval> } | null>(null)
  const filesRef = useRef(files)
  useEffect(() => { filesRef.current = files })

  useEffect(() => () => {
    filesRef.current.forEach((f) => URL.revokeObjectURL(f.previewUrl))
    if (recorder.current) { clearInterval(recorder.current.timer); recorder.current.stream.getTracks().forEach((t) => t.stop()) }
  }, [])

  async function add(list: FileList | File[], origin: LocalFile['origin']) {
    setBusy(true)
    const next = [...filesRef.current]
    const errs: string[] = []
    for (const original of Array.from(list)) {
      if (next.length >= MAX_FILES_PER_REPORT) { errs.push(`You can attach up to ${MAX_FILES_PER_REPORT} files. ${original.name} was not added.`); continue }
      let file = original
      const first = classifyFile(file)
      if (first.ok && first.kind === 'image') file = await compressImage(file)
      const c = classifyFile(file)
      if (!c.ok) { errs.push(`${original.name}: ${c.reason}`); continue }
      if (next.some((n) => n.file.name === file.name && n.file.size === file.size)) { errs.push(`${original.name} is already attached.`); continue }
      next.push({ id: newId(), file, kind: c.kind, mime: c.mime, origin, previewUrl: URL.createObjectURL(file) })
    }
    onChange(next)
    setProblems(errs)
    setBusy(false)
  }

  function remove(id: string) {
    const f = files.find((x) => x.id === id)
    if (f) URL.revokeObjectURL(f.previewUrl)
    onChange(files.filter((x) => x.id !== id))
  }

  async function startRecording() {
    setProblems([])
    const mime = pickRecorderMime()
    if (!mime || !navigator.mediaDevices?.getUserMedia) { setProblems(['Voice recording is not available in this browser. Choose an audio file instead.']); return }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32_000 })
      const chunks: Blob[] = []
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        if (recorder.current) clearInterval(recorder.current.timer)
        recorder.current = null
        setRec(null)
        const type = mime.split(';')[0]
        const ext = type === 'audio/mp4' ? 'm4a' : type === 'audio/ogg' ? 'ogg' : 'webm'
        const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(/\W/g, '')
        if (chunks.length) void add([new File(chunks, `voice-note-${stamp}.${ext}`, { type })], 'recorder')
      }
      // oxlint-disable-next-line react/purity -- runs in a click handler, not during render
      const started = Date.now()
      const timer = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000)
        setRec({ seconds: s })
        if (s >= MAX_RECORDING_SECONDS) mr.stop()
      }, 500)
      recorder.current = { mr, stream, chunks, timer }
      mr.start(1000)
      setRec({ seconds: 0 })
    } catch (e) {
      setProblems([(e as DOMException).name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it for this site, or choose an audio file.' : 'Could not start the microphone.'])
    }
  }

  const stopRecording = () => recorder.current?.mr.stop()

  const input = (props: { accept: string; capture?: 'environment' | 'user'; multiple?: boolean; id: string; origin: LocalFile['origin'] }) => (
    <input id={props.id} className="sr-only" type="file" accept={props.accept} capture={props.capture} multiple={props.multiple} disabled={disabled || busy}
      onChange={(e) => { if (e.target.files?.length) void add(e.target.files, props.origin); e.target.value = '' }} />
  )

  return (
    <div className="stack">
      <div className="stack-sm">
        <div className="row">
          <label className="btn" htmlFor="ev-photo"><Icon name="camera" /> Take a photo</label>
          <label className="btn" htmlFor="ev-video"><Icon name="video" /> Record a video</label>
          <button type="button" className="btn" onClick={() => void startRecording()} disabled={disabled || busy || !!rec}><Icon name="mic" /> Record a voice note</button>
          <label className="btn" htmlFor="ev-files"><Icon name="upload" /> Choose files</label>
        </div>
        {input({ id: 'ev-photo', accept: 'image/*', capture: 'environment', origin: 'camera' })}
        {input({ id: 'ev-video', accept: 'video/*', capture: 'environment', origin: 'camera' })}
        {input({ id: 'ev-files', accept: ACCEPT, multiple: true, origin: 'file' })}
        <p className="hint">Photos (JPEG, PNG, WebP up to {formatBytes(MAX_BYTES.image)}, shrunk on your device), PDFs up to {formatBytes(MAX_BYTES.document)}, audio up to {formatBytes(MAX_BYTES.audio)}, video up to {formatBytes(MAX_BYTES.video)}. Up to {MAX_FILES_PER_REPORT} files.</p>
      </div>

      {rec && (
        <div className="recorder" role="status">
          <span className="rec-dot" aria-hidden />
          <span className="grow strong">Recording <span className="num">{Math.floor(rec.seconds / 60)}:{String(rec.seconds % 60).padStart(2, '0')}</span></span>
          <button type="button" className="btn btn-sm btn-ink" onClick={stopRecording}><Icon name="stop" size={16} /> Stop and keep</button>
        </div>
      )}

      <div className={`drop ${over ? 'over' : ''} hide-sm`} onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) void add(e.dataTransfer.files, 'file') }}>
        <Icon name="upload" size={30} /><span className="strong">Drop files here</span>
      </div>

      {problems.length > 0 && (
        <Notice tone="signal" title="Some files were not added" actions={<button type="button" className="btn btn-sm" onClick={() => setProblems([])}>Dismiss</button>}>
          <ul className="stack-sm">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </Notice>
      )}

      {files.length > 0 && (
        <ul className="tiles" aria-label="Files ready to send">
          {files.map((f) => (
            <li key={f.id} className="tile">
              <div className="tile-media">
                {f.kind === 'image' ? <img src={f.previewUrl} alt={`Preview of ${f.file.name}`} />
                  : f.kind === 'video' ? <video src={f.previewUrl} controls playsInline muted aria-label={`Preview of ${f.file.name}`} />
                  : f.kind === 'audio' ? <audio src={f.previewUrl} controls aria-label={`Preview of ${f.file.name}`} />
                  : <div className="tile-glyph"><Icon name="file" size={40} />PDF document</div>}
              </div>
              <div className="tile-body">
                <div className="tile-name">{f.file.name}</div>
                <div className="row row-tight"><Pill>{KIND_LABEL[f.kind]}</Pill><Pill>{f.mime}</Pill><Pill>{formatBytes(f.file.size)}</Pill></div>
                <div className="row"><button type="button" className="btn btn-sm btn-danger" onClick={() => remove(f.id)} disabled={disabled} aria-label={`Remove ${f.file.name}`}><Icon name="trash" size={16} /> Remove</button></div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- sending: queued, uploading, uploaded, failed

export function UploadList({ items, onRetry, onRemove }: { items: QueueItem[]; onRetry: (id: string) => void; onRemove: (id: string) => void }) {
  const online = useOnline()
  if (!items.length) return null
  const sent = items.filter((i) => i.state === 'uploaded').length
  return (
    <div className="stack-sm" aria-label="Evidence upload status">
      <div className="row row-between"><h3 className="h-sm">Evidence: {sent} of {items.length} uploaded</h3>{sent < items.length && !online && <DeviceStamp>Offline: waiting on this device</DeviceStamp>}</div>
      <ul className="tiles">
        {items.map((i) => {
          const pct = i.total ? Math.round((i.done / i.total) * 100) : 0
          return (
            <li key={i.id} className="tile">
              <div className="tile-body">
                <div className="row row-between">
                  <div className="tile-name">{i.name}</div>
                  <Icon name={KIND_ICON[i.kind]} />
                </div>
                {i.state === 'queued' && <><DeviceStamp>{online ? 'Waiting to send' : 'Saved on this device only'}</DeviceStamp><p className="fine">{online ? 'Starting soon.' : 'It has not been sent. It will upload automatically when you are back online. Keep this page or app installed.'}</p></>}
                {i.state === 'uploading' && <><div className="progress busy" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${i.name}`}><i style={{ width: `${Math.max(6, pct)}%` }} /></div><p className="fine">Uploading, {pct}% ({i.done} of {i.total} parts)</p></>}
                {i.state === 'uploaded' && <Pill tone="go">Uploaded and confirmed by the server</Pill>}
                {i.state === 'failed' && <>
                  <div className="progress fail" aria-hidden><i style={{ width: '100%' }} /></div>
                  <p className="error-text" role="alert">{i.error}</p>
                  <div className="row"><button className="btn btn-sm btn-ink" onClick={() => onRetry(i.id)}><Icon name="retry" size={16} /> Retry</button><button className="btn btn-sm" onClick={() => onRemove(i.id)}>Remove</button></div>
                </>}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
