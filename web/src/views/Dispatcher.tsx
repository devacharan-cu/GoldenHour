import { useMemo, useState } from 'react'
import MapView from '../components/MapView'
import { Badge, Countdown, Elapsed, Empty, ErrorBox, OfferBadge, PosSource, SeverityBadge, StatusBadge, Timeline } from '../components/bits'
import { CAPABILITY_LABEL, CASE_TYPES } from '../lib/capabilities'
import { agoText } from '../lib/geo'
import { findDuplicates } from '../lib/duplicates'
import { eligibility, explainRecommendation, nearestFreeAmbulance, nextWave, offerStatusText, rankQualified, WAVE_SIZE } from '../lib/matching'
import { estimateMinutes } from '../lib/geo'
import { etasFrom } from '../lib/routing'
import { db } from '../lib/firebase'
import { useEvents, useNow, usePatientPrivate } from '../lib/store'
import type { Ambulance, Case, Hospital, Offer, OfferState } from '../lib/types'
import { closeCase, contactNextWave, dismissDuplicate, dispatchCase, extendDeadline, markDuplicate, selectDestination, type Actor } from '../lib/workflow'

interface Props {
  cases: Case[]
  offers: Offer[]
  hospitals: Hospital[]
  ambulances: Ambulance[]
  actor: Actor
  notify: (m: string, tone?: string) => void
  onLogCall: () => void
}

const DISPATCH_ROUTING_BUDGET_MS = 1500 // never hold up an ambulance waiting for a routing service

function priority(c: Case): number {
  return (c.escalation === 'no_hospital' ? 0 : c.escalation === 'attention' ? 1 : 2) * 10 + c.severity
}

function OfferCounts({ offers }: { offers: Offer[] }) {
  const n = (s: OfferState) => offers.filter((o) => o.state === s).length
  if (!offers.length) return null
  return <span className="mono small">✅{n('accepted') + n('selected')} ⏳{n('pending')} ⛔{n('declined') + n('timeout')}</span>
}

function DispatchPanel({ c, hospitals, ambulances, actor, notify }: { c: Case; hospitals: Hospital[]; ambulances: Ambulance[]; actor: Actor; notify: Props['notify'] }) {
  const recommended = nearestFreeAmbulance(c, ambulances)
  const [ambId, setAmbId] = useState('')
  const [busy, setBusy] = useState(false)
  const ambulance = ambulances.find((a) => a.id === ambId) ?? recommended
  const preview = useMemo(() => nextWave(c, hospitals, [], (h) => ({ etaMin: estimateMinutes(c, h), source: 'estimate' })), [c, hospitals])
  const { excluded } = useMemo(() => eligibility(c, hospitals), [c, hospitals])

  async function go() {
    if (!ambulance) return
    setBusy(true)
    try {
      // One short, time-boxed routing request for both the crew ETA and hospital ETAs; falls back to estimates.
      const eligible = eligibility(c, hospitals).eligible
      const [hospEta, crewEta] = await Promise.all([
        etasFrom(c, eligible, undefined, DISPATCH_ROUTING_BUDGET_MS),
        etasFrom(ambulance, [c], undefined, DISPATCH_ROUTING_BUDGET_MS),
      ])
      const byId = new Map(eligible.map((h, i) => [h.id, hospEta[i]]))
      const candidates = nextWave(c, hospitals, [], (h) => byId.get(h.id) ?? { etaMin: estimateMinutes(c, h), source: 'estimate' })
      if (!candidates.length) { notify('No eligible hospital to ask. Check capability profiles or diversion status.', 'warn'); return }
      await dispatchCase(db, actor, c, { ambulance, candidates, etaSceneMin: crewEta[0].etaMin, etaSource: crewEta[0].source })
      notify(`${ambulance.callSign} dispatched; ${candidates.length} hospitals asked.`, 'good')
    } catch (e) {
      notify((e as Error).message, 'warn')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card stack">
      <div><h3 className="h">1 · Dispatch now</h3><p className="sub">Assigning the ambulance and asking hospitals happen together, so hospital confirmation runs while the crew is already driving.</p></div>
      <label>Ambulance
        <select value={ambulance?.id ?? ''} onChange={(e) => setAmbId(e.target.value)}>
          {!ambulances.some((a) => a.available) && <option value="">No ambulance available</option>}
          {ambulances.filter((a) => a.available).map((a) => <option key={a.id} value={a.id}>{a.callSign} · {a.base}{a.id === recommended?.id ? ' (nearest, recommended)' : ''}</option>)}
        </select>
      </label>
      <div>
        <p className="sub">Will ask the {Math.min(WAVE_SIZE, preview.length)} nearest eligible hospitals (straight-line preview; road times are fetched at dispatch):</p>
        <div className="stack tight">
          {preview.map((p) => <div key={p.hospital.id} className="rank"><b>{p.hospital.name}</b><span>~{p.etaMin} min · {p.distanceKm} km</span></div>)}
          {!preview.length && <ErrorBox>No eligible hospital for {c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' + ')}. Check profiles and diversion.</ErrorBox>}
        </div>
        {excluded.length > 0 && (
          <details><summary className="sub link">{excluded.length} hospitals excluded</summary>
            <ul className="plain">{excluded.map((e) => <li key={e.hospital.id} className="sub">{e.hospital.name}: {e.reason}</li>)}</ul>
          </details>
        )}
      </div>
      <button className="btn primary big" disabled={busy || !ambulance || !preview.length} onClick={go}>{busy ? 'Dispatching…' : `🚑 Dispatch ${ambulance?.callSign ?? ''} and ask hospitals`}</button>
    </div>
  )
}

