import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing'
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, query, setDoc, updateDoc, where } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { advanceStatus, acknowledgeAssignment, selectDestination, createCase } from '../lib/workflow'
import { answer, dispatchIt, input, reportCase } from './scenario'
import { anonymous, amb, disabledDispatcher, disp, hosp, readCase, readOffers, reporter, resetWorld, startWorld, stopWorld, stranger } from './world'

beforeAll(startWorld)
afterAll(stopWorld)
beforeEach(resetWorld)

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
    await assertFails(getDocs(collection(s.db, 'hospitals')))
    await assertFails(getDocs(collection(s.db, 'ambulances')))
    await assertFails(getDocs(collection(s.db, 'cases')))
    await assertFails(getDocs(collection(s.db, 'offers')))
  })
  it('denies a disabled dispatcher everything', async () => {
    const d = disabledDispatcher()
    await assertFails(getDocs(collection(d.db, 'cases')))
    await assertFails(getDocs(collection(d.db, 'hospitals')))
  })
  it('denies unauthenticated users everything', async () => {
    const db = anonymous()
    for (const c of ['cases', 'hospitals', 'ambulances', 'offers', 'users']) await assertFails(getDocs(collection(db, c)))
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
    ambulancePos: null, etaSceneMin: null, etaSource: null, dispatchedAtMs: null, notifiedHospitalIds: [], offerWave: 0, recommendedHospitalId: null,
    selectedHospitalId: null, selectedHospitalName: null, selectedAtMs: null, selectedByUid: null, overrideReason: null, escalation: 'none', escalationNote: null,
    duplicateOf: null, duplicateDismissed: false, arrivalConfirmedAtMs: null, arrivalConfirmedByUid: null, closedAtMs: null, closeReason: null, ...over,
  })
  it('accepts a well-formed report from an anonymous reporter', async () => {
    const r = reporter()
    const id = await createCase(r.db, r.actor, input('snakebite'))
    expect((await readCase(r.db, id)).requiredCapabilities).toEqual(['antivenom'])
  })
  it('rejects spoofed reporter, pre-set workflow fields, bad values and mismatched capabilities', async () => {
    const r = reporter()
    const col = collection(r.db, 'cases')
    await assertSucceeds(addDoc(col, raw('rep1')))
    await assertFails(addDoc(col, raw('someone-else')))
    await assertFails(addDoc(col, raw('rep1', { status: 'dispatched' })))
    await assertFails(addDoc(col, raw('rep1', { ambulanceId: 'a1' })))
    await assertFails(addDoc(col, raw('rep1', { selectedHospitalId: 'h1' })))
    await assertFails(addDoc(col, raw('rep1', { notifiedHospitalIds: ['h1'] })))
    await assertFails(addDoc(col, raw('rep1', { severity: 9 })))
    await assertFails(addDoc(col, raw('rep1', { patients: 0 })))
    await assertFails(addDoc(col, raw('rep1', { brief: 'x'.repeat(161) })))
    await assertFails(addDoc(col, raw('rep1', { type: 'trauma', requiredCapabilities: ['cardiac'] })))
    await assertFails(addDoc(col, raw('rep1', { requiredCapabilities: ['trauma', 'nonsense'] })))
    await assertFails(addDoc(col, raw('rep1', { createdAtMs: Date.now() - 86_400_000 })))
    await assertFails(addDoc(col, raw('rep1', { lat: 500 })))
    await assertFails(addDoc(col, raw('rep1', { injected: 'field' })))
    await assertFails(addDoc(col, raw('rep1', { escalation: 'no_hospital' })))
  })
  it('does not let a reporter edit or delete cases, even their own', async () => {
    const r = reporter()
    const id = await reportCase()
    await assertFails(updateDoc(doc(r.db, 'cases', id), { severity: 3 }))
    await assertFails(updateDoc(doc(r.db, 'cases', id), { status: 'closed' }))
    await assertFails(deleteDoc(doc(r.db, 'cases', id)))
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
  it('hides a case from hospitals until they are asked, and hides contact details until they are confirmed', async () => {
    const id = await reportCase()
    await assertFails(getDoc(doc(hosp('h1').db, 'cases', id)))
    await dispatchIt(id)
    await assertSucceeds(getDoc(doc(hosp('h1').db, 'cases', id))) // asked: sees the brief
    await assertFails(getDoc(doc(hosp('h1').db, 'cases', id, 'private', 'patient'))) // but not phone / free text
    await assertFails(getDoc(doc(hosp('h6').db, 'cases', id))) // never asked in wave 1
    await assertFails(getDocs(collection(hosp('h1').db, 'cases'))) // unfiltered list is refused
    const mine = await assertSucceeds(getDocs(query(collection(hosp('h1').db, 'cases'), where('notifiedHospitalIds', 'array-contains', 'h1'))))
    expect(mine.size).toBe(1)
    await assertFails(getDocs(query(collection(hosp('h1').db, 'cases'), where('notifiedHospitalIds', 'array-contains', 'h2'))))
  })
  it('releases contact details only to the confirmed hospital and the assigned crew', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    await answer(id, 'h2', true)
    const d = disp()
    let c = await readCase(d.db, id)
    await updateDoc(doc(d.db, 'cases', id), { recommendedHospitalId: 'h1' })
    c = await readCase(d.db, id)
    await selectDestination(d.db, d.actor, c, await readOffers(d.db, id), 'h1', null)
    await assertSucceeds(getDoc(doc(hosp('h1').db, 'cases', id, 'private', 'patient')))
    await assertFails(getDoc(doc(hosp('h2').db, 'cases', id, 'private', 'patient')))
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
  it('lets only the assigned ambulance read the case and events', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1')
    await assertSucceeds(getDoc(doc(amb('amb1').db, 'cases', id)))
    await assertFails(getDoc(doc(amb('amb2').db, 'cases', id)))
    await assertSucceeds(getDocs(collection(amb('amb1').db, 'cases', id, 'events')))
    await assertFails(getDocs(collection(hosp('h1').db, 'cases', id, 'events')))
    await assertFails(getDocs(collection(reporter().db, 'cases', id, 'events')))
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
    await assertFails(updateDoc(doc(h.db, 'hospitals', 'h1'), { capabilities: ['emergency'] })) // no timestamp
  })
  it('stops everyone else from editing hospitals or creating or deleting them', async () => {
    for (const who of [reporter(), amb(), disp()]) {
      await assertFails(updateDoc(doc(who.db, 'hospitals', 'h1'), { diverted: true }))
    }
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
    await assertFails(updateDoc(doc(hosp('h2').db, 'offers', `${id}_h1`), resp({ respondedByUid: 'hs-h2' }))) // wrong hospital
    await assertFails(updateDoc(doc(reporter().db, 'offers', `${id}_h1`), resp()))
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp({ respondedByUid: 'someone-else' }))) // forged identity
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp({ state: 'selected' }))) // cannot select itself
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp({ confirmations: { warp: true } })))
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), { ...resp(), etaMin: 0 })) // cannot rewrite its own ETA
    await assertSucceeds(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp()))
    // A second answer cannot rewrite the first: re-accepting with different confirmations is refused...
    await assertFails(updateDoc(doc(hosp('h1').db, 'offers', `${id}_h1`), resp({ confirmations: { trauma: true, icu: true } })))
    // ...the only way out is an explicit withdrawal (covered below), after which the offer is closed for good.
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
})

