import { useEffect, useState } from 'react'
import MapView from '../components/MapView'
import { Badge, Countdown, Empty, ErrorBox, PosSource, StatusBadge, caseTitle } from '../components/bits'
import { CASE_TYPES } from '../lib/capabilities'
import { useAuth } from '../lib/auth'
import { db } from '../lib/firebase'
import { requiredCapabilities } from '../lib/capabilities'
import type { Case, CaseType, LatLng, Severity } from '../lib/types'
import { createCaseQueued } from '../lib/workflow'

const PRESETS: { label: string; pos: LatLng }[] = [
  { label: 'Hampankatta junction', pos: { lat: 12.8704, lng: 74.8419 } },
  { label: 'Bajpe airport road', pos: { lat: 12.9613, lng: 74.8907 } },
  { label: 'Surathkal, NH66', pos: { lat: 12.9869, lng: 74.8005 } },
  { label: 'Kankanady', pos: { lat: 12.8684, lng: 74.8575 } },
]

interface Props {
  cases: Case[]
  myId: string | null
  setMyId: (id: string | null) => void
  notify: (m: string, tone?: string) => void
  online: boolean
  /** Dispatcher logging a phoned-in call: report on someone's behalf, then return to the console. */
  onSent?: (id: string) => void
}

function Tracking({ c, onNew }: { c: Case; onNew: () => void }) {
  const t = CASE_TYPES[c.type]
  return (
    <div className="grid two">
      <div className="stack">
        <div className="card stack">
          <div className="row between">
            <div>
              <h2 className="h">{t.icon} {caseTitle(c, t.label)}</h2>
              <p className="sub">Stay with the patient. Keep your phone nearby and your line free.</p>
            </div>
            <StatusBadge status={c.status} />
          </div>
          <Countdown createdAtMs={c.createdAtMs} frozenAtMs={c.status === 'closed' ? c.closedAtMs : undefined} />
          <ol className="steps" aria-label="Progress">
            {[
              ['reported', 'Reported'], ['dispatched', 'Ambulance assigned'], ['enroute', 'On the way'], ['onscene', 'At the scene'], ['transporting', 'To hospital'], ['arrived', 'Arrived'],
            ].map(([s, label], i, all) => {
              const order = ['reported', 'dispatched', 'enroute', 'onscene', 'transporting', 'arrived', 'closed']
              const done = order.indexOf(c.status) >= order.indexOf(s)
              return <li key={s} className={done ? 'done' : ''} aria-current={c.status === s ? 'step' : undefined}><i /><span>{label}</span>{i < all.length - 1 && <u />}</li>
            })}
          </ol>
          <div className="row">
            {c.ambulanceCallSign ? <Badge tone="blue">🚑 {c.ambulanceCallSign}</Badge> : <Badge tone="amber">Finding an ambulance…</Badge>}
            {c.ambulancePos && <PosSource pos={c.ambulancePos} />}
            {c.etaSceneMin !== null && c.status !== 'onscene' && ['dispatched', 'enroute'].includes(c.status) && <Badge tone="blue">Arrives in ~{c.etaSceneMin} min{c.etaSource === 'estimate' ? ' (estimate)' : ''}</Badge>}
            {c.selectedHospitalName ? <Badge tone="green">🏥 {c.selectedHospitalName} is ready</Badge> : c.status !== 'reported' && <Badge tone="amber">Confirming hospital…</Badge>}
          </div>
        </div>
        <button className="btn" onClick={onNew}>Report another emergency</button>
      </div>
      <MapView cases={[c]} focus={[c, ...(c.ambulancePos ? [c.ambulancePos] : [])]} height={420} label="Ambulance and incident location" />
    </div>
  )
}

