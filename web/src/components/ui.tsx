/* oxlint-disable react/only-export-components -- small hooks and helpers intentionally live beside the components they serve */
import { useEffect, useState, type ReactNode } from 'react'
import { formatClock, GOLDEN_HOUR_MS, goldenHourRemainingMs } from '../lib/geo'
import { nextMover, RELAY_LABEL, RELAY_ORDER, relayDone, relayNotes, type RelayRole } from '../lib/relay'
import { useNow, useOnline } from '../lib/store'
import type { Case, CaseEvent, CaseStatus, CaseType, OfferState, Offer, TrackedPos } from '../lib/types'

// ---------------------------------------------------------------- icons (24px, 2px stroke, square caps)

const PATHS = {
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21v-2a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v2',
  child: 'M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M7 21v-1.5a5 5 0 0 1 5-5 5 5 0 0 1 5 5V21',
  radio: 'M4 14v-2a8 8 0 0 1 16 0v2 M3 14h4v6H3z M17 14h4v6h-4z M17 20c0 1.5-2 2-5 2',
  ambulance: 'M2 7h13v10H2z M15 10h4l3 3v4h-7 M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M18 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M8.5 12h4 M10.5 10v4',
  hospital: 'M4 4h16v17H4z M12 8v6 M9 11h6 M10 21v-4h4v4',
  heart: 'M12 21s-8-5.2-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 10c0 5.8-8 11-8 11z',
  brain: 'M8 4a4 4 0 0 0-4 4c0 1 .3 1.8 1 2.5-.7.7-1 1.5-1 2.5a4 4 0 0 0 4 4h1V4H8z M16 4a4 4 0 0 1 4 4c0 1-.3 1.8-1 2.5.7.7 1 1.5 1 2.5a4 4 0 0 1-4 4h-1V4h1z',
  bandage: 'M4.5 14.5l10-10a3.5 3.5 0 0 1 5 5l-10 10a3.5 3.5 0 0 1-5-5z M10 10l4 4',
  snake: 'M17 5a3 3 0 0 0-6 0c0 4 6 4 6 8s-6 4-6 6a3 3 0 0 0 6 0 M12 5h.01',
  flame: 'M12 22c4 0 7-3 7-7 0-3-2-5-3-7-1 2-2 3-4 3 0-3-1-5-3-7-1 3-4 5-4 11 0 4 3 7 7 7z',
  alert: 'M12 3l10 18H2z M12 10v5 M12 18v.5',
  camera: 'M3 7h4l1.5-3h7L17 7h4v13H3z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  mic: 'M9 3h6v11a3 3 0 0 1-6 0z M5 11a7 7 0 0 0 14 0 M12 18v3',
  video: 'M2 6h14v12H2z M16 10l6-3v10l-6-3',
  file: 'M6 2h8l5 5v15H6z M14 2v5h5 M9 13h7 M9 17h7',
  photo: 'M3 4h18v16H3z M9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M3 17l5-4 4 3 3-2 6 4',
  upload: 'M12 16V4 M7 9l5-5 5 5 M4 20h16',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14',
  retry: 'M20 12a8 8 0 1 1-3-6.2 M20 4v5h-5',
  check: 'M4 12l5 5 11-11',
  x: 'M5 5l14 14 M19 5L5 19',
  copy: 'M9 9h11v11H9z M5 15V5a1 1 0 0 1 1-1h10',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8.6 10.5l6.8-3 M8.6 13.5l6.8 3',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
  pin: 'M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  nav: 'M3 11l18-8-8 18-2-8z',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M5 5l2 2 M17 17l2 2 M19 5l-2 2 M7 17l-2 2',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M19 5l-1.5 1.5 M6.5 17.5L5 19',
  moon: 'M20 14a8 8 0 1 1-10-10 7 7 0 0 0 10 10z',
  history: 'M3 12a9 9 0 1 0 3-6.7 M3 4v5h5 M12 8v5l3 2',
  list: 'M4 6h16 M4 12h16 M4 18h16',
  map: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z M9 4v14 M15 6v14',
  logout: 'M9 4H5v16h4 M16 8l4 4-4 4 M20 12H9',
  bell: 'M6 17v-6a6 6 0 0 1 12 0v6l2 2H4z M10 21h4',
  shield: 'M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  plus: 'M12 5v14 M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-5-5',
  lock: 'M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4',
  stop: 'M6 6h12v12H6z',
  play: 'M7 4l13 8-13 8z',
  chevron: 'M9 5l7 7-7 7',
  back: 'M15 5l-7 7 7 7',
  device: 'M7 2h10v20H7z M11 18h2',
} as const
export type IconName = keyof typeof PATHS

