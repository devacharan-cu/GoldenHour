export type EmergencyType = 'cardiac' | 'stroke' | 'trauma' | 'burns' | 'obstetric' | 'other'
export type Severity = 1 | 2 | 3 // 1 = critical
export type Capability = 'cardiac' | 'stroke' | 'trauma' | 'burns' | 'obstetric' | 'emergency'
export type IncidentStatus = 'reported' | 'dispatched' | 'onscene' | 'transporting' | 'arrived' | 'closed'
export type AlertState = 'none' | 'pending' | 'accepted' | 'declined'

export interface LatLng { lat: number; lng: number }

export interface Hospital extends LatLng {
  id: string
  name: string
  area: string
  capabilities: Capability[]
  emergencyBeds: number
  diverted: boolean
}

export interface Ambulance extends LatLng {
  id: string
  callSign: string
  base: string
  available: boolean
}

export interface Incident extends LatLng {
  id: string
  type: EmergencyType
  severity: Severity
  patients: number
  note: string
  contact: string
  createdAtMs: number
  status: IncidentStatus
  hospitalId: string | null
  ambulanceId: string | null
  alert: AlertState
  declinedHospitalIds: string[]
  ambulancePos: LatLng | null
  timeline: { atMs: number; text: string }[]
}
