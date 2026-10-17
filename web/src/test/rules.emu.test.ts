import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { Bytes, addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseReceipt } from '../lib/crypto'
import { downloadEvidence, EvidenceIntegrityError, uploadEvidence } from '../lib/evidence'
import type { Evidence } from '../lib/types'
import { acknowledgeDestination, advanceStatus, cancelAssignment, claimCase, closeCase, confirmArrival, createCase, createCaseQueued, crewAccept, crewDecline, dispatchCase, selectDestination } from '../lib/workflow'
import { mkAmbulance } from '../lib/fixtures'
import { answer, crewAccepts, dispatchIt, input, offerToCrew, reportCase, tick } from './scenario'
import { amb, anonymous, disabledDispatcher, disp, hosp, readCase, readOffers, reporter, resetWorld, startWorld, stopWorld, stranger, withAdmin } from './world'

beforeAll(startWorld)
afterAll(stopWorld)
beforeEach(resetWorld)

const bytes = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251)
const imgMeta = { name: 'scene.jpg', mime: 'image/jpeg', kind: 'image' as const, origin: 'file' as const }
const pos = () => ({ lat: 12.87, lng: 74.84, atMs: Date.now(), source: 'simulated' as const })

describe('identity and roles', () => {
  it('lets a user read only their own profile', async () => {
    const d = disp()
    await assertSucceeds(getDoc(doc(d.db, 'users', 'disp1')))
    await assertFails(getDoc(doc(d.db, 'users', 'disp2')))
    await assertFails(getDoc(doc(anonymous(), 'users', 'disp1')))
  })
  it('never lets anyone write a profile: no self-promotion to any role', async () => {
    for (const who of [reporter(), stranger(), hosp('h1'), amb(), disp()]) {
      await assertFails(setDoc(doc(who.db, 'users', who.actor.uid), { role: 'dispatcher', displayName: 'x', active: true }))
      await assertFails(updateDoc(doc(who.db, 'users', who.actor.uid), { role: 'dispatcher' }))
    }
    await assertFails(setDoc(doc(reporter('evil').db, 'users', 'evil'), { role: 'hospital', hospitalId: 'h1', displayName: 'x', active: true }))
  })
  it('gives a signed-in user with no role document no staff access', async () => {
    const s = stranger()
    for (const c of ['hospitals', 'ambulances', 'cases', 'offers']) await assertFails(getDocs(collection(s.db, c)))
  })
  it('denies a disabled dispatcher everything', async () => {
    const d = disabledDispatcher()
    await assertFails(getDocs(collection(d.db, 'cases')))
    await assertFails(getDocs(collection(d.db, 'hospitals')))
  })
  it('denies unauthenticated users everything', async () => {
    const db = anonymous()
    for (const c of ['cases', 'hospitals', 'ambulances', 'offers', 'users', 'userPrefs']) await assertFails(getDocs(collection(db, c)))
    await assertFails(addDoc(collection(db, 'cases'), { x: 1 }))
  })
  it('denies the legacy incidents collection', async () => {
    await assertFails(getDocs(collection(disp().db, 'incidents')))
  })
})

describe('creating cases (reporters)', () => {
  const raw = (uid: string, over: Record<string, unknown> = {}) => ({
    type: 'trauma', severity: 1, patients: 1, needsIcu: false, brief: 'ok', locationSource: 'manual', reporterUid: uid, createdAtMs: Date.now(),
    status: 'reported', requiredCapabilities: ['trauma'], lat: 12.87, lng: 74.84, ambulanceId: null, ambulanceCallSign: null, ambulanceAckAtMs: null,
    crewOfferedAtMs: null, declinedAmbulanceIds: [], crewDeclineReason: null, ambulancePos: null, etaSceneMin: null, etaSource: null, dispatchedAtMs: null,
    notifiedHospitalIds: [], activeHospitalIds: [], hospitalAlertAtMs: null, offerWave: 0, recommendedHospitalId: null, selectedHospitalId: null,
    selectedHospitalName: null, selectedAtMs: null, selectedByUid: null, overrideReason: null, destinationAckAtMs: null, destinationAckByUid: null, pickupAtMs: null,
    escalation: 'none', escalationNote: null, duplicateOf: null, duplicateDismissed: false, arrivalConfirmedAtMs: null, arrivalConfirmedByUid: null,
    closedAtMs: null, closeReason: null, receiptHash: 'a'.repeat(64), evidenceExpected: 0, ...over,
  })
  it('accepts a well-formed report from an anonymous reporter', async () => {
    const r = reporter()
    const id = await createCase(r.db, r.actor, input('snakebite'))
    expect((await readCase(r.db, id)).requiredCapabilities).toEqual(['antivenom'])
  })
  it('rejects spoofed reporter, pre-set workflow fields, bad values and mismatched capabilities', async () => {
    const col = collection(reporter().db, 'cases')
    await assertSucceeds(addDoc(col, raw('rep1')))
    for (const over of [
      { reporterUid: 'someone-else' }, { status: 'dispatched' }, { ambulanceId: 'a1' }, { selectedHospitalId: 'h1' }, { notifiedHospitalIds: ['h1'] },
      { activeHospitalIds: ['h1'] }, { declinedAmbulanceIds: ['a1'] }, { destinationAckAtMs: Date.now() }, { pickupAtMs: Date.now() }, { severity: 9 }, { patients: 0 },
      { brief: 'x'.repeat(161) }, { requiredCapabilities: ['cardiac'] }, { requiredCapabilities: ['trauma', 'nonsense'] }, { createdAtMs: Date.now() - 86_400_000 },
      { lat: 500 }, { injected: 'field' }, { escalation: 'no_hospital' }, { receiptHash: 'short' }, { receiptHash: 'Z'.repeat(64) }, { evidenceExpected: 11 },
    ]) await assertFails(addDoc(col, raw('rep1', over)))
  })
  it('does not let a reporter edit or delete cases, even their own', async () => {
    const r = reporter()
    const id = await reportCase()
    await assertFails(updateDoc(doc(r.db, 'cases', id), { severity: 3 }))
    await assertFails(updateDoc(doc(r.db, 'cases', id), { status: 'closed' }))
    await assertFails(deleteDoc(doc(r.db, 'cases', id)))
  })
})

