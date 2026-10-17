import { assertFails } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, onSnapshot, query, updateDoc, where } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { planEscalation } from '../lib/matching'
import type { Case, Offer } from '../lib/types'
import { applyPlan, closeCase, confirmAvailability, contactNextWave, dismissDuplicate, extendDeadline, markDuplicate, revokeOffer, selectDestination, updateHospitalProfile } from '../lib/workflow'
import { findDuplicates } from '../lib/duplicates'
import { answer, dispatchIt, driveToHospital, etaByDistance, reportCase } from './scenario'
import { amb, disp, hosp, readCase, readHospitals, readOffers, reporter, resetWorld, startWorld, stopWorld, waitFor } from './world'

beforeAll(startWorld)
afterAll(stopWorld)
beforeEach(resetWorld)

/** One engine tick, exactly as the dispatcher console runs it. */
async function tick(caseId: string, nowMs = Date.now(), ttlMs?: number): Promise<string[]> {
  const d = disp()
  const c = await readCase(d.db, caseId)
  const plan = planEscalation({ c, offers: await readOffers(d.db, caseId), hospitals: await readHospitals(d.db), nowMs, etaFor: etaByDistance })
  return applyPlan(d.db, d.actor, c, plan, nowMs, ttlMs)
}
const states = async (caseId: string) => Object.fromEntries((await readOffers(disp().db, caseId)).map((o) => [o.hospitalId, o.state]))
const eventKinds = async (caseId: string) => (await getDocs(collection(disp().db, 'cases', caseId, 'events'))).docs.map((d) => d.data().kind as string)

describe('happy path: report → dispatch → acceptance → destination → transport → arrival → close', () => {
  it('runs the whole workflow with the destination ready before transport', async () => {
    const id = await reportCase('trauma')
    const c0 = await dispatchIt(id)

    // Five nearest eligible hospitals were asked in the same write as the dispatch (h8 lacks trauma and is skipped).
    expect(c0.status).toBe('dispatched')
    expect(c0.notifiedHospitalIds).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'])
    expect(Object.values(await states(id))).toEqual(['pending', 'pending', 'pending', 'pending', 'pending'])
    expect((await getDoc(doc(disp().db, 'ambulances', 'a1'))).data()?.available).toBe(false)

    // Hospitals answer while the ambulance is still en route.
    await answer(id, 'h2', true)
    await answer(id, 'h1', false)
    await answer(id, 'h3', true)
    await tick(id)
    let c = await readCase(disp().db, id)
    expect(c.recommendedHospitalId).toBe('h2') // nearest of the two qualified

    // A human confirms. Offers are closed out and the ambulance may now be driven all the way.
    const d = disp()
    await selectDestination(d.db, d.actor, c, await readOffers(d.db, id), 'h2', null)
    expect(await states(id)).toMatchObject({ h2: 'selected', h3: 'withdrawn', h1: 'declined', h4: 'withdrawn' })
    await driveToHospital(id)
    c = await readCase(d.db, id)
    expect(c.status).toBe('arrived')
    expect(c.arrivalConfirmedByUid).toBe('hs-h2')

    await closeCase(d.db, d.actor, c, 'Handed over')
    expect((await getDoc(doc(d.db, 'ambulances', 'a1'))).data()?.available).toBe(true)

    // Full audit trail, in a sensible order.
    const kinds = await eventKinds(id)
    for (const k of ['reported', 'dispatched', 'offer_sent', 'offer_accepted', 'offer_declined', 'selected', 'ack', 'status', 'arrival_confirmed', 'closed']) expect(kinds).toContain(k)
  })
})

describe('decline and reroute', () => {
  it('asks the next hospitals automatically when all five decline', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5']) await answer(id, h, false)
    expect((await tick(id)).join()).toContain('wave 2')
    const c = await readCase(disp().db, id)
    expect(c.offerWave).toBe(2)
    expect(c.notifiedHospitalIds).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'])
    await answer(id, 'h6', true)
    await tick(id)
    expect((await readCase(disp().db, id)).recommendedHospitalId).toBe('h6')
  })
  it('does not widen the search while a qualified hospital exists', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    for (const h of ['h2', 'h3', 'h4', 'h5']) await answer(id, h, false)
    await answer(id, 'h1', true)
    await tick(id)
    expect((await readCase(disp().db, id)).offerWave).toBe(1)
  })
})

