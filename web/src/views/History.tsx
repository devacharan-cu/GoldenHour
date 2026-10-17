import { useMemo, useState } from 'react'
import { HandoffCard } from '../components/AiPanels'
import { EvidenceGallery } from '../components/Evidence'
import { Empty, ErrorBox, GoldenRing, Icon, Panel, Pill, SeverityTag, StatusPill, Timeline, TYPE_ICON, type Notify } from '../components/ui'
import { CASE_TYPES } from '../lib/capabilities'
import { formatClock } from '../lib/geo'
import { useCaseById, useCaseHistory, useEvents, useEvidence } from '../lib/store'
import { CLOSE_LABEL, closeKindOf, type Ambulance, type Case, type CaseStatus, type CaseType, type Hospital, type Offer, type UserProfile } from '../lib/types'
import { filterCases } from '../lib/history'
import { Workbench } from './Dispatcher'
import type { Actor } from '../lib/workflow'

interface Props {
  profile: UserProfile
  uid: string
  actor: Actor
  hospitals: Hospital[]
  ambulances: Ambulance[]
  offers: Offer[]
  allCases: Case[]
  notify: Notify
  openId: string | null
  onOpen: (id: string | null) => void
}

const dt = (ms: number) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const duration = (c: Case) => (c.closedAtMs ? formatClock(c.closedAtMs - c.createdAtMs).replace('+', '') : null)

/** Read-only file for people who are not dispatchers: what they are allowed to see about a finished or running case. */
function CaseSummary({ c, role, notify }: { c: Case; role: UserProfile['role']; notify: Notify }) {
  const evidence = useEvidence(c.id)
  const events = useEvents(c.id, role === 'ambulance')
  void notify
  return (
    <div className="stack">
      <Panel title={<><Icon name={TYPE_ICON[c.type]} size={20} /> {CASE_TYPES[c.type].label}, {c.patients} patient{c.patients > 1 ? 's' : ''}</>} actions={<div className="row row-tight"><SeverityTag severity={c.severity} /><StatusPill status={c.status} /></div>}>
        <div className="row" style={{ alignItems: 'flex-start' }}><GoldenRing createdAtMs={c.createdAtMs} frozenAtMs={c.closedAtMs ?? c.arrivalConfirmedAtMs} small />
          <div className="stack-sm grow"><p className="strong measure">&ldquo;{c.brief || 'No summary'}&rdquo;</p>{c.closeReason && <p className="sub">Closed: {c.closeReason}</p>}</div></div>
        <dl className="facts">
          <div><dt>Reported</dt><dd>{dt(c.createdAtMs)}</dd></div>
          <div><dt>Crew</dt><dd>{c.ambulanceCallSign ?? 'Not assigned'}</dd></div>
          <div><dt>Destination</dt><dd>{c.selectedHospitalName ?? 'None'}</dd></div>
          <div><dt>Patient picked up</dt><dd>{c.pickupAtMs ? dt(c.pickupAtMs) : 'No'}</dd></div>
          <div><dt>Receipt confirmed</dt><dd>{c.arrivalConfirmedAtMs ? dt(c.arrivalConfirmedAtMs) : 'No'}</dd></div>
          <div><dt>Total time</dt><dd>{duration(c) ?? 'Still open'}</dd></div>
        </dl>
      </Panel>
      <HandoffCard caseId={c.id} />
      <Panel title="Evidence" quiet><EvidenceGallery caseId={c.id} items={evidence.data} expected={c.evidenceExpected} loading={!evidence.ready} /></Panel>
      {role === 'ambulance' && <Panel title="Timeline" quiet><Timeline items={events.data} loading={!events.ready} /></Panel>}
    </div>
  )
}

