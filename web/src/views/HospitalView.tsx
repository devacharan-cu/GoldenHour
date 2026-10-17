import { useEffect, useMemo, useState } from 'react'
import MapView from '../components/MapView'
import { Badge, Countdown, Empty, ErrorBox, OfferBadge, PosSource, SeverityBadge, StatusBadge, caseTitle } from '../components/bits'
import { CAPABILITIES, CAPABILITY_LABEL, CASE_TYPES, DECLINE_REASONS, confirmationPrompt } from '../lib/capabilities'
import { agoText, estimateMinutes } from '../lib/geo'
import { STALE_AVAILABILITY_MS } from '../lib/matching'
import { db } from '../lib/firebase'
import { useNow, usePatientPrivate } from '../lib/store'
import type { Capability, Case, Hospital, Offer, UserProfile } from '../lib/types'
import { confirmArrival, confirmAvailability, markOfferSeen, respondToOffer, revokeOffer, updateHospitalProfile, type Actor } from '../lib/workflow'

interface Props {
  profile: UserProfile
  actor: Actor
  hospital: Hospital | undefined
  cases: Case[]
  offers: Offer[]
  notify: (m: string, tone?: string) => void
}

type Tab = 'requests' | 'patients' | 'profile'

function RequestCard({ o, c, hospital, actor, notify }: { o: Offer; c: Case; hospital: Hospital; actor: Actor; notify: Props['notify'] }) {
  const now = useNow()
  const t = CASE_TYPES[c.type]
  const [ticks, setTicks] = useState<Partial<Record<Capability, boolean>>>({})
  const [canReceive, setCanReceive] = useState(false)
  const [reason, setReason] = useState<string>(DECLINE_REASONS[0])
  const [busy, setBusy] = useState(false)
  const open = o.state === 'pending' && o.expiresAtMs > now
  const allConfirmed = c.requiredCapabilities.every((cap) => ticks[cap]) && canReceive
  const left = Math.max(0, Math.ceil((o.expiresAtMs - now) / 1000))
  const distToScene = c.ambulancePos ? estimateMinutes(c.ambulancePos, c) : null

  useEffect(() => { if (!o.seenAtMs) void markOfferSeen(db, o).catch(() => undefined) }, [o])

  const send = async (accept: boolean) => {
    setBusy(true)
    try {
      await respondToOffer(db, actor, o, { accept, canReceive: accept ? canReceive : false, confirmations: accept ? Object.fromEntries(c.requiredCapabilities.map((cap) => [cap, !!ticks[cap]])) : {}, declineReason: accept ? null : reason })
      notify(accept ? 'Accepted. Dispatch has your confirmation.' : 'Declined. Dispatch will ask other hospitals.', accept ? 'good' : undefined)
    } catch (e) {
      notify(`Could not send your answer: ${(e as Error).message}. The request may have expired.`, 'warn')
    } finally { setBusy(false) }
  }

  return (
    <div className={`card stack req ${open ? 'live' : ''}`}>
      <div className="row between">
        <div>
          <h3 className="h">{t.icon} {caseTitle(c, t.label)}</h3>
          <div className="row tight"><SeverityBadge severity={c.severity} /><StatusBadge status={c.status} /><OfferBadge state={o.state} />{c.needsIcu && <Badge tone="violet">ICU likely</Badge>}</div>
        </div>
        {open && <div className="deadline" role="timer" aria-label="Time left to answer"><span className="countdown-label">Answer within</span><b className={left < 20 ? 'crit' : ''}>{left}s</b></div>}
      </div>
      <p>“{c.brief || 'No summary provided'}”</p>
      <div className="facts">
        <div><span>Distance from scene</span><b>{o.distanceKm} km · ~{o.etaMin} min{o.etaSource === 'estimate' ? ' (est.)' : ''}</b></div>
        <div><span>Ambulance</span><b>{c.ambulanceCallSign ?? '—'} {c.ambulancePos && <PosSource pos={c.ambulancePos} />}</b></div>
        <div><span>Arrives at scene</span><b>{c.status === 'onscene' || c.status === 'transporting' ? 'there now' : c.etaSceneMin !== null ? `~${c.etaSceneMin} min${c.etaSource === 'estimate' ? ' (est.)' : ''}` : '—'}</b></div>
        <div><span>Needs</span><b>{c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' + ')}</b></div>
      </div>
      {distToScene !== null && <p className="sub">Ambulance is ~{distToScene} min from the scene (estimate from its last position).</p>}

      {open ? (
        <fieldset className="confirm" disabled={busy}>
          <legend>Confirm for THIS case, right now</legend>
          {c.requiredCapabilities.map((cap) => {
            const av = hospital.availability
            const stale = now - av.confirmedAtMs > STALE_AVAILABILITY_MS
            const hint = av.resources[cap] === undefined ? '' : av.resources[cap] ? `Your availability says yes (${agoText(av.confirmedAtMs, now)}${stale ? ', stale' : ''})` : 'Your availability says NOT available'
            return (
              <label key={cap} className="check big-check">
                <input type="checkbox" checked={!!ticks[cap]} onChange={(e) => setTicks((s) => ({ ...s, [cap]: e.target.checked }))} />
                <span>{confirmationPrompt(c.type, cap)}{hint && <small>{hint}. Please confirm it physically.</small>}</span>
              </label>
            )
          })}
          <label className="check big-check"><input type="checkbox" checked={canReceive} onChange={(e) => setCanReceive(e.target.checked)} /><span>We can receive this patient on arrival</span></label>
          <div className="row">
            <button className="btn good big" disabled={!allConfirmed || busy} onClick={() => send(true)}>✅ Accept patient</button>
            <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for declining">{DECLINE_REASONS.map((r) => <option key={r}>{r}</option>)}</select>
            <button className="btn warn" disabled={busy} onClick={() => send(false)}>Decline</button>
          </div>
          {!allConfirmed && <p className="sub">Accept unlocks only when every item above is confirmed. If you cannot confirm something, decline so dispatch can ask another hospital.</p>}
        </fieldset>
      ) : (
        <p className="sub">{o.state === 'pending' ? '⏱ The deadline passed, so dispatch is asking other hospitals.' : o.state === 'accepted' ? 'You accepted. Waiting for dispatch to confirm the destination.' : o.state === 'selected' ? '✅ You are the confirmed destination.' : o.state === 'declined' ? `You declined${o.declineReason ? `: ${o.declineReason}` : ''}.` : o.state === 'withdrawn' ? 'Dispatch chose another hospital. Thank you.' : 'No response was recorded before the deadline.'}</p>
      )}
    </div>
  )
}

