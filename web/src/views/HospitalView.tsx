import { useEffect, useMemo, useState } from 'react'
import { HandoffCard } from '../components/AiPanels'
import { EvidenceGallery } from '../components/Evidence'
import MapView from '../components/MapView'
import { Empty, ErrorBox, GoldenRing, Icon, Notice, OfferPill, Panel, Pill, PosSource, RelayTrack, SeverityTag, StatusPill, Switch, TYPE_ICON, type Notify } from '../components/ui'
import { CAPABILITIES, CAPABILITY_LABEL, CASE_TYPES, DECLINE_REASONS, confirmationPrompt } from '../lib/capabilities'
import { agoText, estimateMinutes } from '../lib/geo'
import { db } from '../lib/firebase'
import { eligibility, STALE_AVAILABILITY_MS } from '../lib/matching'
import { useEvidence, useNow, usePatientPrivate } from '../lib/store'
import type { Capability, Case, Hospital, Offer, UserProfile } from '../lib/types'
import { confirmArrival, confirmAvailability, markOfferSeen, respondToOffer, revokeOffer, updateHospitalProfile, type Actor } from '../lib/workflow'

interface Props {
  profile: UserProfile
  actor: Actor
  hospital: Hospital | undefined
  cases: Case[]
  offers: Offer[]
  hospitals: Hospital[]
  notify: Notify
  selected: string | null
  onSelect: (id: string | null) => void
}

const hm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// ---------------------------------------------------------------- one case, from this hospital's side

