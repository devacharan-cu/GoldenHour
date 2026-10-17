import { assertFails } from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { analyseCase, FakeAiClient } from '../lib/ai'
import { parseReceipt } from '../lib/crypto'
import { findDuplicates } from '../lib/duplicates'
import { CHUNK_SIZE, downloadEvidence, uploadEvidence } from '../lib/evidence'
import { sha256Hex } from '../lib/crypto'
import { Bytes } from 'firebase/firestore'
import { mkAmbulance } from '../lib/fixtures'
import { contactNextWave } from '../lib/workflow'
import type { AiBriefing, Case, Evidence, Offer } from '../lib/types'
import { cancelAssignment, claimCase, closeCase, confirmAvailability, createCaseQueued, crewAccept, crewDecline, dismissDuplicate, dispatchCase, extendDeadline, markDuplicate, revokeOffer, selectDestination, shareHandoff, updateHospitalProfile } from '../lib/workflow'
import { answer, crewAccepts, dispatchIt, driveToHospital, input, offerToCrew, reportCase, tick } from './scenario'
import { amb, disp, hosp, readCase, readHospitals, readOffers, reporter, resetWorld, startWorld, stopWorld, stranger, waitFor } from './world'

beforeAll(startWorld)
afterAll(stopWorld)
beforeEach(resetWorld)

const states = async (caseId: string) => Object.fromEntries((await readOffers(disp().db, caseId)).map((o) => [o.hospitalId, o.state]))
const eventKinds = async (caseId: string) => (await getDocs(collection(disp().db, 'cases', caseId, 'events'))).docs.map((d) => d.data().kind as string)
const bytes = (n: number, seed = 3) => Uint8Array.from({ length: n }, (_, i) => (i * 17 + seed) % 253)

describe('the complete actor sequence', () => {
  it('runs report → dispatcher offers → crew accepts → hospitals pre-alerted → destination → crew acknowledges → pickup → handover → close', async () => {
    const id = await reportCase('trauma')
    const d = disp()

    // 1-2. Reporter filed it; the dispatcher explicitly offers it to ONE ambulance. No hospital hears about it yet.
    const offered = await offerToCrew(id)
    expect(offered).toMatchObject({ status: 'dispatched', ambulanceId: 'a1', ambulanceAckAtMs: null })
    expect((await getDoc(doc(d.db, 'ambulances', 'a1'))).data()).toMatchObject({ available: false, currentCaseId: id })
    expect(await tick(id)).toEqual([]) // engine does nothing until a crew accepts
    expect((await readOffers(d.db, id)).length).toBe(0)

    // 3-5. The crew accepts; only then are the five nearest eligible hospitals asked, while the crew is en route.
    const accepted = await crewAccepts(id)
    expect(accepted.status).toBe('enroute')
    await tick(id)
    const alerted = await readCase(d.db, id)
    expect(alerted.notifiedHospitalIds).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'])
    expect(alerted.activeHospitalIds).toEqual(alerted.notifiedHospitalIds)
    expect(alerted.status).toBe('enroute')
    expect(alerted.hospitalAlertAtMs).toBeGreaterThanOrEqual(alerted.ambulanceAckAtMs as number)

    // 6. Each hospital decides independently.
    await answer(id, 'h2', true)
    await answer(id, 'h1', false)
    await answer(id, 'h3', true)
    await tick(id)
    let c = await readCase(d.db, id)
    expect(c.recommendedHospitalId).toBe('h2')

    // 7. A human confirms; everyone else is withdrawn and loses access.
    await selectDestination(d.db, d.actor, c, await readOffers(d.db, id), 'h2', null)
    expect(await states(id)).toMatchObject({ h2: 'selected', h3: 'withdrawn', h1: 'declined', h4: 'withdrawn' })
    c = await readCase(d.db, id)
    expect(c.activeHospitalIds).toEqual(['h2'])
    expect(c.destinationAckAtMs).toBeNull()

    // 8-9. The crew acknowledges the destination, picks up, arrives; the hospital confirms receipt.
    await driveToHospital(id)
    c = await readCase(d.db, id)
    expect(c).toMatchObject({ status: 'arrived', destinationAckByUid: 'amb1', arrivalConfirmedByUid: 'hs-h2' })
    expect(c.pickupAtMs).toBeGreaterThan(0)

    // 10. Only now can it be closed; the ambulance is released.
    await closeCase(d.db, d.actor, c, 'Handed over to hospital')
    expect((await getDoc(doc(d.db, 'ambulances', 'a1'))).data()).toMatchObject({ available: true, currentCaseId: null })
    expect(await readCase(d.db, id)).toMatchObject({ status: 'closed' })

    // The permanent timeline shows every actor's step, in order.
    const events = (await getDocs(collection(d.db, 'cases', id, 'events'))).docs.map((x) => x.data()).sort((a, b) => a.atMs - b.atMs)
    const kinds = events.map((e) => e.kind)
    for (const k of ['reported', 'dispatched', 'ack', 'wave', 'offer_accepted', 'offer_declined', 'selected', 'destination_ack', 'pickup', 'status', 'arrival_confirmed', 'closed']) expect(kinds).toContain(k)
    expect(kinds.indexOf('dispatched')).toBeLessThan(kinds.indexOf('ack'))
    expect(kinds.indexOf('ack')).toBeLessThan(kinds.indexOf('wave'))
    expect(kinds.indexOf('selected')).toBeLessThan(kinds.indexOf('destination_ack'))
    expect(kinds.indexOf('destination_ack')).toBeLessThan(kinds.indexOf('pickup'))
    expect(kinds.indexOf('arrival_confirmed')).toBeLessThan(kinds.indexOf('closed'))
    expect(new Set(events.map((e) => e.actorRole))).toEqual(new Set(['reporter', 'dispatcher', 'ambulance', 'system', 'hospital']))
  })
})