function ActivePatient({ c, o, hospital, actor, notify }: { c: Case; o: Offer; hospital: Hospital; actor: Actor; notify: Props['notify'] }) {
  const now = useNow()
  const priv = usePatientPrivate(c.id, o.state === 'selected')
  const [busy, setBusy] = useState(false)
  const [why, setWhy] = useState('Resource ran out')
  const eta = c.ambulancePos ? estimateMinutes(c.ambulancePos, hospital) : null
  const guard = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); notify(ok, 'good') } catch (e) { notify((e as Error).message, 'warn') } finally { setBusy(false) } }
  return (
    <div className="grid two">
      <div className="card stack">
        <div className="row between"><h3 className="h">{CASE_TYPES[c.type].icon} {caseTitle(c, CASE_TYPES[c.type].label)}</h3><StatusBadge status={c.status} /></div>
        <Countdown createdAtMs={c.createdAtMs} frozenAtMs={c.arrivalConfirmedAtMs} />
        <p>“{c.brief}”</p>
        {priv && <p className="sub">📞 {priv.contact || 'no phone'}{priv.note ? ` · ${priv.note}` : ''}</p>}
        <div className="row"><Badge tone="blue">🚑 {c.ambulanceCallSign}</Badge><PosSource pos={c.ambulancePos} />{eta !== null && ['transporting', 'onscene', 'enroute'].includes(c.status) && <Badge tone="amber">~{eta} min from here (estimate)</Badge>}{c.ambulancePos && <span className="sub">updated {agoText(c.ambulancePos.atMs, now)}</span>}</div>
        {c.status === 'arrived' && !c.arrivalConfirmedAtMs && <button className="btn good big" disabled={busy} onClick={() => guard(() => confirmArrival(db, actor, c), 'Arrival confirmed')}>🏁 Confirm patient has arrived</button>}
        {c.arrivalConfirmedAtMs && <Badge tone="green">Arrival confirmed {agoText(c.arrivalConfirmedAtMs, now)}</Badge>}
        {['dispatched', 'enroute', 'onscene', 'transporting'].includes(c.status) && (
          <details><summary className="sub link">Can no longer receive?</summary>
            <div className="row" style={{ marginTop: 8 }}>
              <select value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Reason">{DECLINE_REASONS.map((r) => <option key={r}>{r}</option>)}</select>
              <button className="btn warn sm" disabled={busy} onClick={() => guard(() => revokeOffer(db, actor, o, why), 'Withdrawn. Dispatch has been alerted to re-route.')}>Withdraw acceptance</button>
            </div>
          </details>
        )}
      </div>
      <MapView cases={[c]} hospitals={[hospital]} hospitalStates={{ [hospital.id]: 'selected' }} focus={[c, hospital, ...(c.ambulancePos ? [c.ambulancePos] : [])]} height={360} label="Ambulance approaching hospital" />
    </div>
  )
}