describe('receipts: reopening a report on another device', () => {
  it('grants access only to someone who presents the secret code, and never to a guessed or client-supplied id', async () => {
    const r = reporter('rep1')
    const made = await createCaseQueued(r.db, r.actor, input('trauma'))
    await made.done
    const { caseId, secret } = parseReceipt(made.receipt)!
    const other = reporter('rep2')
    await assertFails(getDoc(doc(other.db, 'cases', caseId))) // the id alone is worthless
    await assertFails(claimCase(other.db, other.actor, caseId, 'x'.repeat(32))) // wrong secret
    await assertFails(setDoc(doc(other.db, 'cases', caseId, 'claims', 'rep3'), { secret, claimedAtMs: Date.now() })) // cannot claim on behalf of another uid
    await assertSucceeds(claimCase(other.db, other.actor, caseId, secret))
    await assertSucceeds(getDoc(doc(other.db, 'cases', caseId)))
    await assertSucceeds(getDoc(doc(other.db, 'cases', caseId, 'private', 'patient')))
    await assertFails(getDoc(doc(reporter('rep3').db, 'cases', caseId)))
    await assertFails(getDoc(doc(other.db, 'cases', caseId, 'claims', 'rep1'))) // claims are private to their owner
    expect((await readCase(other.db, caseId)).receiptHash).toHaveLength(64)
  })
  it('never exposes the secret through the case document', async () => {
    const r = reporter('rep1')
    const made = await createCaseQueued(r.db, r.actor, input('trauma'))
    await made.done
    const c = JSON.stringify(await readCase(disp().db, parseReceipt(made.receipt)!.caseId))
    expect(c).not.toContain(parseReceipt(made.receipt)!.secret)
  })
})

describe('privacy of cases and patient data', () => {
  it('shows a reporter only their own case and patient details', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    await assertSucceeds(getDoc(doc(reporter('rep1').db, 'cases', id)))
    await assertSucceeds(getDoc(doc(reporter('rep1').db, 'cases', id, 'private', 'patient')))
    await assertFails(getDoc(doc(reporter('rep2').db, 'cases', id)))
    await assertFails(getDoc(doc(reporter('rep2').db, 'cases', id, 'private', 'patient')))
    await assertFails(getDocs(collection(reporter('rep2').db, 'cases')))
    const own = await assertSucceeds(getDocs(query(collection(reporter('rep1').db, 'cases'), where('reporterUid', '==', 'rep1'))))
    expect(own.size).toBe(1)
  })
  it('lets dispatch see everything', async () => {
    const id = await reportCase()
    await assertSucceeds(getDocs(collection(disp().db, 'cases')))
    await assertSucceeds(getDoc(doc(disp().db, 'cases', id, 'private', 'patient')))
  })
  it('shows hospitals nothing until a crew has accepted and they have been asked', async () => {
    const id = await reportCase()
    await assertFails(getDoc(doc(hosp('h1').db, 'cases', id)))
    await offerToCrew(id) // offered to a crew, not yet accepted: no hospital is contacted
    await assertFails(getDoc(doc(hosp('h1').db, 'cases', id)))
    await crewAccepts(id)
    await tick(id)
    await assertSucceeds(getDoc(doc(hosp('h1').db, 'cases', id))) // asked: sees the brief
    await assertFails(getDoc(doc(hosp('h1').db, 'cases', id, 'private', 'patient'))) // but not phone / free text
    await assertFails(getDoc(doc(hosp('h6').db, 'cases', id))) // never asked in wave 1
    await assertFails(getDocs(collection(hosp('h1').db, 'cases')))
    const mine = await assertSucceeds(getDocs(query(collection(hosp('h1').db, 'cases'), where('activeHospitalIds', 'array-contains', 'h1'))))
    expect(mine.size).toBe(1)
    await assertFails(getDocs(query(collection(hosp('h1').db, 'cases'), where('activeHospitalIds', 'array-contains', 'h2'))))
  })
  it('removes a hospital\'s access to the case the moment it declines', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await assertSucceeds(getDoc(doc(hosp('h1').db, 'cases', id)))
    await answer(id, 'h1', false)
    await assertFails(getDoc(doc(hosp('h1').db, 'cases', id)))
    await assertSucceeds(getDoc(doc(hosp('h2').db, 'cases', id))) // others are unaffected
    expect((await readCase(disp().db, id)).notifiedHospitalIds).toContain('h1') // but the audit record keeps who was asked
  })
  it('removes access from hospitals that stay silent past the deadline', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1', 1200)
    await new Promise((r) => setTimeout(r, 1500))
    await tick(id, Date.now(), 1200)
    await assertFails(getDoc(doc(hosp('h2').db, 'cases', id)))
  })
  it('releases contact details only to the confirmed hospital and the assigned crew', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await answer(id, 'h2', true)
    await tick(id)
    const d = disp()
    await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), 'h1', null)
    await assertSucceeds(getDoc(doc(hosp('h1').db, 'cases', id, 'private', 'patient')))
    await assertFails(getDoc(doc(hosp('h2').db, 'cases', id, 'private', 'patient')))
    await assertFails(getDoc(doc(hosp('h2').db, 'cases', id))) // withdrawn hospitals lose the case entirely
    await assertSucceeds(getDoc(doc(amb('amb1').db, 'cases', id, 'private', 'patient')))
    await assertFails(getDoc(doc(amb('amb2').db, 'cases', id, 'private', 'patient')))
  })
  it("keeps one hospital's offers away from another hospital", async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await assertSucceeds(getDocs(query(collection(hosp('h1').db, 'offers'), where('hospitalId', '==', 'h1'))))
    await assertFails(getDocs(query(collection(hosp('h1').db, 'offers'), where('hospitalId', '==', 'h2'))))
    await assertFails(getDocs(collection(hosp('h1').db, 'offers')))
    await assertFails(getDoc(doc(hosp('h1').db, 'offers', `${id}_h2`)))
    await assertFails(getDocs(collection(reporter().db, 'offers')))
  })
  it('lets only the assigned ambulance read the case and events, and only while it is assigned', async () => {
    const id = await reportCase()
    await offerToCrew(id, 'a1')
    await assertSucceeds(getDoc(doc(amb('amb1').db, 'cases', id)))
    await assertFails(getDoc(doc(amb('amb2').db, 'cases', id)))
    await assertSucceeds(getDocs(collection(amb('amb1').db, 'cases', id, 'events')))
    await assertFails(getDocs(collection(hosp('h1').db, 'cases', id, 'events')))
    await assertFails(getDocs(collection(reporter().db, 'cases', id, 'events')))
    await crewDecline(amb('amb1').db, amb('amb1').actor, await readCase(amb('amb1').db, id), 'Vehicle fault')
    await assertFails(getDoc(doc(amb('amb1').db, 'cases', id))) // a crew that declined no longer sees the case
  })
})