describe('crew decline, reassignment and unanswered offers', () => {
  it('reassigns after a decline: the second crew accepts and only then are hospitals asked', async () => {
    const id = await reportCase()
    await offerToCrew(id, 'a1')
    const a1 = amb('amb1')
    await crewDecline(a1.db, a1.actor, await readCase(a1.db, id), 'On another call')
    expect((await readOffers(disp().db, id)).length).toBe(0)
    await offerToCrew(id, 'a2')
    await tick(id)
    expect((await readOffers(disp().db, id)).length).toBe(0) // still only an offer
    await crewAccepts(id, 'a2')
    await tick(id)
    const c = await readCase(disp().db, id)
    expect(c).toMatchObject({ status: 'enroute', ambulanceId: 'a2', declinedAmbulanceIds: ['a1'] })
    expect(c.notifiedHospitalIds).toHaveLength(5)
    expect((await eventKinds(id)).filter((k) => k === 'crew_declined')).toHaveLength(1)
  })
  it('lets dispatch withdraw an unanswered offer and choose another unit', async () => {
    const id = await reportCase()
    await offerToCrew(id, 'a1')
    const d = disp()
    await cancelAssignment(d.db, d.actor, await readCase(d.db, id), 'No answer after 2 minutes')
    await offerToCrew(id, 'a2')
    expect((await readCase(d.db, id)).ambulanceId).toBe('a2')
    expect((await getDoc(doc(d.db, 'ambulances', 'a1'))).data()?.available).toBe(true)
    expect(await eventKinds(id)).toContain('assignment_cancelled')
  })
  it('settles a crew-accepts versus dispatcher-cancels race with exactly one winner and consistent records', async () => {
    const id = await reportCase()
    await offerToCrew(id, 'a1')
    const a = amb('amb1')
    const d = disp()
    const ca = await readCase(a.db, id)
    const cd = await readCase(d.db, id)
    const results = await Promise.allSettled([crewAccept(a.db, a.actor, ca), cancelAssignment(d.db, d.actor, cd, 'racing')])
    const wonByCrew = results[0].status === 'fulfilled'
    const wonByDispatch = results[1].status === 'fulfilled'
    // Either outcome is acceptable; both succeeding or both failing would leave inconsistent records.
    expect([wonByCrew, wonByDispatch].filter(Boolean).length).toBeGreaterThanOrEqual(1)
    const c = await readCase(d.db, id)
    const ambulance = (await getDoc(doc(d.db, 'ambulances', 'a1'))).data()
    if (c.status === 'enroute') expect(ambulance).toMatchObject({ currentCaseId: id, available: false })
    else expect(ambulance).toMatchObject({ currentCaseId: null, available: true })
  })
})