export function Icon({ name, size = 22, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter" aria-hidden focusable="false">
      <path d={PATHS[name]} />
    </svg>
  )
}

export const TYPE_ICON: Record<CaseType, IconName> = { cardiac: 'heart', stroke: 'brain', trauma: 'bandage', snakebite: 'snake', burns: 'flame', obstetric: 'person', paediatric: 'child', other: 'alert' }
export const RELAY_ICON: Record<RelayRole, IconName> = { reporter: 'person', dispatcher: 'radio', crew: 'ambulance', hospital: 'hospital' }
export const KIND_ICON = { image: 'photo', document: 'file', audio: 'mic', video: 'video' } as const

// ---------------------------------------------------------------- the Relay Track

export interface RelayProps {
  /** The case being shown, or null for the instructional version on the landing page. */
  c: Case | null
  /** The case's hospital offers, or null when this viewer is not allowed to see them (reporters). */
  offers?: Offer[] | null
  /** The signed-in viewer's hand, so "your move" can be marked. */
  viewer: RelayRole
  /** Static explanation (landing page): no case, a fixed baton position and example captions. */
  demo?: { holder: RelayRole; notes: Record<RelayRole, string> }
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function RelayTrack({ c, offers = null, viewer, demo }: RelayProps) {
  const mover = c ? nextMover(c, offers) : { role: demo?.holder ?? 'reporter', action: '' }
  const done = c ? relayDone(c) : { reporter: false, dispatcher: false, crew: false, hospital: false }
  const notes = c ? relayNotes(c, offers, clock) : demo?.notes ?? { reporter: '', dispatcher: '', crew: '', hospital: '' }
  const holder = mover.role
  const idx = holder ? RELAY_ORDER.indexOf(holder) : RELAY_ORDER.length - 1
  const pct = (i: number) => 12.5 + i * 25
  const filled = holder === null ? 100 : (idx / 3) * 100
  const you = holder === viewer
  return (
    <section className="relay" aria-label="Where this case is">
      <div className="relay-nodes">
        <div className="relay-line" aria-hidden><i style={{ width: `${(filled * 75) / 75}%` }} /></div>
        {holder && <div className="relay-baton" style={{ left: `${pct(idx)}%` }} aria-hidden />}
        {RELAY_ORDER.map((r) => (
          <div key={r} className={`relay-node ${done[r] && r !== holder ? 'done' : ''} ${r === holder ? 'now' : ''} ${r === holder && you ? 'you' : ''}`} aria-current={r === holder ? 'step' : undefined}>
            <div className="relay-icon"><Icon name={RELAY_ICON[r]} /></div>
            <div className="relay-name">{RELAY_LABEL[r]}{r === viewer ? <span className="sr-only"> (you)</span> : null}</div>
            <div className="relay-note">{notes[r]}</div>
          </div>
        ))}
      </div>
      {c && (
        <div className="relay-caption" role="status" aria-live="polite">
          {holder ? (
            <>
              <span className={`mover ${you ? 'you' : ''}`}>{you ? 'Your move' : `Waiting on ${RELAY_LABEL[holder].toLowerCase()}`}</span>
              <span className="strong">{mover.action}</span>
            </>
          ) : <span className="strong">{mover.action}</span>}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- golden-hour ring

export function GoldenRing({ createdAtMs, frozenAtMs, small = false }: { createdAtMs: number; frozenAtMs?: number | null; small?: boolean }) {
  const now = useNow()
  const remaining = goldenHourRemainingMs(createdAtMs, frozenAtMs ?? now)
  const pct = Math.max(0, Math.min(1, remaining / GOLDEN_HOUR_MS))
  const R = 45
  const C = 2 * Math.PI * R
  const cls = remaining < 0 ? 'crit' : remaining < 20 * 60000 ? 'warn' : ''
  return (
    <div className={`ring ${cls} ${small ? 'ring-sm' : ''}`} role="timer" aria-label={`Golden hour: ${formatClock(remaining)} ${remaining < 0 ? 'over' : 'left'}`}>
      <svg viewBox="0 0 100 100" aria-hidden>
        <circle className="ring-track" cx="50" cy="50" r={R} />
        <circle className="ring-fill" cx="50" cy="50" r={R} strokeDasharray={C} strokeDashoffset={C * (1 - pct)} />
      </svg>
      <div className="ring-label"><span className="ring-time num">{formatClock(remaining)}</span><span className="ring-cap">{remaining < 0 ? 'over the hour' : 'of the hour left'}</span></div>
    </div>
  )
}

export function Elapsed({ sinceMs, untilMs }: { sinceMs: number; untilMs?: number | null }) {
  const now = useNow()
  return <span className="num">{formatClock((untilMs ?? now) - sinceMs).replace('+', '')}</span>
}

// ---------------------------------------------------------------- marks

const STATUS_META: Record<CaseStatus, { label: string; cls: string }> = {
  reported: { label: 'Waiting for dispatch', cls: 'pill-signal' },
  dispatched: { label: 'Offered to a crew', cls: 'pill-wait' },
  enroute: { label: 'Crew on the way', cls: 'pill-star' },
  onscene: { label: 'Crew on scene', cls: 'pill-star' },
  transporting: { label: 'Taking patient to hospital', cls: 'pill-wait' },
  arrived: { label: 'At the hospital', cls: 'pill-go' },
  closed: { label: 'Closed', cls: '' },
}
export const STATUS_LABEL = Object.fromEntries(Object.entries(STATUS_META).map(([k, v]) => [k, v.label])) as Record<CaseStatus, string>
export const StatusPill = ({ status }: { status: CaseStatus }) => <span className={`pill ${STATUS_META[status].cls}`}>{STATUS_META[status].label}</span>

export const SEVERITY_LABEL = ['', 'Critical', 'Serious', 'Stable'] as const
export const SeverityTag = ({ severity }: { severity: 1 | 2 | 3 }) => <span className={`tag tag-${severity}`}>{SEVERITY_LABEL[severity]}</span>

const OFFER_META: Record<OfferState, { label: string; cls: string }> = {
  pending: { label: 'Waiting', cls: 'pill-wait' },
  accepted: { label: 'Accepted', cls: 'pill-go' },
  declined: { label: 'Declined', cls: 'pill-signal' },
  timeout: { label: 'No response', cls: '' },
  withdrawn: { label: 'Stood down', cls: '' },
  selected: { label: 'Destination', cls: 'pill-go' },
}
export const OfferPill = ({ state }: { state: OfferState }) => <span className={`pill ${OFFER_META[state].cls}`}>{OFFER_META[state].label}</span>

export const Pill = ({ tone, children, title }: { tone?: 'go' | 'wait' | 'signal' | 'star' | 'sim'; children: ReactNode; title?: string }) => <span className={`pill ${tone ? `pill-${tone}` : ''}`} title={title}>{children}</span>

/** Real device GPS and demo movement must never look alike. */
export function PosSource({ pos }: { pos: TrackedPos | null }) {
  if (!pos) return <Pill>No position yet</Pill>
  return pos.source === 'gps'
    ? <span className="stamp stamp-live" title="Position comes from the crew's phone GPS">Live GPS</span>
    : <span className="stamp stamp-sim" title="Demo movement along a route. Not a real vehicle.">Simulated</span>
}

export const AiStamp = () => <span className="stamp stamp-ai" title="Written by an AI model. Check it against the original report.">AI-generated</span>
export const DeviceStamp = ({ children = 'On this device only' }: { children?: ReactNode }) => <span className="stamp stamp-device">{children}</span>

// ---------------------------------------------------------------- structure

export function Panel({ title, actions, children, move, quiet, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; move?: boolean; quiet?: boolean; className?: string }) {
  return (
    <section className={`panel ${move ? 'panel--move' : ''} ${quiet ? 'panel--quiet' : ''} ${className}`}>
      {(title || actions) && <header className="panel-head"><h3 className="h">{title}</h3>{actions}</header>}
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function Empty({ icon = 'list', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><Icon name={icon} size={44} /><b>{title}</b>{children && <p>{children}</p>}{action}</div>
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="stack" role="status" aria-label={label}>
      <div className="skeleton" style={{ height: 120 }} /><div className="skeleton" style={{ height: 24, width: '60%' }} /><div className="skeleton" style={{ height: 24, width: '80%' }} />
      <span className="sr-only">{label}</span>
    </div>
  )
}

export function Notice({ tone, title, children, actions }: { tone?: 'wait' | 'signal' | 'go' | 'star' | 'sim'; title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`notice ${tone ? `notice-${tone}` : ''}`} role={tone === 'signal' ? 'alert' : 'status'}>
      <div className="grow">{title && <b>{title}</b>}{children && <div className="notice-body">{children}</div>}</div>
      {actions && <div className="row row-tight">{actions}</div>}
    </div>
  )
}

export const ErrorBox = ({ children, retry }: { children: ReactNode; retry?: () => void }) => (
  <Notice tone="signal" title="Something went wrong" actions={retry ? <button className="btn btn-sm" onClick={retry}>Try again</button> : undefined}>{children}</Notice>
)

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden />
      <span className="switch-text"><span className="strong">{label}</span>{hint && <span className="hint">{hint}</span>}</span>
    </label>
  )
}

// ---------------------------------------------------------------- timeline

export function Timeline({ items, empty = 'Nothing has happened yet.', loading = false }: { items: CaseEvent[]; empty?: string; loading?: boolean }) {
  if (loading) return <div className="skeleton" style={{ height: 80 }} role="status" aria-label="Loading timeline" />
  if (!items.length) return <p className="sub">{empty}</p>
  const sorted = [...items].sort((a, b) => b.atMs - a.atMs)
  const ROLE = { reporter: 'Reporter', dispatcher: 'Dispatcher', ambulance: 'Crew', hospital: 'Hospital', system: 'System' } as Record<string, string>
  return (
    <ol className="log">
      {sorted.map((e, i) => (
        <li key={e.id} className={i === 0 ? 'latest' : ''}>
          <time className="num" dateTime={new Date(e.atMs).toISOString()}>{new Date(e.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          <span>{e.text}<small>{ROLE[e.actorRole] ?? e.actorRole}</small></span>
        </li>
      ))}
    </ol>
  )
}

// ---------------------------------------------------------------- feedback

export function useToasts() {
  const [messages, setMessages] = useState<{ id: number; text: string; tone?: string }[]>([])
  const notify = (text: string, tone?: 'good' | 'warn' | 'bad') => {
    const id = Date.now() + Math.random()
    setMessages((m) => [...m.slice(-2), { id, text, tone }])
    setTimeout(() => setMessages((m) => m.filter((x) => x.id !== id)), 5200)
  }
  return { messages, notify }
}
export type Notify = (text: string, tone?: 'good' | 'warn' | 'bad') => void

export function Slips({ messages }: { messages: { id: number; text: string; tone?: string }[] }) {
  return <div className="slips" role="status" aria-live="polite">{messages.map((m) => <div key={m.id} className={`slip ${m.tone ? `slip-${m.tone}` : ''}`}>{m.text}</div>)}</div>
}

export function ConnectionBanner({ pendingWrites }: { pendingWrites?: boolean }) {
  const online = useOnline()
  if (online && !pendingWrites) return null
  return (
    <div className="page" style={{ paddingBottom: 0, flex: 'none' }}>
      <Notice tone="wait" title={online ? 'Syncing changes' : 'You are offline'}>
        {online ? 'Your latest changes are being sent.' : 'You can keep working. Changes are kept on this device and sent when the connection returns. Live data may be out of date, and nothing is confirmed until it reaches the server.'}
      </Notice>
    </div>
  )
}

interface BIPEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

/** Chrome's install prompt, captured once so the Account screen can offer it any time. */
let deferredInstall: BIPEvent | null = null
if (typeof window !== 'undefined') window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e as BIPEvent })

export function useInstall() {
  const [available, setAvailable] = useState(!!deferredInstall)
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); deferredInstall = e as BIPEvent; setAvailable(true) }
    window.addEventListener('beforeinstallprompt', h)
    return () => window.removeEventListener('beforeinstallprompt', h)
  }, [])
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true)
  const ios = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent)
  return {
    available, standalone: !!standalone, ios,
    install: async () => { if (!deferredInstall) return; await deferredInstall.prompt(); deferredInstall = null; setAvailable(false) },
  }
}

export function InstallHint() {
  const { available, standalone, ios, install } = useInstall()
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('gh-install-dismissed') === '1' } catch { return false } })
  if (standalone || hidden) return null
  const dismiss = () => { setHidden(true); try { localStorage.setItem('gh-install-dismissed', '1') } catch { /* ignore */ } }
  return (
    <Notice tone="star" title="Install GoldenHour on this device"
      actions={<>{available && <button className="btn btn-sm btn-ink" onClick={() => void install()}>Install</button>}<button className="btn btn-sm" onClick={dismiss}>Not now</button></>}>
      {available ? 'One tap to open it from your home screen, and it keeps working with a weak connection.' : ios ? 'On iPhone, tap Share, then Add to Home Screen.' : 'In Chrome, open the menu and choose Install app. On a computer, use the install icon in the address bar.'}
    </Notice>
  )
}

export const caseTitle = (c: Pick<Case, 'patients'>, label: string) => `${label}, ${c.patients} patient${c.patients > 1 ? 's' : ''}`