describe('choosing the destination', () => {
  it('refuses to select a hospital that has not explicitly confirmed', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    const d = disp()
    await assertFails(updateDoc(doc(d.db, 'cases', id), { selectedHospitalId: 'h1', selectedHospitalName: 'x', selectedByUid: 'disp1', selectedAtMs: Date.now(), recommendedHospitalId: 'h1' })) // pending
    await answer(id, 'h1', true, [], true) // accepted but confirmed nothing
    await assertFails(updateDoc(doc(d.db, 'cases', id), { selectedHospitalId: 'h1', selectedHospitalName: 'x', selectedByUid: 'disp1', selectedAtMs: Date.now(), recommendedHospitalId: 'h1' }))
    await answer(id, 'h2', true, ['trauma'], false) // confirmed but cannot receive
    await assertFails(updateDoc(doc(d.db, 'cases', id), { selectedHospitalId: 'h2', selectedHospitalName: 'x', selectedByUid: 'disp1', selectedAtMs: Date.now(), recommendedHospitalId: 'h2' }))
    await answer(id, 'h3', false)
    await assertFails(updateDoc(doc(d.db, 'cases', id), { selectedHospitalId: 'h3', selectedHospitalName: 'x', selectedByUid: 'disp1', selectedAtMs: Date.now(), recommendedHospitalId: 'h3' }))
  })
  it('requires live antivenom confirmation for snakebite', async () => {
    const id = await reportCase('snakebite')
    await dispatchIt(id)
    const d = disp()
    await answer(id, 'h1', true, ['emergency'], true) // confirmed something else, not antivenom
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
    await assertFails(updateDoc(doc(d.db, 'cases', id), { selectedHospitalId: 'h2', selectedHospitalName: 'x', selectedByUid: 'disp1', selectedAtMs: Date.now(), overrideReason: null }))
    await selectDestination(d.db, d.actor, c, await readOffers(d.db, id), 'h2', 'Closer to the patient family')
    expect((await readCase(d.db, id)).overrideReason).toBe('Closer to the patient family')
  })
  it('stops non-dispatchers from selecting a destination', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    await answer(id, 'h1', true)
    for (const who of [hosp('h1'), amb(), reporter()]) {
      await assertFails(updateDoc(doc(who.db, 'cases', id), { selectedHospitalId: 'h1', selectedByUid: who.actor.uid, recommendedHospitalId: 'h1' }))
    }
  })
  it('stops dispatch rewriting reporter-supplied facts', async () => {
    const id = await reportCase()
    const d = disp()
    for (const patch of [{ severity: 3 }, { type: 'burns' }, { lat: 1 }, { reporterUid: 'x' }, { brief: 'changed' }, { createdAtMs: 1 }]) {
      await assertFails(updateDoc(doc(d.db, 'cases', id), patch))
    }
  })
})