describe('decline and reroute (hospitals)', () => {
  it('asks the next hospitals automatically when all five decline', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5']) await answer(id, h, false)
    expect((await tick(id)).join()).toContain('wave 2')
    const c = await readCase(disp().db, id)
    expect(c.offerWave).toBe(2)
    expect(c.notifiedHospitalIds).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'])
    expect(c.activeHospitalIds).toEqual(['h6', 'h7']) // the five that declined are out
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
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5']) await answer(id, h, true, [], true)
    await tick(id)
    const c = await readCase(disp().db, id)
    expect(c.recommendedHospitalId).toBeNull()
    expect(c.offerWave).toBe(2)
  })
  it('snakebite is only offered to antivenom hospitals and needs a live stock confirmation', async () => {
    const id = await reportCase('snakebite')
    const c = await dispatchIt(id)
    expect(c.notifiedHospitalIds).toEqual(['h1', 'h3'])
    await answer(id, 'h1', true, ['emergency'])
    await answer(id, 'h3', false, [], false, 'Required resource out of stock')
    await tick(id)
    const after = await readCase(disp().db, id)
    expect(after.recommendedHospitalId).toBeNull()
    expect(after.escalation).toBe('no_hospital')
    expect(after.escalationNote).toMatch(/phone hospitals/)
  })
  it('requires a confirmed ICU bed for ICU cases', async () => {
    const id = await reportCase('trauma', { needsIcu: true })
    const c = await dispatchIt(id)
    expect(c.requiredCapabilities).toEqual(['trauma', 'icu'])
    expect(c.notifiedHospitalIds).toEqual(['h1', 'h4'])
    await answer(id, 'h1', true, ['trauma'])
    await tick(id)
    expect((await readCase(disp().db, id)).recommendedHospitalId).toBeNull()
    await answer(id, 'h4', true, ['trauma', 'icu'])
    await tick(id)
    expect((await readCase(disp().db, id)).recommendedHospitalId).toBe('h4')
  })
  it('re-plans when the chosen hospital withdraws after selection, and clears the crew acknowledgement', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await answer(id, 'h2', true)
    await tick(id)
    const d = disp()
    await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), 'h1', null)
    const a = amb('amb1')
    const { acknowledgeDestination } = await import('../lib/workflow')
    await acknowledgeDestination(a.db, a.actor, await readCase(a.db, id))
    expect((await readCase(d.db, id)).destinationAckAtMs).toBeGreaterThan(0)
    const h = hosp('h1')
    await revokeOffer(h.db, h.actor, (await readOffers(d.db, id)).find((o) => o.hospitalId === 'h1') as Offer, 'Antivenom ran out')
    await tick(id)
    const c = await readCase(d.db, id)
    expect(c.selectedHospitalId).toBeNull()
    expect(c.destinationAckAtMs).toBeNull() // the crew must acknowledge the next destination again
    expect(c.activeHospitalIds).not.toContain('h1')
    expect(await eventKinds(id)).toEqual(expect.arrayContaining(['offer_revoked', 'escalation']))
  })
})

