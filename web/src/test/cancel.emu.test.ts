import { collection, doc, getDoc, getDocs, updateDoc } from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseReceipt } from '../lib/crypto'
import { closeKindOf, type Offer } from '../lib/types'
import { acknowledgeDestination, advanceStatus, askHospital, cancelCase, claimCase, closeCase, createCaseQueued, respondToOffer, selectDestination, withdrawReport } from '../lib/workflow'
import { answer, dispatchIt, input, offerToCrew, reportCase } from './scenario'
import { amb, disp, hosp, readCase, readHospitals, readOffers, reporter, resetWorld, startWorld, stopWorld } from './world'

beforeAll(startWorld)
afterAll(stopWorld)
beforeEach(resetWorld)

const eventKinds = async (caseId: string) => (await getDocs(collection(disp().db, 'cases', caseId, 'events'))).docs.map((d) => d.data().kind as string)
const here = () => ({ lat: 12.87, lng: 74.84, atMs: Date.now(), source: 'simulated' as const })

describe('false, accidental and withdrawn reports (nothing is deleted)', () => {
  it('lets dispatch end a live case as a false report: ambulance freed, hospitals stood down, reason and audit kept', async () => {
    const id = await reportCase('trauma')
    await dispatchIt(id)
    const d = disp()
    const c = await readCase(d.db, id)
    expect(c.activeHospitalIds.length).toBeGreaterThan(0)
    const offered = c.activeHospitalIds[0]
    await cancelCase(d.db, d.actor, c, 'false', 'Caller admitted it was a prank', await readOffers(d.db, id))
    const after = await readCase(d.db, id)
    expect(after).toMatchObject({ status: 'closed', activeHospitalIds: [], selectedHospitalId: null })
    expect(closeKindOf(after)).toBe('false')
    expect(after.closeReason).toMatch(/^False report: Caller admitted/)
    expect((await getDoc(doc(d.db, 'ambulances', 'a1'))).data()).toMatchObject({ available: true, currentCaseId: null })
    expect((await readOffers(d.db, id)).every((o) => o.state === 'withdrawn')).toBe(true)
    expect(await eventKinds(id)).toContain('cancelled')
    // the hospital lost access to the case; the record itself still exists for dispatch
    await expect(getDoc(doc(hosp(offered).db, 'cases', id))).rejects.toThrow()
    expect((await getDoc(doc(d.db, 'cases', id))).exists()).toBe(true)
  })

  it('refuses a cancellation without a reason, and once the patient is on board (in the app and in the rules)', async () => {
    const id = await reportCase('trauma')
    await dispatchIt(id)
    const d = disp()
    await expect(cancelCase(d.db, d.actor, await readCase(d.db, id), 'accidental', '  ')).rejects.toThrow(/reason/)
    const best = (await readOffers(d.db, id))[0].hospitalId
    await answer(id, best, true)
    await selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), best, null, best)
    const a = amb()
    await advanceStatus(a.db, a.actor, await readCase(a.db, id), here())
    await acknowledgeDestination(a.db, a.actor, await readCase(a.db, id))
    await advanceStatus(a.db, a.actor, await readCase(a.db, id), here())
    expect((await readCase(d.db, id)).status).toBe('transporting')
    await expect(cancelCase(d.db, d.actor, await readCase(d.db, id), 'false', 'too late to cancel')).rejects.toThrow(/transported|hand-over/)
    await expect(closeCase(d.db, d.actor, await readCase(d.db, id), 'Cancelled: bypassing the app check')).rejects.toThrow()
  })

  it('lets a reporter withdraw an untouched report, but not after a crew was contacted and not someone elses', async () => {
    const r = reporter('rep1')
    const made = await createCaseQueued(r.db, r.actor, input('trauma'))
    await made.done
    const other = reporter('rep2')
    await expect(withdrawReport(other.db, other.actor, await readCase(r.db, made.id), 'not mine')).rejects.toThrow()
    await withdrawReport(r.db, r.actor, await readCase(r.db, made.id), 'Sent by mistake')
    const c = await readCase(r.db, made.id)
    expect(closeKindOf(c)).toBe('withdrawn')
    expect(c.closeReason).toBe('Withdrawn by reporter: Sent by mistake')
    expect(await eventKinds(made.id)).toContain('withdrawn')

    const r2 = reporter('rep3')
    const second = await createCaseQueued(r2.db, r2.actor, input('trauma'))
    await second.done
    await offerToCrew(second.id)
    // pretend the app still thinks it is untouched: the rules must refuse
    await expect(withdrawReport(r2.db, r2.actor, { ...(await readCase(r2.db, second.id)), status: 'reported' }, 'too late')).rejects.toThrow()
    expect((await readCase(r2.db, second.id)).status).toBe('dispatched')
  })

  it('lets a receipt holder on a second device withdraw, and nothing but the three closing fields can change', async () => {
    const r = reporter('rep1')
    const made = await createCaseQueued(r.db, r.actor, input('trauma'))
    await made.done
    const { caseId, secret } = parseReceipt(made.receipt)!
    const phone2 = reporter('rep1-second')
    await claimCase(phone2.db, phone2.actor, caseId, secret)
    await expect(updateDoc(doc(phone2.db, 'cases', caseId), { status: 'closed', closedAtMs: Date.now(), closeReason: 'Withdrawn by reporter: ok fine', severity: 3 })).rejects.toThrow()
    await expect(updateDoc(doc(phone2.db, 'cases', caseId), { status: 'closed', closedAtMs: Date.now(), closeReason: 'whatever' })).rejects.toThrow()
    await withdrawReport(phone2.db, phone2.actor, await readCase(phone2.db, caseId), 'No longer needed')
    expect((await readCase(disp().db, caseId)).status).toBe('closed')
  })
})

