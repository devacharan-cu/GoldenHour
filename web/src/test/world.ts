import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, doc, getDocs, onSnapshot, query, setDoc, where, type Firestore } from 'firebase/firestore'
import { readFileSync } from 'node:fs'
import { mkAmbulance, mkHospital } from '../lib/fixtures'
import type { Actor } from '../lib/workflow'
import type { Capability, Case, Hospital, Offer, UserProfile } from '../lib/types'

export const SCENE = { lat: 12.87, lng: 74.84 }

/** Seven trauma-capable hospitals at increasing distance from SCENE, two with antivenom, one with ICU, plus one without trauma. */
export function worldHospitals(): Hospital[] {
  const caps = (extra: Capability[] = []): Capability[] => ['emergency', 'trauma', 'cardiac', ...extra]
  return [
    mkHospital('h1', 12.871, 74.84, caps(['antivenom', 'icu'])),
    mkHospital('h2', 12.872, 74.84, caps()),
    mkHospital('h3', 12.873, 74.84, caps(['antivenom'])),
    mkHospital('h4', 12.874, 74.84, caps(['icu'])),
    mkHospital('h5', 12.875, 74.84, caps()),
    mkHospital('h6', 12.876, 74.84, caps()),
    mkHospital('h7', 12.877, 74.84, caps()),
    mkHospital('h8', 12.8705, 74.84, ['emergency']),
  ]
}

export const USERS: Record<string, UserProfile> = {
  disp1: { role: 'dispatcher', displayName: 'Dispatcher 1', active: true },
  disp2: { role: 'dispatcher', displayName: 'Dispatcher 2', active: true },
  dispOff: { role: 'dispatcher', displayName: 'Disabled', active: false },
  amb1: { role: 'ambulance', displayName: 'Medic 1', active: true, ambulanceId: 'a1' },
  amb2: { role: 'ambulance', displayName: 'Medic 2', active: true, ambulanceId: 'a2' },
  ...Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7', 'h8'].map((h) => [`hs-${h}`, { role: 'hospital', displayName: `Staff ${h}`, active: true, hospitalId: h } satisfies UserProfile])),
}

let env: RulesTestEnvironment

export async function startWorld(): Promise<RulesTestEnvironment> {
  env = await initializeTestEnvironment({
    projectId: 'demo-goldenhour',
    firestore: { rules: readFileSync(process.env.RULES_PATH ?? new URL('../../../firestore.rules', import.meta.url), 'utf8'), host: '127.0.0.1', port: 8181 },
  })
  return env
}
export const stopWorld = () => env.cleanup()
/** Run something with security rules disabled (test setup and deliberate tampering only). */
export async function withAdmin<T>(fn: (db: Firestore) => Promise<T>): Promise<T> {
  let out: T | undefined
  await env.withSecurityRulesDisabled(async (ctx) => { out = await fn(ctx.firestore() as unknown as Firestore) })
  return out as T
}

export async function resetWorld(): Promise<void> {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore()
    for (const [uid, p] of Object.entries(USERS)) await setDoc(doc(db, 'users', uid), p)
    for (const h of worldHospitals()) { const { id, ...rest } = h; await setDoc(doc(db, 'hospitals', id), rest) }
    for (const a of [mkAmbulance('a1', 12.869, 74.84), mkAmbulance('a2', 12.9, 74.85), mkAmbulance('a3', 12.95, 74.85)]) {
      const { id, ...rest } = a
      await setDoc(doc(db, 'ambulances', id), { ...rest, callSign: `Medic ${id.slice(1)}`, available: true, currentCaseId: null })
    }
  })
}

export interface Who { db: Firestore; actor: Actor }
const asUser = (uid: string, role: Actor['role'], anon = false): Who => ({
  db: env.authenticatedContext(uid, anon ? { firebase: { sign_in_provider: 'anonymous' } } : {}).firestore() as unknown as Firestore,
  actor: { uid, role },
})
export const disp = (uid = 'disp1') => asUser(uid, 'dispatcher')
export const hosp = (h: string) => asUser(`hs-${h}`, 'hospital')
export const amb = (uid = 'amb1') => asUser(uid, 'ambulance')
export const reporter = (uid = 'rep1') => asUser(uid, 'reporter', true)
export const stranger = () => asUser('nobody', 'reporter') // signed in with email, no role document
export const disabledDispatcher = () => asUser('dispOff', 'dispatcher')
export const anonymous = (): Firestore => env.unauthenticatedContext().firestore() as unknown as Firestore

export async function readCase(db: Firestore, id: string): Promise<Case> {
  const { getDoc } = await import('firebase/firestore')
  return { ...(await getDoc(doc(db, 'cases', id))).data(), id } as Case
}
export async function readOffers(db: Firestore, caseId: string): Promise<Offer[]> {
  const s = await getDocs(query(collection(db, 'offers'), where('caseId', '==', caseId)))
  return s.docs.map((d) => ({ ...d.data(), id: d.id }) as Offer)
}
export async function readHospitals(db: Firestore): Promise<Hospital[]> {
  const s = await getDocs(collection(db, 'hospitals'))
  return s.docs.map((d) => ({ ...d.data(), id: d.id }) as Hospital)
}

export const waitFor = async <T>(fn: () => T | Promise<T>, ok: (v: T) => boolean = Boolean as unknown as (v: T) => boolean, ms = 8000): Promise<T> => {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (ok(v)) return v
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 50))
  }
}

export { onSnapshot, collection, query, where }
