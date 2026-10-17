import { useMemo, useState } from 'react'
import { AiPanel } from '../components/AiPanels'
import { EvidenceGallery } from '../components/Evidence'
import MapView from '../components/MapView'
import { Elapsed, Empty, ErrorBox, GoldenRing, Icon, Notice, OfferPill, Panel, Pill, PosSource, RelayTrack, SeverityTag, StatusPill, Timeline, TYPE_ICON, type Notify } from '../components/ui'
import { CAPABILITY_LABEL, CASE_TYPES } from '../lib/capabilities'
import { findDuplicates } from '../lib/duplicates'
import { agoText, estimateMinutes } from '../lib/geo'
import { db } from '../lib/firebase'
import { explainRecommendation, nearestFreeAmbulance, nextWave, offerStatusText, rankQualified, WAVE_SIZE } from '../lib/matching'
import { nextMover } from '../lib/relay'
import { etasFrom } from '../lib/routing'
import { useEvents, useEvidence, useNow, usePatientPrivate } from '../lib/store'
import type { Ambulance, Case, Hospital, Offer, OfferState } from '../lib/types'
import { cancelAssignment, closeCase, contactNextWave, dismissDuplicate, dispatchCase, extendDeadline, markDuplicate, selectDestination, type Actor } from '../lib/workflow'

interface Props {
  cases: Case[]
  offers: Offer[]
  hospitals: Hospital[]
  ambulances: Ambulance[]
  actor: Actor
  notify: Notify
  selected: string | null
  onSelect: (id: string | null) => void
}

const ROUTING_BUDGET_MS = 1500 // never hold up an ambulance waiting for a routing service
const TAG = { 1: 'var(--signal)', 2: '#e08a00', 3: 'var(--go)' } as const
const priority = (c: Case) => (c.escalation === 'no_hospital' ? 0 : c.escalation === 'attention' ? 1 : c.status === 'reported' ? 2 : 3) * 10 + c.severity
const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function OfferCounts({ offers }: { offers: Offer[] }) {
  const n = (s: OfferState) => offers.filter((o) => o.state === s).length
  if (!offers.length) return null
  return <span className="fine num" title="accepted, waiting, declined or silent">{n('accepted') + n('selected')} yes, {n('pending')} waiting, {n('declined') + n('timeout')} no</span>
}

// ---------------------------------------------------------------- step: choose a crew