function ResponsesTable({ c, offers, nowMs }: { c: Case; offers: Offer[]; nowMs: number }) {
  const sorted = [...offers].sort((a, b) => a.wave - b.wave || a.etaMin - b.etaMin)
  return (
    <div className="stack tight" role="list" aria-label="Hospital responses">
      {sorted.map((o) => (
        <div key={o.id} role="listitem" className={`offer ${o.state}`}>
          <div className="row between">
            <div><b>{o.hospitalName}</b><small className="sub"> · wave {o.wave}{o.respondedAtMs ? ` · replied in ${Math.round((o.respondedAtMs - o.requestedAtMs) / 1000)}s` : ''}</small></div>
            <OfferBadge state={o.state} />
          </div>
          <p className="sub">{offerStatusText(o, c, nowMs)}{o.state === 'pending' && o.expiresAtMs > nowMs ? <> · <span className="mono">deadline {Math.ceil((o.expiresAtMs - nowMs) / 1000)}s</span></> : null}</p>
          <div className="row tight">
            {o.seenAtMs ? <Badge tone="green">✓ seen {agoText(o.seenAtMs, nowMs)}</Badge> : <Badge>not yet opened</Badge>}
            <Badge tone="blue">{o.etaMin} min{o.etaSource === 'estimate' ? '*' : ''} · {o.distanceKm} km</Badge>
            {o.confirmations && c.requiredCapabilities.map((cap) => <Badge key={cap} tone={o.confirmations?.[cap] ? 'green' : 'red'}>{o.confirmations?.[cap] ? '✓' : '✗'} {CAPABILITY_LABEL[cap]}</Badge>)}
            {o.confirmations && <Badge tone={o.canReceive ? 'green' : 'red'}>{o.canReceive ? '✓ can receive' : '✗ cannot receive'}</Badge>}
          </div>
        </div>
      ))}
      <p className="sub">* straight-line estimate from the scene; unmarked times use road routing.</p>
    </div>
  )
}

