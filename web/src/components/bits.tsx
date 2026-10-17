/* oxlint-disable react/only-export-components -- hooks and small helpers intentionally live beside their components */
import { useEffect, useState, type ReactNode } from 'react'
import { CAPABILITY_LABEL } from '../lib/capabilities'
import { formatClock, GOLDEN_HOUR_MS, goldenHourRemainingMs } from '../lib/geo'
import { useNow, useOnline } from '../lib/store'
import type { Capability, Case, CaseEvent, CaseStatus, OfferState, TrackedPos } from '../lib/types'

export function Countdown({ createdAtMs, frozenAtMs, label = 'Golden hour' }: { createdAtMs: number; frozenAtMs?: number | null; label?: string }) {
  const now = useNow()
  const remaining = goldenHourRemainingMs(createdAtMs, frozenAtMs ?? now)
  const pct = Math.max(0, Math.min(100, (remaining / GOLDEN_HOUR_MS) * 100))
  const cls = remaining < 0 ? 'crit' : remaining < 20 * 60000 ? 'warn' : 'ok'
  return (
    <div className="countdown" role="timer" aria-label={`${label} remaining`}>
      <div className="countdown-label">{label}</div>
      <div className={`timer ${cls}`}>{formatClock(remaining)}</div>
      <div className="bar"><i className={cls} style={{ width: `${pct}%` }} /></div>
    </div>
  )
}

/** Elapsed time since a moment, e.g. "response time". */
export function Elapsed({ sinceMs, untilMs, className = '' }: { sinceMs: number; untilMs?: number | null; className?: string }) {
  const now = useNow()
  return <span className={`mono ${className}`}>{formatClock((untilMs ?? now) - sinceMs).replace('+', '')}</span>
}

const STATUS_META: Record<CaseStatus, { label: string; tone: string }> = {
  reported: { label: 'Awaiting dispatch', tone: 'red' },
  dispatched: { label: 'Dispatched', tone: 'amber' },
  enroute: { label: 'En route to scene', tone: 'blue' },
  onscene: { label: 'On scene', tone: 'blue' },
  transporting: { label: 'Transporting', tone: 'amber' },
  arrived: { label: 'Arrived at hospital', tone: 'green' },
  closed: { label: 'Closed', tone: 'muted' },
}
export const STATUS_LABEL = Object.fromEntries(Object.entries(STATUS_META).map(([k, v]) => [k, v.label])) as Record<CaseStatus, string>

export function Badge({ tone = 'muted', children, title }: { tone?: string; children: ReactNode; title?: string }) {
  return <span className={`badge ${tone}`} title={title}>{children}</span>
}
export const StatusBadge = ({ status }: { status: CaseStatus }) => <Badge tone={STATUS_META[status].tone}>{STATUS_META[status].label}</Badge>
export const SeverityBadge = ({ severity }: { severity: 1 | 2 | 3 }) => <Badge tone={severity === 1 ? 'red' : severity === 2 ? 'amber' : 'green'}>{['', 'Critical', 'Serious', 'Stable'][severity]}</Badge>

const OFFER_META: Record<OfferState, { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'amber' },
  accepted: { label: 'Accepted', tone: 'green' },
  declined: { label: 'Declined', tone: 'red' },
  timeout: { label: 'No response', tone: 'muted' },
  withdrawn: { label: 'Withdrawn', tone: 'muted' },
  selected: { label: 'Destination', tone: 'green' },
}
export const OfferBadge = ({ state }: { state: OfferState }) => <Badge tone={OFFER_META[state].tone}>{OFFER_META[state].label}</Badge>

export const CapChips = ({ caps }: { caps: Capability[] }) => <div className="row tight">{caps.map((c) => <Badge key={c}>{CAPABILITY_LABEL[c]}</Badge>)}</div>

/** Real device GPS versus the demo simulation must never look alike. */
export function PosSource({ pos }: { pos: TrackedPos | null }) {
  if (!pos) return <Badge>No position yet</Badge>
  return pos.source === 'gps' ? <Badge tone="green" title="Position comes from the crew's phone GPS">● Live GPS</Badge> : <Badge tone="violet" title="Demo movement along a route, not a real vehicle">◌ SIMULATED</Badge>
}

