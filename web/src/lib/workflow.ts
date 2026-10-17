import { arrayRemove, collection, doc, getDoc, runTransaction, setDoc, updateDoc, writeBatch, type Firestore, type WriteBatch } from 'firebase/firestore'
import { requiredCapabilities } from './capabilities'
import { formatReceipt, randomSecret, sha256Hex } from './crypto'
import { OFFER_TTL_MS, type Candidate, type PlanAction } from './matching'
import type { AiBriefing, Ambulance, Capability, Case, CaseStatus, CaseType, EventKind, Hospital, Offer, Role, Severity, TrackedPos } from './types'

export interface Actor { uid: string; role: Role | 'reporter' }
const clean = <T extends object>(o: T): T => JSON.parse(JSON.stringify(o)) as T

function addEvent(db: Firestore, b: WriteBatch, caseId: string, actor: Actor | 'system', dispatcherUid: string | null, kind: EventKind, text: string, now: number) {
  const actorUid = actor === 'system' ? (dispatcherUid as string) : actor.uid
  const actorRole = actor === 'system' ? 'system' : actor.role
  b.set(doc(collection(db, 'cases', caseId, 'events')), { kind, text, atMs: now, actorUid, actorRole })
}

export const offerId = (caseId: string, hospitalId: string) => `${caseId}_${hospitalId}`

// ---------------------------------------------------------------- reporting

export interface NewCaseInput {
  type: CaseType
  severity: Severity
  patients: number
  needsIcu: boolean
  brief: string
  contact: string
  note: string
  lat: number
  lng: number
  locationSource: 'gps' | 'manual'
  /** How many evidence files the reporter intends to attach, so dispatch can see what is still on its way. */
  evidenceExpected?: number
}

export interface CreatedCase {
  id: string
  /** Secret receipt code "<caseId>.<secret>". Shown to the reporter; only the hash of the secret is stored. */
  receipt: string
  /** Settles when the server confirms the write. While offline it stays pending and the report is only on this device. */
  done: Promise<void>
}

export async function createCase(db: Firestore, actor: Actor, i: NewCaseInput, now = Date.now()): Promise<string> {
  const c = await createCaseQueued(db, actor, i, now)
  await c.done
  return c.id
}

export async function createCaseQueued(db: Firestore, actor: Actor, i: NewCaseInput, now = Date.now()): Promise<CreatedCase> {
  const ref = doc(collection(db, 'cases'))
  const secret = randomSecret()
  const receiptHash = await sha256Hex(secret)
  const b = writeBatch(db)
  b.set(ref, {
    type: i.type, severity: i.severity, patients: i.patients, needsIcu: i.needsIcu, brief: i.brief.slice(0, 160), locationSource: i.locationSource,
    reporterUid: actor.uid, createdAtMs: now, status: 'reported', requiredCapabilities: requiredCapabilities(i.type, i.needsIcu), lat: i.lat, lng: i.lng,
    ambulanceId: null, ambulanceCallSign: null, ambulanceAckAtMs: null, crewOfferedAtMs: null, declinedAmbulanceIds: [], crewDeclineReason: null,
    ambulancePos: null, etaSceneMin: null, etaSource: null, dispatchedAtMs: null, notifiedHospitalIds: [], activeHospitalIds: [], hospitalAlertAtMs: null,
    offerWave: 0, recommendedHospitalId: null, selectedHospitalId: null, selectedHospitalName: null, selectedAtMs: null, selectedByUid: null, overrideReason: null,
    destinationAckAtMs: null, destinationAckByUid: null, pickupAtMs: null, escalation: 'none', escalationNote: null, duplicateOf: null, duplicateDismissed: false,
    arrivalConfirmedAtMs: null, arrivalConfirmedByUid: null, closedAtMs: null, closeReason: null, receiptHash, evidenceExpected: Math.min(10, i.evidenceExpected ?? 0),
  })
  b.set(doc(db, 'cases', ref.id, 'private', 'patient'), { contact: i.contact.slice(0, 40), note: i.note.slice(0, 500), reporterUid: actor.uid })
  addEvent(db, b, ref.id, actor, null, 'reported', 'Emergency reported', now)
  return { id: ref.id, receipt: formatReceipt(ref.id, secret), done: b.commit() }
}

