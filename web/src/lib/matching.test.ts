import { describe, expect, it } from 'vitest'
import { mkCase, mkHospital, mkOffer, T0 } from './fixtures'
import { eligibility, explainRecommendation, isQualified, nearestFreeAmbulance, nextWave, offerStatusText, planEscalation, rankQualified } from './matching'
import type { Hospital } from './types'
import { mkAmbulance } from './fixtures'

const etaOf = (h: Hospital) => ({ etaMin: Math.round((h.lat - 12.87) * 1000), source: 'estimate' as const })
const accepted = (id: string, over = {}) => mkOffer(id, { state: 'accepted', canReceive: true, confirmations: { trauma: true }, respondedAtMs: T0 + 5000, ...over })

// Hospitals ordered by distance from the scene (12.87): h1 nearest.
const hs = [
  mkHospital('h1', 12.871, 74.84, ['emergency', 'trauma']),
  mkHospital('h2', 12.872, 74.84, ['emergency', 'trauma']),
  mkHospital('h3', 12.873, 74.84, ['emergency', 'trauma']),
  mkHospital('h4', 12.874, 74.84, ['emergency', 'trauma']),
  mkHospital('h5', 12.875, 74.84, ['emergency', 'trauma']),
  mkHospital('h6', 12.876, 74.84, ['emergency', 'trauma']),
  mkHospital('h7', 12.877, 74.84, ['emergency', 'trauma']),
  mkHospital('nocap', 12.8705, 74.84, ['emergency']),
  mkHospital('div', 12.8706, 74.84, ['emergency', 'trauma'], { diverted: true }),
  mkHospital('divtrauma', 12.8707, 74.84, ['emergency', 'trauma'], { divertedCapabilities: ['trauma'] }),
]