describe('hospital profile and availability', () => {
  it('lets hospital staff edit only their own capability profile and availability', async () => {
    const h = hosp('h1')
    const now = Date.now()
    await assertSucceeds(updateDoc(doc(h.db, 'hospitals', 'h1'), { capabilities: ['emergency', 'trauma'], capabilitiesUpdatedAtMs: now }))
    await assertSucceeds(updateDoc(doc(h.db, 'hospitals', 'h1'), { availability: { emergencyBeds: 2, icuBeds: 0, resources: { antivenom: true }, confirmedAtMs: now, confirmedByUid: 'hs-h1' } }))
    await assertFails(updateDoc(doc(h.db, 'hospitals', 'h2'), { diverted: true }))
  })
  it('rejects forged availability authorship, bad numbers, stale stamps and protected fields', async () => {
    const h = hosp('h1')
    const now = Date.now()
    const base = { emergencyBeds: 1, icuBeds: 1, resources: {}, confirmedAtMs: now, confirmedByUid: 'hs-h1' }
    await assertFails(updateDoc(doc(h.db, 'hospitals', 'h1'), { availability: { ...base, confirmedByUid: 'someone' } }))
    await assertFails(updateDoc(doc(h.db, 'hospitals', 'h1'), { availability: { ...base, emergencyBeds: -1 } }))
    await assertFails(updateDoc(doc(h.db, 'hospitals', 'h1'), { availability: { ...base, emergencyBeds: 1.5 } }))
    await assertFails(updateDoc(doc(h.db, 'hospitals', 'h1'), { availability: { ...base, confirmedAtMs: now - 3_600_000 } }))
    await assertFails(updateDoc(doc(h.db, 'hospitals', 'h1'), { name: 'Renamed', lat: 0 }))
    await assertFails(updateDoc(doc(h.db, 'hospitals', 'h1'), { capabilities: ['emergency', 'warp-drive'], capabilitiesUpdatedAtMs: now }))
    await assertFails(updateDoc(doc(h.db, 'hospitals', 'h1'), { capabilities: ['emergency'] }))
  })
  it('stops everyone else from editing hospitals or creating or deleting them', async () => {
    for (const who of [reporter(), amb(), disp()]) await assertFails(updateDoc(doc(who.db, 'hospitals', 'h1'), { diverted: true }))
    await assertFails(setDoc(doc(disp().db, 'hospitals', 'new'), { name: 'x' }))
    await assertFails(deleteDoc(doc(hosp('h1').db, 'hospitals', 'h1')))
  })
  it('lets staff read hospitals and ambulances but not reporters', async () => {
    for (const who of [disp(), hosp('h1'), amb()]) await assertSucceeds(getDocs(collection(who.db, 'hospitals')))
    await assertFails(getDocs(collection(reporter().db, 'hospitals')))
  })
})

describe('offers: hospital responses', () => {
  it('lets only the addressed hospital respond, once, before the deadline', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    const resp = (extra = {}) => ({ state: 'accepted', respondedAtMs: Date.now(), respondedByUid: 'hs-h1', confirmations: { trauma: true }, canReceive: true, declineReason: null, ...extra })
    await assertFails(updateDoc(doc(hosp('h2').db, 'offers', `${id}_h1`), resp({ respondedByUid: 'hs-h2' })))
    await assertFails(updateDoc(doc(reporter().db, 'offers', `${id}_h1`), resp()))
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp({ respondedByUid: 'someone-else' })))
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp({ state: 'selected' })))
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp({ confirmations: { warp: true } })))
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), { ...resp(), etaMin: 0 }))
    await assertSucceeds(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp()))
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp({ confirmations: { trauma: true, icu: true } })))
    await assertSucceeds(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), { state: 'declined', declineReason: 'Resource ran out', respondedAtMs: Date.now(), respondedByUid: 'hs-h1' }))
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp()))
  })
  it('refuses a response after the deadline', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1', 1200)
    await new Promise((r) => setTimeout(r, 1500))
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), { state: 'accepted', respondedAtMs: Date.now(), respondedByUid: 'hs-h1', confirmations: { trauma: true }, canReceive: true, declineReason: null }))
  })
  it('lets dispatch time out an offer only after its deadline', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1', 1200)
    await assertFails(updateDoc(doc(disp().db, 'offers', `${id}_h1`), { state: 'timeout' }))
    await new Promise((r) => setTimeout(r, 1500))
    await assertSucceeds(updateDoc(doc(disp().db, 'offers', `${id}_h1`), { state: 'timeout' }))
  })
  it('lets only dispatch create offers', async () => {
    const id = await reportCase()
    const offer = { caseId: id, hospitalId: 'h1', hospitalName: 'x', state: 'pending', wave: 1, requestedAtMs: Date.now(), expiresAtMs: Date.now() + 60000, seenAtMs: null, respondedAtMs: null, respondedByUid: null, confirmations: null, canReceive: null, declineReason: null, distanceKm: 1, etaMin: 1, etaSource: 'estimate' }
    await assertFails(setDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), offer))
    await assertFails(setDoc(doc(reporter().db, 'offers', `${id}_h1`), offer))
  })
  it('lets a hospital withdraw an earlier acceptance and mark an offer seen', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await assertSucceeds(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), { seenAtMs: Date.now() }))
    await answer(id, 'h1', true)
    await assertSucceeds(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), { state: 'declined', declineReason: 'Antivenom ran out', respondedAtMs: Date.now(), respondedByUid: 'hs-h1' }))
  })
  it('only lets a hospital drop out of a case together with declining its own offer', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    const active = (await readCase(disp().db, id)).activeHospitalIds
    await assertFails(updateDoc(doc(hosp('h1').db, 'cases', id), { activeHospitalIds: active.filter((h) => h !== 'h1') })) // still pending: cannot quietly leave
    await assertFails(updateDoc(doc(hosp('h1').db, 'cases', id), { activeHospitalIds: active.filter((h) => h !== 'h2') })) // cannot remove a competitor
    await assertFails(updateDoc(doc(hosp('h1').db, 'cases', id), { activeHospitalIds: [...active, 'h7'] })) // cannot add anyone
  })
})