/** Open a case on another device by proving possession of its receipt code. */
export async function claimCase(db: Firestore, actor: Actor, caseId: string, secret: string, now = Date.now()): Promise<void> {
  const ref = doc(db, 'cases', caseId, 'claims', actor.uid)
  // A claim is create-only. Opening the same receipt again (or two tabs at once) must succeed, not fail as "wrong code".
  const claimed = async () => { try { return (await getDoc(ref)).exists() } catch { return false } }
  if (await claimed()) return
  try { await setDoc(ref, { secret, claimedAtMs: now }) } catch (e) {
    if ((e as { code?: string }).code === 'permission-denied' && (await claimed())) return
    throw e
  }
}

// ---------------------------------------------------------------- dispatch: offer the case to a crew

export interface DispatchInput {
  ambulance: Ambulance
  etaSceneMin: number
  etaSource: 'road' | 'estimate'
}

/**
 * Step 1 of dispatch: the dispatcher explicitly offers the case to one available ambulance. The unit is reserved in the
 * same transaction (it can hold only one case), but nothing is promised to hospitals until the crew ACCEPTS.
 */
export async function dispatchCase(db: Firestore, actor: Actor, c: Case, d: DispatchInput, now = Date.now()): Promise<void> {
  if (c.declinedAmbulanceIds.includes(d.ambulance.id)) throw new Error(`${d.ambulance.callSign} already declined this case`)
  await runTransaction(db, async (tx) => {
    const caseRef = doc(db, 'cases', c.id)
    const ambRef = doc(db, 'ambulances', d.ambulance.id)
    const [cs, as] = await Promise.all([tx.get(caseRef), tx.get(ambRef)])
    if (!cs.exists() || cs.data().status !== 'reported') throw new Error('This case has already been offered to a crew')
    if (!as.exists() || as.data().currentCaseId) throw new Error(`${d.ambulance.callSign} is no longer available`)
    const pos: TrackedPos = { lat: d.ambulance.lat, lng: d.ambulance.lng, atMs: now, source: 'simulated' }
    tx.update(caseRef, {
      status: 'dispatched', ambulanceId: d.ambulance.id, ambulanceCallSign: d.ambulance.callSign, crewOfferedAtMs: now, dispatchedAtMs: now, ambulancePos: pos,
      etaSceneMin: d.etaSceneMin, etaSource: d.etaSource,
    })
    tx.update(ambRef, { available: false, currentCaseId: c.id })
    tx.set(doc(collection(db, 'cases', c.id, 'events')), {
      kind: 'dispatched', text: `${d.ambulance.callSign} offered the case (ETA to scene ${d.etaSceneMin} min, ${d.etaSource === 'road' ? 'road routing' : 'estimate'})`,
      atMs: now, actorUid: actor.uid, actorRole: actor.role,
    })
  })
}

/** The crew accepts the offer. Hospitals are asked next, while the crew drives to the scene. */
export async function crewAccept(db: Firestore, actor: Actor, c: Case, now = Date.now()): Promise<void> {
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), { status: 'enroute', ambulanceAckAtMs: now })
  addEvent(db, b, c.id, actor, null, 'ack', `${c.ambulanceCallSign} accepted the dispatch and is on the way`, now)
  await b.commit()
}

/** The crew declines. The case returns to dispatch, the unit is freed and recorded as having declined. */
export async function crewDecline(db: Firestore, actor: Actor, c: Case, reason: string, now = Date.now()): Promise<void> {
  if (!c.ambulanceId) throw new Error('This case is not assigned to your unit')
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), {
    status: 'reported', ambulanceId: null, ambulanceCallSign: null, ambulancePos: null, dispatchedAtMs: null, crewOfferedAtMs: null, etaSceneMin: null, etaSource: null,
    declinedAmbulanceIds: [...c.declinedAmbulanceIds, c.ambulanceId], crewDeclineReason: reason.slice(0, 120),
  })
  b.update(doc(db, 'ambulances', c.ambulanceId), { available: true, currentCaseId: null })
  addEvent(db, b, c.id, actor, null, 'crew_declined', `${c.ambulanceCallSign} declined: ${reason}`, now)
  await b.commit()
}

