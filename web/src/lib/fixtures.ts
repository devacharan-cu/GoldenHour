import { requiredCapabilities } from './capabilities'
import type { Ambulance, Capability, Case, CaseType, Hospital, Offer } from './types'

export const T0 = 1_800_000_000_000

export function mkHospital(id: string, lat: number, lng: number, caps: Capability[] = ['emergency'], over: Partial<Hospital> = {}): Hospital {
  return {
    id, name: `Hospital ${id}`, area: 'Test', lat, lng, capabilities: caps, capabilitiesUpdatedAtMs: T0,
    availability: { emergencyBeds: 3, icuBeds: 1, resources: {}, confirmedAtMs: T0, confirmedByUid: 'u' },
    diverted: false, divertedCapabilities: [], ...over,
  }
}

export function mkAmbulance(id: string, lat: number, lng: number, available = true): Ambulance {
  return { id, callSign: id, base: 'Base', lat, lng, available, currentCaseId: available ? null : 'busy-case' }
}

export function mkCase(over: Partial<Case> = {}): Case {
  const type: CaseType = over.type ?? 'trauma'
  return {
    id: 'c1', type, severity: 1, patients: 1, needsIcu: false, brief: 'Adult, conscious', locationSource: 'manual', reporterUid: 'rep',
    createdAtMs: T0, status: 'enroute', requiredCapabilities: requiredCapabilities(type, over.needsIcu ?? false),
    lat: 12.87, lng: 74.84, ambulanceId: 'amb-1', ambulanceCallSign: 'Medic 1', ambulanceAckAtMs: T0, crewOfferedAtMs: T0, declinedAmbulanceIds: [], crewDeclineReason: null, ambulancePos: null,
    etaSceneMin: 5, etaSource: 'estimate', dispatchedAtMs: T0, notifiedHospitalIds: [], activeHospitalIds: [], hospitalAlertAtMs: null, offerWave: 1, recommendedHospitalId: null,
    selectedHospitalId: null, selectedHospitalName: null, selectedAtMs: null, selectedByUid: null, overrideReason: null, destinationAckAtMs: null, destinationAckByUid: null, pickupAtMs: null,
    escalation: 'none', escalationNote: null, duplicateOf: null, duplicateDismissed: false, arrivalConfirmedAtMs: null,
    arrivalConfirmedByUid: null, closedAtMs: null, closeReason: null, receiptHash: 'a'.repeat(64), evidenceExpected: 0, ...over,
  }
}

export function mkOffer(hospitalId: string, over: Partial<Offer> = {}): Offer {
  return {
    id: `c1_${hospitalId}`, caseId: 'c1', hospitalId, hospitalName: `Hospital ${hospitalId}`, state: 'pending', wave: 1,
    requestedAtMs: T0, expiresAtMs: T0 + 90_000, seenAtMs: null, respondedAtMs: null, respondedByUid: null,
    confirmations: null, canReceive: null, declineReason: null, distanceKm: 3, etaMin: 6, etaSource: 'estimate', ...over,
  }
}