function CrewPanel({ c, hospitals, ambulances, actor, notify, move }: { c: Case; hospitals: Hospital[]; ambulances: Ambulance[]; actor: Actor; notify: Notify; move: boolean }) {
  const now = useNow()
  const free = ambulances.filter((a) => a.available && !c.declinedAmbulanceIds.includes(a.id))
  const recommended = nearestFreeAmbulance(c, free)
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const ambulance = free.find((a) => a.id === pick) ?? recommended
  const preview = useMemo(() => nextWave(c, hospitals, [], (h) => ({ etaMin: estimateMinutes(c, h), source: 'estimate' })), [c, hospitals])
  const declined = c.declinedAmbulanceIds.map((id) => ambulances.find((a) => a.id === id)?.callSign ?? id)
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); notify(ok, 'good') } catch (e) { notify((e as Error).message, 'warn') } finally { setBusy(false) } }

  if (c.status === 'reported') {
    return (
      <Panel title="Crew" move={move} actions={move ? <span className="mover you">Your move</span> : undefined}>
        {declined.length > 0 && <Notice tone="wait" title={`${declined.join(', ')} declined this case`}>{c.crewDeclineReason ? `Last reason: ${c.crewDeclineReason}. ` : ''}Choose a different unit.</Notice>}
        <label className="field"><span className="field-label">Ambulance</span>
          <select value={ambulance?.id ?? ''} onChange={(e) => setPick(e.target.value)} aria-label="Choose an ambulance">
            {!free.length && <option value="">No ambulance is available</option>}
            {free.map((a) => <option key={a.id} value={a.id}>{a.callSign}, based at {a.base}{a.id === recommended?.id ? ' (nearest, recommended)' : ''}</option>)}
          </select>
        </label>
        <div className="stack-sm">
          <p className="sub">Nothing goes to hospitals yet. After the crew <b>accepts</b>, the {Math.min(WAVE_SIZE, preview.length)} nearest hospitals that can treat this patient are asked while the crew is driving:</p>
          <ul className="stack-sm">{preview.map((p) => <li key={p.hospital.id} className="inset row row-between"><b>{p.hospital.name}</b><span className="fine num">about {p.etaMin} min, {p.distanceKm} km (straight-line preview)</span></li>)}</ul>
          {!preview.length && <ErrorBox>No hospital matches {c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' and ')}. Check their capability profiles and diversion status.</ErrorBox>}
        </div>
        <button className="btn btn-go btn-lg" disabled={busy || !ambulance || !preview.length} onClick={() => ambulance && act(async () => {
          const eta = (await etasFrom(ambulance, [c], undefined, ROUTING_BUDGET_MS))[0]
          await dispatchCase(db, actor, c, { ambulance, etaSceneMin: eta.etaMin, etaSource: eta.source })
        }, `Offer sent to ${ambulance.callSign}. Waiting for the crew to accept.`)}>{busy ? <><span className="spin" /> Sending</> : <><Icon name="ambulance" /> Send the offer to {ambulance?.callSign ?? 'a crew'}</>}</button>
      </Panel>
    )
  }

  if (c.status === 'dispatched') {
    const waited = now - (c.crewOfferedAtMs ?? now)
    return (
      <Panel title={`Crew: ${c.ambulanceCallSign}`} actions={<Pill tone="wait">Waiting for the crew</Pill>}>
        <p className="strong">Offered {agoText(c.crewOfferedAtMs ?? now, now)}. The crew has not answered, so no hospital has been contacted.</p>
        <p className="sub">Waiting <Elapsed sinceMs={c.crewOfferedAtMs ?? now} />. {waited > 45000 ? 'If the crew is not responding, take the offer back and choose another unit.' : 'You can take the offer back after 45 seconds.'}</p>
        <div className="row"><button className="btn" disabled={busy || waited < 45000} onClick={() => act(() => cancelAssignment(db, actor, c, 'No answer from the crew'), 'Offer taken back. Choose another crew.')}>Take back the offer</button></div>
      </Panel>
    )
  }

  return (
    <Panel title={`Crew: ${c.ambulanceCallSign}`} actions={<div className="row row-tight"><StatusPill status={c.status} /><PosSource pos={c.ambulancePos} /></div>}>
      <dl className="facts">
        <div><dt>Accepted the dispatch</dt><dd>{c.ambulanceAckAtMs ? `${hm(c.ambulanceAckAtMs)}, ${Math.round((c.ambulanceAckAtMs - (c.crewOfferedAtMs ?? c.ambulanceAckAtMs)) / 1000)} s after the offer` : 'Not yet'}</dd></div>
        <div><dt>Time to scene</dt><dd>{c.status === 'enroute' ? (c.etaSceneMin !== null ? `about ${c.etaSceneMin} min${c.etaSource === 'estimate' ? ' (estimate)' : ''}` : 'Unknown') : 'At the scene'}</dd></div>
        <div><dt>Destination acknowledged</dt><dd>{c.destinationAckAtMs ? hm(c.destinationAckAtMs) : c.selectedHospitalId ? 'Waiting for the crew' : 'No destination yet'}</dd></div>
        <div><dt>Patient picked up</dt><dd>{c.pickupAtMs ? hm(c.pickupAtMs) : 'Not yet'}</dd></div>
        <div><dt>Position</dt><dd>{c.ambulancePos ? `updated ${agoText(c.ambulancePos.atMs, now)}` : 'None yet'}</dd></div>
      </dl>
    </Panel>
  )
}

// ---------------------------------------------------------------- step: hospitals and destination

