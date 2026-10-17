export type Role = 'dispatcher' | 'hospital' | 'ambulance'

/** users/{uid}. Written only by the provisioning script (never by clients). */
export interface UserProfile {
  role: Role
  displayName: string
  active: boolean
  hospitalId?: string
  ambulanceId?: string
}

export type CaseType = 'cardiac' | 'stroke' | 'trauma' | 'snakebite' | 'burns' | 'obstetric' | 'paediatric' | 'other'
export type Severity = 1 | 2 | 3 // 1 = critical
export type Capability = 'emergency' | 'trauma' | 'cardiac' | 'stroke' | 'antivenom' | 'paediatrics' | 'burns' | 'icu' | 'obstetric'

export interface LatLng { lat: number; lng: number }
export interface TrackedPos extends LatLng { atMs: number; source: 'gps' | 'simulated' }

/** Permanent profile (what the hospital is equipped to do) is separate from live availability. */
export interface Availability {
  emergencyBeds: number
  icuBeds: number
  /** Live resource flags (e.g. antivenom in stock, trauma team on duty), keyed by capability. */
  resources: Partial<Record<Capability, boolean>>
  confirmedAtMs: number
  confirmedByUid: string
}

export interface Hospital extends LatLng {
  id: string
  name: string
  area: string
  phone?: string
  capabilities: Capability[]
  capabilitiesUpdatedAtMs: number
  availability: Availability
  diverted: boolean
  divertedCapabilities: Capability[]
}

export interface Ambulance extends LatLng {
  id: string
  callSign: string
  base: string
  available: boolean
  uid?: string
}

export type CaseStatus = 'reported' | 'dispatched' | 'enroute' | 'onscene' | 'transporting' | 'arrived' | 'closed'
export type Escalation = 'none' | 'attention' | 'no_hospital'

export interface Case extends LatLng {
  id: string
  type: CaseType
  severity: Severity
  patients: number
  needsIcu: boolean
  /** Non-identifying clinical summary visible to hospitals that are asked to accept the case. */
  brief: string
  locationSource: 'gps' | 'manual'
  reporterUid: string
  createdAtMs: number
  status: CaseStatus
  requiredCapabilities: Capability[]
  ambulanceId: string | null
  ambulanceCallSign: string | null
  ambulanceAckAtMs: number | null
  ambulancePos: TrackedPos | null
  etaSceneMin: number | null
  etaSource: 'road' | 'estimate' | null
  dispatchedAtMs: number | null
  notifiedHospitalIds: string[]
  offerWave: number
  recommendedHospitalId: string | null
  selectedHospitalId: string | null
  selectedHospitalName: string | null
  selectedAtMs: number | null
  selectedByUid: string | null
  overrideReason: string | null
  escalation: Escalation
  escalationNote: string | null
  duplicateOf: string | null
  duplicateDismissed: boolean
  arrivalConfirmedAtMs: number | null
  arrivalConfirmedByUid: string | null
  closedAtMs: number | null
  closeReason: string | null
}

/** cases/{id}/private/patient. Contact details and free text, kept away from hospitals until handover. */
export interface PatientPrivate {
  contact: string
  note: string
  reporterUid: string
}

export type OfferState = 'pending' | 'accepted' | 'declined' | 'timeout' | 'withdrawn' | 'selected'

/** offers/{caseId}_{hospitalId}: one request per hospital per case. */
export interface Offer {
  id: string
  caseId: string
  hospitalId: string
  hospitalName: string
  state: OfferState
  wave: number
  requestedAtMs: number
  expiresAtMs: number
  seenAtMs: number | null
  respondedAtMs: number | null
  respondedByUid: string | null
  /** Per-capability live confirmation, e.g. { trauma: true, antivenom: false }. */
  confirmations: Partial<Record<Capability, boolean>> | null
  canReceive: boolean | null
  declineReason: string | null
  distanceKm: number
  etaMin: number
  etaSource: 'road' | 'estimate'
}

export type EventKind =
  | 'reported' | 'dispatched' | 'ack' | 'offer_sent' | 'offer_seen' | 'offer_accepted' | 'offer_declined'
  | 'offer_timeout' | 'offer_revoked' | 'wave' | 'recommended' | 'selected' | 'override' | 'escalation' | 'status'
  | 'arrival_confirmed' | 'duplicate' | 'closed'

/** cases/{id}/events/{eventId}: append-only audit trail. */
export interface CaseEvent {
  id: string
  kind: EventKind
  text: string
  atMs: number
  actorUid: string
  actorRole: Role | 'reporter' | 'system'
}
