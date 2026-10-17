import { CAPABILITY_LABEL } from './capabilities'
import { distanceKm } from './geo'
import type { Capability, Case, Hospital, LatLng, Offer } from './types'

export const WAVE_SIZE = 5
export const OFFER_TTL_MS = 90_000
/** Availability older than this is shown as stale. It never counts as confirmation for a case. */
export const STALE_AVAILABILITY_MS = 2 * 60 * 60 * 1000

export interface Candidate {
  hospital: Hospital
  distanceKm: number
  etaMin: number
  etaSource: 'road' | 'estimate'
}

export type EtaFn = (h: Hospital) => { etaMin: number; source: 'road' | 'estimate' }

export interface Exclusion { hospital: Hospital; reason: string }

/** Who may be asked at all: not diverted and the permanent profile lists every required capability. */
export function eligibility(c: Pick<Case, 'requiredCapabilities'>, hospitals: Hospital[]): { eligible: Hospital[]; excluded: Exclusion[] } {
  const eligible: Hospital[] = []
  const excluded: Exclusion[] = []
  for (const h of hospitals) {
    if (h.diverted) { excluded.push({ hospital: h, reason: 'On full diversion' }); continue }
    const diverted = c.requiredCapabilities.find((cap) => h.divertedCapabilities.includes(cap))
    if (diverted) { excluded.push({ hospital: h, reason: `Diverted for ${CAPABILITY_LABEL[diverted]}` }); continue }
    const missing = c.requiredCapabilities.find((cap) => !h.capabilities.includes(cap))
    if (missing) { excluded.push({ hospital: h, reason: `${CAPABILITY_LABEL[missing]} not on hospital profile` }); continue }
    eligible.push(h)
  }
  return { eligible, excluded }
}

/** The next hospitals to contact: nearest eligible (by ETA from the scene) that have not been asked yet. */
export function nextWave(c: Pick<Case, 'requiredCapabilities' | 'lat' | 'lng'>, hospitals: Hospital[], contactedIds: string[], etaFor: EtaFn, size = WAVE_SIZE): Candidate[] {
  return eligibility(c, hospitals).eligible
    .filter((h) => !contactedIds.includes(h.id))
    .map((hospital) => {
      const e = etaFor(hospital)
      return { hospital, distanceKm: Math.round(distanceKm(c, hospital) * 10) / 10, etaMin: e.etaMin, etaSource: e.source }
    })
    .sort((a, b) => a.etaMin - b.etaMin || a.distanceKm - b.distanceKm || a.hospital.id.localeCompare(b.hospital.id))
    .slice(0, size)
}

/** True only when the hospital said yes, said it can receive, and confirmed EVERY required capability for this case. */
export function isQualified(o: Offer, c: Pick<Case, 'requiredCapabilities'>): boolean {
  return o.state === 'accepted' && o.canReceive === true && c.requiredCapabilities.every((cap) => o.confirmations?.[cap] === true)
}

export function missingConfirmations(o: Offer, c: Pick<Case, 'requiredCapabilities'>): Capability[] {
  return c.requiredCapabilities.filter((cap) => o.confirmations?.[cap] !== true)
}

export interface RankedOffer { offer: Offer; rank: number }

export function rankQualified(offers: Offer[], c: Pick<Case, 'requiredCapabilities'>): RankedOffer[] {
  return offers
    .filter((o) => isQualified(o, c))
    .sort((a, b) => a.etaMin - b.etaMin || a.distanceKm - b.distanceKm || (a.respondedAtMs ?? 0) - (b.respondedAtMs ?? 0) || a.hospitalId.localeCompare(b.hospitalId))
    .map((offer, i) => ({ offer, rank: i + 1 }))
}

export function offerStatusText(o: Offer, c: Pick<Case, 'requiredCapabilities'>, nowMs: number): string {
  switch (o.state) {
    case 'pending': return o.expiresAtMs <= nowMs ? 'No response before deadline' : o.seenAtMs ? 'Seen, awaiting decision' : 'Delivered, not yet opened'
    case 'declined': return `Declined${o.declineReason ? `: ${o.declineReason}` : ''}`
    case 'timeout': return 'No response before deadline'
    case 'withdrawn': return 'Request withdrawn by dispatch'
    case 'selected': return 'Confirmed destination'
    case 'accepted': {
      if (o.canReceive !== true) return 'Accepted but did not confirm it can receive'
      const miss = missingConfirmations(o, c)
      return miss.length ? `Accepted but did not confirm: ${miss.map((m) => CAPABILITY_LABEL[m]).join(', ')}` : 'Accepted and confirmed all required resources'
    }
  }
}