function CaseDetail({ c, allCases, offers, hospitals, ambulances, actor, notify }: { c: Case; allCases: Case[]; offers: Offer[]; hospitals: Hospital[]; ambulances: Ambulance[]; actor: Actor; notify: Props['notify'] }) {
  const now = useNow()
  const events = useEvents(c.id, true)
  const priv = usePatientPrivate(c.id, true)
  const [choice, setChoice] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const t = CASE_TYPES[c.type]
  const ranked = useMemo(() => rankQualified(offers, c), [offers, c])
  const best = ranked.find((r) => r.offer.hospitalId === c.recommendedHospitalId) ?? ranked[0]
  const pick = ranked.find((r) => r.offer.hospitalId === (choice || best?.offer.hospitalId))
  const isOverride = !!pick && pick.offer.hospitalId !== best?.offer.hospitalId
  const dupes = findDuplicates(c, allCases)
  const states = Object.fromEntries(offers.map((o) => [o.hospitalId, o.state])) as Record<string, OfferState>
  const dispatched = c.status !== 'reported'
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try { await fn(); if (ok) notify(ok, 'good') } catch (e) { notify((e as Error).message, 'warn') } finally { setBusy(false) }
  }


  return (
    <div className="grid two">
      <div className="stack">
        <div className="card stack">
          <div className="row between">
            <div>
              <h2 className="h">{t.icon} {t.label} · {c.patients} patient{c.patients > 1 ? 's' : ''}</h2>
              <div className="row tight"><SeverityBadge severity={c.severity} /><StatusBadge status={c.status} />{c.needsIcu && <Badge tone="violet">ICU likely</Badge>}<Badge>{c.locationSource === 'gps' ? 'GPS location' : 'Manual location'}</Badge></div>
            </div>
            <Countdown createdAtMs={c.createdAtMs} frozenAtMs={c.status === 'closed' ? c.closedAtMs : c.arrivalConfirmedAtMs} />
          </div>
          <p>“{c.brief || 'No summary given'}”</p>
          {priv && <p className="sub">📞 {priv.contact || 'no phone'}{priv.note ? ` · ${priv.note}` : ''}</p>}
          <p className="sub">Needs: {c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' + ')} · {dispatched ? <>dispatched <Elapsed sinceMs={c.createdAtMs} untilMs={c.dispatchedAtMs} className="inline" /> after the report</> : <>waiting <Elapsed sinceMs={c.createdAtMs} className="inline" /> for dispatch</>}</p>
        </div>

        {c.escalation !== 'none' && (
          <div className={`banner ${c.escalation === 'no_hospital' ? 'crit' : 'warn'}`} role="alert">
            <div><b>{c.escalation === 'no_hospital' ? '🚨 No hospital has confirmed' : '🔔 Needs attention'}</b><p>{c.escalationNote}</p></div>
            <div className="row tight">
              <button className="btn sm" disabled={busy} onClick={() => act(async () => {
                const cands = nextWave(c, hospitals, c.notifiedHospitalIds, (h) => ({ etaMin: estimateMinutes(c, h), source: 'estimate' }))
                if (!(await contactNextWave(db, actor, c, cands, c.offerWave + 1))) throw new Error('No more eligible hospitals to ask. Phone hospitals directly.')
              }, 'Next hospitals contacted')}>Ask next hospitals now</button>
              {offers.some((o) => o.state === 'pending') && <button className="btn sm" disabled={busy} onClick={() => act(() => Promise.all(offers.filter((o) => o.state === 'pending').map((o) => extendDeadline(db, actor, o))), 'Deadlines extended by 60s')}>Extend deadlines +60s</button>}
            </div>
          </div>
        )}

        {dupes.length > 0 && (
          <div className="banner warn" role="alert">
            <div><b>🧬 Possible duplicate</b><p>Same area, {dupes.length} other open report{dupes.length > 1 ? 's' : ''} within 400 m in the last 20 min ({dupes.map((d) => `${CASE_TYPES[d.type].label} ${d.id.slice(0, 5)}`).join(', ')}).</p></div>
            <div className="row tight">
              <button className="btn sm" disabled={busy} onClick={() => act(() => markDuplicate(db, actor, c, dupes[0]), 'Marked as duplicate and closed')}>Merge into {dupes[0].id.slice(0, 5)}</button>
              <button className="btn sm" disabled={busy} onClick={() => act(() => dismissDuplicate(db, c))}>Not a duplicate</button>
            </div>
          </div>
        )}

        {!dispatched && <DispatchPanel c={c} hospitals={hospitals} ambulances={ambulances} actor={actor} notify={notify} />}

        {dispatched && (
          <div className="card stack">
            <div className="row between">
              <h3 className="h">🚑 {c.ambulanceCallSign}</h3>
              <div className="row tight"><StatusBadge status={c.status} /><PosSource pos={c.ambulancePos} /></div>
            </div>
            <div className="row">
              {c.status === 'dispatched' && <Badge tone="amber">Awaiting crew acknowledgement · sent <Elapsed sinceMs={c.dispatchedAtMs ?? now} /> ago</Badge>}
              {c.ambulanceAckAtMs && <Badge tone="green">Acknowledged after {Math.round((c.ambulanceAckAtMs - (c.dispatchedAtMs ?? c.ambulanceAckAtMs)) / 1000)}s</Badge>}
              {c.etaSceneMin !== null && ['dispatched', 'enroute'].includes(c.status) && <Badge tone="blue">ETA scene ~{c.etaSceneMin} min{c.etaSource === 'estimate' ? ' (estimate)' : ' (road)'}</Badge>}
              {c.ambulancePos && <span className="sub">position updated {agoText(c.ambulancePos.atMs, now)}</span>}
            </div>
          </div>
        )}

        {dispatched && c.status !== 'closed' && (
          <div className="card stack">
            <div className="row between"><h3 className="h">🏥 2 · Hospital responses</h3><OfferCounts offers={offers} /></div>
            {offers.length ? <ResponsesTable c={c} offers={offers} nowMs={now} /> : <p className="sub">No requests yet.</p>}
          </div>
        )}

        {dispatched && c.status !== 'closed' && (
          <div className="card stack" aria-live="polite">
            <h3 className="h">⭐ 3 · Destination</h3>
            {c.selectedHospitalId ? (
              <div className="selected-dest">
                <b>✅ {c.selectedHospitalName}</b>
                <p className="sub">Confirmed {agoText(c.selectedAtMs ?? now, now)} by a dispatcher{c.overrideReason ? ` · override reason: “${c.overrideReason}”` : ' · matches the recommendation'}.</p>
              </div>
            ) : best ? (
              <>
                <div className="reco">
                  <p className="eyebrow">Recommended</p>
                  <b>{best.offer.hospitalName}</b>
                  <ul className="plain">{explainRecommendation(best, ranked, c).map((l) => <li key={l}>{l}</li>)}</ul>
                </div>
                {ranked.length > 1 && (
                  <label>Or choose another confirmed hospital
                    <select value={choice || best.offer.hospitalId} onChange={(e) => setChoice(e.target.value)}>
                      {ranked.map((r) => <option key={r.offer.hospitalId} value={r.offer.hospitalId}>{r.offer.hospitalName} · {r.offer.etaMin} min{r.rank === 1 ? ' (recommended)' : ''}</option>)}
                    </select>
                  </label>
                )}
                {isOverride && <label>Reason for overriding the recommendation <small>(required, saved in the audit trail)</small><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. family is closer to this hospital" /></label>}
                <button className="btn primary big" disabled={busy || !pick || (isOverride && reason.trim().length < 3)} onClick={() => act(() => selectDestination(db, actor, c, offers, pick!.offer.hospitalId, isOverride ? reason : null, best?.offer.hospitalId ?? null), 'Destination confirmed. Crew and hospital notified.')}>
                  {isOverride ? 'Override and confirm ' : 'Approve and confirm '}{pick?.offer.hospitalName}
                </button>
              </>
            ) : (
              <p className="sub">Waiting for a hospital to accept <i>and</i> confirm {c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' + ')}. An accept without full confirmation is never offered as a destination.</p>
            )}
          </div>
        )}

        {c.status === 'arrived' && (
          <div className="card stack">
            <p>{c.arrivalConfirmedAtMs ? `🏁 ${c.selectedHospitalName} confirmed arrival.` : 'Waiting for the hospital to confirm arrival.'}</p>
            <button className="btn good" disabled={busy} onClick={() => act(() => closeCase(db, actor, c, 'Handed over to hospital'), 'Case closed; ambulance released')}>Close case and release ambulance</button>
          </div>
        )}
        {c.status !== 'arrived' && c.status !== 'closed' && (
          <button className="btn danger sm" disabled={busy} onClick={() => { if (window.confirm('Cancel and close this case? The ambulance will be released.')) void act(() => closeCase(db, actor, c, 'Cancelled by dispatcher'), 'Case closed') }}>Cancel case</button>
        )}

        <div className="card">
          <h3 className="h">Audit trail</h3>
          <div style={{ marginTop: 10 }}>{events.error ? <ErrorBox>{events.error}</ErrorBox> : <Timeline items={events.data} />}</div>
        </div>
      </div>

      <div className="sticky">
        <MapView cases={[c]} hospitals={hospitals} ambulances={dispatched ? [] : ambulances} hospitalStates={states} height={520} label="Incident, ambulance and hospitals"
          focus={[c, ...(c.ambulancePos ? [c.ambulancePos] : []), ...hospitals.filter((h) => states[h.id] && ['selected', 'accepted'].includes(states[h.id]))]} />
        <p className="sub legend">🔴 incident · 🔵 ambulance (◌ dashed = simulated) · 🟢 selected / accepted · 🟠 waiting · ⚪ declined</p>
      </div>
    </div>
  )
}

