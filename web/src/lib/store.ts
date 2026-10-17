import { useEffect, useMemo, useRef, useState } from 'react'
import { collection, doc, onSnapshot, orderBy, query, where, type Query } from 'firebase/firestore'
import { db } from './firebase'
import { planEscalation, type EtaFn } from './matching'
import { etasFrom } from './routing'
import { estimateMinutes } from './geo'
import { applyPlan, type Actor } from './workflow'
import type { Ambulance, Case, CaseEvent, Hospital, Offer, PatientPrivate, UserProfile } from './types'

export interface Live<T> { data: T; ready: boolean; error: string | null; fromCache: boolean }

function useLiveQuery<T extends { id: string }>(q: Query | null, key: string): Live<T[]> {
  const [state, setState] = useState<Live<T[]>>({ data: [], ready: false, error: null, fromCache: false })
  useEffect(() => {
    if (!q) { setState({ data: [], ready: true, error: null, fromCache: false }); return }
    setState((s) => ({ ...s, ready: false }))
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => setState({ data: snap.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as T), ready: true, error: null, fromCache: snap.metadata.fromCache }),
      (e) => setState((s) => ({ ...s, ready: true, error: e.message })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}

/** Cases this user is allowed to see, scoped by role so the query itself satisfies the security rules. */
export function useCases(uid: string | null, profile: UserProfile | null): Live<Case[]> {
  const key = `${uid}|${profile?.role}|${profile?.hospitalId}|${profile?.ambulanceId}`
  const q = useMemo(() => {
    if (!uid) return null
    if (profile?.role === 'dispatcher') return collection(db, 'cases')
    if (profile?.role === 'hospital' && profile.hospitalId) return query(collection(db, 'cases'), where('notifiedHospitalIds', 'array-contains', profile.hospitalId))
    if (profile?.role === 'ambulance' && profile.ambulanceId) return query(collection(db, 'cases'), where('ambulanceId', '==', profile.ambulanceId))
    return query(collection(db, 'cases'), where('reporterUid', '==', uid))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useLiveQuery<Case>(q, key)
}

export function useOffers(profile: UserProfile | null): Live<Offer[]> {
  const key = `${profile?.role}|${profile?.hospitalId}`
  const q = useMemo(() => {
    if (profile?.role === 'dispatcher') return collection(db, 'offers')
    if (profile?.role === 'hospital' && profile.hospitalId) return query(collection(db, 'offers'), where('hospitalId', '==', profile.hospitalId))
    return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useLiveQuery<Offer>(q, key)
}

export function useHospitals(enabled: boolean): Live<Hospital[]> {
  const q = useMemo(() => (enabled ? collection(db, 'hospitals') : null), [enabled])
  return useLiveQuery<Hospital>(q, String(enabled))
}
export function useAmbulances(enabled: boolean): Live<Ambulance[]> {
  const q = useMemo(() => (enabled ? collection(db, 'ambulances') : null), [enabled])
  return useLiveQuery<Ambulance>(q, String(enabled))
}

export function useEvents(caseId: string | null, enabled: boolean): Live<CaseEvent[]> {
  const q = useMemo(() => (caseId && enabled ? query(collection(db, 'cases', caseId, 'events'), orderBy('atMs')) : null), [caseId, enabled])
  return useLiveQuery<CaseEvent>(q, `${caseId}|${enabled}`)
}

export function usePatientPrivate(caseId: string | null, enabled: boolean): PatientPrivate | null | undefined {
  const [v, setV] = useState<PatientPrivate | null | undefined>(undefined)
  useEffect(() => {
    if (!caseId || !enabled) return
    return onSnapshot(doc(db, 'cases', caseId, 'private', 'patient'), (s) => setV(s.exists() ? (s.data() as PatientPrivate) : null), () => setV(null))
  }, [caseId, enabled])
  return caseId && enabled ? v : undefined
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

export function useOnline(): boolean {
  const [on, setOn] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const up = () => setOn(true)
    const down = () => setOn(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])
  return on
}

const ENGINE_INTERVAL_MS = 4000

/**
 * The escalation engine. Runs inside every open dispatcher console: it times out silent hospitals, asks the next
 * wave, updates the recommendation and raises escalations. It is idempotent, so several consoles can run it safely.
 * IMPORTANT: this is browser logic, not a server. If no dispatcher console is open, timeouts and re-routing pause.
 */
export function useEscalationEngine(enabled: boolean, actor: Actor | null, cases: Case[], offers: Offer[], hospitals: Hospital[], onLog?: (msg: string) => void): void {
  const latest = useRef({ cases, offers, hospitals })
  latest.current = { cases, offers, hospitals }
  const busy = useRef(false)
  const roadEtas = useRef(new Map<string, Map<string, { etaMin: number; source: 'road' | 'estimate' }>>())

  useEffect(() => {
    if (!enabled || !actor) return
    const run = async () => {
      if (busy.current || !navigator.onLine) return
      busy.current = true
      try {
        const { cases: cs, offers: os, hospitals: hs } = latest.current
        for (const c of cs) {
          if (!['dispatched', 'enroute', 'onscene', 'transporting'].includes(c.status)) continue
          if (!roadEtas.current.has(c.id)) {
            roadEtas.current.set(c.id, new Map())
            etasFrom(c, hs).then((r) => hs.forEach((h, i) => roadEtas.current.get(c.id)?.set(h.id, r[i])))
          }
          const cache = roadEtas.current.get(c.id)
          const etaFor: EtaFn = (h) => cache?.get(h.id) ?? { etaMin: estimateMinutes(c, h), source: 'estimate' }
          const plan = planEscalation({ c, offers: os.filter((o) => o.caseId === c.id), hospitals: hs, nowMs: Date.now(), etaFor })
          if (plan.length) {
            const done = await applyPlan(db, actor, c, plan)
            if (done.length && onLog) onLog(`Engine: ${done.join(', ')}`)
          }
        }
      } finally {
        busy.current = false
      }
    }
    const t = setInterval(run, ENGINE_INTERVAL_MS)
    run()
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, actor?.uid])
}