function HospitalPanel({ c, offers, hospitals, actor, notify, move }: { c: Case; offers: Offer[]; hospitals: Hospital[]; actor: Actor; notify: Notify; move: boolean }) {
  const now = useNow()
  const [choice, setChoice] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const ranked = useMemo(() => rankQualified(offers, c), [offers, c])
  const best = ranked.find((r) => r.offer.hospitalId === c.recommendedHospitalId) ?? ranked[0]
  const pick = ranked.find((r) => r.offer.hospitalId === (choice || best?.offer.hospitalId))
  const isOverride = !!pick && pick.offer.hospitalId !== best?.offer.hospitalId
  const sorted = [...offers].sort((a, b) => a.wave - b.wave || a.etaMin - b.etaMin)
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) notify(ok, 'good') } catch (e) { notify((e as Error).message, 'warn') } finally { setBusy(false) } }
  const alertLag = c.hospitalAlertAtMs && c.ambulanceAckAtMs ? Math.max(0, Math.round((c.hospitalAlertAtMs - c.ambulanceAckAtMs) / 1000)) : null

  return (
    <>
      <Panel title="Hospitals" actions={<OfferCounts offers={offers} />}>
        {alertLag !== null && <p className="sub">Hospitals were asked {alertLag} second{alertLag === 1 ? '' : 's'} after the crew accepted, while the crew was driving to the scene.</p>}
        {c.escalation !== 'none' && (
          <Notice tone={c.escalation === 'no_hospital' ? 'signal' : 'wait'} title={c.escalation === 'no_hospital' ? 'No hospital has confirmed' : 'Needs attention'}
            actions={<>
              <button className="btn btn-sm" disabled={busy} onClick={() => act(async () => {
                const cands = nextWave(c, hospitals, c.notifiedHospitalIds, (h) => ({ etaMin: estimateMinutes(c, h), source: 'estimate' }))
                if (!(await contactNextWave(db, actor, c, cands, c.offerWave + 1))) throw new Error('No more eligible hospitals to ask. Phone hospitals directly.')
              }, 'Next hospitals asked.')}>Ask the next hospitals now</button>
              {offers.some((o) => o.state === 'pending') && <button className="btn btn-sm" disabled={busy} onClick={() => act(() => Promise.all(offers.filter((o) => o.state === 'pending').map((o) => extendDeadline(db, actor, o))), 'Deadlines extended by a minute.')}>Give them another minute</button>}
            </>}>{c.escalationNote}</Notice>
        )}
        {sorted.length === 0 ? <p className="sub">Waiting for the crew to accept before any hospital is asked.</p> : (
          <ul className="stack-sm" aria-label="Hospital responses">
            {sorted.map((o) => (
              <li key={o.id} className={`offer ${o.state}`}>
                <div className="row row-between"><div><b>{o.hospitalName}</b><span className="fine"> wave {o.wave}{o.respondedAtMs ? `, answered in ${Math.round((o.respondedAtMs - o.requestedAtMs) / 1000)} s` : ''}</span></div><OfferPill state={o.state} /></div>
                <p className="sub">{offerStatusText(o, c, now)}{o.state === 'pending' && o.expiresAtMs > now ? ` Deadline in ${Math.ceil((o.expiresAtMs - now) / 1000)} s.` : ''}</p>
                <div className="row row-tight">
                  {o.seenAtMs ? <Pill tone="go">Opened {agoText(o.seenAtMs, now)}</Pill> : <Pill>Not opened yet</Pill>}
                  <Pill tone="star">{o.etaMin} min{o.etaSource === 'estimate' ? ' (est.)' : ''}, {o.distanceKm} km from the scene</Pill>
                  {o.confirmations && c.requiredCapabilities.map((cap) => <Pill key={cap} tone={o.confirmations?.[cap] ? 'go' : 'signal'}>{o.confirmations?.[cap] ? 'Confirmed' : 'Not confirmed'}: {CAPABILITY_LABEL[cap]}</Pill>)}
                  {o.confirmations && <Pill tone={o.canReceive ? 'go' : 'signal'}>{o.canReceive ? 'Can receive' : 'Cannot receive'}</Pill>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Destination" move={move} actions={move ? <span className="mover you">Your move</span> : undefined}>
        {c.selectedHospitalId ? (
          <div className="reco" aria-live="polite">
            <span className="reco-name">{c.selectedHospitalName}</span>
            <p className="sub">Confirmed {agoText(c.selectedAtMs ?? now, now)}{c.overrideReason ? `. Override reason: “${c.overrideReason}”` : ', as recommended'}.</p>
            <p className="strong">{c.destinationAckAtMs ? `The crew acknowledged it at ${hm(c.destinationAckAtMs)}.` : 'Waiting for the crew to acknowledge the destination.'}</p>
          </div>
        ) : best ? (
          <>
            <div className="reco">
              <span className="fine strong">Recommended</span>
              <span className="reco-name">{best.offer.hospitalName}</span>
              <ul className="stack-sm" style={{ paddingLeft: 18, listStyle: 'disc' }}>{explainRecommendation(best, ranked, c).map((l) => <li key={l}>{l}</li>)}</ul>
            </div>
            {ranked.length > 1 && (
              <label className="field"><span className="field-label">Or choose another confirmed hospital</span>
                <select value={choice || best.offer.hospitalId} onChange={(e) => setChoice(e.target.value)}>{ranked.map((r) => <option key={r.offer.hospitalId} value={r.offer.hospitalId}>{r.offer.hospitalName}, {r.offer.etaMin} min{r.rank === 1 ? ' (recommended)' : ''}</option>)}</select>
              </label>
            )}
            {isOverride && <label className="field"><span className="field-label">Why not the recommended hospital? <small>(required, kept in the audit trail)</small></span><input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example, the family lives next to this hospital" /></label>}
            <button className="btn btn-go btn-lg" disabled={busy || !pick || (isOverride && reason.trim().length < 3)} onClick={() => act(() => selectDestination(db, actor, c, offers, pick!.offer.hospitalId, isOverride ? reason : null, best?.offer.hospitalId ?? null), 'Destination confirmed. The crew will be asked to acknowledge it.')}>
              {isOverride ? 'Override and confirm' : 'Approve and confirm'} {pick?.offer.hospitalName}
            </button>
          </>
        ) : <p className="sub measure">Waiting for a hospital to accept <b>and</b> confirm {c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' and ')} for this patient. An accept without full confirmation is never offered as a destination.</p>}
      </Panel>
    </>
  )
}

// ---------------------------------------------------------------- the case workbench

export function Workbench({ c, allCases, offers, hospitals, ambulances, actor, notify }: { c: Case; allCases: Case[]; offers: Offer[]; hospitals: Hospital[]; ambulances: Ambulance[]; actor: Actor; notify: Notify }) {
  const now = useNow()
  const events = useEvents(c.id, true)
  const evidence = useEvidence(c.id)
  const priv = usePatientPrivate(c.id, true)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelWhy, setCancelWhy] = useState('False alarm')
  const t = CASE_TYPES[c.type]
  const mover = nextMover(c, offers)
  const mine = mover.role === 'dispatcher'
  const dupes = findDuplicates(c, allCases)
  const states = Object.fromEntries(offers.map((o) => [o.hospitalId, o.state])) as Record<string, OfferState>
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) notify(ok, 'good') } catch (e) { notify((e as Error).message, 'warn') } finally { setBusy(false) } }
  const live = c.status !== 'closed'
  const closeNow = c.status === 'arrived' && !!c.arrivalConfirmedAtMs
  const destinationMove = mine && ['enroute', 'onscene', 'transporting'].includes(c.status) && !c.selectedHospitalId

  return (
    <div className="stack-lg">
      <RelayTrack c={c} offers={offers} viewer="dispatcher" />
      <div className="cols-2">
        <div className="stack">
          {dupes.length > 0 && (
            <Notice tone="wait" title="This looks like a duplicate report" actions={<>
              <button className="btn btn-sm" disabled={busy} onClick={() => act(() => markDuplicate(db, actor, c, dupes[0]), 'Merged as a duplicate and closed.')}>Merge into {dupes[0].id.slice(0, 5)}</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => act(() => dismissDuplicate(db, c))}>It is not a duplicate</button>
            </>}>{dupes.length} other open report{dupes.length > 1 ? 's' : ''} within 400 m in the last 20 minutes ({dupes.map((d) => `${CASE_TYPES[d.type].label} ${d.id.slice(0, 5)}`).join(', ')}).</Notice>
          )}

          <Panel title={<><Icon name={TYPE_ICON[c.type]} size={20} /> {t.label}, {c.patients} patient{c.patients > 1 ? 's' : ''}</>} actions={<div className="row row-tight"><SeverityTag severity={c.severity} /><StatusPill status={c.status} />{c.needsIcu && <Pill tone="sim">ICU likely</Pill>}</div>}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <GoldenRing createdAtMs={c.createdAtMs} frozenAtMs={c.closedAtMs ?? c.arrivalConfirmedAtMs} />
              <div className="stack-sm grow">
                <p className="strong measure">&ldquo;{c.brief || 'No summary given'}&rdquo;</p>
                {priv && <p className="sub"><Icon name="phone" size={14} /> {priv.contact || 'no phone given'}{priv.note ? `. ${priv.note}` : ''}</p>}
                <p className="fine">Needs {c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' and ')}. Reported {agoText(c.createdAtMs, now)}. Location {c.locationSource === 'gps' ? "from the reporter's device" : 'placed by hand'}.</p>
              </div>
            </div>
            <h4 className="h-sm">Evidence from the reporter</h4>
            <EvidenceGallery caseId={c.id} items={evidence.data} expected={c.evidenceExpected} loading={!evidence.ready} />
          </Panel>

          <AiPanel c={c} evidence={evidence.data} evidenceReady={evidence.ready} priv={priv} actor={actor} notify={notify} />

          <CrewPanel c={c} hospitals={hospitals} ambulances={ambulances} actor={actor} notify={notify} move={mine && c.status === 'reported'} />

          {c.status !== 'reported' && c.status !== 'dispatched' && <HospitalPanel c={c} offers={offers} hospitals={hospitals} actor={actor} notify={notify} move={destinationMove} />}

          {c.status === 'arrived' && (
            <Panel title="Handover" move={closeNow} actions={closeNow ? <span className="mover you">Your move</span> : undefined}>
              {c.arrivalConfirmedAtMs ? <p className="strong">{c.selectedHospitalName} confirmed it received the patient at {hm(c.arrivalConfirmedAtMs)}.</p> : <p className="strong">The crew is at {c.selectedHospitalName}. Waiting for the hospital to confirm it received the patient. The case cannot be closed before that.</p>}
              <button className="btn btn-go btn-lg" disabled={busy || !closeNow} onClick={() => act(() => closeCase(db, actor, c, 'Handed over to the hospital'), 'Case closed. The ambulance is free.')}>Close the case and free the ambulance</button>
            </Panel>
          )}

          {live && c.status !== 'arrived' && (
            cancelling ? (
              <Panel title="Cancel this case" quiet>
                <p className="sub">The ambulance will be freed and hospitals stood down. Use this only when the case will not reach a hospital.</p>
                <label className="field"><span className="field-label">Reason</span><select value={cancelWhy} onChange={(e) => setCancelWhy(e.target.value)}>{['False alarm', 'Patient declined care', 'Resolved at the scene', 'Reported in error', 'Other'].map((r) => <option key={r}>{r}</option>)}</select></label>
                <div className="row"><button className="btn btn-danger" disabled={busy} onClick={() => act(() => closeCase(db, actor, c, `Cancelled: ${cancelWhy}`), 'Case cancelled.')}>Cancel the case</button><button className="btn" onClick={() => setCancelling(false)}>Keep it open</button></div>
              </Panel>
            ) : <button className="btn btn-danger btn-sm" style={{ justifySelf: 'start' }} onClick={() => setCancelling(true)}>Cancel this case</button>
          )}

          <Panel title="Timeline" quiet>{events.error ? <ErrorBox>{events.error}</ErrorBox> : <Timeline items={events.data} loading={!events.ready} />}</Panel>
        </div>

        <div className="sticky stack">
          <MapView cases={[c]} hospitals={hospitals} ambulances={c.ambulanceId ? [] : ambulances} hospitalStates={states} height={520} label="Incident, crew and hospitals"
            focus={[c, ...(c.ambulancePos ? [c.ambulancePos] : []), ...hospitals.filter((h) => states[h.id] && ['selected', 'accepted'].includes(states[h.id]))]} />
          <p className="fine">Red diamond: incident. Arrow: the crew (purple dashed means simulated movement, green means live GPS). Squares: hospitals that were asked.</p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the live console

export default function Dispatcher({ cases, offers, hospitals, ambulances, actor, notify, selected, onSelect }: Props) {
  const now = useNow()
  const active = useMemo(() => cases.filter((c) => c.status !== 'closed').sort((a, b) => priority(a) - priority(b) || a.createdAtMs - b.createdAtMs), [cases])
  const currentId = selected ?? active[0]?.id ?? null
  const current = cases.find((c) => c.id === currentId) ?? null
  const free = ambulances.filter((a) => a.available).length
  const escalations = active.filter((c) => c.escalation !== 'none').length
  const waiting = active.filter((c) => c.status === 'reported').length

  return (
    <div className="stack-lg">
      <div className="kpis" role="group" aria-label="Operations summary">
        <div className={`kpi ${waiting ? 'alarm' : ''}`}><b className="num">{waiting}</b><span>waiting for dispatch</span></div>
        <div className="kpi"><b className="num">{active.length}</b><span>open cases</span></div>
        <div className={`kpi ${escalations ? 'alarm' : ''}`}><b className="num">{escalations}</b><span>need attention</span></div>
        <div className="kpi"><b className="num">{free}/{ambulances.length}</b><span>ambulances free</span></div>
        <div className="kpi"><b className="num">{hospitals.filter((h) => !h.diverted).length}/{hospitals.length}</b><span>hospitals open</span></div>
      </div>
      <p className="fine">This console sends the hospital pre-alert, handles missed deadlines and asks the next hospitals. Keep at least one dispatcher console open while cases are active.</p>
      <div className="ops">
        <aside className="ops-queue stack" aria-label="Open cases">
          {active.length === 0 ? <Empty icon="check" title="No open cases">New reports appear here the moment they are sent.</Empty> : (
            <div className="strips">
              {active.map((c) => {
                const co = offers.filter((o) => o.caseId === c.id)
                const mv = nextMover(c, co)
                return (
                  <button key={c.id} className={`strip ${c.escalation !== 'none' ? 'escalated' : ''}`} style={{ ['--tag' as string]: TAG[c.severity] }} aria-current={currentId === c.id} onClick={() => onSelect(c.id)}>
                    <span className="strip-stub" />
                    <span className="strip-body">
                      <span className="strip-title"><Icon name={TYPE_ICON[c.type]} size={18} />{CASE_TYPES[c.type].label}<SeverityTag severity={c.severity} /></span>
                      <span className="strip-sub">{c.brief || 'No summary'}</span>
                      <span className="row row-tight"><StatusPill status={c.status} />{mv.role === 'dispatcher' && <span className="mover you">Your move</span>}{c.escalation !== 'none' && <Pill tone="signal">Needs attention</Pill>}</span>
                      <OfferCounts offers={co} />
                    </span>
                    <span className="strip-meta num"><span>{Math.max(0, Math.floor((now - c.createdAtMs) / 60000))} min</span>{c.evidenceExpected > 0 && <span title="Files attached"><Icon name="photo" size={14} /> {c.evidenceExpected}</span>}</span>
                  </button>
                )
              })}
            </div>
          )}
        </aside>
        <section aria-label="Case">
          {current ? <Workbench key={current.id} c={current} allCases={cases} offers={offers.filter((o) => o.caseId === current.id)} hospitals={hospitals} ambulances={ambulances} actor={actor} notify={notify} />
            : <Empty icon="radio" title="Select a case">Choose a case from the list to work on it.</Empty>}
        </section>
      </div>
    </div>
  )
}