function ProfileTab({ hospital, actor, notify }: { hospital: Hospital; actor: Actor; notify: Props['notify'] }) {
  const now = useNow()
  const [caps, setCaps] = useState<Capability[]>(hospital.capabilities)
  const [div, setDiv] = useState(hospital.diverted)
  const [divCaps, setDivCaps] = useState<Capability[]>(hospital.divertedCapabilities)
  const [beds, setBeds] = useState(hospital.availability.emergencyBeds)
  const [icu, setIcu] = useState(hospital.availability.icuBeds)
  const [res, setRes] = useState<Partial<Record<Capability, boolean>>>(hospital.availability.resources)
  const [busy, setBusy] = useState(false)
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const stale = now - hospital.availability.confirmedAtMs > STALE_AVAILABILITY_MS

  const save = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); try { await fn(); notify(ok, 'good') } catch (e) { notify((e as Error).message, 'warn') } finally { setBusy(false) } }

  return (
    <div className="grid two">
      <div className="card stack">
        <div><h3 className="h">Permanent capability profile</h3><p className="sub">What this hospital is equipped to do. Used to decide who gets asked. Updated {agoText(hospital.capabilitiesUpdatedAtMs, now)}.</p></div>
        <div className="chips">{CAPABILITIES.map((c) => <button type="button" key={c.id} className="chip" aria-pressed={caps.includes(c.id)} onClick={() => setCaps((l) => toggle(l, c.id))}><span aria-hidden>{c.icon}</span>{c.label}</button>)}</div>
        <div><h4 className="h2">Diversion</h4>
          <label className="check"><input type="checkbox" checked={div} onChange={(e) => setDiv(e.target.checked)} />Full diversion: do not send any new patients</label>
          <p className="sub">Or divert only specific services:</p>
          <div className="row tight">{caps.map((c) => <label key={c} className="check pill"><input type="checkbox" checked={divCaps.includes(c)} onChange={() => setDivCaps((l) => toggle(l, c))} />{CAPABILITY_LABEL[c]}</label>)}</div>
        </div>
        <button className="btn primary" disabled={busy || !caps.length} onClick={() => save(() => updateHospitalProfile(db, actor, hospital, { capabilities: caps, diverted: div, divertedCapabilities: divCaps.filter((c) => caps.includes(c)) }), 'Profile saved')}>Save profile and diversion</button>
      </div>
      <div className="card stack">
        <div>
          <h3 className="h">Live availability</h3>
          <p className="sub">Separate from the profile. {stale ? <b className="warn-text">Last confirmed {agoText(hospital.availability.confirmedAtMs, now)}: stale.</b> : <>Last confirmed {agoText(hospital.availability.confirmedAtMs, now)}.</>} Shown to you as a reminder only; for every case you must still confirm resources yourself.</p>
        </div>
        <div className="row">
          <label style={{ flex: 1 }}>Emergency beds<input type="number" min={0} max={999} value={beds} onChange={(e) => setBeds(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
          <label style={{ flex: 1 }}>ICU beds<input type="number" min={0} max={999} value={icu} onChange={(e) => setIcu(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
        </div>
        <p className="sub">Resources available right now:</p>
        <div className="stack tight">{caps.map((c) => <label key={c} className="check"><input type="checkbox" checked={!!res[c]} onChange={(e) => setRes((r) => ({ ...r, [c]: e.target.checked }))} />{CAPABILITY_LABEL[c]} ready{c === 'antivenom' ? ' (antivenom in stock)' : ''}</label>)}</div>
        <button className="btn primary" disabled={busy} onClick={() => save(() => confirmAvailability(db, actor, hospital, { emergencyBeds: beds, icuBeds: icu, resources: Object.fromEntries(caps.map((c) => [c, !!res[c]])) }), 'Availability confirmed')}>Confirm availability now</button>
      </div>
    </div>
  )
}

export default function HospitalView({ profile, actor, hospital, cases, offers, notify }: Props) {
  const [tab, setTab] = useState<Tab>('requests')
  const byCase = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases])
  const rows = offers.map((o) => ({ o, c: byCase.get(o.caseId) })).filter((x): x is { o: Offer; c: Case } => !!x.c)
  const now = useNow()
  const pending = rows.filter((r) => r.o.state === 'pending' && r.o.expiresAtMs > now && r.c.status !== 'closed')
  const history = rows.filter((r) => !pending.includes(r) && r.c.status !== 'closed').sort((a, b) => b.o.requestedAtMs - a.o.requestedAtMs)
  const active = rows.filter((r) => r.o.state === 'selected' && r.c.status !== 'closed')
  const waiting = rows.filter((r) => r.o.state === 'accepted' && r.c.status !== 'closed')

  if (!hospital) return <ErrorBox>Your account is linked to hospital “{profile.hospitalId}”, which was not found. Ask an administrator.</ErrorBox>
  return (
    <div className="stack">
      <div className="row between">
        <div><h2 className="h">{hospital.name}</h2><p className="sub">{hospital.area}{hospital.diverted ? ' · ON FULL DIVERSION' : ''}</p></div>
        <div className="row tight">{hospital.diverted ? <Badge tone="red">Diverted</Badge> : <Badge tone="green">Accepting</Badge>}{hospital.divertedCapabilities.length > 0 && <Badge tone="amber">Diverting {hospital.divertedCapabilities.map((c) => CAPABILITY_LABEL[c]).join(', ')}</Badge>}</div>
      </div>
      <div className="subtabs" role="tablist">
        {([['requests', `Requests${pending.length ? ` (${pending.length})` : ''}`], ['patients', `Incoming patients${active.length ? ` (${active.length})` : ''}`], ['profile', 'Profile & availability']] as [Tab, string][]).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={`subtab ${id === 'requests' && pending.length ? 'alert' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'requests' && (
        <div className="stack">
          {!pending.length && <Empty icon="📭" title="No requests waiting">When dispatch sends an ambulance, the nearest capable hospitals appear here instantly.</Empty>}
          {pending.map(({ o, c }) => <RequestCard key={o.id} o={o} c={c} hospital={hospital} actor={actor} notify={notify} />)}
          {history.length > 0 && <h3 className="h2">Earlier requests</h3>}
          {history.map(({ o, c }) => <RequestCard key={o.id} o={o} c={c} hospital={hospital} actor={actor} notify={notify} />)}
        </div>
      )}
      {tab === 'patients' && (
        <div className="stack">
          {!active.length && !waiting.length && <Empty icon="🏥" title="No patients on the way">Confirmed arrivals appear here with the live ambulance position.</Empty>}
          {waiting.map(({ c, o }) => <div key={o.id} className="card"><b>{CASE_TYPES[c.type].icon} {caseTitle(c, CASE_TYPES[c.type].label)}</b><p className="sub">You accepted this one. Waiting for dispatch to confirm the destination.</p></div>)}
          {active.map(({ c, o }) => <ActivePatient key={o.id} c={c} o={o} hospital={hospital} actor={actor} notify={notify} />)}
        </div>
      )}
      {tab === 'profile' && <ProfileTab hospital={hospital} actor={actor} notify={notify} />}
    </div>
  )
}
