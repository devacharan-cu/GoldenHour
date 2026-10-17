import { useEffect, useState } from 'react'
import { formatCountdown, goldenHourRemainingMs, GOLDEN_HOUR_MS, STATUS_LABEL } from '../lib/triage'
import type { EmergencyType, Incident } from '../lib/types'

export const TYPE_META: Record<EmergencyType, { label: string; icon: string }> = {
  cardiac: { label: 'Cardiac', icon: '🫀' },
  stroke: { label: 'Stroke', icon: '🧠' },
  trauma: { label: 'Trauma', icon: '🩹' },
  burns: { label: 'Burns', icon: '🔥' },
  obstetric: { label: 'Childbirth', icon: '🤰' },
  other: { label: 'Other', icon: '🚨' },
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function Countdown({ incident }: { incident: Pick<Incident, 'createdAtMs' | 'status'> }) {
  const now = useNow()
  const remaining = goldenHourRemainingMs(incident.createdAtMs, now)
  const pct = Math.max(0, Math.min(100, (remaining / GOLDEN_HOUR_MS) * 100))
  const cls = remaining < 0 ? 'crit' : remaining < 20 * 60000 ? 'warn' : 'ok'
  const color = cls === 'crit' ? 'var(--red)' : cls === 'warn' ? 'var(--amber)' : 'var(--green)'
  return (
    <div>
      <div className={`timer ${cls}`} aria-label="Golden hour remaining">{formatCountdown(remaining)}</div>
      <div className="bar"><i style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  )
}

export function StatusBadge({ status }: { status: Incident['status'] }) {
  const color = status === 'reported' ? 'red' : status === 'arrived' || status === 'closed' ? 'green' : status === 'transporting' ? 'amber' : 'blue'
  return <span className={`badge ${color}`}>{STATUS_LABEL[status]}</span>
}

export function Timeline({ items }: { items: Incident['timeline'] }) {
  return (
    <ul className="timeline">
      {[...items].reverse().map((t, i) => (
        <li key={i}>
          <span>{new Date(t.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
          <b>{t.text}</b>
        </li>
      ))}
    </ul>
  )
}