describe('ambulance status transitions', () => {
  it('only allows the assigned crew, in order, and needs a confirmed destination before transport', async () => {
    const id = await reportCase()
    await dispatchIt(id, 'a1')
    const pos = { lat: 12.87, lng: 74.84, atMs: Date.now(), source: 'simulated' as const }
    const a2 = amb('amb2')
    await assertFails(updateDoc(doc(a2.db, 'cases', id), { status: 'enroute', ambulanceAckAtMs: Date.now() })) // different unit
    const a = amb('amb1')
    await assertFails(updateDoc(doc(a.db, 'cases', id), { status: 'onscene' })) // skipped acknowledgement
    await acknowledgeAssignment(a.db, a.actor, await readCase(a.db, id))
    await advanceStatus(a.db, a.actor, await readCase(a.db, id), pos) // onscene
    await expect(advanceStatus(a.db, a.actor, await readCase(a.db, id), pos)).rejects.toThrow() // no destination yet
    await assertFails(updateDoc(doc(a.db, 'cases', id), { status: 'arrived' })) // cannot skip
    await assertFails(updateDoc(doc(a.db, 'cases', id), { status: 'closed' }))
    await assertFails(updateDoc(doc(a.db, 'cases', id), { selectedHospitalId: 'h1' }))
    await assertFails(updateDoc(doc(a.db, 'cases', id), { notifiedHospitalIds: [] }))
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

describe('audit trail', () => {
  it('is append-only: nobody can edit or delete events', async () => {
    const id = await reportCase()
    const d = disp()
    const events = await getDocs(collection(d.db, 'cases', id, 'events'))
    expect(events.size).toBe(1)
    const ref = events.docs[0].ref
    await assertFails(updateDoc(ref, { text: 'tampered' }))
    await assertFails(deleteDoc(ref))
  })
  it('rejects forged authorship or roles', async () => {
    const id = await reportCase()
    await dispatchIt(id)
    const ev = (uid: string, role: string) => ({ kind: 'status', text: 'x', atMs: Date.now(), actorUid: uid, actorRole: role })
    await assertFails(addDoc(collection(disp().db, 'cases', id, 'events'), ev('someone-else', 'dispatcher')))
    await assertFails(addDoc(collection(hosp('h1').db, 'cases', id, 'events'), ev('hs-h1', 'dispatcher')))
    await assertFails(addDoc(collection(hosp('h6').db, 'cases', id, 'events'), ev('hs-h6', 'hospital'))) // never asked
    await assertFails(addDoc(collection(amb('amb2').db, 'cases', id, 'events'), ev('amb2', 'ambulance'))) // wrong unit
    await assertFails(addDoc(collection(reporter('rep2').db, 'cases', id, 'events'), ev('rep2', 'reporter')))
    await assertSucceeds(addDoc(collection(hosp('h1').db, 'cases', id, 'events'), ev('hs-h1', 'hospital')))
  })
})

describe('ambulance fleet records', () => {
  it('lets dispatch toggle availability only, and a crew update only its position', async () => {
    await assertSucceeds(updateDoc(doc(disp().db, 'ambulances', 'a1'), { available: false }))
    await assertFails(updateDoc(doc(disp().db, 'ambulances', 'a1'), { callSign: 'renamed' }))
    await assertSucceeds(updateDoc(doc(amb('amb1').db, 'ambulances', 'a1'), { lat: 12.9, lng: 74.9 }))
    await assertFails(updateDoc(doc(amb('amb1').db, 'ambulances', 'a2'), { lat: 12.9, lng: 74.9 }))
    // dispatch just set a1 to unavailable above, so this is a real change a crew must not be able to make
    await assertFails(updateDoc(doc(amb('amb1').db, 'ambulances', 'a1'), { available: true }))
    await assertFails(updateDoc(doc(reporter().db, 'ambulances', 'a1'), { available: true }))
  })
})