describe('missing capabilities and unavailable resources', () => {
  it('never treats an accept without confirmation as a destination, and keeps searching', async () => {
    const id = await reportCase('trauma')
    await dispatchIt(id)
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5']) await answer(id, h, true, [], true) // accept but confirm nothing
    await tick(id)
    const c = await readCase(disp().db, id)
    expect(c.recommendedHospitalId).toBeNull()
    expect(c.offerWave).toBe(2) // widened, because nobody actually qualified
  })
  it('snakebite is only offered to antivenom hospitals and needs a live stock confirmation', async () => {
    const id = await reportCase('snakebite')
    const c = await dispatchIt(id)
    expect(c.notifiedHospitalIds).toEqual(['h1', 'h3']) // only profiles listing antivenom
    await answer(id, 'h1', true, ['emergency']) // yes, but did NOT confirm antivenom is in stock
    await answer(id, 'h3', false, [], false, 'Required resource out of stock')
    await tick(id)
    const after = await readCase(disp().db, id)
    expect(after.recommendedHospitalId).toBeNull()
    expect(after.escalation).toBe('no_hospital') // nobody left: clear human escalation, nothing invented
    expect(after.escalationNote).toMatch(/phone hospitals/)
  })
  it('requires a confirmed ICU bed for ICU cases', async () => {
    const id = await reportCase('trauma', { needsIcu: true })
    const c = await dispatchIt(id)
    expect(c.requiredCapabilities).toEqual(['trauma', 'icu'])
    expect(c.notifiedHospitalIds).toEqual(['h1', 'h4']) // only profiles with ICU
    await answer(id, 'h1', true, ['trauma']) // forgot ICU
    await tick(id)
    expect((await readCase(disp().db, id)).recommendedHospitalId).toBeNull()
    await answer(id, 'h4', true, ['trauma', 'icu'])
    await tick(id)
    expect((await readCase(disp().db, id)).recommendedHospitalId).toBe('h4')
  })
  it('re-plans when the chosen hospital withdraws after selection', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await answer(id, 'h2', true)
    await tick(id)
    const d = disp()
    await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), 'h1', null)
    // h2 was withdrawn by dispatch when h1 was selected, so h1 backing out leaves nobody qualified
    const h = hosp('h1')
    await revokeOffer(h.db, h.actor, (await readOffers(d.db, id)).find((o) => o.hospitalId === 'h1') as Offer, 'Antivenom ran out')
    await tick(id)
    const c = await readCase(d.db, id)
    expect(c.selectedHospitalId).toBeNull()
    expect(c.escalation === 'attention' || c.escalation === 'none').toBe(true)
    expect((await eventKinds(id))).toContain('offer_revoked')
    expect((await eventKinds(id))).toContain('escalation')
  })
})

describe('approving before the engine has stored the recommendation', () => {
  it('confirms the best qualified hospital without demanding an override reason', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h2', true)
    const d = disp()
    const c = await readCase(d.db, id)
    expect(c.recommendedHospitalId).toBeNull() // no engine tick has run yet
    await selectDestination(d.db, d.actor, c, await readOffers(d.db, id), 'h2', null, 'h2')
    const after = await readCase(d.db, id)
    expect(after).toMatchObject({ selectedHospitalId: 'h2', recommendedHospitalId: 'h2', overrideReason: null })
  })
  it('still refuses to record a recommendation for a hospital that has not confirmed', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h2', true)
    const d = disp()
    const c = await readCase(d.db, id)
    // h3 is pending: claiming it as the recommendation must fail on the server
    await expect(selectDestination(d.db, d.actor, c, await readOffers(d.db, id), 'h2', null, 'h3')).rejects.toThrow()
  })
})

describe('timeouts and escalation', () => {
  it('times out silent hospitals and moves on, using server-enforced deadlines', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1', 1200)
    await answer(id, 'h1', false)
    await new Promise((r) => setTimeout(r, 1500))
    const log = await tick(id, Date.now(), 1200)
    expect(log).toContain('timeout')
    expect(log.join()).toContain('wave 2')
    const s = await states(id)
    expect(s).toMatchObject({ h1: 'declined', h2: 'timeout', h3: 'timeout', h4: 'timeout', h5: 'timeout', h6: 'pending', h7: 'pending' })
  })
  it('escalates once all eligible hospitals declined or timed out, and does not repeat itself', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5']) await answer(id, h, false)
    await tick(id)
    for (const h of ['h6', 'h7']) await answer(id, h, false)
    await tick(id)
    const c = await readCase(disp().db, id)
    expect(c.escalation).toBe('no_hospital')
    const before = (await eventKinds(id)).filter((k) => k === 'escalation').length
    await tick(id)
    expect((await eventKinds(id)).filter((k) => k === 'escalation').length).toBe(before)
  })
  it('stops a hospital answering after the deadline passes', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1', 1000)
    await new Promise((r) => setTimeout(r, 1300))
    await expect(answer(id, 'h1', true)).rejects.toThrow()
  })
  it('lets dispatch extend a pending deadline', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1', 3000)
    const d = disp()
    const o = (await readOffers(d.db, id))[0]
    await extendDeadline(d.db, d.actor, o, 60_000)
    expect((await readOffers(d.db, id)).find((x) => x.id === o.id)?.expiresAtMs).toBeGreaterThan(o.expiresAtMs + 30_000)
  })
})