describe('choosing the destination', () => {
  const sel = (h: string, extra = {}) => ({ selectedHospitalId: h, selectedHospitalName: 'x', selectedByUid: 'disp1', selectedAtMs: Date.now(), recommendedHospitalId: h, ...extra })
  it('refuses to select a hospital that has not explicitly confirmed', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    const d = disp()
    await assertFails(updateDoc(doc(d.db, 'cases', id), sel('h1'))) // pending
    await answer(id, 'h1', true, [], true) // accepted but confirmed nothing
    await assertFails(updateDoc(doc(d.db, 'cases', id), sel('h1')))
    await answer(id, 'h2', true, ['trauma'], false) // confirmed but cannot receive
    await assertFails(updateDoc(doc(d.db, 'cases', id), sel('h2')))
    await answer(id, 'h3', false)
    await assertFails(updateDoc(doc(d.db, 'cases', id), sel('h3')))
  })
  it('requires live antivenom confirmation for snakebite', async () => {
    const id = await reportCase('snakebite')
    await dispatchIt(id)
    const d = disp()
    await answer(id, 'h1', true, ['emergency'], true)
    await assertFails(updateDoc(doc(d.db, 'cases', id), { recommendedHospitalId: 'h1' }))
    await answer(id, 'h3', true, ['antivenom'], true)
    await assertSucceeds(updateDoc(doc(d.db, 'cases', id), { recommendedHospitalId: 'h3' }))
  })
  it('requires a written reason to override the recommendation', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await answer(id, 'h2', true)
    const d = disp()
    await updateDoc(doc(d.db, 'cases', id), { recommendedHospitalId: 'h1' })
    const c = await readCase(d.db, id)
    await expect(selectDestination(d.db, d.actor, c, await readOffers(d.db, id), 'h2', '')).rejects.toThrow(/reason/)
    await assertFails(updateDoc(doc(d.db, 'cases', id), { ...sel('h2'), recommendedHospitalId: 'h1', overrideReason: null }))
    await selectDestination(d.db, d.actor, c, await readOffers(d.db, id), 'h2', 'Closer to the patient family')
    expect((await readCase(d.db, id)).overrideReason).toBe('Closer to the patient family')
  })
  it('stops non-dispatchers from selecting a destination', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    for (const who of [hosp('h1'), amb(), reporter()]) await assertFails(updateDoc(doc(who.db, 'cases', id), { selectedHospitalId: 'h1', selectedByUid: who.actor.uid, recommendedHospitalId: 'h1' }))
  })
  it('stops dispatch rewriting reporter-supplied facts or the receipt', async () => {
    const id = await reportCase()
    const d = disp()
    for (const patch of [{ severity: 3 }, { type: 'burns' }, { lat: 1 }, { reporterUid: 'x' }, { brief: 'changed' }, { createdAtMs: 1 }, { receiptHash: 'b'.repeat(64) }, { evidenceExpected: 3 }]) {
      await assertFails(updateDoc(doc(d.db, 'cases', id), patch))
    }
  })
  it('clears the crew acknowledgement when the destination changes and refuses to forge one', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await answer(id, 'h2', true)
    await tick(id)
    const d = disp()
    await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), 'h1', null)
    await assertFails(updateDoc(doc(d.db, 'cases', id), { destinationAckAtMs: Date.now(), destinationAckByUid: d.actor.uid })) // dispatch cannot acknowledge on the crew's behalf
  })
})

