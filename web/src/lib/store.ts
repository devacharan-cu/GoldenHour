import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collection, doc, getDocs, limit, onSnapshot, orderBy, query, startAfter, where, type DocumentSnapshot, type Firestore, type Query } from 'firebase/firestore'
import { db } from './firebase'
import { planEscalation, type EtaFn } from './matching'
import { etasFrom } from './routing'
import { estimateMinutes } from './geo'
import { applyPlan, type Actor } from './workflow'
import { normalizeCase, type AiBriefing, type Ambulance, type Case, type CaseEvent, type Evidence, type Hospital, type Offer, type PatientPrivate, type UserProfile } from './types'

export interface Live<T> { data: T; ready: boolean; error: string | null; fromCache: boolean; hasPendingWrites: boolean }

function useLiveQuery<T extends { id: string }>(q: Query | null, key: string, map: (raw: any) => T = (r) => r as T): Live<T[]> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const [state, setState] = useState<Live<T[]>>({ data: [], ready: false, error: null, fromCache: false, hasPendingWrites: false })
  useEffect(() => {
    if (!q) { setState({ data: [], ready: true, error: null, fromCache: false, hasPendingWrites: false }); return }
    setState((s) => ({ ...s, ready: false }))
    return onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => setState({ data: snap.docs.map((d) => map({ ...(d.data() as object), id: d.id })), ready: true, error: null, fromCache: snap.metadata.fromCache, hasPendingWrites: snap.metadata.hasPendingWrites }),
      (e) => setState((s) => ({ ...s, ready: true, error: e.message })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}

/** How many of the newest cases the dispatcher console keeps live. Older ones are reached through History. */
export const CONSOLE_CASE_LIMIT = 200

/** Cases this user is allowed to see, scoped by role so the query itself satisfies the security rules. */
export function useCases(uid: string | null, profile: UserProfile | null): Live<Case[]> {
  const key = `${uid}|${profile?.role}|${profile?.hospitalId}|${profile?.ambulanceId}`
  const q = useMemo(() => {
    if (!uid) return null
    if (profile?.role === 'dispatcher') return query(collection(db, 'cases'), orderBy('createdAtMs', 'desc'), limit(CONSOLE_CASE_LIMIT))
    if (profile?.role === 'hospital' && profile.hospitalId) return query(collection(db, 'cases'), where('activeHospitalIds', 'array-contains', profile.hospitalId))
    if (profile?.role === 'ambulance' && profile.ambulanceId) return query(collection(db, 'cases'), where('ambulanceId', '==', profile.ambulanceId))
    return query(collection(db, 'cases'), where('reporterUid', '==', uid))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return useLiveQuery<Case>(q, key, normalizeCase)
}

/** One case by id: how a reporter opens a report on another device after proving they hold its receipt. */
export function useCaseById(caseId: string | null): { data: Case | null; ready: boolean; error: string | null } {
  const [s, setS] = useState<{ data: Case | null; ready: boolean; error: string | null }>({ data: null, ready: false, error: null })
  useEffect(() => {
    if (!caseId) return
    return onSnapshot(doc(db, 'cases', caseId), (d) => setS({ data: d.exists() ? normalizeCase({ ...(d.data() as object), id: d.id } as Case) : null, ready: true, error: null }), (e) => setS({ data: null, ready: true, error: e.message }))
  }, [caseId])
  return caseId ? s : { data: null, ready: true, error: null }
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

export function useEvidence(caseId: string | null, enabled = true): Live<Evidence[]> {
  const q = useMemo(() => (caseId && enabled ? query(collection(db, 'cases', caseId, 'evidence'), orderBy('createdAtMs')) : null), [caseId, enabled])
  return useLiveQuery<Evidence>(q, `ev|${caseId}|${enabled}`)
}

export function usePatientPrivate(caseId: string | null, enabled: boolean): PatientPrivate | null | undefined {
  const [v, setV] = useState<PatientPrivate | null | undefined>(undefined)
  useEffect(() => {
    if (!caseId || !enabled) return
    return onSnapshot(doc(db, 'cases', caseId, 'private', 'patient'), (s) => setV(s.exists() ? (s.data() as PatientPrivate) : null), () => setV(null))
  }, [caseId, enabled])
  return caseId && enabled ? v : undefined
}

/** The AI draft (dispatch only) and the reviewed, shared handoff. Each is null when absent or not permitted for this role. */
export function useAiDocs(caseId: string | null, wantDraft: boolean, wantHandoff: boolean): { draft: AiBriefing | null; handoff: AiBriefing | null } {
  const [draft, setDraft] = useState<AiBriefing | null>(null)
  const [handoff, setHandoff] = useState<AiBriefing | null>(null)
  useEffect(() => {
    if (!caseId) return
    const subs: (() => void)[] = []
    if (wantDraft) subs.push(onSnapshot(doc(db, 'cases', caseId, 'ai', 'draft'), (s) => setDraft(s.exists() ? (s.data() as AiBriefing) : null), () => setDraft(null)))
    if (wantHandoff) subs.push(onSnapshot(doc(db, 'cases', caseId, 'ai', 'handoff'), (s) => setHandoff(s.exists() ? (s.data() as AiBriefing) : null), () => setHandoff(null)))
    return () => subs.forEach((u) => u())
  }, [caseId, wantDraft, wantHandoff])
  return { draft: caseId && wantDraft ? draft : null, handoff: caseId && wantHandoff ? handoff : null }
}

/** Page through every case ever recorded, newest first. Used by incident history. */
export function useCaseHistory(profile: UserProfile | null, uid: string | null, pageSize = 40) {
  const [rows, setRows] = useState<Case[]>([])
  const [cursor, setCursor] = useState<DocumentSnapshot | null>(null)
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const role = profile?.role

  const base = useCallback((d: Firestore): Query | null => {
    if (role === 'dispatcher') return query(collection(d, 'cases'), orderBy('createdAtMs', 'desc'))
    if (role === 'hospital' && profile?.hospitalId) return query(collection(d, 'cases'), where('activeHospitalIds', 'array-contains', profile.hospitalId))
    if (role === 'ambulance' && profile?.ambulanceId) return query(collection(d, 'cases'), where('ambulanceId', '==', profile.ambulanceId))
    if (uid) return query(collection(d, 'cases'), where('reporterUid', '==', uid))
    return null
  }, [role, profile?.hospitalId, profile?.ambulanceId, uid])

  const loadMore = useCallback(async (reset = false) => {
    const b = base(db)
    if (!b || loading) return
    setLoading(true)
    setError(null)
    try {
      const paged = reset || !cursor ? query(b, limit(pageSize)) : query(b, startAfter(cursor), limit(pageSize))
      const snap = await getDocs(paged)
      const next = snap.docs.map((d) => normalizeCase({ ...(d.data() as object), id: d.id } as Case))
      setRows((r) => (reset ? next : [...r, ...next]))
      setCursor(snap.docs.at(-1) ?? (reset ? null : cursor))
      setDone(snap.size < pageSize)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, cursor, loading, pageSize])

  useEffect(() => { void loadMore(true) }, [role, profile?.hospitalId, profile?.ambulanceId, uid]) // eslint-disable-line react-hooks/exhaustive-deps
  return { rows, done, loading, error, loadMore: () => loadMore(false), reload: () => loadMore(true) }
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
 * The escalation engine. Runs inside every open dispatcher console: it asks hospitals as soon as a crew accepts, times out
 * silent hospitals, asks the next wave, updates the recommendation and raises escalations. It is idempotent, so several
 * consoles can run it safely. IMPORTANT: this is browser logic, not a server. With no dispatcher console open,
 * the hospital pre-alert, timeouts and re-routing pause.
 */
export function useEscalationEngine(enabled: boolean, actor: Actor | null, cases: Case[], offers: Offer[], hospitals: Hospital[], onLog?: (msg: string) => void): void {
  const latest = useRef({ cases, offers, hospitals })
  useEffect(() => { latest.current = { cases, offers, hospitals } })
  const busy = useRef(false)
  const again = useRef(false)
  const roadEtas = useRef(new Map<string, Map<string, { etaMin: number; source: 'road' | 'estimate' }>>())
  const run = useRef<() => Promise<void>>(async () => undefined)

  useEffect(() => { run.current = async () => {
    if (!enabled || !actor || !navigator.onLine) return
    if (busy.current) { again.current = true; return }
    busy.current = true
    try {
      const { cases: cs, offers: os, hospitals: hs } = latest.current
      for (const c of cs) {
        if (!['dispatched', 'enroute', 'onscene', 'transporting'].includes(c.status)) continue
        // Fetch road travel times as soon as a crew is offered the case, so they are ready when the crew accepts.
        if (!roadEtas.current.has(c.id) && hs.length) {
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
      if (again.current) { again.current = false; setTimeout(() => void run.current(), 50) }
    }
  } })

  // Periodic tick, plus an immediate reaction (debounced) whenever the data changes, so a crew's acceptance reaches hospitals within a second.
  useEffect(() => {
    if (!enabled || !actor) return
    const t = setInterval(() => void run.current(), ENGINE_INTERVAL_MS)
    return () => clearInterval(t)
  }, [enabled, actor])
  const signature = cases.map((c) => `${c.id}:${c.status}:${c.offerWave}:${c.selectedHospitalId}`).join('|') + '#' + offers.map((o) => `${o.id}:${o.state}`).join('|')
  useEffect(() => {
    if (!enabled || !actor) return
    const t = setTimeout(() => void run.current(), 250)
    return () => clearTimeout(t)
  }, [signature, enabled, actor, hospitals.length])
}