/** Dispatcher takes back an offer the crew has not answered. */
export async function cancelAssignment(db: Firestore, actor: Actor, c: Case, reason: string, now = Date.now()): Promise<void> {
  if (c.status !== 'dispatched' || !c.ambulanceId) throw new Error('Only an unanswered offer can be taken back')
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), {
    status: 'reported', ambulanceId: null, ambulanceCallSign: null, ambulancePos: null, dispatchedAtMs: null, crewOfferedAtMs: null, etaSceneMin: null, etaSource: null, ambulanceAckAtMs: null,
  })
  b.update(doc(db, 'ambulances', c.ambulanceId), { available: true, currentCaseId: null })
  addEvent(db, b, c.id, actor, null, 'assignment_cancelled', `Offer to ${c.ambulanceCallSign} taken back: ${reason}`, now)
  await b.commit()
}

// ---------------------------------------------------------------- hospital pre-alert waves

function offerDoc(c: Pick<Case, 'id'>, cand: Candidate, wave: number, now: number, ttl = OFFER_TTL_MS): Omit<Offer, 'id'> {
  return {
    caseId: c.id, hospitalId: cand.hospital.id, hospitalName: cand.hospital.name, state: 'pending', wave, requestedAtMs: now, expiresAtMs: now + ttl,
    seenAtMs: null, respondedAtMs: null, respondedByUid: null, confirmations: null, canReceive: null, declineReason: null,
    distanceKm: cand.distanceKm, etaMin: cand.etaMin, etaSource: cand.etaSource,
  }
}

/** Contact the next wave. Guarded by the expected wave number so two dispatcher tabs cannot both do it. */
export async function contactNextWave(db: Firestore, actor: Actor, c: Case, candidates: Candidate[], wave: number, now = Date.now(), ttlMs?: number): Promise<boolean> {
  return runTransaction(db, async (tx) => {
    const caseRef = doc(db, 'cases', c.id)
    const cs = await tx.get(caseRef)
    if (!cs.exists() || cs.data().offerWave !== wave - 1) return false
    const known: string[] = cs.data().notifiedHospitalIds
    const active: string[] = cs.data().activeHospitalIds
    const fresh = candidates.filter((x) => !known.includes(x.hospital.id))
    if (!fresh.length) return false
    tx.update(caseRef, {
      offerWave: wave,
      notifiedHospitalIds: [...known, ...fresh.map((x) => x.hospital.id)],
      activeHospitalIds: [...active, ...fresh.map((x) => x.hospital.id)],
      hospitalAlertAtMs: cs.data().hospitalAlertAtMs ?? now,
    })
    for (const cand of fresh) tx.set(doc(db, 'offers', offerId(c.id, cand.hospital.id)), offerDoc(c, cand, wave, now, ttlMs))
    tx.set(doc(collection(db, 'cases', c.id, 'events')), {
      kind: 'wave', text: `${wave === 1 ? 'Pre-alert' : `Wave ${wave}`}: asked ${fresh.map((x) => x.hospital.name).join(', ')}`, atMs: now, actorUid: actor.uid, actorRole: 'system',
    })
    return true
  })
}

/**
 * Ask one specific hospital (for example the one a declining hospital suggested). It gets an ordinary pending offer, so it must still
 * accept and confirm every capability before it can ever be chosen. Safe against two dispatchers: a hospital is only asked once.
 */