describe('crew: accept, decline, destination acknowledgement, pickup', () => {
  async function toOnScene(withDestination = true) {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await tick(id)
    const d = disp()
    if (withDestination) await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), 'h1', null)
    const a = amb('amb1')
    await advanceStatus(a.db, a.actor, await readCase(a.db, id), pos())
    return { id, a, d }
  }

  it('only lets the offered crew accept, and only from the offered state', async () => {
    const id = await reportCase()
    await offerToCrew(id, 'a1')
    await assertFails(updateDoc(doc(amb('amb2').db, 'cases', id), { status: 'enroute', ambulanceAckAtMs: Date.now() })) // someone else's offer
    await assertFails(updateDoc(doc(amb('amb1').db, 'cases', id), { status: 'onscene' })) // cannot skip accepting
    await assertFails(updateDoc(doc(disp().db, 'cases', id), { status: 'enroute', ambulanceAckAtMs: Date.now() })) // dispatch cannot accept for the crew
    const a = amb('amb1')
    await assertSucceeds(crewAccept(a.db, a.actor, await readCase(a.db, id)))
    expect((await readCase(a.db, id)).status).toBe('enroute')
  })

  it('sends no hospital request before the crew accepts', async () => {
    const id = await reportCase()
    await offerToCrew(id)
    expect((await tick(id))).toEqual([])
    expect((await readOffers(disp().db, id)).length).toBe(0)
    await crewAccepts(id)
    await tick(id)
    expect((await readOffers(disp().db, id)).length).toBe(5)
  })

  it('lets a crew decline: the case returns to dispatch, the unit is freed and cannot be re-offered', async () => {
    const id = await reportCase()
    await offerToCrew(id, 'a1')
    const a = amb('amb1')
    await crewDecline(a.db, a.actor, await readCase(a.db, id), 'Vehicle fault')
    const c = await readCase(disp().db, id)
    expect(c).toMatchObject({ status: 'reported', ambulanceId: null, declinedAmbulanceIds: ['a1'], crewDeclineReason: 'Vehicle fault' })
    expect((await getDoc(doc(disp().db, 'ambulances', 'a1'))).data()).toMatchObject({ available: true, currentCaseId: null })
    const d = disp()
    await expect(dispatchCase(d.db, d.actor, c, { ambulance: { ...mkAmbulance('a1', 12.869, 74.84), callSign: 'Medic 1' }, etaSceneMin: 3, etaSource: 'estimate' })).rejects.toThrow(/declined/)
    await assertFails(updateDoc(doc(d.db, 'cases', id), { status: 'dispatched', ambulanceId: 'a1', ambulanceCallSign: 'Medic 1', crewOfferedAtMs: Date.now(), dispatchedAtMs: Date.now(), etaSceneMin: 3, etaSource: 'estimate', ambulancePos: null }))
    await offerToCrew(id, 'a2') // a different unit is fine
    expect((await readCase(d.db, id)).ambulanceId).toBe('a2')
  })

  it('refuses a decline that is not honest (wrong reason shape, leaving the unit marked busy, or erasing the declined list)', async () => {
    const id = await reportCase()
    await offerToCrew(id, 'a1')
    const a = amb('amb1')
    const reset = { status: 'reported', ambulanceId: null, ambulanceCallSign: null, ambulancePos: null, dispatchedAtMs: null, crewOfferedAtMs: null, etaSceneMin: null, etaSource: null }
    await assertFails(updateDoc(doc(a.db, 'cases', id), { ...reset, declinedAmbulanceIds: [], crewDeclineReason: 'x' })) // hides that it declined
    await assertFails(updateDoc(doc(a.db, 'cases', id), { ...reset, declinedAmbulanceIds: ['a1'], crewDeclineReason: 5 }))
    await assertFails(updateDoc(doc(a.db, 'ambulances', 'a1'), { available: true, currentCaseId: null })) // cannot free itself while the case still names it
  })

  it('lets dispatch take back an unanswered offer, but not one the crew accepted', async () => {
    const id = await reportCase()
    await offerToCrew(id, 'a1')
    const d = disp()
    await cancelAssignment(d.db, d.actor, await readCase(d.db, id), 'No answer from crew')
    expect(await readCase(d.db, id)).toMatchObject({ status: 'reported', ambulanceId: null })
    expect((await getDoc(doc(d.db, 'ambulances', 'a1'))).data()?.available).toBe(true)
    await offerToCrew(id, 'a1')
    await crewAccepts(id)
    await expect(cancelAssignment(d.db, d.actor, await readCase(d.db, id), 'late')).rejects.toThrow()
  })

  it('never lets one ambulance hold two cases', async () => {
    const [c1, c2] = await Promise.all([reportCase('trauma', {}, reporter('r1')), reportCase('trauma', {}, reporter('r2'))])
    await offerToCrew(c1, 'a1')
    const d = disp()
    await expect(dispatchCase(d.db, d.actor, await readCase(d.db, c2), { ambulance: { ...mkAmbulance('a1', 12.869, 74.84), callSign: 'Medic 1' }, etaSceneMin: 3, etaSource: 'estimate' })).rejects.toThrow(/available/)
    // and the rules enforce it even if the client is bypassed
    await assertFails(updateDoc(doc(d.db, 'ambulances', 'a1'), { available: false, currentCaseId: c2 }))
    await assertFails(updateDoc(doc(d.db, 'ambulances', 'a3'), { available: false, currentCaseId: c2 })) // the case must actually name that unit
    await assertFails(updateDoc(doc(d.db, 'ambulances', 'a3'), { available: false, currentCaseId: null })) // flags must agree
  })

  it('does not let transport start until the destination is confirmed AND the crew acknowledged it', async () => {
    const { id, a } = await toOnScene(false)
    await assertFails(updateDoc(doc(a.db, 'cases', id), { destinationAckAtMs: Date.now(), destinationAckByUid: a.actor.uid })) // nothing to acknowledge yet
    await assertFails(updateDoc(doc(a.db, 'cases', id), { status: 'transporting', pickupAtMs: Date.now() })) // no destination
    const d = disp()
    await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), 'h1', null)
    await assertFails(updateDoc(doc(a.db, 'cases', id), { status: 'transporting', pickupAtMs: Date.now() })) // destination, but not acknowledged
    await expect(advanceStatus(a.db, a.actor, await readCase(a.db, id), pos())).rejects.toThrow(/Acknowledge/)
    await assertFails(updateDoc(doc(amb('amb2').db, 'cases', id), { destinationAckAtMs: Date.now(), destinationAckByUid: 'amb2' })) // not their case
    await assertFails(updateDoc(doc(a.db, 'cases', id), { destinationAckAtMs: Date.now(), destinationAckByUid: 'someone-else' })) // forged author
    await acknowledgeDestination(a.db, a.actor, await readCase(a.db, id))
    await assertFails(updateDoc(doc(a.db, 'cases', id), { status: 'transporting' })) // pickup time is mandatory
    await advanceStatus(a.db, a.actor, await readCase(a.db, id), pos())
    expect(await readCase(a.db, id)).toMatchObject({ status: 'transporting' })
    expect((await readCase(a.db, id)).pickupAtMs).toBeGreaterThan(0)
  })

  it('only lets the crew move forward one step at a time and never close or rewrite the case', async () => {
    const { id, a } = await toOnScene()
    for (const patch of [{ status: 'arrived' }, { status: 'closed' }, { status: 'reported' }, { selectedHospitalId: 'h2' }, { notifiedHospitalIds: [] }, { activeHospitalIds: [] }, { arrivalConfirmedAtMs: Date.now() }, { ambulanceId: 'a2' }]) {
      await assertFails(updateDoc(doc(a.db, 'cases', id), patch))
    }
  })

  it('validates position payloads', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1')
    const a = amb('amb1')
    await assertSucceeds(updateDoc(doc(a.db, 'cases', id), { ambulancePos: { lat: 12.9, lng: 74.9, atMs: Date.now(), source: 'gps' } }))
    await assertFails(updateDoc(doc(a.db, 'cases', id), { ambulancePos: { lat: 999, lng: 74.9, atMs: Date.now(), source: 'gps' } }))
    await assertFails(updateDoc(doc(a.db, 'cases', id), { ambulancePos: { lat: 12.9, lng: 74.9, atMs: Date.now(), source: 'magic' } }))
    await assertFails(updateDoc(doc(a.db, 'cases', id), { ambulancePos: { lat: 12.9, lng: 74.9, atMs: 5, source: 'gps' } }))
  })
})