describe('a declining hospital may suggest another, which still has to confirm', () => {
  it('records the suggestion, lets dispatch ask that hospital only once, and never skips its confirmation', async () => {
    const id = await reportCase('trauma')
    await dispatchIt(id)
    const d = disp()
    const asked = (await readOffers(d.db, id)).map((o) => o.hospitalId)
    const outsider = (await readHospitals(d.db)).find((h) => !asked.includes(h.id) && h.capabilities.includes('trauma'))
    expect(outsider, 'the seeded world should have a trauma hospital outside the first wave').toBeTruthy()
    const h = hosp(asked[0])
    const offer = (await readOffers(d.db, id)).find((o) => o.hospitalId === asked[0]) as Offer
    await respondToOffer(h.db, h.actor, offer, { accept: false, canReceive: false, confirmations: {}, declineReason: 'No capacity right now', suggest: { id: outsider!.id, name: outsider!.name } })
    expect((await readOffers(d.db, id)).find((o) => o.hospitalId === asked[0])?.suggestedHospitalId).toBe(outsider!.id)
    const cand = { hospital: outsider!, distanceKm: 3, etaMin: 6, etaSource: 'estimate' as const }
    expect(await askHospital(d.db, d.actor, await readCase(d.db, id), cand, 'suggested')).toBe(true)
    expect(await askHospital(d.db, d.actor, await readCase(d.db, id), cand, 'suggested')).toBe(false)
    expect((await readOffers(d.db, id)).find((x) => x.hospitalId === outsider!.id)?.state).toBe('pending')
    await expect(selectDestination(d.db, d.actor, await readCase(d.db, id), await readOffers(d.db, id), outsider!.id, 'because', null)).rejects.toThrow()
  })

  it('rejects a suggestion that names the suggesting hospital, or comes with an accept', async () => {
    const id = await reportCase('trauma')
    await dispatchIt(id)
    const offer = (await readOffers(disp().db, id))[0]
    const h = hosp(offer.hospitalId)
    const base = { respondedAtMs: Date.now(), respondedByUid: h.actor.uid, confirmations: { trauma: true }, declineReason: 'x' }
    await expect(updateDoc(doc(h.db, 'offers', offer.id), { ...base, state: 'declined', canReceive: false, suggestedHospitalId: offer.hospitalId })).rejects.toThrow()
    await expect(updateDoc(doc(h.db, 'offers', offer.id), { ...base, state: 'accepted', canReceive: true, declineReason: null, suggestedHospitalId: 'h5' })).rejects.toThrow()
  })
})