function CaseFile({ o, c, hospital, hospitals, actor, notify }: { o: Offer; c: Case | undefined; hospital: Hospital; hospitals: Hospital[]; actor: Actor; notify: Notify }) {
  const now = useNow()
  const evidence = useEvidence(c ? c.id : null, !!c)
  const destination = o.state === 'selected'
  const priv = usePatientPrivate(c?.id ?? null, destination)
  const [ticks, setTicks] = useState<Partial<Record<Capability, boolean>>>({})
  const [canReceive, setCanReceive] = useState(false)
  const [reason, setReason] = useState<string>(DECLINE_REASONS[0])
  const [why, setWhy] = useState<string>(DECLINE_REASONS[0])
  const [suggestId, setSuggestId] = useState('')
  const [busy, setBusy] = useState(false)
  const open = o.state === 'pending' && o.expiresAtMs > now
  const left = Math.max(0, Math.ceil((o.expiresAtMs - now) / 1000))

  useEffect(() => { if (!o.seenAtMs) void markOfferSeen(db, o).catch(() => undefined) }, [o])
  const act = async (fn: () => Promise<unknown>, ok?: string) => { setBusy(true); try { await fn(); if (ok) notify(ok, 'good') } catch (e) { notify(`${(e as Error).message}. The request may have expired.`, 'warn') } finally { setBusy(false) } }

  if (!c) {
    // After declining, timing out or being stood down this hospital no longer has access to the case or its files.
    return (
      <Panel title="Request closed" quiet>
        <div className="row row-tight"><OfferPill state={o.state} /><span className="fine">{o.respondedAtMs ? hm(o.respondedAtMs) : hm(o.requestedAtMs)}</span></div>
        <p className="sub measure">{o.state === 'declined' ? `You declined${o.declineReason ? `: ${o.declineReason}` : ''}.` : o.state === 'timeout' ? 'The deadline passed with no answer.' : o.state === 'withdrawn' ? 'Dispatch chose another hospital.' : 'This request is no longer active.'} For privacy, the case details and files are no longer available to you.</p>
      </Panel>
    )
  }

  const suggestions = hospitals.filter((h) => h.id !== hospital.id && eligibility(c, [h]).eligible.length > 0)
  const allConfirmed = c.requiredCapabilities.every((cap) => ticks[cap]) && canReceive
  const eta = c.ambulancePos ? estimateMinutes(c.ambulancePos, hospital) : null
  const t = CASE_TYPES[c.type]
  const you = o.state === 'pending' || (c.status === 'arrived' && !c.arrivalConfirmedAtMs && destination)

  return (
    <div className="stack-lg">
      <RelayTrack c={c} offers={[o]} viewer="hospital" />
      <div className="cols-2">
        <div className="stack">
          <Panel title={<><Icon name={TYPE_ICON[c.type]} size={20} /> {t.label}, {c.patients} patient{c.patients > 1 ? 's' : ''}</>} actions={<div className="row row-tight"><SeverityTag severity={c.severity} /><OfferPill state={o.state} /></div>} move={you}>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <GoldenRing createdAtMs={c.createdAtMs} frozenAtMs={c.arrivalConfirmedAtMs} small />
              <div className="stack-sm grow">
                <p className="strong measure">&ldquo;{c.brief || 'No summary provided'}&rdquo;</p>
                <p className="fine">Needs {c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' and ')}. Reported {agoText(c.createdAtMs, now)}.</p>
              </div>
              {open && <div className="deadline" role="timer" aria-label="Time left to answer"><span className="fine strong">Answer within</span><b className={`num ${left < 20 ? 'crit' : ''}`}>{left}s</b></div>}
            </div>
            <dl className="facts">
              <div><dt>From the scene to you</dt><dd>{o.distanceKm} km, about {o.etaMin} min{o.etaSource === 'estimate' ? ' (estimate)' : ''}</dd></div>
              <div><dt>Crew</dt><dd>{c.ambulanceCallSign ?? 'Not assigned'} <PosSource pos={c.ambulancePos} /></dd></div>
              <div><dt>Crew to scene</dt><dd>{['onscene', 'transporting', 'arrived'].includes(c.status) ? 'Reached the scene' : c.etaSceneMin !== null ? `about ${c.etaSceneMin} min${c.etaSource === 'estimate' ? ' (estimate)' : ''}` : 'Unknown'}</dd></div>
              <div><dt>Crew to you</dt><dd>{destination && eta !== null && c.status !== 'arrived' ? `about ${eta} min (estimate)` : destination ? 'Arrived' : 'Not travelling here yet'}</dd></div>
            </dl>
            {destination && priv && <div className="inset"><p><Icon name="phone" size={16} /> <b>{priv.contact || 'No phone given'}</b></p>{priv.note && <p className="sub">{priv.note}</p>}</div>}
            {!destination && <p className="fine">The reporter&apos;s phone number and private detail are only shared with the hospital that is chosen.</p>}
          </Panel>

          {open ? (
            <Panel title="Confirm for this patient, right now" move>
              <p className="sub measure">Tick only what is true at this moment. Accept unlocks when every item is confirmed. If you cannot confirm something, decline so dispatch can ask another hospital.</p>
              <fieldset className="stack-sm" disabled={busy}>
                <legend className="sr-only">Confirmations</legend>
                {c.requiredCapabilities.map((cap) => {
                  const av = hospital.availability
                  const stale = now - av.confirmedAtMs > STALE_AVAILABILITY_MS
                  const hint = av.resources[cap] === undefined ? '' : av.resources[cap] ? `Your availability page says yes (${agoText(av.confirmedAtMs, now)}${stale ? ', out of date' : ''}).` : 'Your availability page says it is NOT available.'
                  return (
                    <label key={cap} className="choice"><input type="checkbox" checked={!!ticks[cap]} onChange={(e) => setTicks((s) => ({ ...s, [cap]: e.target.checked }))} />
                      <span><b>{confirmationPrompt(c.type, cap)}</b>{hint && <span className="hint">{hint} Please confirm it physically.</span>}</span></label>
                  )
                })}
                <label className="choice"><input type="checkbox" checked={canReceive} onChange={(e) => setCanReceive(e.target.checked)} /><span><b>We can receive this patient when they arrive</b></span></label>
              </fieldset>
              <div className="row">
                <button className="btn btn-go btn-lg" disabled={!allConfirmed || busy} onClick={() => act(() => respondToOffer(db, actor, o, { accept: true, canReceive, confirmations: Object.fromEntries(c.requiredCapabilities.map((cap) => [cap, !!ticks[cap]])), declineReason: null }), 'Accepted. Dispatch has your confirmation.')}><Icon name="check" /> Accept this patient</button>
                <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for declining" style={{ maxWidth: 300 }}>{DECLINE_REASONS.map((r) => <option key={r}>{r}</option>)}</select>
                <button className="btn btn-danger" disabled={busy} onClick={() => act(() => respondToOffer(db, actor, o, { accept: false, canReceive: false, confirmations: {}, declineReason: reason, suggest: suggestions.find((h) => h.id === suggestId) ? { id: suggestId, name: suggestions.find((h) => h.id === suggestId)!.name } : null }), 'Declined. Dispatch will ask other hospitals.')}>Decline</button>
              </div>
              {suggestions.length > 0 && (
                <label className="field"><span className="field-label">If you decline: another hospital you think is better placed <small>(optional)</small></span>
                  <select value={suggestId} onChange={(e) => setSuggestId(e.target.value)}><option value="">No suggestion</option>{suggestions.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
                  <span className="hint">Only hospitals whose profile covers this patient&apos;s needs are listed. Dispatch decides whether to ask them, and they must still confirm.</span>
                </label>
              )}
            </Panel>
          ) : (
            <Notice tone={o.state === 'selected' ? 'go' : o.state === 'accepted' ? 'star' : 'wait'} title={o.state === 'selected' ? 'You are the confirmed destination' : o.state === 'accepted' ? 'You accepted. Waiting for dispatch to choose' : 'This request is no longer open for an answer'}>
              {o.state === 'selected' ? 'Prepare the team. The crew has been told to bring the patient to you.' : o.state === 'accepted' ? 'You will be told if you are chosen. Dispatch may choose a closer hospital.' : o.state === 'pending' ? 'The deadline passed, so dispatch is asking other hospitals.' : 'Nothing more is needed from you.'}
            </Notice>
          )}

          {destination && c.status === 'arrived' && !c.arrivalConfirmedAtMs && (
            <Panel title="Handover" move actions={<span className="mover you">Your move</span>}>
              <p className="strong">The crew has arrived with the patient.</p>
              <button className="btn btn-go btn-lg" disabled={busy} onClick={() => act(() => confirmArrival(db, actor, c), 'Receipt confirmed. Dispatch can now close the case.')}><Icon name="check" /> Confirm we received the patient</button>
            </Panel>
          )}
          {c.arrivalConfirmedAtMs && <Notice tone="go" title={`You confirmed receipt at ${hm(c.arrivalConfirmedAtMs)}`}>Dispatch closes the case from here.</Notice>}

          {(o.state === 'accepted' || (destination && c.status !== 'arrived' && c.status !== 'closed')) && (
            <details className="panel panel--quiet"><summary className="panel-head" style={{ cursor: 'pointer' }}><span className="strong">Can no longer receive this patient?</span></summary>
              <div className="panel-body"><div className="row"><select value={why} onChange={(e) => setWhy(e.target.value)} aria-label="Reason"><option>{DECLINE_REASONS[2]}</option>{DECLINE_REASONS.filter((r) => r !== DECLINE_REASONS[2]).map((r) => <option key={r}>{r}</option>)}</select>
                <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => act(() => revokeOffer(db, actor, o, why), 'Withdrawn. Dispatch has been told to re-route.')}>Withdraw my acceptance</button></div></div></details>
          )}

          <HandoffCard caseId={c.id} />
          <Panel title="Evidence from the reporter" quiet><EvidenceGallery caseId={c.id} items={evidence.data} expected={c.evidenceExpected} empty="No files were attached." loading={!evidence.ready} /></Panel>
        </div>
        <div className="sticky"><MapView cases={[c]} hospitals={[hospital]} hospitalStates={{ [hospital.id]: o.state }} focus={[c, hospital, ...(c.ambulancePos ? [c.ambulancePos] : [])]} height={440} label="Incident, ambulance and your hospital" /></div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- "Our hospital": profile, availability, diversion

function OurHospital({ hospital, actor, notify }: { hospital: Hospital; actor: Actor; notify: Notify }) {
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
    <div className="cols-2">
      <Panel title="What this hospital can do">
        <p className="sub measure">The permanent capability profile decides who is asked at all. Updated {agoText(hospital.capabilitiesUpdatedAtMs, now)}. It is never treated as proof that something is available now.</p>
        <div className="picker" role="group" aria-label="Capabilities">{CAPABILITIES.map((c) => <button type="button" key={c.id} className="pick" aria-pressed={caps.includes(c.id)} onClick={() => setCaps((l) => toggle(l, c.id))}><Icon name="hospital" />{c.label}</button>)}</div>
        <Switch checked={div} onChange={setDiv} label="Full diversion" hint="Do not send any new patients." />
        <div className="stack-sm"><p className="field-label">Or divert only some services</p><div className="row row-tight">{caps.map((c) => <label key={c} className="pill" style={{ cursor: 'pointer', padding: '6px 12px' }}><input type="checkbox" checked={divCaps.includes(c)} onChange={() => setDivCaps((l) => toggle(l, c))} /> {CAPABILITY_LABEL[c]}</label>)}</div></div>
        <button className="btn btn-ink" disabled={busy || !caps.length} onClick={() => save(() => updateHospitalProfile(db, actor, hospital, { capabilities: caps, diverted: div, divertedCapabilities: divCaps.filter((c) => caps.includes(c)) }), 'Profile and diversion saved.')}>Save profile and diversion</button>
      </Panel>
      <Panel title="What is available right now">
        <p className="sub measure">{stale ? <b style={{ color: 'var(--wait)' }}>Last confirmed {agoText(hospital.availability.confirmedAtMs, now)}, so it is out of date. </b> : <>Last confirmed {agoText(hospital.availability.confirmedAtMs, now)}. </>}This is only a reminder for your own team. For every patient you are still asked to confirm resources yourself.</p>
        <div className="row"><label className="field grow"><span className="field-label">Emergency beds</span><input type="number" min={0} max={999} value={beds} onChange={(e) => setBeds(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
          <label className="field grow"><span className="field-label">ICU beds</span><input type="number" min={0} max={999} value={icu} onChange={(e) => setIcu(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label></div>
        <div className="stack-sm">{caps.map((c) => <Switch key={c} checked={!!res[c]} onChange={(v) => setRes((r) => ({ ...r, [c]: v }))} label={`${CAPABILITY_LABEL[c]} ready`} hint={c === 'antivenom' ? 'Antivenom physically in stock' : undefined} />)}</div>
        <button className="btn btn-ink" disabled={busy} onClick={() => save(() => confirmAvailability(db, actor, hospital, { emergencyBeds: beds, icuBeds: icu, resources: Object.fromEntries(caps.map((c) => [c, !!res[c]])) }), 'Availability confirmed.')}>Confirm availability now</button>
      </Panel>
    </div>
  )
}

// ---------------------------------------------------------------- inbox

export default function HospitalView({ profile, actor, hospital, cases, offers, hospitals, notify, selected, onSelect }: Props) {
  const [tab, setTab] = useState<'cases' | 'hospital'>('cases')
  const now = useNow()
  const byCase = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases])
  const rows = useMemo(() => [...offers].sort((a, b) => b.requestedAtMs - a.requestedAtMs), [offers])
  const live = rows.filter((o) => !['closed'].includes(byCase.get(o.caseId)?.status ?? 'x') && (o.state === 'pending' || o.state === 'accepted' || o.state === 'selected'))
  const pending = live.filter((o) => o.state === 'pending' && o.expiresAtMs > now)
  const earlier = rows.filter((o) => !live.includes(o))
  const currentId = selected ?? live[0]?.id ?? earlier[0]?.id ?? null
  const current = rows.find((o) => o.id === currentId) ?? null

  if (!hospital) return <ErrorBox>Your account is linked to a hospital (&ldquo;{profile.hospitalId}&rdquo;) that could not be found. Ask your administrator.</ErrorBox>

  const strip = (o: Offer) => {
    const c = byCase.get(o.caseId)
    const open = o.state === 'pending' && o.expiresAtMs > now
    return (
      <button key={o.id} className="strip" aria-current={currentId === o.id} onClick={() => onSelect(o.id)} style={{ ['--tag' as string]: c ? (c.severity === 1 ? 'var(--signal)' : c.severity === 2 ? '#e08a00' : 'var(--go)') : 'var(--line-soft)' }}>
        <span className="strip-stub" />
        <span className="strip-body">
          <span className="strip-title">{c ? <><Icon name={TYPE_ICON[c.type]} size={18} />{CASE_TYPES[c.type].label}</> : 'Closed request'}{open && <span className="mover you">Your move</span>}</span>
          <span className="strip-sub">{c ? c.brief || 'No summary' : 'Details no longer available to you'}</span>
          <span className="row row-tight"><OfferPill state={o.state} />{c && <StatusPill status={c.status} />}</span>
        </span>
        <span className="strip-meta num">{open ? `${Math.max(0, Math.ceil((o.expiresAtMs - now) / 1000))} s` : hm(o.requestedAtMs)}</span>
      </button>
    )
  }

  return (
    <div className="stack-lg">
      <div className="row row-between">
        <div><h1 className="title">{hospital.name}</h1><p className="sub">{hospital.area}</p></div>
        <div className="row row-tight">{hospital.diverted ? <Pill tone="signal">On full diversion</Pill> : <Pill tone="go">Accepting patients</Pill>}{hospital.divertedCapabilities.length > 0 && <Pill tone="wait">Diverting {hospital.divertedCapabilities.map((c) => CAPABILITY_LABEL[c]).join(', ')}</Pill>}</div>
      </div>
      <div className="tablist" role="tablist">
        <button role="tab" aria-selected={tab === 'cases'} onClick={() => setTab('cases')}>Cases{pending.length > 0 && <span className="count">{pending.length}</span>}</button>
        <button role="tab" aria-selected={tab === 'hospital'} onClick={() => setTab('hospital')}>Our hospital</button>
      </div>
      {tab === 'hospital' ? <OurHospital hospital={hospital} actor={actor} notify={notify} /> : (
        <div className="inbox">
          <aside className="stack" aria-label="Requests">
            {rows.length === 0 ? <Empty icon="list" title="No requests yet">When dispatch has a crew on the way, the nearest hospitals that can treat the patient are asked here, instantly.</Empty> : (
              <>
                {live.length > 0 && <div className="stack-sm"><h2 className="h-sm">Active</h2><div className="strips">{live.map(strip)}</div></div>}
                {earlier.length > 0 && <div className="stack-sm"><h2 className="h-sm">Earlier</h2><div className="strips">{earlier.slice(0, 20).map(strip)}</div></div>}
              </>
            )}
          </aside>
          <section aria-label="Case file">{current ? <CaseFile key={current.id} o={current} c={byCase.get(current.caseId)} hospital={hospital} hospitals={hospitals} actor={actor} notify={notify} /> : <Empty icon="hospital" title="Nothing to review">Select a request to see the case file.</Empty>}</section>
        </div>
      )}
    </div>
  )
}
