import { useEffect, useRef, useState } from 'react'
import MapView from '../components/MapView'
import { StatusBadge, TYPE_META } from '../components/bits'
import { movePosition, setStatus } from '../lib/store'
import { lerp, travelMinutes } from '../lib/triage'
import type { Ambulance, Hospital, Incident, LatLng } from '../lib/types'

interface Props {
  incidents: Incident[]
  hospitals: Hospital[]
  ambulances: Ambulance[]
  notify: (m: string) => void
}

const STEPS = 12
const STEP_MS = 1200

export default function AmbulanceView({ incidents, hospitals, ambulances, notify }: Props) {
  const [aid, setAid] = useState('')
  const [driving, setDriving] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  const amb = ambulances.find((a) => a.id === aid) ?? ambulances[0]
  const job = amb ? incidents.find((i) => i.ambulanceId === amb.id && i.status !== 'closed' && i.status !== 'arrived') : undefined
  const hospital = job ? hospitals.find((h) => h.id === job.hospitalId) : undefined

  function drive(from: LatLng, to: LatLng, onDone: () => Promise<void>) {
    if (!job || !amb) return
    setDriving(true)
    let n = 0
    timer.current = setInterval(async () => {
      n++
      try {
        await movePosition(job.id, amb.id, lerp(from, to, n / STEPS))
        if (n >= STEPS) {
          clearInterval(timer.current!)
          await onDone()
          setDriving(false)
        }
      } catch (e) {
        clearInterval(timer.current!)
        setDriving(false)
        notify(`Update failed: ${(e as Error).message}`)
      }
    }, STEP_MS)
  }

  if (!amb) return <div className="card empty">Loading units…</div>
  const start = job?.ambulancePos ?? { lat: amb.lat, lng: amb.lng }

  return (
    <div className="grid two">
      <div className="stack">
        <div className="card">
          <label>Unit
            <select value={amb.id} onChange={(e) => setAid(e.target.value)} disabled={driving}>
              {ambulances.map((a) => <option key={a.id} value={a.id}>{a.callSign} · {a.available ? 'available' : 'on call'}</option>)}
            </select>
          </label>
        </div>
        {!job && <div className="card empty">No active assignment for {amb.callSign}. Dispatch an incident from the Dispatch tab.</div>}
        {job && (
          <div className="card stack">
            <div className="row between">
              <h3 className="h">{TYPE_META[job.type].icon} {TYPE_META[job.type].label} · {job.patients} patient{job.patients > 1 ? 's' : ''}</h3>
              <StatusBadge status={job.status} />
            </div>
            <p className="sub">{job.note ? `“${job.note}”` : 'No notes'}{job.contact && ` · call ${job.contact}`}</p>
            {job.status === 'dispatched' && (
              <>
                <p>Scene is ~{travelMinutes(start, job)} min away.</p>
                <button className="btn primary" disabled={driving} onClick={() => drive(start, job, () => setStatus(job, 'onscene', `${amb.callSign} arrived on scene`, job))}>
                  {driving ? 'Driving to scene…' : 'Start drive to scene (simulated)'}
                </button>
              </>
            )}
            {job.status === 'onscene' && (
              hospital ? (
                <>
                  <p>Destination: <b>{hospital.name}</b> (~{travelMinutes(job, hospital)} min). {job.alert === 'accepted' ? '✅ Hospital is ready.' : '⏳ Awaiting hospital acceptance.'}</p>
                  <button className="btn primary" disabled={driving} onClick={() => setStatus(job, 'transporting', `${amb.callSign} departed scene with patient`).then(() => drive(job, hospital, () => setStatus(job, 'arrived', `${amb.callSign} arrived at ${hospital.name}`, hospital)))}>
                    {driving ? 'Transporting…' : 'Load patient & transport (simulated)'}
                  </button>
                </>
              ) : <div className="err">Hospital declined or not set. Waiting for dispatch to re-route.</div>
            )}
            {job.status === 'transporting' && hospital && <p>Transporting to <b>{hospital.name}</b>…</p>}
          </div>
        )}
        <p className="sub">Driving is simulated for the demo: the unit moves along a straight line and live position updates stream to every other screen.</p>
      </div>
      <MapView
        incidents={job ? [job] : []}
        hospitals={hospital ? [hospital] : hospitals}
        ambulances={ambulances.filter((a) => a.id === amb.id)}
        focus={job ? [job, start, ...(hospital ? [hospital] : [])] : [{ lat: amb.lat, lng: amb.lng }]}
        height={460}
      />
    </div>
  )
}