const KIND_ICON: Record<string, string> = {
  reported: '🚨', dispatched: '🚑', offer_sent: '📨', offer_accepted: '✅', offer_declined: '⛔', offer_timeout: '⏱', offer_revoked: '↩️', wave: '📡', recommended: '⭐',
  selected: '🏥', override: '✍️', escalation: '🔔', status: '📍', ack: '👍', arrival_confirmed: '🏁', duplicate: '🧬', closed: '🔒',
}
export function Timeline({ items, empty = 'No events yet' }: { items: CaseEvent[]; empty?: string }) {
  if (!items.length) return <p className="sub">{empty}</p>
  return (
    <ol className="timeline">
      {[...items].reverse().map((e) => (
        <li key={e.id}>
          <span className="t-time mono">{new Date(e.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <span className="t-icon" aria-hidden>{KIND_ICON[e.kind] ?? '•'}</span>
          <span className="t-text">{e.text}<small>{e.actorRole}</small></span>
        </li>
      ))}
    </ol>
  )
}

export function Empty({ icon = '🛰️', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-icon" aria-hidden>{icon}</div><b>{title}</b>{children && <p>{children}</p>}</div>
}

export function Loading({ label = 'Loading live data…' }: { label?: string }) {
  return <div className="empty" role="status"><div className="spinner" aria-hidden /><p>{label}</p></div>
}

export function ErrorBox({ children, retry }: { children: ReactNode; retry?: () => void }) {
  return <div className="err" role="alert">{children}{retry && <button className="btn sm" onClick={retry} style={{ marginLeft: 10 }}>Retry</button>}</div>
}

export function Toasts({ messages }: { messages: { id: number; text: string; tone?: string }[] }) {
  return <div className="toasts" aria-live="polite">{messages.map((m) => <div key={m.id} className={`toast ${m.tone ?? ''}`}>{m.text}</div>)}</div>
}

export function useToasts() {
  const [messages, setMessages] = useState<{ id: number; text: string; tone?: string }[]>([])
  const notify = (text: string, tone?: string) => {
    const id = Date.now() + Math.random()
    setMessages((m) => [...m.slice(-2), { id, text, tone }])
    setTimeout(() => setMessages((m) => m.filter((x) => x.id !== id)), 4500)
  }
  return { messages, notify }
}

export function ConnectionBanner({ pendingWrites }: { pendingWrites?: boolean }) {
  const online = useOnline()
  if (online && !pendingWrites) return null
  return <div className="banner warn" role="status">{online ? 'Syncing changes…' : 'You are offline. You can keep working; changes will sync when the connection returns, and live data may be out of date.'}</div>
}

interface BIPEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

export function InstallPrompt({ compact = false }: { compact?: boolean }) {
  const [evt, setEvt] = useState<BIPEvent | null>(null)
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem('gh-install-dismissed') === '1' } catch { return false } })
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone)
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setEvt(e as BIPEvent) }
    window.addEventListener('beforeinstallprompt', h)
    return () => window.removeEventListener('beforeinstallprompt', h)
  }, [])
  if (standalone || dismissed) return null
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent)
  const dismiss = () => { setDismissed(true); try { localStorage.setItem('gh-install-dismissed', '1') } catch { /* ignore */ } }
  return (
    <div className="banner install">
      <div>
        <b>Install GoldenHour</b>
        {!compact && <p className="sub">{evt ? 'Add it to your home screen for one-tap access and offline support.' : ios ? 'On iPhone: tap Share, then “Add to Home Screen”.' : 'Android Chrome: open the ⋮ menu and choose “Install app” or “Add to Home screen”. Desktop: use the install icon in the address bar.'}</p>}
      </div>
      <div className="row tight">
        {evt && <button className="btn sm primary" onClick={() => { void evt.prompt().then(() => setEvt(null)) }}>Install</button>}
        <button className="btn sm" onClick={dismiss}>Not now</button>
      </div>
    </div>
  )
}

export const caseTitle = (c: Pick<Case, 'type' | 'patients'>, label: string) => `${label} · ${c.patients} patient${c.patients > 1 ? 's' : ''}`