export default function Reporter({ cases, myId, setMyId, notify, online, onSent }: Props) {
  const { ensureReporter } = useAuth()
  const [type, setType] = useState<CaseType>('cardiac')
  const [severity, setSeverity] = useState<Severity>(1)
  const [patients, setPatients] = useState(1)
  const [needsIcu, setNeedsIcu] = useState(false)
  const [brief, setBrief] = useState('')
  const [note, setNote] = useState('')
  const [contact, setContact] = useState('')
  const [pos, setPos] = useState<LatLng | null>(null)
  const [source, setSource] = useState<'gps' | 'manual'>('manual')
  const [locLabel, setLocLabel] = useState('Location not set')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Create the anonymous session as soon as the form opens (while online), so a report can still be queued if the signal drops later.
  useEffect(() => { if (online) void ensureReporter().catch(() => undefined) }, [online, ensureReporter])

  const mine = onSent ? undefined : cases.find((c) => c.id === myId)
  if (mine) return <Tracking c={mine} onNew={() => setMyId(null)} />
  if (myId && !mine && !onSent) return <Empty icon="📡" title="Report sent">Your emergency is saved on this device and will appear here the moment it reaches dispatch.<br /><button className="btn" style={{ marginTop: 12 }} onClick={() => setMyId(null)}>Start a new report</button></Empty>

  function locate() {
    if (!navigator.geolocation) return setError('This device cannot provide GPS. Tap the map or pick a location.')
    setLocLabel('Asking for permission…')
    navigator.geolocation.getCurrentPosition(
      (p) => { setPos({ lat: p.coords.latitude, lng: p.coords.longitude }); setSource('gps'); setLocLabel(`Real GPS fix (±${Math.round(p.coords.accuracy)} m)`) },
      (e) => { setLocLabel('Location not set'); setError(e.code === 1 ? 'Location permission was denied. Tap the map to place the emergency instead.' : 'Could not get a GPS fix. Tap the map to place the emergency instead.') },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 },
    )
  }

  async function submit() {
    if (!pos) return setError('Set the emergency location first.')
    setBusy(true)
    setError(null)
    try {
      const actor = await ensureReporter()
      const q = createCaseQueued(db, actor, { type, severity, patients, needsIcu, brief: brief.trim(), contact: contact.trim(), note: note.trim(), lat: pos.lat, lng: pos.lng, locationSource: source })
      if (onSent) { onSent(q.id); notify('Call logged. It is in the queue.', 'good'); q.done.catch((e: Error) => notify(`Could not save: ${e.message}`, 'warn')); return }
      setMyId(q.id)
      if (online) { await Promise.race([q.done, new Promise((r) => setTimeout(r, 6000))]); notify('Help requested. Dispatch has been alerted.', 'good') }
      else notify('You are offline. The report is saved and will send automatically when you reconnect. Call 112 if you can.', 'warn')
      q.done.catch((e: Error) => { setMyId(null); setError(`Could not send: ${e.message}`) })
    } catch (e) {
      setError(`Could not send the report: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid two">
      <div className="card stack">
        <div>
          <h2 className="h">Request emergency help</h2>
          <p className="sub">Takes under a minute. In a real emergency in India also call <b>112</b>.</p>
        </div>
        {error && <ErrorBox>{error}</ErrorBox>}
        <fieldset className="field">
          <legend>What is happening?</legend>
          <div className="chips">
            {(Object.keys(CASE_TYPES) as CaseType[]).map((t) => (
              <button key={t} type="button" className="chip" aria-pressed={type === t} onClick={() => setType(t)}><span aria-hidden>{CASE_TYPES[t].icon}</span>{CASE_TYPES[t].label}</button>
            ))}
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>Condition</legend>
          <div className="seg">
            {([[1, 'Critical'], [2, 'Serious'], [3, 'Stable']] as [Severity, string][]).map(([s, l]) => (
              <button key={s} type="button" className="chip" aria-pressed={severity === s} onClick={() => setSeverity(s)}>{l}</button>
            ))}
          </div>
        </fieldset>
        <div className="row">
          <label style={{ flex: 1 }}>Patients<input type="number" inputMode="numeric" min={1} max={50} value={patients} onChange={(e) => setPatients(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} /></label>
          <label className="check" style={{ flex: 2 }}><input type="checkbox" checked={needsIcu} onChange={(e) => setNeedsIcu(e.target.checked)} />Looks like they will need intensive care ({requiredCapabilities(type, true).length > 1 ? 'asks hospitals to confirm an ICU bed' : ''})</label>
        </div>
        <label>Short summary for hospitals <small>(no names or phone numbers)</small>
          <input maxLength={160} placeholder="e.g. Adult male, chest pain, conscious" value={brief} onChange={(e) => setBrief(e.target.value)} />
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>Your phone <small>(shared with dispatch and crew only)</small><input type="tel" inputMode="tel" autoComplete="tel" maxLength={40} placeholder="+91…" value={contact} onChange={(e) => setContact(e.target.value)} /></label>
        </div>
        <label>Extra details <small>(private to dispatch and crew)</small><textarea rows={2} maxLength={500} placeholder="Landmark, how to reach the patient…" value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="card inset stack">
          <div className="row between">
            <div><b>📍 {locLabel}</b>{pos && <p className="sub">{pos.lat.toFixed(4)}, {pos.lng.toFixed(4)} · {source === 'gps' ? 'from your device GPS' : 'placed manually'}</p>}</div>
            <button type="button" className="btn sm" onClick={locate}>Use my GPS</button>
          </div>
          <p className="sub">GPS is only used when you tap the button, and only to place this emergency. Or tap the map, or:</p>
          <select aria-label="Pick a demo location" value="" onChange={(e) => { const p = PRESETS[Number(e.target.value)]; if (p) { setPos(p.pos); setSource('manual'); setLocLabel(p.label) } }}>
            <option value="" disabled>Choose a demo location</option>
            {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
          </select>
        </div>
        <button className="btn primary sos" disabled={busy || !pos} onClick={submit}>{busy ? 'Sending…' : '🚨 Send SOS'}</button>
        {!online && <p className="sub">Offline: your report will be saved on this device and sent when you reconnect.</p>}
      </div>
      <MapView pin={pos} focus={pos ? [pos] : undefined} height={460} label="Tap to place the emergency" onPick={(p) => { setPos(p); setSource('manual'); setLocLabel('Placed on map') }} />
    </div>
  )
}