export async function askHospital(db: Firestore, actor: Actor, c: Case, cand: Candidate, why: string, now = Date.now(), ttlMs?: number): Promise<boolean> {
  return runTransaction(db, async (tx) => {
    const caseRef = doc(db, 'cases', c.id)
    const cs = await tx.get(caseRef)
    if (!cs.exists() || cs.data().status === 'closed' || cs.data().selectedHospitalId) return false
    const known: string[] = cs.data().notifiedHospitalIds
    if (known.includes(cand.hospital.id)) return false
    tx.update(caseRef, { notifiedHospitalIds: [...known, cand.hospital.id], activeHospitalIds: [...cs.data().activeHospitalIds, cand.hospital.id] })
    tx.set(doc(db, 'offers', offerId(c.id, cand.hospital.id)), offerDoc(c, cand, cs.data().offerWave, now, ttlMs))
    tx.set(doc(collection(db, 'cases', c.id, 'events')), { kind: 'wave', text: `Asked ${cand.hospital.name} (${why})`, atMs: now, actorUid: actor.uid, actorRole: 'system' })
    return true
  })
}

export async function extendDeadline(db: Firestore, _actor: Actor, o: Offer, extraMs = 60_000, now = Date.now()): Promise<void> {
  await updateDoc(doc(db, 'offers', o.id), { expiresAtMs: Math.max(o.expiresAtMs, now) + extraMs })
}

/** Execute the pure plan from planEscalation(). Races between dispatcher tabs are tolerated for idempotent steps. */
export async function applyPlan(db: Firestore, actor: Actor, c: Case, actions: PlanAction[], now = Date.now(), ttlMs?: number): Promise<string[]> {
  const log: string[] = []
  for (const a of actions) {
    try {
      const b = writeBatch(db)
      const caseRef = doc(db, 'cases', c.id)
      if (a.type === 'timeout') {
        for (const id of a.offerIds) b.update(doc(db, 'offers', id), { state: 'timeout' })
        // A hospital that stayed silent loses access to the case and its evidence.
        b.update(caseRef, { activeHospitalIds: arrayRemove(...a.offerIds.map((id) => id.slice(c.id.length + 1))) })
        addEvent(db, b, c.id, 'system', actor.uid, 'offer_timeout', `No response from ${a.offerIds.length} hospital(s) before the deadline`, now)
      } else if (a.type === 'clearSelection') {
        b.update(caseRef, { selectedHospitalId: null, selectedHospitalName: null, selectedAtMs: null, selectedByUid: null, overrideReason: null, destinationAckAtMs: null, destinationAckByUid: null, escalation: 'attention', escalationNote: a.reason })
        addEvent(db, b, c.id, 'system', actor.uid, 'escalation', `Destination lost: ${a.reason}`, now)
      } else if (a.type === 'recommend') {
        b.update(caseRef, { recommendedHospitalId: a.hospitalId })
        addEvent(db, b, c.id, 'system', actor.uid, 'recommended', a.hospitalId ? 'Recommended destination updated' : 'No qualified hospital to recommend yet', now)
      } else if (a.type === 'escalate') {
        b.update(caseRef, { escalation: a.level, escalationNote: a.note })
        addEvent(db, b, c.id, 'system', actor.uid, 'escalation', a.note, now)
      } else if (a.type === 'clearEscalation') {
        b.update(caseRef, { escalation: 'none', escalationNote: null })
      } else if (a.type === 'nextWave') {
        if (await contactNextWave(db, actor, c, a.candidates, a.wave, now, ttlMs)) log.push(`wave ${a.wave}`)
        continue
      }
      await b.commit()
      log.push(a.type)
    } catch (e) {
      // Another dispatcher tab usually already applied this step.
      console.warn(`[engine] ${a.type} skipped:`, (e as Error).message)
    }
  }
  return log
}

// ---------------------------------------------------------------- destination decision

