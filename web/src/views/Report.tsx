import { useState } from 'react'
import MapView from '../components/MapView'
import { Countdown, StatusBadge, Timeline, TYPE_META } from '../components/bits'
import { reportIncident } from '../lib/store'
import type { Ambulance, EmergencyType, Hospital, Incident, LatLng, Severity } from '../lib/types'

const PRESETS: { label: string; pos: LatLng }[] = [
  { label: 'Hampankatta junction', pos: { lat: 12.8704, lng: 74.8419 } },
  { label: 'Mangalore Airport road, Bajpe', pos: { lat: 12.9613, lng: 74.8907 } },
  { label: 'Surathkal NH66', pos: { lat: 12.9869, lng: 74.8005 } },
  { label: 'Kankanady', pos: { lat: 12.8684, lng: 74.8575 } },
]

interface Props {
  incidents: Incident[]
  hospitals: Hospital[]
  ambulances: Ambulance[]
  myId: string | null
  setMyId: (id: string | null) => void
  notify: (m: string) => void
}

export default function Report({ incidents, hospitals, ambulances, myId, setMyId, notify }: Props) {
  const [type, setType] = useState<EmergencyType>('cardiac')
  const [severity, setSeverity] = useState<Severity>(1)
  const [patients, setPatients] = useState(1)
  const [note, setNote] = useState('')
  const [contact, setContact] = useState('')
  const [pos, setPos] = useState<LatLng | null>(null)
  const [locLabel, setLocLabel] = useState('Location not set')
  const [busy, setBusy] = useState(false)

  const mine = incidents.find((i) => i.id === myId)

  function locate() {
    if (!navigator.geolocation) return notify('Geolocation unavailable - pick a preset location')
    setLocLabel('Locating…')
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPos({ lat: p.coords.latitude, lng: p.coords.longitude })
        setLocLabel(`GPS fix (±${Math.round(p.coords.accuracy)} m)`)
      },
      () => {
        setLocLabel('Location not set')
        notify('Could not get GPS - choose a preset location instead')
      },
      { enableHighAccuracy: true, timeout: 8000 },
    )
  }

  async function submit() {
    if (!pos) return notify('Set your location first')
    setBusy(true)
    try {
      const id = await reportIncident({ type, severity, patients, note: note.trim().slice(0, 500), contact: contact.trim().slice(0, 40), ...pos })
      setMyId(id)
      notify('Help requested. Dispatch has been notified.')
    } catch (e) {
      notify(`Could not send report: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (mine) {
    const h = hospitals.find((x) => x.id === mine.hospitalId)
    const a = ambulances.find((x) => x.id === mine.ambulanceId)
    return (
      <div className="grid two">
        <div className="stack">
          <div className="card">
            <div className="row between">
              <div>
                <h2 className="h">{TYPE_META[mine.type].icon} {TYPE_META[mine.type].label} emergency</h2>
                <p className="sub">Stay calm. Keep the patient still and your phone nearby.</p>
              </div>
              <StatusBadge status={mine.status} />
            </div>
            <div style={{ marginTop: 14 }}>
              <p className="sub">Golden hour</p>
              <Countdown incident={mine} />
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <span className="badge blue">{a ? `🚑 ${a.callSign}` : 'Finding ambulance…'}</span>
              <span className={`badge ${h ? 'green' : 'amber'}`}>{h ? `🏥 ${h.name}` : 'Selecting hospital…'}</span>
            </div>
          </div>
          <div className="card">
            <h3 className="h">Live updates</h3>
            <div style={{ marginTop: 10 }}><Timeline items={mine.timeline} /></div>
          </div>
          <button className="btn" onClick={() => setMyId(null)}>Report another emergency</button>
        </div>
        <MapView incidents={[mine]} hospitals={h ? [h] : []} focus={[mine, ...(mine.ambulancePos ? [mine.ambulancePos] : []), ...(h ? [h] : [])]} height={420} />
      </div>
    )
  }

  return (
    <div className="grid two">
      <div className="card stack">
        <div>
          <h2 className="h">Request emergency help</h2>
          <p className="sub">Takes under 10 seconds. In a real emergency in India also dial 112.</p>
        </div>
        <label>What is happening?
          <div className="chips" role="group" aria-label="Emergency type">
            {(Object.keys(TYPE_META) as EmergencyType[]).map((t) => (
              <button key={t} type="button" className="chip" aria-pressed={type === t} onClick={() => setType(t)}>
                <span>{TYPE_META[t].icon}</span>{TYPE_META[t].label}
              </button>
            ))}
          </div>
        </label>
        <label>Condition
          <div className="seg" role="group" aria-label="Severity">
            {([[1, 'Critical'], [2, 'Serious'], [3, 'Stable']] as [Severity, string][]).map(([s, l]) => (
              <button key={s} type="button" className="chip" aria-pressed={severity === s} onClick={() => setSeverity(s)}>{l}</button>
            ))}
          </div>
        </label>
        <div className="row">
          <label style={{ flex: 1 }}>Patients
            <input type="number" min={1} max={20} value={patients} onChange={(e) => setPatients(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
          </label>
          <label style={{ flex: 2 }}>Your phone (optional)
            <input type="tel" inputMode="tel" maxLength={40} placeholder="+91…" value={contact} onChange={(e) => setContact(e.target.value)} />
          </label>
        </div>
        <label>Details (optional)
          <textarea rows={2} maxLength={500} placeholder="Age, symptoms, landmark…" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="card" style={{ background: 'var(--bg)' }}>
          <div className="row between">
            <div><b>📍 {locLabel}</b>{pos && <p className="sub">{pos.lat.toFixed(4)}, {pos.lng.toFixed(4)}</p>}</div>
            <button type="button" className="btn sm" onClick={locate}>Use my GPS</button>
          </div>
          <label style={{ marginTop: 10 }}>…or pick a demo location
            <select
              value=""
              onChange={(e) => {
                const p = PRESETS[Number(e.target.value)]
                if (p) { setPos(p.pos); setLocLabel(p.label) }
              }}
            >
              <option value="" disabled>Choose a location</option>
              {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
            </select>
          </label>
        </div>
        <button className="btn primary sos" disabled={busy || !pos} onClick={submit}>{busy ? 'Sending…' : '🚨 Send SOS'}</button>
      </div>
      <MapView incidents={incidents.filter((i) => i.id === myId)} hospitals={hospitals} focus={pos ? [pos] : undefined} height={420} />
    </div>
  )
}