describe('handover and closing', () => {
  async function toArrived() {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await tick(id)
    const d = disp()
    await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), 'h1', null)
    const a = amb('amb1')
    await advanceStatus(a.db, a.actor, await readCase(a.db, id), pos())
    await acknowledgeDestination(a.db, a.actor, await readCase(a.db, id))
    await advanceStatus(a.db, a.actor, await readCase(a.db, id), pos())
    await advanceStatus(a.db, a.actor, await readCase(a.db, id), pos())
    return { id, d, a }
  }
  it('cannot be closed after arrival until the hospital confirms receipt', async () => {
    const { id, d } = await toArrived()
    await expect(closeCase(d.db, d.actor, await readCase(d.db, id), 'Handed over')).rejects.toThrow(/not confirmed/)
    await assertFails(updateDoc(doc(d.db, 'cases', id), { status: 'closed', closedAtMs: Date.now(), closeReason: 'Handed over' })) // the rules agree
    await assertFails(updateDoc(doc(amb('amb1').db, 'cases', id), { arrivalConfirmedAtMs: Date.now(), arrivalConfirmedByUid: 'amb1' })) // crew cannot confirm for the hospital
    await assertFails(updateDoc(doc(hosp('h2').db, 'cases', id), { arrivalConfirmedAtMs: Date.now(), arrivalConfirmedByUid: 'hs-h2' })) // wrong hospital
    const h = hosp('h1')
    await confirmArrival(h.db, h.actor, await readCase(h.db, id))
    await closeCase(d.db, d.actor, await readCase(d.db, id), 'Handed over')
    expect(await readCase(d.db, id)).toMatchObject({ status: 'closed' })
    expect((await getDoc(doc(d.db, 'ambulances', 'a1'))).data()).toMatchObject({ available: true, currentCaseId: null })
  })
  it('can be cancelled before arrival, which still frees the ambulance', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    const d = disp()
    await closeCase(d.db, d.actor, await readCase(d.db, id), 'Cancelled: false alarm')
    expect((await getDoc(doc(d.db, 'ambulances', 'a1'))).data()?.currentCaseId).toBeNull()
  })
  it('requires a real reason and a current timestamp to close', async () => {
    const id = await reportCase()
    const d = disp()
    await assertFails(updateDoc(doc(d.db, 'cases', id), { status: 'closed', closedAtMs: Date.now(), closeReason: '' }))
    await assertFails(updateDoc(doc(d.db, 'cases', id), { status: 'closed', closedAtMs: 5, closeReason: 'Cancelled' }))
    await assertSucceeds(updateDoc(doc(d.db, 'cases', id), { status: 'closed', closedAtMs: Date.now(), closeReason: 'Cancelled: false alarm' }))
  })
})

describe('audit trail', () => {
  it('is append-only: nobody can edit or delete events', async () => {
    const id = await reportCase()
    const d = disp()
    const events = await getDocs(collection(d.db, 'cases', id, 'events'))
    expect(events.size).toBe(1)
    await assertFails(updateDoc(events.docs[0].ref, { text: 'tampered' }))
    await assertFails(deleteDoc(events.docs[0].ref))
  })
  it('rejects forged authorship or roles', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    const ev = (uid: string, role: string) => ({ kind: 'status', text: 'x', atMs: Date.now(), actorUid: uid, actorRole: role })
    await assertFails(addDoc(collection(disp().db, 'cases', id, 'events'), ev('someone-else', 'dispatcher')))
    await assertFails(addDoc(collection(hosp('h1').db, 'cases', id, 'events'), ev('hs-h1', 'dispatcher')))
    await assertFails(addDoc(collection(hosp('h6').db, 'cases', id, 'events'), ev('hs-h6', 'hospital')))
    await assertFails(addDoc(collection(amb('amb2').db, 'cases', id, 'events'), ev('amb2', 'ambulance')))
    await assertFails(addDoc(collection(reporter('rep2').db, 'cases', id, 'events'), ev('rep2', 'reporter')))
    await assertSucceeds(addDoc(collection(hosp('h1').db, 'cases', id, 'events'), ev('hs-h1', 'hospital')))
  })
})

describe('ambulance fleet records', () => {
  it('lets a crew update only its own position and never claim, release or rename anything', async () => {
    await assertSucceeds(updateDoc(doc(amb('amb1').db, 'ambulances', 'a1'), { lat: 12.9, lng: 74.9 }))
    await assertFails(updateDoc(doc(amb('amb1').db, 'ambulances', 'a2'), { lat: 12.9, lng: 74.9 }))
    await assertFails(updateDoc(doc(amb('amb1').db, 'ambulances', 'a1'), { callSign: 'x' }))
    await assertFails(updateDoc(doc(amb('amb1').db, 'ambulances', 'a1'), { available: false, currentCaseId: 'c' }))
    await assertFails(updateDoc(doc(reporter().db, 'ambulances', 'a1'), { lat: 1, lng: 1 }))
    await assertFails(updateDoc(doc(disp().db, 'ambulances', 'a1'), { callSign: 'renamed' }))
  })
})