/** Confirm the destination. The server rules re-check that the hospital's offer is accepted and fully confirmed. */
export async function selectDestination(db: Firestore, actor: Actor, c: Case, offers: Offer[], hospitalId: string, overrideReason: string | null, recommendedId: string | null = c.recommendedHospitalId, now = Date.now()): Promise<void> {
  const chosen = offers.find((o) => o.hospitalId === hospitalId)
  if (!chosen) throw new Error('No offer from that hospital')
  // The screen can know the recommendation before the engine has stored it, so the approved recommendation travels with the write.
  const isOverride = hospitalId !== recommendedId
  if (isOverride && (!overrideReason || overrideReason.trim().length < 3)) throw new Error('A reason is required to override the recommendation')
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), {
    recommendedHospitalId: recommendedId, selectedHospitalId: hospitalId, selectedHospitalName: chosen.hospitalName, selectedAtMs: now, selectedByUid: actor.uid,
    overrideReason: isOverride ? (overrideReason as string).trim() : null, escalation: 'none', escalationNote: null,
    destinationAckAtMs: null, destinationAckByUid: null,
    // Everyone else is withdrawn and loses access; only the destination keeps the case.
    activeHospitalIds: [hospitalId],
  })
  for (const o of offers) {
    if (o.hospitalId === hospitalId) b.update(doc(db, 'offers', o.id), { state: 'selected' })
    else if (o.state === 'pending' || o.state === 'accepted') b.update(doc(db, 'offers', o.id), { state: 'withdrawn' })
  }
  addEvent(db, b, c.id, actor, null, 'selected', `Destination confirmed: ${chosen.hospitalName}${isOverride ? ` (override: ${overrideReason})` : ' (recommended)'}`, now)
  await b.commit()
}

/** The crew confirms it has seen the destination. Transport cannot start before this. */
export async function acknowledgeDestination(db: Firestore, actor: Actor, c: Case, now = Date.now()): Promise<void> {
  if (!c.selectedHospitalId) throw new Error('No destination has been confirmed yet')
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), { destinationAckAtMs: now, destinationAckByUid: actor.uid })
  addEvent(db, b, c.id, actor, null, 'destination_ack', `${c.ambulanceCallSign} acknowledged the destination: ${c.selectedHospitalName}`, now)
  await b.commit()
}

// ---------------------------------------------------------------- hospital actions

export async function markOfferSeen(db: Firestore, o: Offer, now = Date.now()): Promise<void> {
  if (o.seenAtMs) return
  await updateDoc(doc(db, 'offers', o.id), { seenAtMs: now })
}

export interface OfferResponse {
  accept: boolean
  canReceive: boolean
  confirmations: Partial<Record<Capability, boolean>>
  declineReason: string | null
  /** Declining only: another hospital the team thinks is better placed. */
  suggest?: { id: string; name: string } | null
}

export async function respondToOffer(db: Firestore, actor: Actor, o: Offer, r: OfferResponse, now = Date.now()): Promise<void> {
  const b = writeBatch(db)
  b.update(doc(db, 'offers', o.id), {
    state: r.accept ? 'accepted' : 'declined', respondedAtMs: now, respondedByUid: actor.uid,
    confirmations: r.confirmations, canReceive: r.accept ? r.canReceive : false, declineReason: r.accept ? null : (r.declineReason ?? 'Declined'),
    ...(!r.accept && r.suggest ? { suggestedHospitalId: r.suggest.id } : {}),
  })
  // Declining ends this hospital's access to the case and its evidence, in the same atomic write.
  if (!r.accept) b.update(doc(db, 'cases', o.caseId), { activeHospitalIds: arrayRemove(o.hospitalId) })
  addEvent(db, b, o.caseId, actor, null, r.accept ? 'offer_accepted' : 'offer_declined',
    r.accept ? `${o.hospitalName} accepted${r.canReceive ? '' : ' (cannot receive)'}; confirmed: ${Object.entries(r.confirmations).filter(([, v]) => v).map(([k]) => k).join(', ') || 'nothing'}` : `${o.hospitalName} declined: ${r.declineReason ?? 'no reason given'}${r.suggest ? `. Suggested ${r.suggest.name} instead` : ''}`, now)
  await b.commit()
}

export async function revokeOffer(db: Firestore, actor: Actor, o: Offer, reason: string, now = Date.now()): Promise<void> {
  const b = writeBatch(db)
  b.update(doc(db, 'offers', o.id), { state: 'declined', declineReason: reason, respondedAtMs: now, respondedByUid: actor.uid })
  b.update(doc(db, 'cases', o.caseId), { activeHospitalIds: arrayRemove(o.hospitalId) })
  addEvent(db, b, o.caseId, actor, null, 'offer_revoked', `${o.hospitalName} withdrew its acceptance: ${reason}`, now)
  await b.commit()
}

