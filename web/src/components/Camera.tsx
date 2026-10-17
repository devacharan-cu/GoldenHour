/* oxlint-disable react/only-export-components -- the capability check and limits live beside the component that uses them */
import { useEffect, useRef, useState } from 'react'
import { Icon } from './ui'

/**
 * In-app camera: a live viewfinder (rear camera first), shutter, retake and confirm. It is used instead of a generic file
 * picker. If the browser has no camera API, permission is refused, or no camera exists, the caller is told so it can fall
 * back to the phone's own camera app (an <input capture>) or to choosing a file.
 */

export type CameraMode = 'photo' | 'video'
export const MAX_VIDEO_SECONDS = 45
const VIDEO_BITRATE = 1_500_000 // about 8 MB at the 45 s limit, under the 15 MB cap

export const cameraSupported = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

function pickVideoMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m))
}

type Problem = { kind: 'denied' | 'missing' | 'busy' | 'unsupported' | 'other'; text: string }

function describe(e: unknown): Problem {
  const name = (e as DOMException)?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return { kind: 'denied', text: 'Camera permission was refused. Allow the camera for this site in your browser settings, then try again, or use your phone’s camera app instead.' }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return { kind: 'missing', text: 'No camera was found on this device.' }
  if (name === 'NotReadableError' || name === 'AbortError') return { kind: 'busy', text: 'The camera is in use by another app. Close it and try again.' }
  return { kind: 'other', text: 'The camera could not be started.' }
}