describe('concurrent incidents and dispatchers', () => {
  it('dispatches two simultaneous incidents to different ambulances without mixing offers', async () => {
    const [c1, c2] = await Promise.all([reportCase('trauma', {}, reporter('r1')), reportCase('cardiac', {}, reporter('r2'))])
    await Promise.all([dispatchIt(c1, 'a1'), dispatchIt(c2, 'a2')])
    expect((await readCase(disp().db, c1)).ambulanceId).toBe('a1')
    expect((await readCase(disp().db, c2)).ambulanceId).toBe('a2')
    const [o1, o2] = await Promise.all([readOffers(disp().db, c1), readOffers(disp().db, c2)])
    expect(o1.every((o) => o.caseId === c1)).toBe(true)
    expect(o2.every((o) => o.caseId === c2)).toBe(true)
    // a hospital asked about both sees both, and can answer them independently
    await answer(c1, 'h1', true)
    await answer(c2, 'h1', false)
    expect((await states(c1)).h1).toBe('accepted')
    expect((await states(c2)).h1).toBe('declined')
  })
  it('never double-books an ambulance when two dispatchers race', async () => {
    const [c1, c2] = await Promise.all([reportCase('trauma', {}, reporter('r1')), reportCase('trauma', {}, reporter('r2'))])
    const results = await Promise.allSettled([dispatchIt(c1, 'a1'), dispatchIt(c2, 'a1')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  })
  it('does not dispatch the same case twice', async () => {
    const id = await reportCase()
    const results = await Promise.allSettled([dispatchIt(id, 'a1'), dispatchIt(id, 'a2')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const free = (await Promise.all(['a1', 'a2'].map((a) => getDoc(doc(disp().db, 'ambulances', a))))).filter((s) => s.data()?.available).length
    expect(free).toBe(1)
  })
  it('lets two dispatcher consoles tick at once but contacts the next wave only once', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5']) await answer(id, h, false)
    const logs = await Promise.all([tick(id), tick(id)])
    expect(logs.flat().filter((l) => l === 'wave 2')).toHaveLength(1)
    const c = await readCase(disp().db, id)
    expect(c.offerWave).toBe(2)
    expect(new Set(c.notifiedHospitalIds).size).toBe(c.notifiedHospitalIds.length)
    expect(await contactNextWave(disp().db, disp().actor, c, [], 2)).toBe(false)
  })
})

describe('multi-user real-time updates', () => {
  it('pushes the request to hospitals, responses to dispatch and status to the reporter', async () => {
    const rep = reporter('rep1')
    const h1Offers: Offer[][] = []
    const h6Offers: Offer[][] = []
    const dispOffers: Offer[][] = []
    let repCase: Case | null = null
    const unsubs = [
      onSnapshot(query(collection(hosp('h1').db, 'offers'), where('hospitalId', '==', 'h1')), (s) => h1Offers.push(s.docs.map((d) => d.data() as Offer))),
      onSnapshot(query(collection(hosp('h6').db, 'offers'), where('hospitalId', '==', 'h6')), (s) => h6Offers.push(s.docs.map((d) => d.data() as Offer))),
      onSnapshot(collection(disp().db, 'offers'), (s) => dispOffers.push(s.docs.map((d) => d.data() as Offer))),
    ]
    const id = await reportCase('trauma', {}, rep)
    unsubs.push(onSnapshot(doc(rep.db, 'cases', id), (s) => { repCase = { ...s.data(), id } as Case }))

    await dispatchIt(id)
    await waitFor(() => h1Offers.at(-1)?.length, (n) => n === 1)
    expect(h1Offers.at(-1)?.[0].state).toBe('pending')
    expect(h6Offers.at(-1)?.length ?? 0).toBe(0) // wave 2 hospital sees nothing yet

    await answer(id, 'h1', true)
    await waitFor(() => dispOffers.at(-1)?.find((o) => o.hospitalId === 'h1')?.state, (s) => s === 'accepted')

    await tick(id)
    const d = disp()
    await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), 'h1', null)
    await waitFor(() => repCase?.selectedHospitalName, (n) => n === 'Hospital h1')
    expect(repCase).toMatchObject({ selectedHospitalId: 'h1', ambulanceCallSign: 'Medic 1' })

    await driveToHospital(id)
    await waitFor(() => (repCase as Case | null)?.status, (s) => s === 'arrived')
    unsubs.forEach((u) => u())
  })
  it('streams ambulance position and status to every interested screen', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await tick(id)
    let seenByHospital: Case | null = null
    const unsub = onSnapshot(doc(hosp('h1').db, 'cases', id), (s) => { seenByHospital = { ...s.data(), id } as Case })
    const a = amb()
    await updateDoc(doc(a.db, 'cases', id), { ambulancePos: { lat: 12.88, lng: 74.85, atMs: Date.now(), source: 'gps' }, etaSceneMin: 3, etaSource: 'road' })
    await waitFor(() => (seenByHospital as Case | null)?.ambulancePos?.source, (s) => s === 'gps')
    expect(seenByHospital).toMatchObject({ etaSceneMin: 3, etaSource: 'road' })
    unsub()
  })
})

