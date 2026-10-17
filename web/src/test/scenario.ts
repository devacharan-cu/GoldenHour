import { mkAmbulance } from '../lib/fixtures'
import { nextWave, type EtaFn } from '../lib/matching'
import { confirmArrival, createCase, dispatchCase, respondToOffer, type NewCaseInput } from '../lib/workflow'
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

/** Dispatcher assigns the ambulance and contacts the five nearest eligible hospitals. Returns the dispatched case. */
export async function dispatchIt(caseId: string, ambulanceId = 'a1', ttlMs?: number): Promise<Case> {
  const d = disp()
  const c = await readCase(d.db, caseId)
  const hospitals = await readHospitals(d.db)
  const candidates = nextWave(c, hospitals, [], etaByDistance)
  await dispatchCase(d.db, d.actor, c, { ambulance: { ...mkAmbulance(ambulanceId, 12.869, 74.84), callSign: `Medic ${ambulanceId.slice(1)}` }, candidates, etaSceneMin: 4, etaSource: 'estimate', ttlMs })
  return readCase(d.db, caseId)
}

export async function answer(caseId: string, hospitalId: string, yes: boolean, confirm: Capability[] = ['trauma'], canReceive = true, reason: string | null = 'No capacity right now'): Promise<void> {
  const h = hosp(hospitalId)
  const o = (await readOffers(disp().db, caseId)).find((x) => x.hospitalId === hospitalId)
  if (!o) throw new Error(`no offer for ${hospitalId}`)
  await respondToOffer(h.db, h.actor, o, { accept: yes, canReceive, confirmations: Object.fromEntries(confirm.map((c) => [c, true])), declineReason: yes ? null : reason })
}

export async function driveToHospital(caseId: string): Promise<void> {
  const a = amb()
  const { acknowledgeAssignment, advanceStatus } = await import('../lib/workflow')
  let c = await readCase(a.db, caseId)
  await acknowledgeAssignment(a.db, a.actor, c)
  for (let i = 0; i < 3; i++) {
    c = await readCase(a.db, caseId)
    await advanceStatus(a.db, a.actor, c, { lat: SCENE.lat, lng: SCENE.lng, atMs: Date.now(), source: 'simulated' })
  }
  const h = hosp((await readCase(a.db, caseId)).selectedHospitalId as string)
  await confirmArrival(h.db, h.actor, await readCase(h.db, caseId))
}