export function CameraCapture({ mode, onDone, onClose, onFallback }: {
  mode: CameraMode
  onDone: (file: File) => void
  onClose: () => void
  /** Offered when the live camera cannot be used: open the phone's own camera app / file chooser. */
  onFallback: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recRef = useRef<{ mr: MediaRecorder; chunks: Blob[]; timer: ReturnType<typeof setInterval> } | null>(null)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [canFlip, setCanFlip] = useState(false)
  const [live, setLive] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [recording, setRecording] = useState<number | null>(null)
  const [taken, setTaken] = useState<{ file: File; url: string } | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (taken) return
    let cancelled = false
    async function start() {
      setProblem(null)
      setLive(false)
      if (!cameraSupported()) { setProblem({ kind: 'unsupported', text: 'This browser cannot open the camera from a web page.' }); return }
      try {
        const base = { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        // A camera that was only just released by the previous screen can briefly report "not found" or "in use": try once more before giving up.
        const ask = async (c: MediaStreamConstraints): Promise<MediaStream> => {
          try { return await navigator.mediaDevices.getUserMedia(c) } catch (e) {
            if (!['NotFoundError', 'NotReadableError', 'AbortError'].includes((e as DOMException).name)) throw e
            await new Promise((r) => setTimeout(r, 700))
            return navigator.mediaDevices.getUserMedia(c)
          }
        }
        let stream: MediaStream
        try { stream = await ask({ video: base, audio: mode === 'video' }) }
        catch (e) {
          // a video without sound is still useful when the microphone is refused, missing or busy
          if (mode === 'video' && ['NotAllowedError', 'NotFoundError', 'NotReadableError'].includes((e as DOMException).name)) stream = await ask({ video: base, audio: false })
          else throw e
        }
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        const v = videoRef.current
        if (v) { v.srcObject = stream; await v.play().catch(() => undefined) }
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
        if (!cancelled) { setCanFlip(devices.filter((d) => d.kind === 'videoinput').length > 1); setLive(true) }
      } catch (e) {
        if (!cancelled) setProblem(describe(e))
      }
    }
    void start()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
  }, [facing, mode, attempt, taken])

  useEffect(() => () => {
    if (recRef.current) { clearInterval(recRef.current.timer); recRef.current.mr.onstop = null; if (recRef.current.mr.state !== 'inactive') recRef.current.mr.stop() }
  }, [])

  useEffect(() => { dialogRef.current?.focus() }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])
  useEffect(() => () => { if (taken) URL.revokeObjectURL(taken.url) }, [taken])

  function shoot() {
    const v = videoRef.current
    if (!v || !v.videoWidth) return
    const scale = Math.min(1, 1920 / Math.max(v.videoWidth, v.videoHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(v.videoWidth * scale)
    canvas.height = Math.round(v.videoHeight * scale)
    canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) { setProblem({ kind: 'other', text: 'The photo could not be captured. Try again.' }); return }
      const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(/\W/g, '')
      const file = new File([blob], `photo-${stamp}.jpg`, { type: 'image/jpeg' })
      setTaken({ file, url: URL.createObjectURL(file) })
    }, 'image/jpeg', 0.88)
  }

  function startRecording() {
    const stream = streamRef.current
    if (!stream) return
    const mime = pickVideoMime()
    if (!mime) { setProblem({ kind: 'unsupported', text: 'This browser cannot record video from a web page.' }); return }
    const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: 64_000 })
    const chunks: Blob[] = []
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
    mr.onstop = () => {
      if (recRef.current) clearInterval(recRef.current.timer)
      recRef.current = null
      setRecording(null)
      if (!chunks.length) return
      const type = mime.split(';')[0]
      const stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(/\W/g, '')
      const file = new File(chunks, `video-${stamp}.${type === 'video/mp4' ? 'mp4' : 'webm'}`, { type })
      setTaken({ file, url: URL.createObjectURL(file) })
    }
    const started = Date.now()
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000)
      setRecording(s)
      if (s >= MAX_VIDEO_SECONDS) mr.stop()
    }, 250)
    recRef.current = { mr, chunks, timer }
    mr.start(1000)
    setRecording(0)
  }

  const stopRecording = () => recRef.current?.mr.stop()
  const title = mode === 'photo' ? 'Take a photo' : 'Record a video'

  return (
    <div className="cam" role="dialog" aria-modal="true" aria-label={title} ref={dialogRef} tabIndex={-1}>
      <div className="cam-top">
        <button type="button" className="cam-btn" onClick={onClose} aria-label="Close the camera"><Icon name="x" size={24} /></button>
        <span className="cam-title">{title}</span>
        {canFlip && !taken && !recording && live ? <button type="button" className="cam-btn" onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))} aria-label="Switch between the rear and front camera"><Icon name="retry" size={22} /></button> : <span className="cam-btn cam-btn-ghost" aria-hidden />}
      </div>

      <div className="cam-stage">
        {taken ? (
          mode === 'photo' ? <img src={taken.url} alt="The photo you just took" /> : <video src={taken.url} controls playsInline aria-label="The video you just recorded" />
        ) : (
          <video ref={videoRef} playsInline muted autoPlay aria-label="Live camera view" className={live ? 'on' : ''} />
        )}
        {!taken && !live && !problem && <div className="cam-note" role="status"><span className="spin" /> Starting the camera. If your browser asks, choose Allow.</div>}
        {problem && (
          <div className="cam-note" role="alert">
            <Icon name="alert" size={32} />
            <p>{problem.text}</p>
            <div className="row" style={{ justifyContent: 'center' }}>
              {(problem.kind === 'denied' || problem.kind === 'busy' || problem.kind === 'other') && <button type="button" className="btn btn-sm" onClick={() => setAttempt((a) => a + 1)}>Try again</button>}
              <button type="button" className="btn btn-sm btn-ink" onClick={onFallback}>{mode === 'photo' ? 'Use my phone’s camera app' : 'Use my phone’s video recorder'}</button>
              <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
            </div>
          </div>
        )}
        {recording !== null && <div className="cam-rec" role="timer"><i aria-hidden /> {Math.floor(recording / 60)}:{String(recording % 60).padStart(2, '0')} / 0:{MAX_VIDEO_SECONDS}</div>}
      </div>

      <div className="cam-bar">
        {taken ? (
          <>
            <button type="button" className="btn btn-lg" onClick={() => setTaken(null)}><Icon name="retry" /> Retake</button>
            <button type="button" className="btn btn-lg btn-go" onClick={() => onDone(taken.file)}><Icon name="check" /> {mode === 'photo' ? 'Use this photo' : 'Use this video'}</button>
          </>
        ) : mode === 'photo' ? (
          <button type="button" className="cam-shutter" onClick={shoot} disabled={!live} aria-label="Take the photo"><i /></button>
        ) : recording === null ? (
          <button type="button" className="cam-shutter cam-shutter-rec" onClick={startRecording} disabled={!live} aria-label="Start recording"><i /></button>
        ) : (
          <button type="button" className="cam-shutter cam-shutter-rec on" onClick={stopRecording} aria-label="Stop recording"><i /></button>
        )}
      </div>
    </div>
  )
}