export async function confirmArrival(db: Firestore, actor: Actor, c: Case, now = Date.now()): Promise<void> {
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), { arrivalConfirmedAtMs: now, arrivalConfirmedByUid: actor.uid })
  addEvent(db, b, c.id, actor, null, 'arrival_confirmed', `${c.selectedHospitalName ?? 'Hospital'} confirmed receipt of the patient`, now)
  await b.commit()
}

export async function updateHospitalProfile(db: Firestore, actor: Actor, h: Hospital, p: { capabilities: Capability[]; diverted: boolean; divertedCapabilities: Capability[] }, now = Date.now()): Promise<void> {
  void actor
  await updateDoc(doc(db, 'hospitals', h.id), { capabilities: p.capabilities, diverted: p.diverted, divertedCapabilities: p.divertedCapabilities, capabilitiesUpdatedAtMs: now })
}

export async function confirmAvailability(db: Firestore, actor: Actor, h: Hospital, a: { emergencyBeds: number; icuBeds: number; resources: Partial<Record<Capability, boolean>> }, now = Date.now()): Promise<void> {
  await updateDoc(doc(db, 'hospitals', h.id), { availability: clean({ ...a, confirmedAtMs: now, confirmedByUid: actor.uid }) })
}

// ---------------------------------------------------------------- crew progress

const NEXT: Partial<Record<CaseStatus, CaseStatus>> = { enroute: 'onscene', onscene: 'transporting', transporting: 'arrived' }
const STATUS_TEXT: Partial<Record<CaseStatus, string>> = { onscene: 'arrived on scene', transporting: 'picked up the patient and departed', arrived: 'arrived at the hospital' }

export async function advanceStatus(db: Firestore, actor: Actor, c: Case, pos: TrackedPos | null, now = Date.now()): Promise<void> {
  const next = NEXT[c.status]
  if (!next) throw new Error(`Cannot advance from ${c.status}`)
  if (next === 'transporting' && !c.destinationAckAtMs) throw new Error('Acknowledge the confirmed destination before leaving the scene')
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), {
    status: next, ...(pos ? { ambulancePos: pos } : {}), ...(next === 'onscene' ? { etaSceneMin: 0 } : {}), ...(next === 'transporting' ? { pickupAtMs: now } : {}),
  })
  addEvent(db, b, c.id, actor, null, next === 'transporting' ? 'pickup' : 'status', `${c.ambulanceCallSign} ${STATUS_TEXT[next]}`, now)
  await b.commit()
}

export async function reportPosition(db: Firestore, c: Pick<Case, 'id'>, pos: TrackedPos, etaSceneMin: number | null, etaSource: 'road' | 'estimate' | null): Promise<void> {
  await updateDoc(doc(db, 'cases', c.id), { ambulancePos: pos, ...(etaSceneMin !== null ? { etaSceneMin: Math.round(etaSceneMin), etaSource } : {}) })
}

// ---------------------------------------------------------------- closing

/** Close after the hospital confirmed receipt, or cancel a case that never reached the hospital. Frees the ambulance. */
export async function closeCase(db: Firestore, actor: Actor, c: Case, reason: string, now = Date.now()): Promise<void> {
  if (c.status === 'arrived' && !c.arrivalConfirmedAtMs) throw new Error('The hospital has not confirmed receipt of the patient yet')
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), { status: 'closed', closedAtMs: now, closeReason: reason })
  if (c.ambulanceId) b.update(doc(db, 'ambulances', c.ambulanceId), { available: true, currentCaseId: null })
  addEvent(db, b, c.id, actor, null, 'closed', `Case closed: ${reason}`, now)
  await b.commit()
}

export type CancelKind = 'false' | 'accidental' | 'cancelled'
const CANCEL_PREFIX: Record<CancelKind, string> = { false: 'False report', accidental: 'Accidental report', cancelled: 'Cancelled' }

/** States in which dispatch may still end a case without a hospital hand-over. After pickup the patient is in the vehicle, so only the hand-over closes it. */
export const canCancelStatus = (status: Case['status']) => status === 'reported' || status === 'dispatched' || status === 'enroute' || status === 'onscene'

