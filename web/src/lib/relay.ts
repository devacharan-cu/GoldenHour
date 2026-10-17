import { isQualified } from './matching'
import type { Case, Offer } from './types'

/** The four hands a case passes through. The Relay Track on every screen shows which one holds it now. */
export type RelayRole = 'reporter' | 'dispatcher' | 'crew' | 'hospital'
export const RELAY_ORDER: RelayRole[] = ['reporter', 'dispatcher', 'crew', 'hospital']
export const RELAY_LABEL: Record<RelayRole, string> = { reporter: 'Reporter', dispatcher: 'Dispatcher', crew: 'Crew', hospital: 'Hospital' }

export interface Mover {
  /** Whose move it is right now, or null once the case is closed. */
  role: RelayRole | null
  /** What they need to do, in plain words. */
  action: string
}

/** Map the signed-in role to a relay role. Hospital staff, crews and dispatchers act as themselves; anyone else is the reporter. */
export const relayRoleOf = (role: 'dispatcher' | 'hospital' | 'ambulance' | 'reporter' | undefined): RelayRole =>
  role === 'ambulance' ? 'crew' : role === 'dispatcher' ? 'dispatcher' : role === 'hospital' ? 'hospital' : 'reporter'

/**
 * Whose move is it? Derived purely from the case and its hospital offers, so every screen on every laptop agrees.
 * Ambulance acceptance (crew) and hospital acceptance (hospital) are separate moves.
 */
export function nextMover(c: Case, offers: Offer[] | null): Mover {
  if (c.status === 'closed') return { role: null, action: 'The case is closed' }
  if (c.status === 'reported') return { role: 'dispatcher', action: 'Choose a crew and send the offer' }
  if (c.status === 'dispatched') return { role: 'crew', action: 'Accept or decline the dispatch' }
  if (c.status === 'arrived') {
    return c.arrivalConfirmedAtMs
      ? { role: 'dispatcher', action: 'Close the case' }
      : { role: 'hospital', action: 'Confirm the patient arrived' }
  }
  if (!c.selectedHospitalId) {
    // A reporter cannot see individual hospital offers, only that hospitals were asked.
    if (offers === null) return c.offerWave === 0 ? { role: 'dispatcher', action: 'Asking the nearest hospitals' } : { role: 'hospital', action: 'Hospitals are confirming they can treat the patient' }
    if (offers.some((o) => o.state === 'pending')) return { role: 'hospital', action: 'Confirm resources, then accept or decline' }
    if (offers.some((o) => isQualified(o, c))) return { role: 'dispatcher', action: 'Confirm the destination' }
    return c.offerWave === 0
      ? { role: 'dispatcher', action: 'Asking the nearest hospitals' }
      : { role: 'dispatcher', action: 'No hospital has confirmed yet' }
  }
  if (!c.destinationAckAtMs) return { role: 'crew', action: 'Acknowledge the destination' }
  if (c.status === 'enroute') return { role: 'crew', action: 'Drive to the scene' }
  if (c.status === 'onscene') return { role: 'crew', action: 'Pick up the patient' }
  return { role: 'crew', action: 'Drive to the hospital' }
}

/** Which of the four hands have finished their part. */
export function relayDone(c: Case): Record<RelayRole, boolean> {
  return { reporter: true, dispatcher: c.status !== 'reported', crew: c.ambulanceAckAtMs !== null, hospital: c.arrivalConfirmedAtMs !== null }
}

/** One short line under each hand on the track. */
export function relayNotes(c: Case, offers: Offer[] | null, clock: (ms: number) => string): Record<RelayRole, string> {
  const asked = offers ? offers.length : c.notifiedHospitalIds.length
  const answered = offers ? offers.filter((o) => o.state !== 'pending').length : 0
  return {
    reporter: `reported ${clock(c.createdAtMs)}`,
    dispatcher: c.status === 'reported' ? 'to choose a crew' : c.selectedAtMs ? `chose ${c.selectedHospitalName ?? 'hospital'}` : c.crewOfferedAtMs ? `offered ${clock(c.crewOfferedAtMs)}` : 'working',
    crew: !c.ambulanceCallSign ? 'not assigned' : c.ambulanceAckAtMs ? `${c.ambulanceCallSign} accepted ${clock(c.ambulanceAckAtMs)}` : `${c.ambulanceCallSign} deciding`,
    hospital: c.arrivalConfirmedAtMs ? `received ${clock(c.arrivalConfirmedAtMs)}` : c.selectedHospitalName ? `${c.selectedHospitalName} ready` : asked ? (offers ? `${answered} of ${asked} answered` : `${asked} asked`) : 'not asked yet',
  }
}