describe('eligibility', () => {
  const r = eligibility(mkCase(), hs)
  it('lists only hospitals with the required profile capability that are not diverted', () => {
    expect(r.eligible.map((h) => h.id)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'])
  })
  it('explains every exclusion', () => {
    const why = Object.fromEntries(r.excluded.map((e) => [e.hospital.id, e.reason]))
    expect(why.nocap).toMatch(/Trauma care not on hospital profile/)
    expect(why.div).toBe('On full diversion')
    expect(why.divtrauma).toMatch(/Diverted for Trauma care/)
  })
  it('requires ICU on the profile when the case needs ICU', () => {
    const c = mkCase({ needsIcu: true })
    expect(eligibility(c, hs).eligible).toHaveLength(0)
    const withIcu = hs.map((h) => (h.id === 'h2' ? { ...h, capabilities: [...h.capabilities, 'icu' as const] } : h))
    expect(eligibility(c, withIcu).eligible.map((h) => h.id)).toEqual(['h2'])
  })
  it('snakebite needs antivenom on the profile', () => {
    const c = mkCase({ type: 'snakebite' })
    expect(eligibility(c, hs).eligible).toHaveLength(0)
  })
})

describe('nextWave', () => {
  it('contacts the five nearest eligible hospitals first', () => {
    expect(nextWave(mkCase(), hs, [], etaOf).map((c) => c.hospital.id)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'])
  })
  it('then moves on to the next ones, skipping already contacted', () => {
    expect(nextWave(mkCase(), hs, ['h1', 'h2', 'h3', 'h4', 'h5'], etaOf).map((c) => c.hospital.id)).toEqual(['h6', 'h7'])
  })
  it('returns nothing when everyone eligible was contacted', () => {
    expect(nextWave(mkCase(), hs, hs.map((h) => h.id), etaOf)).toEqual([])
  })
})

describe('qualification and ranking', () => {
  const c = mkCase()
  it('accepts only when explicitly confirmed', () => {
    expect(isQualified(accepted('h1'), c)).toBe(true)
  })
  it('rejects accept without canReceive', () => {
    expect(isQualified(accepted('h1', { canReceive: false }), c)).toBe(false)
  })
  it('rejects accept with a missing or false capability confirmation', () => {
    expect(isQualified(accepted('h1', { confirmations: {} }), c)).toBe(false)
    expect(isQualified(accepted('h1', { confirmations: { trauma: false } }), c)).toBe(false)
    expect(isQualified(accepted('h1', { confirmations: null }), c)).toBe(false)
  })
  it('requires every capability, including ICU, for ICU cases', () => {
    const icu = mkCase({ needsIcu: true })
    expect(isQualified(accepted('h1', { confirmations: { trauma: true } }), icu)).toBe(false)
    expect(isQualified(accepted('h1', { confirmations: { trauma: true, icu: true } }), icu)).toBe(true)
  })
  it('requires live antivenom confirmation for snakebite', () => {
    const sb = mkCase({ type: 'snakebite' })
    expect(isQualified(mkOffer('h1', { state: 'accepted', canReceive: true, confirmations: { antivenom: false } }), sb)).toBe(false)
    expect(isQualified(mkOffer('h1', { state: 'accepted', canReceive: true, confirmations: { antivenom: true } }), sb)).toBe(true)
  })
  it('ranks by ETA then distance, ignoring unqualified offers', () => {
    const offers = [accepted('h2', { etaMin: 9 }), accepted('h1', { etaMin: 4 }), mkOffer('h3', { state: 'declined' }), accepted('h4', { etaMin: 9, distanceKm: 1 })]
    expect(rankQualified(offers, c).map((r) => r.offer.hospitalId)).toEqual(['h1', 'h4', 'h2'])
  })
  it('explains the recommendation', () => {
    const ranked = rankQualified([accepted('h1', { etaMin: 4 }), accepted('h2', { etaMin: 9 })], c)
    const text = explainRecommendation(ranked[0], ranked, c).join(' ')
    expect(text).toMatch(/explicitly confirmed Trauma care/)
    expect(text).toMatch(/Fastest of 2/)
    expect(text).toMatch(/Next best: Hospital h2/)
  })
  it('describes each offer state for dispatchers', () => {
    expect(offerStatusText(mkOffer('a'), c, T0)).toMatch(/not yet opened/)
    expect(offerStatusText(mkOffer('a', { seenAtMs: T0 }), c, T0)).toMatch(/Seen/)
    expect(offerStatusText(mkOffer('a', { state: 'declined', declineReason: 'No capacity right now' }), c, T0)).toBe('Declined: No capacity right now')
    expect(offerStatusText(accepted('a', { confirmations: {} }), c, T0)).toMatch(/did not confirm: Trauma care/)
  })
})

describe('planEscalation', () => {
  const base = { hospitals: hs, etaFor: etaOf }
  const c0 = mkCase({ notifiedHospitalIds: ['h1', 'h2', 'h3', 'h4', 'h5'] })
  const pend = ['h1', 'h2', 'h3', 'h4', 'h5'].map((id) => mkOffer(id))

  it('does nothing while offers are pending and within deadline', () => {
    expect(planEscalation({ ...base, c: c0, offers: pend, nowMs: T0 + 30_000 })).toEqual([])
  })
  it('times out expired offers, then contacts the next wave', () => {
    const plan = planEscalation({ ...base, c: c0, offers: pend, nowMs: T0 + 91_000 })
    expect(plan[0]).toEqual({ type: 'timeout', offerIds: pend.map((o) => o.id) })
    const wave = plan.find((a) => a.type === 'nextWave')
    expect(wave && wave.type === 'nextWave' && wave.candidates.map((x) => x.hospital.id)).toEqual(['h6', 'h7'])
    expect(wave && wave.type === 'nextWave' && wave.wave).toBe(2)
  })
  it('re-routes to the next wave after everyone declines', () => {
    const offers = pend.map((o) => ({ ...o, state: 'declined' as const }))
    const plan = planEscalation({ ...base, c: c0, offers, nowMs: T0 + 10_000 })
    expect(plan.some((a) => a.type === 'nextWave')).toBe(true)
  })
  it('does NOT ask more hospitals while one qualified offer exists, and recommends it', () => {
    const offers = [accepted('h3', { etaMin: 3 }), ...pend.filter((o) => o.hospitalId !== 'h3').map((o) => ({ ...o, state: 'declined' as const }))]
    const plan = planEscalation({ ...base, c: c0, offers, nowMs: T0 + 10_000 })
    expect(plan).toEqual([{ type: 'recommend', hospitalId: 'h3' }])
  })
  it('does not recommend an accepted-but-unconfirmed hospital and keeps searching', () => {
    const offers = pend.map((o) => accepted(o.hospitalId, { confirmations: {} }))
    const plan = planEscalation({ ...base, c: c0, offers, nowMs: T0 + 10_000 })
    expect(plan.find((a) => a.type === 'recommend')).toBeUndefined()
    expect(plan.some((a) => a.type === 'nextWave')).toBe(true)
  })
  it('escalates clearly when nobody qualifies and nobody is left to contact', () => {
    const all = hs.filter((h) => h.id.startsWith('h') && h.capabilities.includes('trauma') && !h.diverted && !h.divertedCapabilities.length).map((h) => h.id)
    const c = mkCase({ notifiedHospitalIds: all })
    const offers = all.map((id) => mkOffer(id, { state: 'declined' }))
    const plan = planEscalation({ ...base, c, offers, nowMs: T0 + 10_000 })
    expect(plan).toEqual([{ type: 'escalate', level: 'no_hospital', note: expect.stringMatching(/phone hospitals/) }])
  })
  it('does not repeat an escalation that is already raised', () => {
    const all = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']
    const c = mkCase({ notifiedHospitalIds: all, escalation: 'no_hospital' })
    expect(planEscalation({ ...base, c, offers: all.map((id) => mkOffer(id, { state: 'declined' })), nowMs: T0 })).toEqual([])
  })
  it('clears the no-hospital escalation when a hospital finally qualifies', () => {
    const c = mkCase({ notifiedHospitalIds: ['h1'], escalation: 'no_hospital' })
    const plan = planEscalation({ ...base, c, offers: [accepted('h1')], nowMs: T0 })
    expect(plan).toContainEqual({ type: 'clearEscalation' })
    expect(plan).toContainEqual({ type: 'recommend', hospitalId: 'h1' })
  })
  it('flags attention when the ambulance is on scene with no confirmed hospital', () => {
    const c = mkCase({ status: 'onscene', notifiedHospitalIds: ['h1'] })
    const plan = planEscalation({ ...base, c, offers: [mkOffer('h1')], nowMs: T0 + 1000 })
    expect(plan).toContainEqual({ type: 'escalate', level: 'attention', note: expect.stringMatching(/on scene/) })
  })
  it('detects a selected hospital that revoked and re-plans', () => {
    const c = mkCase({ selectedHospitalId: 'h1', selectedHospitalName: 'Hospital h1', notifiedHospitalIds: ['h1', 'h2'] })
    const offers = [mkOffer('h1', { state: 'declined' }), accepted('h2')]
    const plan = planEscalation({ ...base, c, offers, nowMs: T0 })
    expect(plan[0]).toEqual({ type: 'clearSelection', reason: 'Hospital h1 is no longer confirmed' })
    expect(plan).toContainEqual({ type: 'recommend', hospitalId: 'h2' })
  })
  it('leaves a healthy confirmed destination alone', () => {
    const c = mkCase({ selectedHospitalId: 'h1', notifiedHospitalIds: ['h1'] })
    expect(planEscalation({ ...base, c, offers: [accepted('h1', { state: 'selected' })], nowMs: T0 })).toEqual([])
  })
  it('ignores cases that are not yet dispatched or are finished', () => {
    for (const status of ['reported', 'arrived', 'closed'] as const) {
      expect(planEscalation({ ...base, c: mkCase({ status }), offers: [], nowMs: T0 })).toEqual([])
    }
  })
})

describe('nearestFreeAmbulance', () => {
  it('picks the nearest available unit', () => {
    const p = { lat: 12.9, lng: 74.8 }
    expect(nearestFreeAmbulance(p, [mkAmbulance('busy', 12.9, 74.8, false), mkAmbulance('far', 13.1, 74.8), mkAmbulance('near', 12.95, 74.8)])?.id).toBe('near')
    expect(nearestFreeAmbulance(p, [mkAmbulance('busy', 12.9, 74.8, false)])).toBeNull()
  })
})
