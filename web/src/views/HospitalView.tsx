import { useState } from 'react'
import { Countdown, StatusBadge, TYPE_META } from '../components/bits'
import { respondToAlert, setBeds, setDiverted, setStatus } from '../lib/store'
import { REQUIRED_CAPABILITY, travelMinutes } from '../lib/triage'
import type { Hospital, Incident } from '../lib/types'

interface Props {
  incidents: Incident[]
  hospitals: Hospital[]
  notify: (m: string) => void
}

export default function HospitalView({ incidents, hospitals, notify }: Props) {
  const [hid, setHid] = useState('')
  const hospital = hospitals.find((h) => h.id === hid) ?? hospitals[0]
  if (!hospital) return <div className="card empty">Loading hospitals…</div>

  const incoming = incidents.filter((i) => i.hospitalId === hospital.id && i.status !== 'closed')
  const guard = async (fn: () => Promise<void>) => {
    try { await fn() } catch (e) { notify(`Action failed: ${(e as Error).message}`) }
  }

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="card stack">
        <label>Hospital
          <select value={hospital.id} onChange={(e) => setHid(e.target.value)}>
            {hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        </label>
        <div className="row between">
          <div>
            <p className="sub">Emergency beds</p>
            <div className="stepper">
              <button className="btn sm" aria-label="Decrease beds" onClick={() => guard(() => setBeds(hospital.id, hospital.emergencyBeds - 1))}>−</button>
              <b>{hospital.emergencyBeds}</b>
              <button className="btn sm" aria-label="Increase beds" onClick={() => guard(() => setBeds(hospital.id, hospital.emergencyBeds + 1))}>+</button>
            </div>
          </div>
          <button className={`btn ${hospital.diverted ? 'warn' : ''}`} onClick={() => guard(() => setDiverted(hospital.id, !hospital.diverted))}>
            {hospital.diverted ? 'On diversion - tap to reopen' : 'Open - tap to divert'}
          </button>
        </div>
        <div className="row">{hospital.capabilities.map((c) => <span key={c} className="badge">{c}</span>)}</div>
      </div>

      <h2 className="h">Incoming patients ({incoming.length})</h2>
      {!incoming.length && <div className="card empty">No inbound ambulances. Alerts from dispatch appear here the moment they are sent.</div>}
      {incoming.map((i) => {
        const t = TYPE_META[i.type]
        const eta = i.ambulancePos ? travelMinutes(i.ambulancePos, hospital) : null
        return (
          <div key={i.id} className="card" style={{ borderColor: i.alert === 'pending' ? 'var(--amber)' : undefined }}>
            <div className="row between">
              <div>
                <h3 className="h">{t.icon} {t.label} · {i.patients} patient{i.patients > 1 ? 's' : ''}</h3>
                <div className="row" style={{ marginTop: 6 }}>
                  <span className={`badge ${i.severity === 1 ? 'red' : i.severity === 2 ? 'amber' : 'green'}`}>{['', 'Critical', 'Serious', 'Stable'][i.severity]}</span>
                  <StatusBadge status={i.status} />
                  {eta !== null && i.status !== 'arrived' && <span className="badge blue">ETA ~{eta} min</span>}
                </div>
              </div>
              <div style={{ minWidth: 110 }}><Countdown incident={i} /></div>
            </div>
            <div className="card" style={{ background: 'var(--bg)', marginTop: 12 }}>
              <p className="sub">Pre-arrival brief</p>
              <p style={{ marginTop: 4 }}>Prepare <b>{REQUIRED_CAPABILITY[i.type]}</b> team. {i.note ? `Notes: “${i.note}”.` : 'No additional notes.'}</p>
            </div>
            {i.alert === 'pending' && (
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn good" onClick={() => guard(() => respondToAlert(i, hospital, true))}>Accept &amp; prepare</button>
                <button className="btn warn" onClick={() => guard(() => respondToAlert(i, hospital, false))}>Decline (re-route)</button>
              </div>
            )}
            {i.alert === 'accepted' && i.status === 'arrived' && (
              <div className="row" style={{ marginTop: 12 }}>
                <span className="badge green">Patient arrived</span>
                <button className="btn sm" onClick={() => guard(async () => { await setBeds(hospital.id, hospital.emergencyBeds - 1); await setStatus(i, 'arrived', `${hospital.name} admitted the patient`); notify('Admitted; bed count updated') })}>Admit (−1 bed)</button>
              </div>
            )}
            {i.alert === 'accepted' && i.status !== 'arrived' && <p className="sub" style={{ marginTop: 10 }}>✅ You accepted this patient. Team preparing.</p>}
          </div>
        )
      })}
    </div>
  )
}
