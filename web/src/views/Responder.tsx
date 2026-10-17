import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import MapView from '../components/MapView'
import { Badge, Countdown, Empty, PosSource, SeverityBadge, StatusBadge, caseTitle } from '../components/bits'
import { CAPABILITY_LABEL, CASE_TYPES } from '../lib/capabilities'
import { agoText, estimateMinutes } from '../lib/geo'
import { db } from '../lib/firebase'
import { routePath, pointAlong, type RoutePath } from '../lib/routing'
import { useNow, usePatientPrivate } from '../lib/store'
import type { Ambulance, Case, Hospital, LatLng, TrackedPos } from '../lib/types'
import { acknowledgeAssignment, advanceStatus, reportPosition, type Actor } from '../lib/workflow'

interface Props {
  actor: Actor
  ambulance: Ambulance | undefined
  cases: Case[]
  hospitals: Hospital[]
  notify: (m: string, tone?: string) => void
}

const SIM_SPEEDUP = 30 // 30x real time so a demo does not take 20 minutes
const GPS_WRITE_EVERY_MS = 4000

const navLink = (p: LatLng) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`

function Job({ c, ambulance, hospitals, actor, notify }: { c: Case; ambulance: Ambulance; hospitals: Hospital[]; actor: Actor; notify: Props['notify'] }) {
  const now = useNow()
  const priv = usePatientPrivate(c.id, true)
  const hospital = hospitals.find((h) => h.id === c.selectedHospitalId)
  const target: (LatLng & { name: string }) | null = c.status === 'transporting' && hospital ? { ...hospital, name: hospital.name } : ['dispatched', 'enroute', 'onscene'].includes(c.status) ? { lat: c.lat, lng: c.lng, name: 'the scene' } : null
  const [mode, setMode] = useState<'idle' | 'gps' | 'sim'>('idle')
  const [busy, setBusy] = useState(false)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [route, setRoute] = useState<RoutePath | null>(null)
  const watch = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastWrite = useRef(0)
  const posRef = useRef<LatLng | null>(c.ambulancePos)
  posRef.current = c.ambulancePos

  const stop = useCallback(() => {
    if (watch.current !== null) { navigator.geolocation.clearWatch(watch.current); watch.current = null }
    if (timer.current) { clearInterval(timer.current); timer.current = null }
    setMode('idle')
  }, [])
  useEffect(() => stop, [stop])
  useEffect(() => { stop() }, [c.status, stop]) // a new leg starts with a fresh choice

  const targetKey = target ? `${target.lat},${target.lng}` : ''
  useEffect(() => {
    if (!target) { setRoute(null); return }
    const from = posRef.current ?? ambulance
    let live = true
    void routePath(from, target).then((r) => { if (live) setRoute(r) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, c.status])

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try { await fn(); if (ok) notify(ok, 'good') } catch (e) { notify((e as Error).message, 'warn') } finally { setBusy(false) }
  }

  function startGps() {
    if (!target) return
    if (!navigator.geolocation) return setGpsError('This device has no GPS. Use the demo simulation instead.')
    stop()
    setGpsError(null)
    setMode('gps')
    watch.current = navigator.geolocation.watchPosition(
      (p) => {
        const t = Date.now()
        if (t - lastWrite.current < GPS_WRITE_EVERY_MS) return
        lastWrite.current = t
        const pos: TrackedPos = { lat: p.coords.latitude, lng: p.coords.longitude, atMs: t, source: 'gps' }
        void reportPosition(db, c, pos, estimateMinutes(pos, target), 'estimate').catch(() => undefined)
      },
      (e) => { stop(); setGpsError(e.code === 1 ? 'Location permission denied. Allow location for this site, or use the demo simulation.' : 'No GPS signal. Try again outdoors or use the demo simulation.') },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 },
    )
  }

  function startSim() {
    if (!target || !route) return
    stop()
    setMode('sim')
    const seconds = Math.min(60, Math.max(20, (route.durationMin * 60) / SIM_SPEEDUP))
    const steps = Math.round(seconds / 1.5)
    let n = 0
    timer.current = setInterval(() => {
      n++
      const t = Math.min(1, n / steps)
      const p = pointAlong(route.points, t)
      const pos: TrackedPos = { lat: p.lat, lng: p.lng, atMs: Date.now(), source: 'simulated' }
      void reportPosition(db, c, pos, route.durationMin * (1 - t), route.source).catch(() => undefined)
      if (t >= 1) stop()
    }, 1500)
  }

  const lastPos = c.ambulancePos
  const dist = lastPos && target ? estimateMinutes(lastPos, target) : null
  const asked = c.notifiedHospitalIds.length

  return (
    <div className="grid two">
      <div className="stack">
        <div className="card stack">
          <div className="row between">
            <div>
              <h2 className="h">{CASE_TYPES[c.type].icon} {caseTitle(c, CASE_TYPES[c.type].label)}</h2>
              <div className="row tight"><SeverityBadge severity={c.severity} /><StatusBadge status={c.status} />{c.needsIcu && <Badge tone="violet">ICU likely</Badge>}</div>
            </div>
            <Countdown createdAtMs={c.createdAtMs} frozenAtMs={c.arrivalConfirmedAtMs} />
          </div>
          <p>“{c.brief}”</p>
          {priv && <div className="card inset"><p><b>📞 {priv.contact || 'No phone given'}</b>{priv.contact && <> · <a href={`tel:${priv.contact.replace(/[^\d+]/g, '')}`}>Call</a></>}</p>{priv.note && <p className="sub">{priv.note}</p>}</div>}
          <div className="row">
            <Badge tone="blue">Scene</Badge><span className="sub">{c.lat.toFixed(4)}, {c.lng.toFixed(4)} · {c.locationSource === 'gps' ? 'from reporter GPS' : 'placed manually'}</span>
            <a className="btn sm" href={navLink(c)} target="_blank" rel="noopener noreferrer">🧭 Navigate to scene</a>
          </div>
        </div>

        <div className="card stack" aria-live="polite">
          <div className="row between"><h3 className="h">Your steps</h3><PosSource pos={lastPos} /></div>

          {c.status === 'dispatched' && (
            <>
              <p>Dispatch has assigned you. Acknowledge to start. Hospitals are already being asked.</p>
              <button className="btn primary big" disabled={busy} onClick={() => run(() => acknowledgeAssignment(db, actor, c), 'Acknowledged')}>👍 Acknowledge and start</button>
            </>
          )}

          {(c.status === 'enroute' || c.status === 'transporting') && target && (
            <>
              <p>Heading to <b>{target.name}</b>{dist !== null ? ` · about ${dist} min away (estimate)` : ''}{lastPos ? ` · position updated ${agoText(lastPos.atMs, now)}` : ''}.</p>
              <div className="row">
                <button className={`btn ${mode === 'gps' ? 'good' : ''}`} onClick={() => (mode === 'gps' ? stop() : startGps())}>{mode === 'gps' ? '● Sharing live GPS (tap to stop)' : '📡 Share my live GPS'}</button>
                <button className={`btn violet ${mode === 'sim' ? 'on' : ''}`} disabled={!route} onClick={() => (mode === 'sim' ? stop() : startSim())}>{mode === 'sim' ? '◌ Simulating (tap to stop)' : '◌ Demo: simulate this drive'}</button>
                {c.status === 'transporting' && hospital && <a className="btn sm" href={navLink(hospital)} target="_blank" rel="noopener noreferrer">🧭 Navigate to hospital</a>}
              </div>
              <p className="sub">GPS asks for your location only when you tap. The demo simulation moves a marker along the road route and is always labelled SIMULATED to everyone else.{route && ` Route: ${route.durationMin} min (${route.source === 'road' ? 'road routing' : 'straight-line estimate'}).`}</p>
              {gpsError && <div className="err" role="alert">{gpsError}</div>}
            </>
          )}

          {c.status === 'enroute' && <button className="btn primary big" disabled={busy} onClick={() => run(() => advanceStatus(db, actor, c, lastPos), 'Marked on scene')}>📍 Arrived on scene</button>}

          {c.status === 'onscene' && (
            <>
              {hospital ? (
                <div className="selected-dest"><b>🏥 Destination: {hospital.name}</b><p className="sub">Confirmed by dispatch. {hospital.area}{hospital.phone ? ` · ${hospital.phone}` : ''}. Hospital team is preparing.</p></div>
              ) : (
                <div className="banner warn"><div><b>Waiting for dispatch to confirm a hospital</b><p>{asked} hospitals were asked. You can load the patient, but transport can start only after a destination is confirmed. Stay on this screen.</p></div></div>
              )}
              <button className="btn primary big" disabled={busy || !hospital} onClick={() => run(() => advanceStatus(db, actor, c, lastPos), 'Transporting')}>🚑 Patient loaded: depart for hospital</button>
            </>
          )}

          {c.status === 'transporting' && <button className="btn primary big" disabled={busy} onClick={() => run(() => advanceStatus(db, actor, c, lastPos), 'Arrived at hospital')}>🏁 Arrived at hospital</button>}

          {c.status === 'arrived' && <p>✅ You are at <b>{c.selectedHospitalName}</b>. Waiting for hospital and dispatch to complete the handover.</p>}
        </div>
        {c.escalation !== 'none' && <div className="banner warn">⚠️ Dispatch is working on the hospital destination: {c.escalationNote}</div>}
        {c.requiredCapabilities.length > 0 && <p className="sub">Case needs: {c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' + ')}.</p>}
      </div>
      <MapView cases={[c]} hospitals={hospital ? [hospital] : []} hospitalStates={hospital ? { [hospital.id]: 'selected' } : {}} route={route?.points}
        focus={[c, ...(lastPos ? [lastPos] : []), ...(hospital && c.status === 'transporting' ? [hospital] : [])]} height={440} label="Route and incident" />
    </div>
  )
}

export default function Responder({ actor, ambulance, cases, hospitals, notify }: Props) {
  const job = useMemo(() => cases.filter((c) => c.status !== 'closed').sort((a, b) => b.createdAtMs - a.createdAtMs)[0], [cases])
  if (!ambulance) return <Empty icon="🚑" title="Unit not found">Your account is not linked to an ambulance. Ask an administrator.</Empty>
  return (
    <div className="stack">
      <div className="row between">
        <div><h2 className="h">🚑 {ambulance.callSign}</h2><p className="sub">Base: {ambulance.base}</p></div>
        {job ? <Badge tone="amber">On a call</Badge> : <Badge tone="green">Available</Badge>}
      </div>
      {job ? <Job key={job.id} c={job} ambulance={ambulance} hospitals={hospitals} actor={actor} notify={notify} /> : <Empty icon="🟢" title="Standing by">New assignments from dispatch appear here immediately.</Empty>}
    </div>
  )
}
