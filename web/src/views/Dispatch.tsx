import { useState } from 'react'
import MapView from '../components/MapView'
import { Countdown, StatusBadge, Timeline, TYPE_META } from '../components/bits'
import { dispatch, releaseAmbulance, setStatus } from '../lib/store'
import { rankHospitals } from '../lib/triage'
import type { Ambulance, Hospital, Incident } from '../lib/types'

interface Props {
  incidents: Incident[]
  hospitals: Hospital[]
  ambulances: Ambulance[]
  notify: (m: string) => void
}

function IncidentCard({ inc, hospitals, ambulances, notify }: { inc: Incident } & Omit<Props, 'incidents'>) {
  const [pick, setPick] = useState('')
  const ranked = rankHospitals(inc, hospitals)
  const hospital = hospitals.find((h) => h.id === inc.hospitalId)
  const amb = ambulances.find((a) => a.id === inc.ambulanceId)
  const needsHospital = inc.status !== 'reported' && !inc.hospitalId && inc.status !== 'closed'
  const t = TYPE_META[inc.type]

  const run = async (fn: () => Promise<string | void>) => {
    try {
      const m = await fn()
      if (m) notify(m)
    } catch (e) {
      notify(`Action failed: ${(e as Error).message}`)
    }
  }

  return (
    <div className="card">
      <div className="row between">
        <div>
          <h3 className="h">{t.icon} {t.label} · {inc.patients} patient{inc.patients > 1 ? 's' : ''}</h3>
          <div className="row" style={{ marginTop: 6 }}>
            <span className={`badge ${inc.severity === 1 ? 'red' : inc.severity === 2 ? 'amber' : 'green'}`}>{['', 'Critical', 'Serious', 'Stable'][inc.severity]}</span>
            <StatusBadge status={inc.status} />
            {inc.alert === 'pending' && <span className="badge amber">Awaiting hospital</span>}
            {inc.alert === 'accepted' && <span className="badge green">Hospital ready</span>}
          </div>
        </div>
        {inc.status !== 'closed' && <div style={{ minWidth: 120 }}><Countdown incident={inc} /></div>}
      </div>
      {inc.note && <p className="sub" style={{ marginTop: 10 }}>“{inc.note}”{inc.contact && ` · ${inc.contact}`}</p>}

      {(inc.status === 'reported' || needsHospital) && (
        <div className="stack" style={{ marginTop: 12 }}>
          <p className="sub">Recommended hospitals (capability, beds, travel time)</p>
          {ranked.slice(0, 3).map((r, i) => (
            <div key={r.hospital.id} className={`rank ${i === 0 && r.capable ? 'best' : ''}`}>
              <b>{r.hospital.name}</b><span>{r.etaMin} min · {r.distanceKm} km</span>
              <span className="sub">{r.reason}</span><span />
            </div>
          ))}
          {!ranked.length && <div className="err">No hospital available - all diverted or declined.</div>}
          <div className="row">
            <button className="btn primary" disabled={!ranked.length} onClick={() => run(() => dispatch(inc, hospitals, ambulances))}>
              {needsHospital ? 'Re-route to best hospital' : 'Dispatch ambulance + alert hospital'}
            </button>
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Choose hospital manually" style={{ flex: 1, minWidth: 140 }}>
              <option value="">Auto-select</option>
              {ranked.map((r) => <option key={r.hospital.id} value={r.hospital.id}>{r.hospital.name}</option>)}
            </select>
            {pick && <button className="btn sm" onClick={() => run(() => dispatch(inc, hospitals, ambulances, pick))}>Send to selected</button>}
          </div>
        </div>
      )}

      {(amb || hospital) && inc.status !== 'closed' && (
        <div className="row" style={{ marginTop: 12 }}>
          {amb && <span className="badge blue">🚑 {amb.callSign}</span>}
          {hospital && <span className="badge green">🏥 {hospital.name}</span>}
        </div>
      )}

      {inc.status === 'arrived' && (
        <button
          className="btn good" style={{ marginTop: 12 }}
          onClick={() => run(async () => {
            await setStatus(inc, 'closed', 'Case handed over and closed by dispatch')
            if (inc.ambulanceId) await releaseAmbulance(inc.ambulanceId)
            return 'Case closed; ambulance released'
          })}
        >Close case &amp; release ambulance</button>
      )}
      <details style={{ marginTop: 12 }}>
        <summary className="sub" style={{ cursor: 'pointer' }}>Timeline</summary>
        <div style={{ marginTop: 8 }}><Timeline items={inc.timeline} /></div>
      </details>
    </div>
  )
}

export default function Dispatch({ incidents, hospitals, ambulances, notify }: Props) {
  const active = incidents.filter((i) => i.status !== 'closed').sort((a, b) => a.severity - b.severity || a.createdAtMs - b.createdAtMs)
  const closed = incidents.filter((i) => i.status === 'closed').sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 3)
  const free = ambulances.filter((a) => a.available).length
  return (
    <div className="grid two">
      <div className="stack">
        <div className="row">
          <span className="badge red">{active.length} active</span>
          <span className="badge blue">{free}/{ambulances.length} ambulances free</span>
          <span className="badge green">{hospitals.filter((h) => !h.diverted).length}/{hospitals.length} hospitals open</span>
        </div>
        {!active.length && <div className="card empty">No active emergencies. Reports from the Report tab appear here instantly.</div>}
        {active.map((i) => <IncidentCard key={i.id} inc={i} hospitals={hospitals} ambulances={ambulances} notify={notify} />)}
        {closed.length > 0 && (
          <div className="card">
            <h3 className="h">Recently closed</h3>
            <p className="sub" style={{ marginTop: 6 }}>
              {closed.map((c) => `${TYPE_META[c.type].label} (${Math.round(((c.timeline.at(-2)?.atMs ?? c.createdAtMs) - c.createdAtMs) / 60000)} min to hospital)`).join(' · ')}
            </p>
          </div>
        )}
      </div>
      <div style={{ position: 'sticky', top: 12 }}>
        <MapView incidents={incidents} hospitals={hospitals} ambulances={ambulances} height={520} />
        <p className="sub" style={{ marginTop: 8 }}>🔴 incident · 🟢 hospital · 🔵 ambulance</p>
      </div>
    </div>
  )
}
