import { useEffect, useRef, useState } from 'react'
import { EvidenceComposer, EvidenceGallery, UploadList, type LocalFile } from '../components/Evidence'
import MapView from '../components/MapView'
import { Empty, ErrorBox, GoldenRing, Icon, Notice, Panel, Pill, PosSource, RelayTrack, SeverityTag, StatusPill, Switch, TYPE_ICON, type Notify } from '../components/ui'
import { CASE_TYPES, requiredCapabilities } from '../lib/capabilities'
import { agoText } from '../lib/geo'
import { friendlyAuthError, useAuth } from '../lib/auth'
import { parseReceipt } from '../lib/crypto'
import { formatBytes, KIND_LABEL } from '../lib/evidence'
import { db } from '../lib/firebase'
import { uploadQueue, useUploadQueue } from '../lib/queue'
import { receiptFor, receiptLink, saveReceipt } from '../lib/receipts'
import { useCaseById, useEvidence, useNow, useOnline } from '../lib/store'
import type { Case, CaseType, LatLng, Severity } from '../lib/types'
import { claimCase, createCaseQueued } from '../lib/workflow'

const PRESETS: { label: string; pos: LatLng }[] = [
  { label: 'Hampankatta junction', pos: { lat: 12.8704, lng: 74.8419 } },
  { label: 'Bajpe airport road', pos: { lat: 12.9613, lng: 74.8907 } },
  { label: 'Surathkal, NH66', pos: { lat: 12.9869, lng: 74.8005 } },
  { label: 'Kankanady', pos: { lat: 12.8684, lng: 74.8575 } },
]
const STEPS = ['What happened', 'Where', 'Details and evidence', 'Review and send'] as const
let n = 0
const newId = () => `${Date.now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 7)}`

// ---------------------------------------------------------------- receipt