describe('evidence: files stored as access-controlled chunks', () => {
  const up = async (who = reporter('rep1'), caseId: string, evidenceId = 'ev1', size = 1_700_000) => {
    await uploadEvidence(who.db, who.actor, caseId, evidenceId, bytes(size), imgMeta)
    return bytes(size)
  }
  const meta = (over: Record<string, unknown> = {}) => ({ name: 'a.jpg', mime: 'image/jpeg', kind: 'image', size: 1000, sha256: 'a'.repeat(64), chunkCount: 1, chunkSize: 716800, status: 'uploading', uploaderUid: 'rep1', createdAtMs: Date.now(), origin: 'file', ...over })

  it('round-trips a multi-chunk file, verified by checksum, for dispatch', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    const original = await up(reporter('rep1'), id)
    const d = disp()
    const evs = (await getDocs(collection(d.db, 'cases', id, 'evidence'))).docs.map((x) => ({ ...x.data(), id: x.id }) as Evidence)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toMatchObject({ status: 'ready', chunkCount: 3, size: 1_700_000 })
    const blob = await downloadEvidence(d.db, id, evs[0])
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original)
  })

  it('lets exactly the people on the case see the evidence', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    await up(reporter('rep1'), id)
    const read = (who: { db: ReturnType<typeof disp>['db'] }) => getDocs(collection(who.db, 'cases', id, 'evidence'))
    await assertFails(read(reporter('rep2')))
    await assertFails(read(stranger()))
    await assertFails(read(hosp('h1'))) // not asked yet
    await dispatchIt(id)
    await assertSucceeds(read(reporter('rep1')))
    await assertSucceeds(read(disp()))
    await assertSucceeds(read(amb('amb1')))
    await assertFails(read(amb('amb2')))
    await assertSucceeds(read(hosp('h1')))
    await assertFails(read(hosp('h6')))
    await assertSucceeds(getDocs(collection(hosp('h1').db, 'cases', id, 'evidence', 'ev1', 'chunks')))
    await assertFails(getDocs(collection(hosp('h6').db, 'cases', id, 'evidence', 'ev1', 'chunks')))
  })

  it('takes the evidence away from a hospital the moment it declines', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    await up(reporter('rep1'), id)
    await dispatchIt(id)
    await assertSucceeds(getDocs(collection(hosp('h1').db, 'cases', id, 'evidence')))
    await answer(id, 'h1', false)
    await assertFails(getDocs(collection(hosp('h1').db, 'cases', id, 'evidence')))
    await assertFails(getDocs(collection(hosp('h1').db, 'cases', id, 'evidence', 'ev1', 'chunks')))
  })

  it('keeps evidence with the confirmed hospital only', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    await up(reporter('rep1'), id)
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await answer(id, 'h2', true)
    await tick(id)
    const d = disp()
    await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), 'h1', null)
    await assertSucceeds(getDocs(collection(hosp('h1').db, 'cases', id, 'evidence')))
    await assertFails(getDocs(collection(hosp('h2').db, 'cases', id, 'evidence')))
  })

  it('rejects unsupported types, oversize files, inconsistent metadata and uploads by outsiders', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    const col = (who = reporter('rep1')) => doc(who.db, 'cases', id, 'evidence', 'bad')
    await assertSucceeds(setDoc(col(), meta()))
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b2'), meta({ mime: 'image/gif' })))
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b3'), meta({ mime: 'image/svg+xml' })))
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b4'), meta({ mime: 'text/html', kind: 'document' })))
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b5'), meta({ kind: 'image', mime: 'application/pdf' }))) // kind and mime must agree
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b6'), meta({ size: 6 * 1024 * 1024, chunkCount: 9 }))) // image over 5 MB
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b7'), meta({ kind: 'video', mime: 'video/mp4', size: 16 * 1024 * 1024, chunkCount: 24 })))
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b8'), meta({ size: 2_000_000, chunkCount: 1 }))) // chunk count must match size
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b9'), meta({ sha256: 'zz' })))
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b10'), meta({ status: 'ready' }))) // cannot be created already "ready"
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'b11'), meta({ uploaderUid: 'rep9' }))) // forged uploader
    await assertFails(setDoc(doc(reporter('rep2').db, 'cases', id, 'evidence', 'b12'), meta({ uploaderUid: 'rep2' }))) // not their case
    await assertFails(setDoc(doc(hosp('h1').db, 'cases', id, 'evidence', 'b13'), meta({ uploaderUid: 'hs-h1' }))) // hospitals cannot add evidence
  })

  it('refuses to mark an upload ready before its last chunk arrives, and freezes it afterwards', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    const r = reporter('rep1')
    const e = doc(r.db, 'cases', id, 'evidence', 'ev9')
    await setDoc(e, meta({ size: 1_500_000, chunkCount: 3 }))
    const chunk = (n: number) => doc(r.db, 'cases', id, 'evidence', 'ev9', 'chunks', String(n))
    await assertSucceeds(setDoc(chunk(0), { i: 0, data: Bytes.fromUint8Array(bytes(716_800)) }))
    await assertFails(updateDoc(e, { status: 'ready' })) // last chunk missing
    await assertFails(setDoc(chunk(1), { i: 1, data: Bytes.fromUint8Array(bytes(100)) })) // a middle chunk must be full size
    await assertFails(setDoc(chunk(5), { i: 5, data: Bytes.fromUint8Array(bytes(100)) })) // out of range
    await assertFails(setDoc(chunk(1), { i: 7, data: Bytes.fromUint8Array(bytes(716_800)) })) // index must match the id
    await assertFails(setDoc(chunk(1), { i: 1, data: Bytes.fromUint8Array(bytes(716_801)) })) // over the chunk size
    await assertFails(setDoc(doc(reporter('rep2').db, 'cases', id, 'evidence', 'ev9', 'chunks', '1'), { i: 1, data: Bytes.fromUint8Array(bytes(716_800)) })) // not the uploader
    await assertSucceeds(setDoc(chunk(1), { i: 1, data: Bytes.fromUint8Array(bytes(716_800)) }))
    await assertSucceeds(setDoc(chunk(2), { i: 2, data: Bytes.fromUint8Array(bytes(66_400)) }))
    await assertFails(updateDoc(e, { status: 'ready', size: 1 })) // only the status may change
    await assertSucceeds(updateDoc(e, { status: 'ready' }))
    await assertFails(setDoc(chunk(1), { i: 1, data: Bytes.fromUint8Array(bytes(716_800, 9)) })) // finished chunks are immutable
    await assertFails(deleteDoc(e)) // finished evidence is permanent
    await assertFails(deleteDoc(chunk(0)))
  })

  it('lets an unfinished upload be abandoned', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    const r = reporter('rep1')
    await setDoc(doc(r.db, 'cases', id, 'evidence', 'ev9'), meta())
    await assertSucceeds(deleteDoc(doc(r.db, 'cases', id, 'evidence', 'ev9')))
    await assertFails(deleteDoc(doc(reporter('rep2').db, 'cases', id, 'evidence', 'nope')))
  })

  it('accepts no new evidence on a closed case', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    const d = disp()
    await closeCase(d.db, d.actor, await readCase(d.db, id), 'Cancelled: false alarm')
    await assertFails(setDoc(doc(reporter('rep1').db, 'cases', id, 'evidence', 'late'), meta()))
  })

  it('detects a tampered or incomplete file instead of showing it', async () => {
    const id = await reportCase('trauma', {}, reporter('rep1'))
    await up(reporter('rep1'), id)
    const d = disp()
    const ev = { ...(await getDoc(doc(d.db, 'cases', id, 'evidence', 'ev1'))).data(), id: 'ev1' } as Evidence
    await withAdmin((db) => setDoc(doc(db, 'cases', id, 'evidence', 'ev1', 'chunks', '1'), { i: 1, data: Bytes.fromUint8Array(bytes(716_800, 99)) }))
    await expect(downloadEvidence(d.db, id, ev)).rejects.toBeInstanceOf(EvidenceIntegrityError)
    await withAdmin((db) => deleteDoc(doc(db, 'cases', id, 'evidence', 'ev1', 'chunks', '2')))
    await expect(downloadEvidence(d.db, id, ev)).rejects.toThrow(/parts/)
  })
})

