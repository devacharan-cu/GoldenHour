import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HandoffCard } from '../components/AiPanels'
import { EvidenceGallery } from '../components/Evidence'
import MapView from '../components/MapView'
import { Elapsed, Empty, GoldenRing, Icon, Notice, Panel, Pill, PosSource, RelayTrack, SeverityTag, StatusPill, TYPE_ICON, type Notify } from '../components/ui'
import { CAPABILITY_LABEL, CASE_TYPES } from '../lib/capabilities'
import { agoText, distanceKm, estimateMinutes } from '../lib/geo'
import { db } from '../lib/firebase'
import { pointAlong, routePath, type RoutePath } from '../lib/routing'
import { useEvidence, useNow, usePatientPrivate } from '../lib/store'
import type { Ambulance, Case, Hospital, LatLng, TrackedPos } from '../lib/types'
import { acknowledgeDestination, advanceStatus, crewAccept, crewDecline, reportPosition, type Actor } from '../lib/workflow'

interface Props {
  actor: Actor
  ambulance: Ambulance | undefined
  cases: Case[]
  hospitals: Hospital[]
  notify: Notify
}

const SIM_SPEEDUP = 30 // 30x real time so a demonstration does not take twenty minutes
const GPS_WRITE_EVERY_MS = 4000
const DECLINE_REASONS = ['Already on another call', 'Vehicle or equipment fault', 'Crew unavailable', 'Too far from the scene', 'Other'] as const
const navLink = (p: LatLng) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`
const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function Mission({ c, ambulance, hospitals, actor, notify }: { c: Case; ambulance: Ambulance; hospitals: Hospital[]; actor: Actor; notify: Notify }) {
  const now = useNow()
  const evidence = useEvidence(c.id)
  const accepted = c.status !== 'dispatched'
  const priv = usePatientPrivate(c.id, accepted)
  const hospital = hospitals.find((h) => h.id === c.selectedHospitalId)
  const target: (LatLng & { name: string }) | null = c.status === 'transporting' && hospital ? { ...hospital, name: hospital.name } : ['enroute', 'onscene'].includes(c.status) ? { lat: c.lat, lng: c.lng, name: 'the scene' } : null
  const [mode, setMode] = useState<'idle' | 'gps' | 'sim'>('idle')
  const [busy, setBusy] = useState(false)
  const [gpsError, setGpsError] = useState<string | null>(null)
  const [route, setRoute] = useState<RoutePath | null>(null)
  const [declining, setDeclining] = useState(false)
  const [why, setWhy] = useState<string>(DECLINE_REASONS[0])
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
  useEffect(() => { stop() }, [c.status, stop]) // each leg of the journey starts with a fresh choice

  const targetKey = target ? `${target.lat},${target.lng}` : ''
  useEffect(() => {
    if (!target) { setRoute(null); return }
    let live = true
    void routePath(posRef.current ?? ambulance, target).then((r) => { if (live) setRoute(r) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, c.status])

  const run = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) notify(ok, 'good') } catch (e) { notify((e as Error).message, 'warn') } finally { setBusy(false) } }

  function startGps() {
    if (!target) return
    if (!navigator.geolocation) return setGpsError('This device has no GPS. Use the demonstration drive instead.')
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
      (e) => { stop(); setGpsError(e.code === 1 ? 'Location permission was denied. Allow location for this site, or use the demonstration drive.' : 'No GPS signal. Try again in the open, or use the demonstration drive.') },
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
      void reportPosition(db, c, { lat: p.lat, lng: p.lng, atMs: Date.now(), source: 'simulated' }, route.durationMin * (1 - t), route.source).catch(() => undefined)
      if (t >= 1) stop()
    }, 1500)
  }

  const lastPos = c.ambulancePos
  const minutesAway = lastPos && target ? estimateMinutes(lastPos, target) : null
  const sceneKm = Math.round(distanceKm(ambulance, c) * 10) / 10
  const eta = c.status === 'enroute' && c.etaSceneMin !== null ? c.etaSceneMin : minutesAway

  const drive = target && (c.status === 'enroute' || c.status === 'transporting') && (
    <Panel title={`Heading to ${target.name}`}>
      <div className="row row-between"><div><div className="mission-eta num">{eta ?? '?'}<span className="h" style={{ fontSize: '1.2rem' }}> min</span></div><p className="fine">{c.etaSource === 'road' && c.status === 'enroute' ? 'Road routing estimate' : 'Straight-line estimate'}{lastPos ? `, position updated ${agoText(lastPos.atMs, now)}` : ''}</p></div><PosSource pos={lastPos} /></div>
      <div className="row">
        <a className="btn btn-ink" href={navLink(target)} target="_blank" rel="noopener noreferrer"><Icon name="nav" size={18} /> Open navigation</a>
        <button className={`btn ${mode === 'gps' ? 'btn-go' : ''}`} onClick={() => (mode === 'gps' ? stop() : startGps())}>{mode === 'gps' ? 'Sharing live GPS: tap to stop' : <><Icon name="pin" size={18} /> Share my live GPS</>}</button>
        <button className="btn" disabled={!route} onClick={() => (mode === 'sim' ? stop() : startSim())}>{mode === 'sim' ? 'Simulating: tap to stop' : 'Demo: simulate this drive'}</button>
      </div>
      <p className="fine measure">GPS asks for your location only when you tap, and the screens of everyone watching are marked Live GPS. The demonstration drive moves a marker along the road route and is marked Simulated everywhere.{route ? ` Route: ${route.durationMin} min (${route.source === 'road' ? 'road routing' : 'straight-line estimate'}).` : ''}</p>
      {gpsError && <Notice tone="signal" title="GPS is not available">{gpsError}</Notice>}
    </Panel>
  )

  // The one thing to do next, pinned to the bottom of the screen
  let primary: React.ReactNode = null
  if (c.status === 'dispatched') {
    primary = declining ? null : (
      <>
        <button className="btn btn-lg" style={{ flex: '0 0 auto' }} onClick={() => setDeclining(true)} disabled={busy}>Decline</button>
        <button className="btn btn-go btn-lg bigaction" disabled={busy} onClick={() => run(() => crewAccept(db, actor, c), 'Accepted. Head to the scene.')}>{busy ? <span className="spin" /> : <><Icon name="check" /> Accept this dispatch</>}</button>
      </>
    )
  } else if (c.status === 'enroute') {
    primary = <button className="btn btn-go btn-lg bigaction" disabled={busy} onClick={() => run(() => advanceStatus(db, actor, c, lastPos), 'Marked on scene.')}><Icon name="pin" /> I am at the scene</button>
  } else if (c.status === 'onscene') {
    primary = !c.selectedHospitalId
      ? <button className="btn btn-lg bigaction" disabled>Waiting for a confirmed hospital</button>
      : !c.destinationAckAtMs
        ? <button className="btn btn-go btn-lg bigaction" disabled={busy} onClick={() => run(() => acknowledgeDestination(db, actor, c), 'Destination acknowledged.')}><Icon name="check" /> Acknowledge {hospital?.name ?? c.selectedHospitalName}</button>
        : <button className="btn btn-go btn-lg bigaction" disabled={busy} onClick={() => run(() => advanceStatus(db, actor, c, lastPos), 'Patient picked up. Heading to the hospital.')}><Icon name="ambulance" /> Patient picked up, leave for hospital</button>
  } else if (c.status === 'transporting') {
    primary = <button className="btn btn-go btn-lg bigaction" disabled={busy} onClick={() => run(() => advanceStatus(db, actor, c, lastPos), 'Arrived at the hospital.')}><Icon name="hospital" /> I am at the hospital</button>
  }
  // On the way to the scene, the destination can be acknowledged as soon as dispatch has confirmed it.
  const canAckEarly = c.status === 'enroute' && !!c.selectedHospitalId && !c.destinationAckAtMs

  return (
    <div className="mission">
      <RelayTrack c={c} viewer="crew" />

      {c.status === 'dispatched' && (
        <section className="mission-hero panel--move" aria-label="Incoming dispatch" style={{ boxShadow: '6px 6px 0 var(--hi), 6px 6px 0 2px var(--line)' }}>
          <div className="row row-between"><div className="row"><SeverityTag severity={c.severity} /><span className="pill pill-wait">Offered <Elapsed sinceMs={c.crewOfferedAtMs ?? now} /> ago</span></div><Pill>Hospitals are asked after you accept</Pill></div>
          <h2 className="title"><Icon name={TYPE_ICON[c.type]} size={30} /> {CASE_TYPES[c.type].label}, {c.patients} patient{c.patients > 1 ? 's' : ''}</h2>
          <p className="lede">&ldquo;{c.brief || 'No summary given'}&rdquo;</p>
          <dl className="facts">
            <div><dt>Distance from your base</dt><dd>{sceneKm} km, about {estimateMinutes(ambulance, c)} min (estimate)</dd></div>
            <div><dt>Hospital needs</dt><dd>{c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' and ')}</dd></div>
            <div><dt>Location</dt><dd>{c.locationSource === 'gps' ? "From the reporter's device" : 'Placed by hand'}</dd></div>
          </dl>
          {declining && (
            <div className="stack-sm">
              <label className="field"><span className="field-label">Why are you declining?</span><select value={why} onChange={(e) => setWhy(e.target.value)}>{DECLINE_REASONS.map((r) => <option key={r}>{r}</option>)}</select></label>
              <div className="row"><button className="btn btn-danger" disabled={busy} onClick={() => run(() => crewDecline(db, actor, c, why), 'Declined. Dispatch will choose another crew.')}>Decline the dispatch</button><button className="btn" onClick={() => setDeclining(false)}>Go back</button></div>
            </div>
          )}
        </section>
      )}

      {c.status === 'onscene' && (
        <Panel title="Destination" move={!!c.selectedHospitalId && !c.destinationAckAtMs} actions={c.selectedHospitalId && !c.destinationAckAtMs ? <span className="mover you">Your move</span> : undefined}>
          {!c.selectedHospitalId ? <><p className="strong">Dispatch has not confirmed a hospital yet.</p><p className="sub measure">{c.notifiedHospitalIds.length} hospitals were asked while you drove. You can start caring for the patient. Transport starts once a destination is confirmed and you have acknowledged it.</p></>
            : <><p className="reco-name">{hospital?.name ?? c.selectedHospitalName}</p><p className="sub">{hospital?.area}{hospital?.phone ? `, ${hospital.phone}` : ''}. {c.destinationAckAtMs ? `You acknowledged this at ${hm(c.destinationAckAtMs)}.` : 'Confirmed by dispatch. Acknowledge it to continue.'}</p></>}
        </Panel>
      )}

      {canAckEarly && (
        <Notice tone="go" title={`Dispatch confirmed ${c.selectedHospitalName}`} actions={<button className="btn btn-sm btn-go" disabled={busy} onClick={() => run(() => acknowledgeDestination(db, actor, c), 'Destination acknowledged.')}>Acknowledge the destination</button>}>You can acknowledge it now so it is ready when you reach the patient.</Notice>
      )}

      {drive}

      {c.status === 'arrived' && (
        <Panel title="At the hospital" move={false}>
          <p className="strong">{c.arrivalConfirmedAtMs ? `${c.selectedHospitalName} confirmed it received the patient at ${hm(c.arrivalConfirmedAtMs)}.` : `Waiting for ${c.selectedHospitalName} to confirm it received the patient.`}</p>
          <p className="sub">Dispatch closes the case after the hospital confirms. You will be free then.</p>
        </Panel>
      )}

      {c.escalation !== 'none' && <Notice tone="wait" title="Dispatch is working on the hospital">{c.escalationNote}</Notice>}

      <div className="cols-2">
        <div className="stack">
          <Panel title="The patient" actions={<div className="row row-tight"><GoldenRing createdAtMs={c.createdAtMs} frozenAtMs={c.arrivalConfirmedAtMs} small /><StatusPill status={c.status} /></div>}>
            <p className="strong">&ldquo;{c.brief || 'No summary given'}&rdquo;</p>
            {accepted && priv && <div className="inset"><p><Icon name="phone" size={16} /> <b>{priv.contact || 'No phone given'}</b>{priv.contact && <> <a href={`tel:${priv.contact.replace(/[^\d+]/g, '')}`}>Call</a></>}</p>{priv.note && <p className="sub">{priv.note}</p>}</div>}
            {!accepted && <p className="fine">Contact details appear after you accept.</p>}
            <div className="row"><Pill tone="star">Scene {c.lat.toFixed(4)}, {c.lng.toFixed(4)}</Pill><a className="btn btn-sm" href={navLink(c)} target="_blank" rel="noopener noreferrer"><Icon name="nav" size={16} /> Navigate to scene</a></div>
          </Panel>
          <HandoffCard caseId={c.id} />
          <Panel title="Evidence from the reporter" quiet><EvidenceGallery caseId={c.id} items={evidence.data} expected={c.evidenceExpected} loading={!evidence.ready} /></Panel>
        </div>
        <div className="sticky"><MapView cases={[c]} hospitals={hospital ? [hospital] : []} hospitalStates={hospital ? { [hospital.id]: 'selected' } : {}} route={route?.points} focus={[c, ...(lastPos ? [lastPos] : []), ...(hospital && c.status === 'transporting' ? [hospital] : [])]} height={420} label="Route and incident" /></div>
      </div>

      {primary && <div className="actionbar" role="region" aria-label="Next step">{primary}</div>}
    </div>
  )
}

export default function Responder({ actor, ambulance, cases, hospitals, notify }: Props) {
  const job = useMemo(() => cases.filter((c) => c.status !== 'closed').sort((a, b) => b.createdAtMs - a.createdAtMs)[0], [cases])
  if (!ambulance) return <Empty icon="ambulance" title="Your account is not linked to an ambulance">Ask your administrator to link this account to a unit.</Empty>
  return (
    <div className="stack-lg">
      <div className="row row-between"><div><h1 className="title">{ambulance.callSign}</h1><p className="sub">Based at {ambulance.base}</p></div>{job ? <Pill tone={job.status === 'dispatched' ? 'wait' : 'star'}>{job.status === 'dispatched' ? 'New dispatch' : 'On a call'}</Pill> : <Pill tone="go">Available</Pill>}</div>
      {job ? <Mission key={job.id} c={job} ambulance={ambulance} hospitals={hospitals} actor={actor} notify={notify} />
        : <Empty icon="radio" title="Standing by">New dispatches from the control room appear here and ring if sound is on. Keep this screen open.</Empty>}
    </div>
  )
}