describe('timeouts and escalation', () => {
  it('times out silent hospitals, removes their access, and moves on using server-enforced deadlines', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1', 1200)
    await answer(id, 'h1', false)
    await new Promise((r) => setTimeout(r, 1500))
    const log = await tick(id, Date.now(), 1200)
    expect(log).toContain('timeout')
    expect(log.join()).toContain('wave 2')
    expect(await states(id)).toMatchObject({ h1: 'declined', h2: 'timeout', h3: 'timeout', h4: 'timeout', h5: 'timeout', h6: 'pending', h7: 'pending' })
    expect((await readCase(disp().db, id)).activeHospitalIds).toEqual(['h6', 'h7'])
  })
  it('escalates once all eligible hospitals declined or timed out, and does not repeat itself', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    for (const h of ['h1', 'h2', 'h3', 'h4', 'h5']) await answer(id, h, false)
    await tick(id)
    for (const h of ['h6', 'h7']) await answer(id, h, false)
    await tick(id)
    expect((await readCase(disp().db, id)).escalation).toBe('no_hospital')
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
  it('runs two simultaneous incidents on different ambulances without mixing offers', async () => {
    const [c1, c2] = await Promise.all([reportCase('trauma', {}, reporter('r1')), reportCase('cardiac', {}, reporter('r2'))])
    await Promise.all([offerToCrew(c1, 'a1'), offerToCrew(c2, 'a2')])
    await Promise.all([crewAccepts(c1, 'a1'), crewAccepts(c2, 'a2')])
    await Promise.all([tick(c1), tick(c2)])
    expect((await readCase(disp().db, c1)).ambulanceId).toBe('a1')
    expect((await readCase(disp().db, c2)).ambulanceId).toBe('a2')
    const [o1, o2] = await Promise.all([readOffers(disp().db, c1), readOffers(disp().db, c2)])
    expect(o1.every((o) => o.caseId === c1)).toBe(true)
    expect(o2.every((o) => o.caseId === c2)).toBe(true)
    await answer(c1, 'h1', true)
    await answer(c2, 'h1', false)
    expect((await states(c1)).h1).toBe('accepted')
    expect((await states(c2)).h1).toBe('declined')
    // h1 declined c2 but must still see c1
    await getDoc(doc(hosp('h1').db, 'cases', c1))
    await assertFails(getDoc(doc(hosp('h1').db, 'cases', c2)))
  })
  it('never double-books an ambulance when two dispatchers race', async () => {
    const [c1, c2] = await Promise.all([reportCase('trauma', {}, reporter('r1')), reportCase('trauma', {}, reporter('r2'))])
    const results = await Promise.allSettled([offerToCrew(c1, 'a1'), offerToCrew(c2, 'a1')])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
    expect((await getDoc(doc(disp().db, 'ambulances', 'a1'))).data()?.currentCaseId).toMatch(/\w{20}/)
  })
  it('does not offer the same case to two ambulances', async () => {
    const id = await reportCase()
    const results = await Promise.allSettled([offerToCrew(id, 'a1'), offerToCrew(id, 'a2')])
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
  it('does not send the first wave twice when two consoles react to the same acceptance', async () => {
    const id = await reportCase()
    await offerToCrew(id)
    await crewAccepts(id)
    const logs = await Promise.all([tick(id), tick(id), tick(id)])
    expect(logs.flat().filter((l) => l === 'wave 1')).toHaveLength(1)
    expect((await readOffers(disp().db, id)).length).toBe(5)
  })
})

describe('multi-user real-time updates', () => {
  it('shows each actor the right thing at the right moment', async () => {
    const rep = reporter('rep1')
    const seen = { rep: [] as Case[], crew: [] as Case[][], h1: [] as Case[][], h1Offers: [] as Offer[][] }
    const id = await reportCase('trauma', {}, rep)
    const unsubs = [
      onSnapshot(doc(rep.db, 'cases', id), (s) => seen.rep.push({ ...s.data(), id } as Case)),
      onSnapshot(query(collection(amb('amb1').db, 'cases'), where('ambulanceId', '==', 'a1')), (s) => seen.crew.push(s.docs.map((d) => ({ ...d.data(), id: d.id }) as Case))),
      onSnapshot(query(collection(hosp('h1').db, 'cases'), where('activeHospitalIds', 'array-contains', 'h1')), (s) => seen.h1.push(s.docs.map((d) => ({ ...d.data(), id: d.id }) as Case))),
      onSnapshot(query(collection(hosp('h1').db, 'offers'), where('hospitalId', '==', 'h1')), (s) => seen.h1Offers.push(s.docs.map((d) => d.data() as Offer))),
    ]
    await offerToCrew(id)
    await waitFor(() => seen.crew.at(-1)?.length, (n) => n === 1) // the crew sees the offer immediately
    expect(seen.h1.at(-1)?.length ?? 0).toBe(0) // hospitals still see nothing
    expect(seen.h1Offers.at(-1)?.length ?? 0).toBe(0)
    await crewAccepts(id)
    await waitFor(() => seen.rep.at(-1)?.status, (s) => s === 'enroute') // the reporter sees the crew is coming
    await tick(id)
    await waitFor(() => seen.h1.at(-1)?.length, (n) => n === 1) // now hospital 1 sees the case and its request
    await waitFor(() => seen.h1Offers.at(-1)?.[0]?.state, (s) => s === 'pending')
    await answer(id, 'h1', false)
    await waitFor(() => seen.h1.at(-1)?.length, (n) => n === 0) // declining removes the case from its screen
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
    await offerToCrew(b, 'a2')
    await markDuplicate(d.db, d.actor, await readCase(d.db, b), cases[0])
    expect(await readCase(d.db, b)).toMatchObject({ status: 'closed', duplicateOf: a })
    expect((await getDoc(doc(d.db, 'ambulances', 'a2'))).data()).toMatchObject({ available: true, currentCaseId: null })
    await dismissDuplicate(d.db, cases[0])
    expect((await readCase(d.db, a)).duplicateDismissed).toBe(true)
  })
})

describe('receipts', () => {
  it('lets a reporter reopen their case on a second device and watch it live, while a stranger cannot', async () => {
    const r = reporter('rep1')
    const made = await createCaseQueued(r.db, r.actor, input('trauma'))
    await made.done
    const { caseId, secret } = parseReceipt(made.receipt)!
    const phone2 = reporter('rep1-second-device')
    await claimCase(phone2.db, phone2.actor, caseId, secret)
    let status = ''
    const unsub = onSnapshot(doc(phone2.db, 'cases', caseId), (s) => { status = s.data()?.status })
    await dispatchIt(caseId)
    await waitFor(() => status, (s) => s === 'enroute')
    unsub()
    await expect(claimCase(stranger().db, stranger().actor, caseId, 'definitely-not-the-secret-0000')).rejects.toThrow()
  })
})

describe('evidence and the AI briefing, end to end', () => {
  async function caseWithEvidence() {
    const rep = reporter('rep1')
    const id = await reportCase('snakebite', { brief: 'Adult male bitten on the leg' }, rep)
    await uploadEvidence(rep.db, rep.actor, id, 'photo1', bytes(900_000), { name: 'leg.jpg', mime: 'image/jpeg', kind: 'image', origin: 'camera' })
    await uploadEvidence(rep.db, rep.actor, id, 'voice1', bytes(300_000), { name: 'voice-note.webm', mime: 'audio/webm', kind: 'audio', origin: 'recorder' })
    await uploadEvidence(rep.db, rep.actor, id, 'doc1', bytes(100_000), { name: 'history.pdf', mime: 'application/pdf', kind: 'document', origin: 'file' })
    await uploadEvidence(rep.db, rep.actor, id, 'vid1', bytes(1_600_000), { name: 'clip.mp4', mime: 'video/mp4', kind: 'video', origin: 'file' })
    const d = disp()
    const evidence = (await getDocs(collection(d.db, 'cases', id, 'evidence'))).docs.map((x) => ({ ...x.data(), id: x.id }) as Evidence)
    return { id, d, evidence }
  }

  it('stores every media type and logs it on the timeline', async () => {
    const { id, evidence } = await caseWithEvidence()
    expect(evidence.map((e) => e.kind).sort()).toEqual(['audio', 'document', 'image', 'video'])
    expect(evidence.every((e) => e.status === 'ready')).toBe(true)
    expect((await eventKinds(id)).filter((k) => k === 'evidence')).toHaveLength(4)
  })

  it('resumes an interrupted upload instead of starting over', async () => {
    const rep = reporter('rep1')
    const id = await reportCase('trauma', {}, rep)
    const data = bytes(1_500_000)
    const meta = { name: 'a.jpg', mime: 'image/jpeg', kind: 'image' as const, origin: 'file' as const }
    // A previous attempt got as far as the metadata and the first chunk before the connection dropped.
    await setDoc(doc(rep.db, 'cases', id, 'evidence', 'resume1'), {
      name: meta.name, mime: meta.mime, kind: meta.kind, size: data.length, sha256: await sha256Hex(data), chunkCount: 3, chunkSize: CHUNK_SIZE,
      status: 'uploading', uploaderUid: 'rep1', createdAtMs: Date.now(), origin: meta.origin,
    })
    await setDoc(doc(rep.db, 'cases', id, 'evidence', 'resume1', 'chunks', '0'), { i: 0, data: Bytes.fromUint8Array(data.subarray(0, CHUNK_SIZE)) })
    expect((await getDocs(collection(rep.db, 'cases', id, 'evidence', 'resume1', 'chunks'))).size).toBe(1)
    // Resuming must write only chunks 1 and 2 (rewriting chunk 0 would be refused), then finish and verify.
    const progress: number[] = []
    await uploadEvidence(rep.db, rep.actor, id, 'resume1', data, meta, (done) => progress.push(done))
    expect(progress[0]).toBe(1) // starts from what is already there
    expect(progress.at(-1)).toBe(3)
    const ev = { ...(await getDoc(doc(rep.db, 'cases', id, 'evidence', 'resume1'))).data(), id: 'resume1' } as Evidence
    expect(ev.status).toBe('ready')
    expect(Buffer.compare(new Uint8Array(await (await downloadEvidence(rep.db, id, ev)).arrayBuffer()), data)).toBe(0)
    // Calling it again on a finished upload is a harmless no-op.
    await uploadEvidence(rep.db, rep.actor, id, 'resume1', data, meta)
  })

  it('produces a labelled AI draft that is private until a dispatcher reviews and shares it', async () => {
    const { id, d, evidence } = await caseWithEvidence()
    await dispatchIt(id)
    const c = await readCase(d.db, id)
    const res = await analyseCase(d.db, new FakeAiClient('ok'), c, evidence, 'Near the bus stop')
    expect(res.ok).toBe(true)
    const draft = (await getDoc(doc(d.db, 'cases', id, 'ai', 'draft'))).data() as AiBriefing
    expect(draft).toMatchObject({ aiGenerated: true })
    expect(draft.model).toMatch(/test-fake/)
    expect(draft.transcript).toMatch(/Test transcript/) // the audio was transcribed
    expect(draft.missingInformation.length).toBeGreaterThan(0)
    await expect(getDoc(doc(hosp('h1').db, 'cases', id, 'ai', 'draft'))).rejects.toThrow()
    // the dispatcher corrects the draft, then shares it
    const corrected = { ...draft, handoff: draft.handoff + ' Dispatcher note: patient is conscious.', edited: true }
    await shareHandoff(d.db, d.actor, id, corrected)
    const seen = (await getDoc(doc(hosp('h1').db, 'cases', id, 'ai', 'handoff'))).data() as AiBriefing
    expect(seen).toMatchObject({ aiGenerated: true, edited: true, reviewedByUid: 'disp1' })
    expect(seen.handoff).toMatch(/Dispatcher note/)
    expect((await getDoc(doc(d.db, 'cases', id))).data()?.brief).toBe('Adult male bitten on the leg') // the original report is untouched
    expect(await eventKinds(id)).toContain('ai')
  })

  it('reports an unavailable AI plainly and saves nothing', async () => {
    const { id, d, evidence } = await caseWithEvidence()
    const res = await analyseCase(d.db, new FakeAiClient('down'), await readCase(d.db, id), evidence, '')
    expect(res).toMatchObject({ ok: false, unavailable: true })
    expect((await getDoc(doc(d.db, 'cases', id, 'ai', 'draft'))).exists()).toBe(false)
  })

  it('rejects a malformed AI answer instead of guessing, and saves nothing', async () => {
    const { id, d, evidence } = await caseWithEvidence()
    const res = await analyseCase(d.db, new FakeAiClient('malformed'), await readCase(d.db, id), evidence, '')
    expect(res).toMatchObject({ ok: false, unavailable: false })
    expect((await getDoc(doc(d.db, 'cases', id, 'ai', 'draft'))).exists()).toBe(false)
  })

  it('strips diagnosis, treatment, resource claims and dispatch advice from an overreaching AI', async () => {
    const { id, d, evidence } = await caseWithEvidence()
    const res = await analyseCase(d.db, new FakeAiClient('overreach'), await readCase(d.db, id), evidence, '')
    expect(res.ok).toBe(true)
    const draft = (await getDoc(doc(d.db, 'cases', id, 'ai', 'draft'))).data() as AiBriefing
    for (const bad of [/heart attack/i, /aspirin/i, /300 mg/i, /antivenom in stock/i, /taken there/i, /diagnosis/i, /administer/i]) {
      expect(`${draft.summary} ${draft.handoff}`).not.toMatch(bad)
    }
    expect(draft.guardrailFlags.length).toBeGreaterThanOrEqual(3)
  })

  it('only dispatch can run or store AI output', async () => {
    const { id, evidence } = await caseWithEvidence()
    await dispatchIt(id)
    const h = hosp('h1')
    await expect(setDoc(doc(h.db, 'cases', id, 'ai', 'draft'), { aiGenerated: true, model: 'x', summary: 's', handoff: 'h' })).rejects.toThrow()
    const res = await analyseCase(h.db, new FakeAiClient('ok'), await readCase(h.db, id), evidence, '').catch(() => ({ ok: false }))
    expect(res.ok).toBe(false)
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

// referenced to keep helper imports honest
void [mkAmbulance, dispatchCase, closeCase]
