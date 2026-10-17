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
  /** Always equals (currentCaseId === null). Kept as a plain field so queries and old data stay simple. */
  available: boolean
  /** The one case this unit is currently offered or assigned. Set only while it is null, so a unit can never hold two cases. */
  currentCaseId: string | null
  uid?: string
}

/**
 * reported    waiting for a dispatcher to offer it to a crew
 * dispatched  offered to a crew, waiting for them to accept or decline
 * enroute     crew accepted and is travelling to the scene (hospitals are asked now)
 * onscene     crew at the scene
 * transporting patient picked up, travelling to the destination hospital
 * arrived     crew at the hospital, waiting for the hospital to confirm receipt
 * closed      finished (after hospital confirmation) or cancelled
 */
export type Escalation = 'none' | 'attention' | 'no_hospital'

export type CaseStatus = 'reported' | 'dispatched' | 'enroute' | 'onscene' | 'transporting' | 'arrived' | 'closed'

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
  /** When the crew ACCEPTED the dispatch offer. */
  ambulanceAckAtMs: number | null
  crewOfferedAtMs: number | null
  declinedAmbulanceIds: string[]
  crewDeclineReason: string | null
  ambulancePos: TrackedPos | null
  etaSceneMin: number | null
  etaSource: 'road' | 'estimate' | null
  dispatchedAtMs: number | null
  /** Every hospital ever asked (audit). */
  notifiedHospitalIds: string[]
  /** Hospitals that may CURRENTLY see the case and its evidence: pending, accepted or selected. Declined or withdrawn hospitals are removed. */
  activeHospitalIds: string[]
  hospitalAlertAtMs: number | null
  offerWave: number
  recommendedHospitalId: string | null
  selectedHospitalId: string | null
  selectedHospitalName: string | null
  selectedAtMs: number | null
  selectedByUid: string | null
  overrideReason: string | null
  /** The crew acknowledged the confirmed destination. Transport cannot start without it. */
  destinationAckAtMs: number | null
  destinationAckByUid: string | null
  pickupAtMs: number | null
  escalation: Escalation
  escalationNote: string | null
  duplicateOf: string | null
  duplicateDismissed: boolean
  arrivalConfirmedAtMs: number | null
  arrivalConfirmedByUid: string | null
  closedAtMs: number | null
  closeReason: string | null
  /** SHA-256 (hex) of the reporter's secret receipt code. The code itself is never stored. */
  receiptHash: string
  evidenceExpected: number
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

export type EvidenceKind = 'image' | 'document' | 'audio' | 'video'

/** cases/{id}/evidence/{evidenceId}: metadata. The bytes live in the chunks subcollection. */
export interface Evidence {
  id: string
  name: string
  mime: string
  kind: EvidenceKind
  size: number
  sha256: string
  chunkCount: number
  chunkSize: number
  status: 'uploading' | 'ready'
  uploaderUid: string
  createdAtMs: number
  origin: 'camera' | 'recorder' | 'file'
}

export interface AiFacts {
  incidentType: string | null
  symptoms: string[]
  locationClues: string[]
  timestamps: string[]
  patientCount: number | null
}

/** cases/{id}/ai/draft (dispatcher only) and cases/{id}/ai/handoff (reviewed copy shared with crew and active hospitals). */
export interface AiBriefing {
  aiGenerated: true
  model: string
  generatedAtMs: number
  transcript: string | null
  summary: string
  facts: AiFacts
  missingInformation: string[]
  uncertainties: string[]
  conflicts: string[]
  handoff: string
  sourceEvidenceIds: string[]
  guardrailFlags: string[]
  /** Set on the shared copy only. */
  reviewedByUid?: string
  reviewedAtMs?: number
  edited?: boolean
}

export type EventKind =
  | 'reported' | 'dispatched' | 'ack' | 'crew_declined' | 'assignment_cancelled' | 'destination_ack' | 'pickup' | 'evidence' | 'ai' | 'offer_sent' | 'offer_seen' | 'offer_accepted' | 'offer_declined'
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

/**
 * Cases written before a field existed (for example by an earlier version of the app) are filled with safe defaults on
 * read, so the screens never crash on an older record. Nothing is written back.
 */
export function normalizeCase(raw: Partial<Case> & { id: string }): Case {
  return {
    ambulanceId: null, ambulanceCallSign: null, ambulanceAckAtMs: null, crewOfferedAtMs: null, declinedAmbulanceIds: [], crewDeclineReason: null,
    ambulancePos: null, etaSceneMin: null, etaSource: null, dispatchedAtMs: null, notifiedHospitalIds: [], activeHospitalIds: [], hospitalAlertAtMs: null,
    offerWave: 0, recommendedHospitalId: null, selectedHospitalId: null, selectedHospitalName: null, selectedAtMs: null, selectedByUid: null, overrideReason: null,
    destinationAckAtMs: null, destinationAckByUid: null, pickupAtMs: null, escalation: 'none', escalationNote: null, duplicateOf: null, duplicateDismissed: false,
    arrivalConfirmedAtMs: null, arrivalConfirmedByUid: null, closedAtMs: null, closeReason: null, receiptHash: '', evidenceExpected: 0, needsIcu: false, brief: '',
    patients: 1, locationSource: 'manual',
    ...raw,
  } as Case
}