describe('AI briefing documents', () => {
  const draft = (over = {}) => ({ aiGenerated: true, model: 'm', generatedAtMs: Date.now(), transcript: null, summary: 's', facts: {}, missingInformation: [], uncertainties: [], conflicts: [], handoff: 'h', sourceEvidenceIds: [], guardrailFlags: [], ...over })
  it('keeps the draft private to dispatch and shares only the reviewed handoff', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    const d = disp()
    await assertSucceeds(setDoc(doc(d.db, 'cases', id, 'ai', 'draft'), draft()))
    for (const who of [hosp('h1'), amb('amb1'), reporter('rep1')]) await assertFails(getDoc(doc(who.db, 'cases', id, 'ai', 'draft')))
    for (const who of [hosp('h1'), amb('amb1')]) await assertSucceeds(getDoc(doc(who.db, 'cases', id, 'ai', 'handoff'))) // permitted, just not written yet
    await assertFails(setDoc(doc(d.db, 'cases', id, 'ai', 'handoff'), draft())) // sharing needs a named, timestamped reviewer
    await assertSucceeds(setDoc(doc(d.db, 'cases', id, 'ai', 'handoff'), draft({ reviewedByUid: 'disp1', reviewedAtMs: Date.now() })))
    expect((await getDoc(doc(hosp('h1').db, 'cases', id, 'ai', 'handoff'))).data()?.aiGenerated).toBe(true)
    await assertFails(getDoc(doc(hosp('h6').db, 'cases', id, 'ai', 'handoff'))) // not on the case
    await assertFails(getDoc(doc(reporter('rep1').db, 'cases', id, 'ai', 'handoff')))
  })
  it('lets only dispatch write it, and only if it is labelled AI-generated', async () => {
    const id = await reportCase()
    for (const who of [hosp('h1'), amb(), reporter('rep1')]) await assertFails(setDoc(doc(who.db, 'cases', id, 'ai', 'draft'), draft()))
    await assertFails(setDoc(doc(disp().db, 'cases', id, 'ai', 'draft'), draft({ aiGenerated: false })))
    await assertFails(setDoc(doc(disp().db, 'cases', id, 'ai', 'draft'), draft({ summary: 'x'.repeat(2001) })))
    await assertFails(setDoc(doc(disp().db, 'cases', id, 'ai', 'other'), draft()))
  })
  it('removes a hospital from the handoff when it declines', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await setDoc(doc(disp().db, 'cases', id, 'ai', 'handoff'), draft({ reviewedByUid: 'disp1', reviewedAtMs: Date.now() }))
    await answer(id, 'h1', false)
    await assertFails(getDoc(doc(hosp('h1').db, 'cases', id, 'ai', 'handoff')))
  })
})

describe('display preferences', () => {
  const prefs = { theme: 'dark', textSize: 'large', reduceMotion: 'on', sound: true, desktopAlerts: false, compact: true }
  it('are private to their owner and validated', async () => {
    const a = reporter('rep1')
    await assertSucceeds(setDoc(doc(a.db, 'userPrefs', 'rep1'), prefs))
    await assertSucceeds(getDoc(doc(a.db, 'userPrefs', 'rep1')))
    await assertFails(getDoc(doc(reporter('rep2').db, 'userPrefs', 'rep1')))
    await assertFails(setDoc(doc(reporter('rep2').db, 'userPrefs', 'rep1'), prefs))
    await assertFails(setDoc(doc(a.db, 'userPrefs', 'rep1'), { ...prefs, theme: 'neon' }))
    await assertFails(setDoc(doc(a.db, 'userPrefs', 'rep1'), { ...prefs, role: 'dispatcher' }))
    await assertFails(deleteDoc(doc(a.db, 'userPrefs', 'rep1')))
  })
})
