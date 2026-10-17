import { useEffect, useRef } from 'react'
import { chime, desktopNotify } from './alerts'
import { useSettings } from './settings'
import type { Case, Offer, UserProfile } from './types'

/**
 * Draw attention to new work: a chime and, if the person allowed it, a desktop notification while the tab is hidden.
 *  dispatcher  a new report, or a new escalation
 *  crew        a new dispatch offer
 *  hospital    a new request to confirm resources
 * The first batch of data after loading is treated as already seen, so reopening the app does not ring.
 */
export function useAttention(profile: UserProfile | null, cases: Case[], offers: Offer[], ready: boolean): void {
  const { settings } = useSettings()
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!profile || !ready) return
    const fresh: { key: string; title: string; body: string }[] = []
    if (profile.role === 'dispatcher') {
      for (const c of cases) {
        if (c.status === 'reported') fresh.push({ key: `new:${c.id}`, title: 'New emergency report', body: c.brief || 'A report is waiting for dispatch' })
        if (c.escalation !== 'none' && c.status !== 'closed') fresh.push({ key: `esc:${c.id}:${c.escalation}`, title: 'Needs your attention', body: c.escalationNote ?? 'A case needs a decision' })
      }
    } else if (profile.role === 'ambulance') {
      for (const c of cases) if (c.status === 'dispatched') fresh.push({ key: `offer:${c.id}:${c.crewOfferedAtMs}`, title: 'New dispatch', body: c.brief || 'You have been offered a case' })
    } else if (profile.role === 'hospital') {
      for (const o of offers) if (o.state === 'pending') fresh.push({ key: `req:${o.id}`, title: 'Incoming patient request', body: 'Confirm resources and accept or decline' })
    }
    if (seen.current === null) { seen.current = new Set(fresh.map((f) => f.key)); return }
    const novel = fresh.filter((f) => !seen.current!.has(f.key))
    novel.forEach((f) => seen.current!.add(f.key))
    if (!novel.length) return
    if (settings.sound) chime()
    if (settings.desktopAlerts) desktopNotify(novel[0].title, novel[0].body)
  }, [profile, cases, offers, ready, settings.sound, settings.desktopAlerts])
}
