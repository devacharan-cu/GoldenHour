import { mkAmbulance } from '../lib/fixtures'
import { planEscalation, type EtaFn } from '../lib/matching'
import { acknowledgeDestination, advanceStatus, applyPlan, confirmArrival, createCase, crewAccept, dispatchCase, respondToOffer, type NewCaseInput } from '../lib/workflow'
import type { Capability, Case, CaseType } from '../lib/types'
import { SCENE, amb, disp, hosp, readCase, readHospitals, readOffers, reporter } from './world'

export const etaByDistance: EtaFn = (h) => ({ etaMin: Math.max(1, Math.round((h.lat - SCENE.lat) * 1000)), source: 'estimate' })

export const input = (type: CaseType = 'trauma', over: Partial<NewCaseInput> = {}): NewCaseInput => ({
  type, severity: 1, patients: 1, needsIcu: false, brief: 'Adult, conscious, breathing', contact: '+91 90000 00000', note: 'Near the bus stop',
  lat: SCENE.lat, lng: SCENE.lng, locationSource: 'manual', ...over,
})

export async function reportCase(type: CaseType = 'trauma', over: Partial<NewCaseInput> = {}, rep = reporter()): Promise<string> {
  return createCase(rep.db, rep.actor, input(type, over))
}

/** One engine tick, exactly as the dispatcher console runs it. */
export async function tick(caseId: string, nowMs = Date.now(), ttlMs?: number): Promise<string[]> {
  const d = disp()
  const c = await readCase(d.db, caseId)
  const plan = planEscalation({ c, offers: await readOffers(d.db, caseId), hospitals: await readHospitals(d.db), nowMs, etaFor: etaByDistance })
  return applyPlan(d.db, d.actor, c, plan, nowMs, ttlMs)
}

/** Dispatcher explicitly offers the case to one ambulance. Nothing is sent to hospitals yet. */
export async function offerToCrew(caseId: string, ambulanceId = 'a1'): Promise<Case> {
  const d = disp()
  const c = await readCase(d.db, caseId)
  await dispatchCase(d.db, d.actor, c, { ambulance: { ...mkAmbulance(ambulanceId, 12.869, 74.84), callSign: `Medic ${ambulanceId.slice(1)}` }, etaSceneMin: 4, etaSource: 'estimate' })
  return readCase(d.db, caseId)
}

export const crewUidFor = (ambulanceId: string) => (ambulanceId === 'a2' ? 'amb2' : 'amb1')

export async function crewAccepts(caseId: string, ambulanceId = 'a1'): Promise<Case> {
  const a = amb(crewUidFor(ambulanceId))
  await crewAccept(a.db, a.actor, await readCase(a.db, caseId))
  return readCase(a.db, caseId)
}

/** Full start of a live case: offer, crew accepts, then the engine pre-alerts the five nearest eligible hospitals. */
export async function dispatchIt(caseId: string, ambulanceId = 'a1', ttlMs?: number): Promise<Case> {
  await offerToCrew(caseId, ambulanceId)
  await crewAccepts(caseId, ambulanceId)
  await tick(caseId, Date.now(), ttlMs)
  return readCase(disp().db, caseId)
}

export async function answer(caseId: string, hospitalId: string, yes: boolean, confirm: Capability[] = ['trauma'], canReceive = true, reason: string | null = 'No capacity right now'): Promise<void> {
  const h = hosp(hospitalId)
  const o = (await readOffers(disp().db, caseId)).find((x) => x.hospitalId === hospitalId)
  if (!o) throw new Error(`no offer for ${hospitalId}`)
  await respondToOffer(h.db, h.actor, o, { accept: yes, canReceive, confirmations: Object.fromEntries(confirm.map((c) => [c, true])), declineReason: yes ? null : reason })
}

/** Crew side after a destination has been confirmed: on scene, acknowledge, pick up, arrive; then the hospital confirms. */
export async function driveToHospital(caseId: string, ambulanceId = 'a1'): Promise<void> {
  const a = amb(crewUidFor(ambulanceId))
  const pos = { lat: SCENE.lat, lng: SCENE.lng, atMs: Date.now(), source: 'simulated' as const }
  let c = await readCase(a.db, caseId)
  if (c.status === 'dispatched') { await crewAccept(a.db, a.actor, c); c = await readCase(a.db, caseId) }
  await advanceStatus(a.db, a.actor, c, pos) // on scene
  await acknowledgeDestination(a.db, a.actor, await readCase(a.db, caseId))
  await advanceStatus(a.db, a.actor, await readCase(a.db, caseId), pos) // picked up
  await advanceStatus(a.db, a.actor, await readCase(a.db, caseId), pos) // at hospital
  const h = hosp((await readCase(a.db, caseId)).selectedHospitalId as string)
  await confirmArrival(h.db, h.actor, await readCase(h.db, caseId))
}