describe('hospital configuration', () => {
  it('stamps when capabilities and availability were last confirmed, and keeps them separate', async () => {
    const h = hosp('h1')
    const hospital = (await readHospitals(h.db)).find((x) => x.id === 'h1')!
    const t = Date.now()
    await confirmAvailability(h.db, h.actor, hospital, { emergencyBeds: 4, icuBeds: 0, resources: { antivenom: true } }, t)
    await updateHospitalProfile(h.db, h.actor, hospital, { capabilities: ['emergency', 'trauma'], diverted: false, divertedCapabilities: [] }, t)
    const after = (await readHospitals(h.db)).find((x) => x.id === 'h1')!
    expect(after.availability).toMatchObject({ emergencyBeds: 4, confirmedAtMs: t, confirmedByUid: 'hs-h1' })
    expect(after.capabilities).toEqual(['emergency', 'trauma'])
    expect(after.capabilitiesUpdatedAtMs).toBe(t)
  })
  it('removes a hospital from future waves once it diverts that specialty', async () => {
    const h = hosp('h1')
    const hospital = (await readHospitals(h.db)).find((x) => x.id === 'h1')!
    await updateHospitalProfile(h.db, h.actor, hospital, { capabilities: hospital.capabilities, diverted: false, divertedCapabilities: ['trauma'] })
    const id = await reportCase('trauma')
    expect((await dispatchIt(id)).notifiedHospitalIds).toEqual(['h2', 'h3', 'h4', 'h5', 'h6'])
  })
})

describe('duplicates', () => {
  it('flags nearby reports and lets dispatch merge them, freeing the ambulance', async () => {
    const [a, b] = await Promise.all([reportCase('trauma', {}, reporter('r1')), reportCase('trauma', { lat: 12.8702 }, reporter('r2'))])
    const d = disp()
    const cases = await Promise.all([readCase(d.db, a), readCase(d.db, b)])
    expect(findDuplicates(cases[1], [cases[0]])).toHaveLength(1)
    await dispatchIt(b, 'a2')
    await markDuplicate(d.db, d.actor, await readCase(d.db, b), cases[0])
    const closed = await readCase(d.db, b)
    expect(closed).toMatchObject({ status: 'closed', duplicateOf: a })
    expect((await getDoc(doc(d.db, 'ambulances', 'a2'))).data()?.available).toBe(true)
    await dismissDuplicate(d.db, cases[0])
    expect((await readCase(d.db, a)).duplicateDismissed).toBe(true)
  })
})

describe('reporter protections still hold mid-workflow', () => {
  it('lets the reporter watch their case but never change it', async () => {
    const rep = reporter('rep1')
    const id = await reportCase('trauma', {}, rep)
    await dispatchIt(id)
    expect((await readCase(rep.db, id)).ambulanceCallSign).toBe('Medic 1')
    await assertFails(updateDoc(doc(rep.db, 'cases', id), { status: 'closed' }))
    await assertFails(getDocs(collection(rep.db, 'offers')))
  })
})