export function explainRecommendation(best: RankedOffer, all: RankedOffer[], c: Pick<Case, 'requiredCapabilities'>): string[] {
  const o = best.offer
  const lines = [
    `Accepted and explicitly confirmed ${c.requiredCapabilities.map((x) => CAPABILITY_LABEL[x]).join(' + ')} for this case.`,
    `Fastest of ${all.length} qualified hospital${all.length > 1 ? 's' : ''}: ${o.etaMin} min from the scene (${o.etaSource === 'road' ? 'road routing' : 'straight-line estimate'}), ${o.distanceKm} km.`,
  ]
  const next = all[1]
  if (next) lines.push(`Next best: ${next.offer.hospitalName}, ${next.offer.etaMin} min.`)
  return lines
}

export type PlanAction =
  | { type: 'timeout'; offerIds: string[] }
  | { type: 'clearSelection'; reason: string }
  | { type: 'nextWave'; wave: number; candidates: Candidate[] }
  | { type: 'escalate'; level: 'no_hospital' | 'attention'; note: string }
  | { type: 'clearEscalation' }
  | { type: 'recommend'; hospitalId: string | null }

interface PlanInput {
  c: Case
  offers: Offer[]
  hospitals: Hospital[]
  nowMs: number
  etaFor: EtaFn
}

/**
 * Decide what the workflow must do next. Pure: the dispatcher console executes the returned actions.
 * Never invents availability. When nobody qualifies and nobody is left to ask, it escalates to a human.
 */
export function planEscalation({ c, offers, hospitals, nowMs, etaFor }: PlanInput): PlanAction[] {
  const actions: PlanAction[] = []
  if (c.status === 'reported' || c.status === 'closed' || c.status === 'arrived') return actions

  const expired = offers.filter((o) => o.state === 'pending' && o.expiresAtMs <= nowMs)
  if (expired.length) actions.push({ type: 'timeout', offerIds: expired.map((o) => o.id) })
  const expiredIds = new Set(expired.map((o) => o.id))
  const live = offers.map((o) => (expiredIds.has(o.id) ? { ...o, state: 'timeout' as const } : o))

  const qualified = rankQualified(live, c)
  const pending = live.filter((o) => o.state === 'pending')

  if (c.selectedHospitalId) {
    const sel = live.find((o) => o.hospitalId === c.selectedHospitalId)
    if (!sel || sel.state !== 'selected') {
      actions.push({ type: 'clearSelection', reason: `${sel?.hospitalName ?? 'Selected hospital'} is no longer confirmed` })
    } else {
      if (c.escalation !== 'none') actions.push({ type: 'clearEscalation' })
      return actions
    }
  }

  const bestId = qualified[0]?.offer.hospitalId ?? null
  if (bestId !== c.recommendedHospitalId) actions.push({ type: 'recommend', hospitalId: bestId })

  if (qualified.length || pending.length) {
    if (c.escalation === 'no_hospital') actions.push({ type: 'clearEscalation' })
    if (!qualified.length && c.status === 'onscene' && c.escalation !== 'attention') {
      actions.push({ type: 'escalate', level: 'attention', note: 'Ambulance is on scene and no hospital has confirmed yet' })
    }
    return actions
  }

  // Nobody qualified and nobody pending: ask more hospitals, or escalate to a human.
  const candidates = nextWave(c, hospitals, [...c.notifiedHospitalIds], etaFor)
  if (candidates.length) {
    actions.push({ type: 'nextWave', wave: c.offerWave + 1, candidates })
    if (c.escalation === 'no_hospital') actions.push({ type: 'clearEscalation' })
  } else if (c.escalation !== 'no_hospital') {
    actions.push({ type: 'escalate', level: 'no_hospital', note: 'No eligible hospital has confirmed and none remain to contact. Dispatcher must phone hospitals or choose another route.' })
  }
  return actions
}

export function nearestFreeAmbulance<T extends LatLng & { available: boolean }>(point: LatLng, ambulances: T[]): T | null {
  const free = ambulances.filter((a) => a.available)
  if (!free.length) return null
  return free.reduce((best, a) => (distanceKm(a, point) < distanceKm(best, point) ? a : best))
}