function ReceiptPanel({ caseId, notify }: { caseId: string; notify: Notify }) {
  const saved = receiptFor(caseId)
  if (!saved) return null
  const link = receiptLink(saved.receipt)
  const copy = async (text: string, what: string) => { try { await navigator.clipboard.writeText(text); notify(`${what} copied.`, 'good') } catch { notify('Could not copy. Select the code and copy it by hand.', 'warn') } }
  return (
    <section className="receipt" aria-label="Your receipt">
      <div className="panel-head"><h3 className="h">Your receipt</h3><Pill tone="wait">Keep it private</Pill></div>
      <div className="receipt-code" data-testid="receipt-code">{saved.receipt}</div>
      <div className="panel-body">
        <p className="sub measure">This code reopens your report on any device. Anyone who has it can see the report, so do not post it. We cannot recover it for you, and it is removed from this device when you leave.</p>
        <div className="row noprint">
          <button className="btn btn-sm" onClick={() => void copy(saved.receipt, 'Receipt code')}><Icon name="copy" size={16} /> Copy code</button>
          <button className="btn btn-sm" onClick={() => void copy(link, 'Link')}><Icon name="copy" size={16} /> Copy link</button>
          {'share' in navigator && <button className="btn btn-sm" onClick={() => void navigator.share({ title: 'GoldenHour report', text: 'Open my emergency report', url: link }).catch(() => undefined)}><Icon name="share" size={16} /> Share</button>}
          <button className="btn btn-sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- tracking a report

const updates = (c: Case) => [
  [c.createdAtMs, 'You sent the report'],
  [c.crewOfferedAtMs, c.ambulanceCallSign ? `Dispatch offered it to ${c.ambulanceCallSign}` : null],
  [c.ambulanceAckAtMs, c.ambulanceCallSign ? `${c.ambulanceCallSign} accepted and is on the way` : null],
  [c.hospitalAlertAtMs, 'The nearest hospitals were asked to get ready'],
  [c.selectedAtMs, c.selectedHospitalName ? `${c.selectedHospitalName} confirmed it can receive the patient` : null],
  [c.pickupAtMs, 'The crew picked up the patient'],
  [c.arrivalConfirmedAtMs, 'The hospital confirmed the patient arrived'],
  [c.closedAtMs, c.closeReason ? `Case closed: ${c.closeReason}` : null],
].filter((x): x is [number, string] => !!x[0] && !!x[1]).sort((a, b) => b[0] - a[0])

export function ReportTracking({ c, notify, onBack }: { c: Case; notify: Notify; onBack?: () => void }) {
  const { user } = useAuth()
  const evidence = useEvidence(c.id)
  const queue = useUploadQueue(user?.uid ?? null).filter((i) => i.caseId === c.id)
  const now = useNow(30000)
  const online = useOnline()
  const t = CASE_TYPES[c.type]
  const ups = updates(c)
  return (
    <div className="stack-lg">
      {onBack && <button className="btn btn-quiet" style={{ justifySelf: 'start' }} onClick={onBack}><Icon name="back" size={16} /> All reports</button>}
      <RelayTrack c={c} viewer="reporter" />
      <div className="cols-2">
        <div className="stack">
          <Panel title={<><Icon name={TYPE_ICON[c.type]} size={20} /> {t.label}, {c.patients} patient{c.patients > 1 ? 's' : ''}</>} actions={<div className="row row-tight"><SeverityTag severity={c.severity} /><StatusPill status={c.status} /></div>}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <GoldenRing createdAtMs={c.createdAtMs} frozenAtMs={c.closedAtMs ?? c.arrivalConfirmedAtMs} />
              <div className="stack-sm grow">
                <p className="strong">{c.ambulanceCallSign ? `${c.ambulanceCallSign} ${c.ambulanceAckAtMs ? 'is coming to you' : 'has been asked to come'}` : 'Dispatch is choosing a crew'}</p>
                {c.etaSceneMin !== null && ['enroute'].includes(c.status) && <p className="sub">About {c.etaSceneMin} minute{c.etaSceneMin === 1 ? '' : 's'} away{c.etaSource === 'estimate' ? ' (an estimate)' : ''}.</p>}
                {c.ambulancePos && <div className="row row-tight"><PosSource pos={c.ambulancePos} /><span className="fine">updated {agoText(c.ambulancePos.atMs, now)}</span></div>}
                <p className="sub">{c.selectedHospitalName ? `${c.selectedHospitalName} is ready to receive the patient.` : c.status === 'reported' || c.status === 'dispatched' ? 'A hospital will be chosen once a crew is on the way.' : 'Hospitals are confirming they can treat the patient.'}</p>
              </div>
            </div>
            <p className="sub">Stay with the patient and keep your phone free. If anything changes, or it gets worse, call 112.</p>
          </Panel>
          {(queue.length > 0 || evidence.data.length > 0 || c.evidenceExpected > 0) && (
            <Panel title="Your files">
              {queue.length > 0 && <UploadList items={queue} onRetry={(id) => void uploadQueue.retry(id)} onRemove={(id) => void uploadQueue.remove(id)} />}
              {evidence.data.length > 0 && queue.every((i) => i.state === 'uploaded') && <EvidenceGallery caseId={c.id} items={evidence.data} expected={c.evidenceExpected} loading={!evidence.ready} />}
              {!online && queue.some((i) => i.state !== 'uploaded') && <Notice tone="wait" title="Not sent yet">Files marked &ldquo;saved on this device only&rdquo; have not reached dispatch. They send automatically once you are back online.</Notice>}
            </Panel>
          )}
          <Panel title="What has happened"><ol className="log">{ups.map(([ms, text], i) => <li key={text} className={i === 0 ? 'latest' : ''}><time className="num">{new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><span>{text}</span></li>)}</ol></Panel>
          <ReceiptPanel caseId={c.id} notify={notify} />
        </div>
        <div className="sticky"><MapView cases={[c]} focus={[c, ...(c.ambulancePos ? [c.ambulancePos] : [])]} height={440} label="Where the crew is" /></div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- a list of the person's reports

export function MyReports({ cases, onOpen, onNew }: { cases: Case[]; onOpen: (id: string) => void; onNew: () => void }) {
  const mine = [...cases].sort((a, b) => b.createdAtMs - a.createdAtMs)
  return (
    <div className="stack">
      <div className="row row-between"><h1 className="title">Your reports</h1><button className="btn btn-go" onClick={onNew}>Report an emergency</button></div>
      {mine.length === 0 ? <Empty icon="list" title="No reports on this device" action={<button className="btn" onClick={onNew}>Report an emergency</button>}>Reports you send appear here while you are on this device. To open one from somewhere else, use its receipt code.</Empty> : (
        <div className="strips">
          {mine.map((c) => (
            <button key={c.id} className="strip" style={{ ['--tag' as string]: c.severity === 1 ? 'var(--signal)' : c.severity === 2 ? '#e08a00' : 'var(--go)' }} onClick={() => onOpen(c.id)}>
              <span className="strip-stub" />
              <span className="strip-body"><span className="strip-title"><Icon name={TYPE_ICON[c.type]} size={18} />{CASE_TYPES[c.type].label}<StatusPill status={c.status} /></span><span className="strip-sub">{c.brief || 'No summary'}</span></span>
              <span className="strip-meta num">{new Date(c.createdAtMs).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- opening a report from a receipt

export function OpenByReceipt({ code, notify, onClose }: { code: string; notify: Notify; onClose: () => void }) {
  const { ensureReporter } = useAuth()
  const parsed = parseReceipt(code)
  const [state, setState] = useState<'claiming' | 'ready' | 'failed'>(parsed ? 'claiming' : 'failed')
  const [error, setError] = useState<string | null>(parsed ? null : 'That code is not valid. It should be the long code shown after the report was sent.')
  const { data, ready } = useCaseById(state === 'ready' && parsed ? parsed.caseId : null)
  useEffect(() => {
    if (!parsed) return
    let live = true
    ;(async () => {
      try {
        const actor = await ensureReporter()
        await claimCase(db, actor, parsed.caseId, parsed.secret)
        saveReceipt({ caseId: parsed.caseId, receipt: `${parsed.caseId}.${parsed.secret}`, createdAtMs: Date.now(), label: 'Reopened report' })
        if (live) setState('ready')
      } catch (e) {
        if (live) { setState('failed'); setError((e as { code?: string }).code === 'permission-denied' ? 'That receipt code does not match any report. Check it and try again.' : friendlyAuthError(e)) }
      }
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])
  if (state === 'failed') return <div className="stack"><ErrorBox>{error}</ErrorBox><button className="btn" onClick={onClose}>Back</button></div>
  if (state === 'claiming' || !ready) return <div className="stack" role="status"><div className="skeleton" style={{ height: 160 }} /><p className="sub">Checking your receipt</p></div>
  if (!data) return <div className="stack"><ErrorBox>This report could not be found.</ErrorBox><button className="btn" onClick={onClose}>Back</button></div>
  return <ReportTracking c={data} notify={notify} onBack={onClose} />
}

// ---------------------------------------------------------------- the report flow

export function ReportFlow({ notify, onSent, onCreated }: { notify: Notify; onSent?: (id: string) => void; onCreated: (c: { id: string }) => void }) {
  const { ensureReporter } = useAuth()
  const online = useOnline()
  const [step, setStep] = useState(0)
  const [type, setType] = useState<CaseType>('cardiac')
  const [severity, setSeverity] = useState<Severity>(1)
  const [patients, setPatients] = useState(1)
  const [needsIcu, setNeedsIcu] = useState(false)
  const [pos, setPos] = useState<LatLng | null>(null)
  const [source, setSource] = useState<'gps' | 'manual'>('manual')
  const [locLabel, setLocLabel] = useState('')
  const [locating, setLocating] = useState(false)
  const [brief, setBrief] = useState('')
  const [note, setNote] = useState('')
  const [contact, setContact] = useState('')
  const [files, setFiles] = useState<LocalFile[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus(); window.scrollTo({ top: 0 }) }, [step])
  useEffect(() => { if (online) void ensureReporter().catch(() => undefined) }, [online, ensureReporter]) // sign in quietly while online so a report can still be queued if the signal drops

  const caps = requiredCapabilities(type, needsIcu)
  const canNext = step === 1 ? !!pos : true

  function locate() {
    if (!navigator.geolocation) return setError('This device cannot share its location. Tap the map or choose a place instead.')
    setLocating(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      (p) => { setLocating(false); setPos({ lat: p.coords.latitude, lng: p.coords.longitude }); setSource('gps'); setLocLabel(`Your device location, accurate to about ${Math.round(p.coords.accuracy)} m`) },
      (e) => { setLocating(false); setError(e.code === 1 ? 'Location permission was denied. Tap the map to place the emergency instead.' : 'Could not get a location fix. Tap the map to place the emergency instead.') },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 },
    )
  }

  async function submit() {
    if (!pos) return
    setBusy(true)
    setError(null)
    try {
      const actor = await ensureReporter()
      const made = await createCaseQueued(db, actor, { type, severity, patients, needsIcu, brief: brief.trim(), contact: contact.trim(), note: note.trim(), lat: pos.lat, lng: pos.lng, locationSource: source, evidenceExpected: files.length })
      saveReceipt({ caseId: made.id, receipt: made.receipt, createdAtMs: Date.now(), label: CASE_TYPES[type].label })
      const role = actor.role === 'dispatcher' ? 'dispatcher' : 'reporter'
      for (const f of files) {
        await uploadQueue.add({ id: newId(), caseId: made.id, uid: actor.uid, role, evidenceId: newId(), name: f.file.name, mime: f.mime, kind: f.kind, size: f.file.size, origin: f.origin }, f.file)
      }
      files.forEach((f) => URL.revokeObjectURL(f.previewUrl))
      made.done.then(() => void uploadQueue.process()).catch((e: Error) => notify(`The report could not be saved: ${e.message}`, 'bad'))
      notify(online ? 'Report sent. Dispatch can see it now.' : 'Saved on this device only. It has NOT been sent, and will send when you are back online.', online ? 'good' : 'warn')
      if (onSent) onSent(made.id)
      onCreated(made)
    } catch (e) {
      setError(`Could not send the report: ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  return (
    <div className="page--narrow" style={{ width: '100%', margin: '0 auto' }}>
      <div className="stack-lg">
        <nav aria-label="Progress"><ol className="steps">{STEPS.map((s, i) => <li key={s} className={`step ${i < step ? 'done' : ''} ${i === step ? 'now' : ''}`} aria-current={i === step ? 'step' : undefined}><span>{i + 1}</span> <span className="hide-sm">{s}</span></li>)}</ol></nav>
        <div className="stack">
          <h1 className="title" ref={heading} tabIndex={-1}>{STEPS[step]}</h1>
          {error && <ErrorBox>{error}</ErrorBox>}

          {step === 0 && (
            <>
              <fieldset className="field"><legend className="field-label">What is happening?</legend>
                <div className="picker" role="group">{(Object.keys(CASE_TYPES) as CaseType[]).map((k) => <button key={k} type="button" className="pick" aria-pressed={type === k} onClick={() => setType(k)}><Icon name={TYPE_ICON[k]} />{CASE_TYPES[k].label}</button>)}</div>
              </fieldset>
              <fieldset className="field"><legend className="field-label">How is the patient?</legend>
                <div className="seg seg-full" role="group">{([[1, 'Critical'], [2, 'Serious'], [3, 'Stable']] as [Severity, string][]).map(([s, l]) => <button key={s} type="button" aria-pressed={severity === s} onClick={() => setSeverity(s)}>{l}</button>)}</div>
              </fieldset>
              <label className="field"><span className="field-label">How many patients?</span><input type="number" inputMode="numeric" min={1} max={50} value={patients} onChange={(e) => setPatients(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} /></label>
              <Switch checked={needsIcu} onChange={setNeedsIcu} label="They may need intensive care" hint="Hospitals will then be asked to confirm an ICU bed as well." />
              <p className="fine">Hospitals will be asked to confirm: {caps.map((c) => c).join(' and ')}.</p>
            </>
          )}

          {step === 1 && (
            <>
              <div className="inset stack-sm">
                <div className="row row-between"><div><b>{pos ? locLabel || 'Location set' : 'Where is the emergency?'}</b>{pos && <p className="fine num">{pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}{source === 'gps' ? ', from your device' : ', placed by hand'}</p>}</div>
                  <button type="button" className="btn btn-ink" onClick={locate} disabled={locating}>{locating ? <><span className="spin" /> Locating</> : <><Icon name="pin" size={18} /> Use my location</>}</button></div>
                <p className="fine">Your location is read only when you tap that button, and is used only to place this emergency. Or tap the map, or pick a place:</p>
                <select aria-label="Pick a demo place" value="" onChange={(e) => { const p = PRESETS[Number(e.target.value)]; if (p) { setPos(p.pos); setSource('manual'); setLocLabel(p.label) } }}>
                  <option value="" disabled>Choose a demo place</option>{PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
                </select>
              </div>
              <MapView pin={pos} focus={pos ? [pos] : undefined} height={380} label="Tap to place the emergency" onPick={(p) => { setPos(p); setSource('manual'); setLocLabel('Placed on the map') }} />
            </>
          )}

          {step === 2 && (
            <>
              <label className="field"><span className="field-label">Short summary for hospitals <small>(no names or phone numbers)</small></span><input type="text" maxLength={160} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Adult man, bitten on the leg, conscious" /><span className="hint">{brief.length}/160. Hospitals that are asked see this.</span></label>
              <label className="field"><span className="field-label">More detail <small>(only dispatch, the crew and the confirmed hospital see this)</small></span><textarea maxLength={500} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Landmark, how to reach the patient, what happened" /></label>
              <label className="field"><span className="field-label">Your phone number <small>(same audience as above)</small></span><input type="tel" inputMode="tel" autoComplete="tel" maxLength={40} value={contact} onChange={(e) => setContact(e.target.value)} placeholder="+91" /></label>
              <h2 className="h">Photos, voice notes, video, documents</h2>
              <p className="sub measure">Optional. Anything that helps dispatch and the hospital understand what is happening. Files stay private to the people working on this case.</p>
              <EvidenceComposer files={files} onChange={setFiles} disabled={busy} />
            </>
          )}

          {step === 3 && (
            <>
              <dl className="summary-list">
                <div><dt>Emergency</dt><dd><b>{CASE_TYPES[type].label}</b>, {['', 'critical', 'serious', 'stable'][severity]}, {patients} patient{patients > 1 ? 's' : ''}{needsIcu ? ', may need intensive care' : ''}</dd><button className="btn btn-sm btn-quiet" onClick={() => setStep(0)}>Change</button></div>
                <div><dt>Location</dt><dd>{locLabel || 'Placed on the map'} <span className="fine num">({pos?.lat.toFixed(4)}, {pos?.lng.toFixed(4)})</span></dd><button className="btn btn-sm btn-quiet" onClick={() => setStep(1)}>Change</button></div>
                <div><dt>Summary</dt><dd>{brief || <span className="muted">None</span>}</dd><button className="btn btn-sm btn-quiet" onClick={() => setStep(2)}>Change</button></div>
                <div><dt>Private detail</dt><dd>{note || <span className="muted">None</span>}{contact && <><br />Phone {contact}</>}</dd><button className="btn btn-sm btn-quiet" onClick={() => setStep(2)}>Change</button></div>
                <div><dt>Files</dt><dd>{files.length ? <ul className="stack-sm">{files.map((f) => <li key={f.id}>{f.file.name} <span className="fine">({KIND_LABEL[f.kind]}, {formatBytes(f.file.size)})</span></li>)}</ul> : <span className="muted">None</span>}</dd><button className="btn btn-sm btn-quiet" onClick={() => setStep(2)}>Change</button></div>
              </dl>
              <Notice tone="star" title="Who will see this">Dispatch sees everything. The crew sees it once they accept. Hospitals that are asked see the summary, the location and your files, and lose access if they decline. Your phone number and private detail only go to the hospital that is chosen.</Notice>
              {!online && <Notice tone="wait" title="You are offline">Sending now saves the report on this device only. It has not reached anyone until you reconnect. Call 112 if you can.</Notice>}
            </>
          )}
        </div>
      </div>

      <div className="actionbar" style={{ position: 'sticky', marginTop: 24, borderTop: '2px solid var(--line)' }}>
        {step > 0 && <button className="btn" style={{ flex: '0 0 auto' }} onClick={() => setStep(step - 1)} disabled={busy}>Back</button>}
        {step < 3
          ? <button className="btn btn-go btn-lg" onClick={() => setStep(step + 1)} disabled={!canNext}>{step === 1 && !pos ? 'Set the location to continue' : 'Next'}</button>
          : <button className="btn btn-go btn-lg" onClick={() => void submit()} disabled={busy || !pos}>{busy ? <><span className="spin" /> Sending</> : online ? 'Send to dispatch' : 'Save on this device'}</button>}
      </div>
    </div>
  )
}