export default function Dispatcher({ cases, offers, hospitals, ambulances, actor, notify, onLogCall }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const now = useNow()
  const active = useMemo(() => cases.filter((c) => c.status !== 'closed').sort((a, b) => priority(a) - priority(b) || a.createdAtMs - b.createdAtMs), [cases])
  const closed = useMemo(() => cases.filter((c) => c.status === 'closed').sort((a, b) => (b.closedAtMs ?? 0) - (a.closedAtMs ?? 0)).slice(0, 5), [cases])
  const current = cases.find((c) => c.id === (selected ?? active[0]?.id)) ?? null
  const free = ambulances.filter((a) => a.available).length
  const escalations = active.filter((c) => c.escalation !== 'none').length

  return (
    <div className="dispatcher">
      <div className="kpis">
        <div className="kpi"><b>{active.length}</b><span>active</span></div>
        <div className={`kpi ${escalations ? 'crit' : ''}`}><b>{escalations}</b><span>escalations</span></div>
        <div className="kpi"><b>{free}/{ambulances.length}</b><span>ambulances free</span></div>
        <div className="kpi"><b>{hospitals.filter((h) => !h.diverted).length}/{hospitals.length}</b><span>hospitals open</span></div>
        <button className="btn sm" onClick={onLogCall}>＋ Log a phoned-in call</button>
      </div>
      <p className="sub engine">⚙️ This console runs the timeout and re-routing engine every few seconds. Keep at least one dispatcher console open while cases are active.</p>
      <div className="split">
        <aside className="queue" aria-label="Incident queue">
          {!active.length && <Empty icon="🟢" title="No active emergencies">New reports appear here instantly.</Empty>}
          {active.map((c) => {
            const co = offers.filter((o) => o.caseId === c.id)
            return (
              <button key={c.id} className={`qitem ${(selected ?? active[0]?.id) === c.id ? 'on' : ''} ${c.escalation !== 'none' ? 'esc' : ''}`} onClick={() => setSelected(c.id)} aria-current={(selected ?? active[0]?.id) === c.id}>
                <span className="qicon" aria-hidden>{CASE_TYPES[c.type].icon}</span>
                <span className="qmain"><b>{CASE_TYPES[c.type].label}</b><small>{c.brief || 'No summary'}</small>
                  <span className="row tight"><SeverityBadge severity={c.severity} /><StatusBadge status={c.status} /><OfferCounts offers={co} />{c.escalation !== 'none' && <Badge tone="red">🔔</Badge>}</span>
                </span>
                <span className="mono small">{Math.floor((now - c.createdAtMs) / 60000)}m</span>
              </button>
            )
          })}
          {closed.length > 0 && <details className="closed"><summary className="sub link">Recently closed ({closed.length})</summary>
            {closed.map((c) => <button key={c.id} className="qitem dim" onClick={() => setSelected(c.id)}><span className="qicon">{CASE_TYPES[c.type].icon}</span><span className="qmain"><b>{CASE_TYPES[c.type].label}</b><small>{c.closeReason}</small></span></button>)}
          </details>}
        </aside>
        <section className="detail">
          {current ? <CaseDetail key={current.id} c={current} allCases={cases} offers={offers.filter((o) => o.caseId === current.id)} hospitals={hospitals} ambulances={ambulances} actor={actor} notify={notify} />
            : <Empty icon="🎛️" title="Select an incident">Choose a case from the queue to coordinate it.</Empty>}
        </section>
      </div>
    </div>
  )
}