/**
 * Dispatch ends a case that will not reach a hospital: a false or accidental report, or a cancellation. Nothing is deleted. The case stays
 * in history with its reason; the ambulance is released and every hospital is stood down; the audit trail records who did it and why.
 */
export async function cancelCase(db: Firestore, actor: Actor, c: Case, kind: CancelKind, note: string, offers: Offer[] = [], now = Date.now()): Promise<void> {
  const why = note.trim()
  if (why.length < 3) throw new Error('Write a short reason (at least 3 characters). It is kept in the audit trail.')
  if (!canCancelStatus(c.status)) throw new Error(c.status === 'closed' ? 'This case is already closed.' : 'The patient is already being transported or has arrived. Finish the hand-over instead of cancelling.')
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), {
    status: 'closed', closedAtMs: now, closeReason: `${CANCEL_PREFIX[kind]}: ${why}`.slice(0, 200),
    activeHospitalIds: [], selectedHospitalId: null, selectedHospitalName: null,
  })
  for (const o of offers.filter((x) => x.caseId === c.id && ['pending', 'accepted', 'selected'].includes(x.state))) b.update(doc(db, 'offers', o.id), { state: 'withdrawn' })
  if (c.ambulanceId) b.update(doc(db, 'ambulances', c.ambulanceId), { available: true, currentCaseId: null })
  addEvent(db, b, c.id, actor, null, 'cancelled', `Case ended as ${CANCEL_PREFIX[kind].toLowerCase()}: ${why}`, now)
  await b.commit()
}

/** The reporter takes their own report back. Only possible before any crew has been offered the case. */
export async function withdrawReport(db: Firestore, actor: Actor, c: Case, note: string, now = Date.now()): Promise<void> {
  const why = note.trim() || 'No longer needed'
  if (c.status !== 'reported') throw new Error('A crew has already been contacted about this report. Call 112 or the dispatcher to change it.')
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), { status: 'closed', closedAtMs: now, closeReason: `Withdrawn by reporter: ${why}`.slice(0, 200) })
  addEvent(db, b, c.id, actor, null, 'withdrawn', `Reporter withdrew the report: ${why}`, now)
  await b.commit()
}

export async function markDuplicate(db: Firestore, actor: Actor, c: Case, ofCase: Case, now = Date.now()): Promise<void> {
  if (!canCancelStatus(c.status)) throw new Error('The patient is already on board or the case is closed, so it cannot be merged.')
  const b = writeBatch(db)
  b.update(doc(db, 'cases', c.id), { duplicateOf: ofCase.id, status: 'closed', closedAtMs: now, closeReason: 'Duplicate report' })
  if (c.ambulanceId) b.update(doc(db, 'ambulances', c.ambulanceId), { available: true, currentCaseId: null })
  addEvent(db, b, c.id, actor, null, 'duplicate', `Marked as duplicate of case ${ofCase.id.slice(0, 6)}`, now)
  await b.commit()
}

export async function dismissDuplicate(db: Firestore, c: Case): Promise<void> {
  await updateDoc(doc(db, 'cases', c.id), { duplicateDismissed: true })
}

// ---------------------------------------------------------------- AI briefing (draft for dispatch, reviewed handoff for others)

export async function saveAiDraft(db: Firestore, caseId: string, b: AiBriefing): Promise<void> {
  await setDoc(doc(db, 'cases', caseId, 'ai', 'draft'), clean(b))
}

/** The dispatcher reviews (and may correct) the AI draft, then shares it with the crew and active hospitals. */
export async function shareHandoff(db: Firestore, actor: Actor, caseId: string, b: AiBriefing, now = Date.now()): Promise<void> {
  const batch = writeBatch(db)
  batch.set(doc(db, 'cases', caseId, 'ai', 'handoff'), clean({ ...b, reviewedByUid: actor.uid, reviewedAtMs: now }))
  addEvent(db, batch, caseId, actor, null, 'ai', `AI-assisted handoff reviewed${b.edited ? ' and corrected' : ''} by dispatch and shared`, now)
  await batch.commit()
}