export default function History({ profile, uid, actor, hospitals, ambulances, offers, allCases, notify, openId, onOpen }: Props) {
  const history = useCaseHistory(profile, uid)
  const [f, setF] = useState({ q: '', status: 'all', type: 'all', severity: 'all', from: '', to: '' })
  const shown = useMemo(() => filterCases(history.rows, f), [history.rows, f])
  const opened = useCaseById(openId)
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  const filtering = f.q || f.status !== 'all' || f.type !== 'all' || f.severity !== 'all' || f.from || f.to

  if (openId) {
    const c = opened.data ?? history.rows.find((r) => r.id === openId) ?? null
    return (
      <div className="stack-lg">
        <button className="btn btn-quiet" style={{ justifySelf: 'start' }} onClick={() => onOpen(null)}><Icon name="back" size={16} /> Back to history</button>
        {!opened.ready && !c ? <div className="skeleton" style={{ height: 200 }} /> : !c ? <ErrorBox>This case is not available to you.</ErrorBox>
          : profile.role === 'dispatcher'
            ? <Workbench c={c} allCases={allCases} offers={offers.filter((o) => o.caseId === c.id)} hospitals={hospitals} ambulances={ambulances} actor={actor} notify={notify} />
            : <CaseSummary c={c} role={profile.role} notify={notify} />}
      </div>
    )
  }

  return (
    <div className="stack-lg">
      <div className="stack-sm"><h1 className="title">Incident history</h1><p className="sub measure">{profile.role === 'dispatcher' ? 'Every case ever recorded, newest first.' : profile.role === 'hospital' ? 'Cases your hospital is or was confirmed for. Cases you declined are not kept for privacy.' : 'Cases assigned to your unit.'} Closed cases stay on record after you sign out or the app is updated.</p></div>
      <Panel title="Find a case" quiet>
        <div className="filters">
          <label className="field"><span className="field-label">Search</span><input type="search" value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="Summary, hospital, crew, case ID" /></label>
          <label className="field"><span className="field-label">Status</span><select value={f.status} onChange={(e) => set({ status: e.target.value })}><option value="all">All</option><option value="open">Open</option><option value="closed">Closed</option><option value="completed">Completed with handover</option><option value="cancelled">Ended without a hospital</option><option value="false">False reports</option><option value="accidental">Accidental reports</option><option value="duplicate">Duplicates</option><option value="withdrawn">Withdrawn by reporter</option></select></label>
          <label className="field"><span className="field-label">Type</span><select value={f.type} onChange={(e) => set({ type: e.target.value })}><option value="all">All types</option>{(Object.keys(CASE_TYPES) as CaseType[]).map((t) => <option key={t} value={t}>{CASE_TYPES[t].label}</option>)}</select></label>
          <label className="field"><span className="field-label">Severity</span><select value={f.severity} onChange={(e) => set({ severity: e.target.value })}><option value="all">Any</option><option value="1">Critical</option><option value="2">Serious</option><option value="3">Stable</option></select></label>
          <label className="field"><span className="field-label">From</span><input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} /></label>
          <label className="field"><span className="field-label">To</span><input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} /></label>
        </div>
        <div className="row row-between"><span className="sub" role="status">{shown.length} of {history.rows.length} loaded case{history.rows.length === 1 ? '' : 's'}{history.done ? '' : ', more available'}</span>{filtering && <button className="btn btn-sm" onClick={() => setF({ q: '', status: 'all', type: 'all', severity: 'all', from: '', to: '' })}>Clear filters</button>}</div>
      </Panel>

      {history.error && <ErrorBox retry={history.reload}>{history.error}</ErrorBox>}
      {history.loading && history.rows.length === 0 ? <div className="skeleton" style={{ height: 220 }} /> : shown.length === 0 ? (
        <Empty icon="history" title={filtering ? 'No cases match these filters' : 'No cases yet'} action={filtering ? <button className="btn" onClick={() => setF({ q: '', status: 'all', type: 'all', severity: 'all', from: '', to: '' })}>Clear filters</button> : undefined}>{filtering ? 'Try a different search or widen the dates. Older cases may need “Load older cases” below.' : 'Cases appear here as they are reported.'}</Empty>
      ) : (
        <div className="rows" role="table" aria-label="Cases">
          <div className="rows-head" role="row" style={{ ['--cols' as string]: '9rem minmax(0, 2fr) 11rem minmax(0, 1.2fr) 6rem' }}><span>When</span><span>Case</span><span>Status</span><span className="cell-hide">Crew and hospital</span><span className="cell-hide">Took</span></div>
          {shown.map((c) => (
            <button key={c.id} className="rows-row" role="row" style={{ ['--cols' as string]: '9rem minmax(0, 2fr) 11rem minmax(0, 1.2fr) 6rem' }} onClick={() => onOpen(c.id)}>
              <span className="num">{dt(c.createdAtMs)}</span>
              <span><b><Icon name={TYPE_ICON[c.type]} size={16} /> {CASE_TYPES[c.type].label}</b> <SeverityTag severity={c.severity} /><br /><span className="sub">{c.brief || 'No summary'}</span></span>
              <span><StatusPill status={c.status as CaseStatus} />{c.status === 'closed' && <><br /><span className="fine">{c.arrivalConfirmedAtMs ? 'Handed over' : CLOSE_LABEL[closeKindOf(c) ?? 'cancelled']}</span></>}</span>
              <span className="cell-hide sub">{c.ambulanceCallSign ?? 'No crew'}<br />{c.selectedHospitalName ?? 'No hospital'}</span>
              <span className="cell-hide num">{duration(c) ?? <Pill tone="wait">Open</Pill>}</span>
            </button>
          ))}
        </div>
      )}
      <div className="row">{!history.done && <button className="btn" disabled={history.loading} onClick={() => history.loadMore()}>{history.loading ? <><span className="spin" /> Loading</> : 'Load older cases'}</button>}{history.done && history.rows.length > 0 && <span className="fine">That is every case on record.</span>}</div>
    </div>
  )
}
