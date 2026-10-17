import type { Ambulance, Capability, EmergencyType, Hospital, Incident, LatLng } from './types'

export const GOLDEN_HOUR_MS = 60 * 60 * 1000
const AVG_SPEED_KMH = 35 // urban ambulance average, conservative

export const REQUIRED_CAPABILITY: Record<EmergencyType, Capability> = {
  cardiac: 'cardiac',
  stroke: 'stroke',
  trauma: 'trauma',
  burns: 'burns',
  obstetric: 'obstetric',
  other: 'emergency',
}

export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function travelMinutes(a: LatLng, b: LatLng): number {
  // road distance is typically ~1.3x straight-line
  return Math.round(((distanceKm(a, b) * 1.3) / AVG_SPEED_KMH) * 60)
}

export function goldenHourRemainingMs(createdAtMs: number, nowMs: number): number {
  return GOLDEN_HOUR_MS - (nowMs - createdAtMs)
}

export function formatCountdown(ms: number): string {
  const sign = ms < 0 ? '+' : ''
  const s = Math.floor(Math.abs(ms) / 1000)
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${sign}${mm}:${ss}`
}

export interface HospitalRank {
  hospital: Hospital
  etaMin: number
  distanceKm: number
  capable: boolean
  score: number // lower is better
  reason: string
}

/** Rank hospitals for an incident. Capability match dominates, then bed availability, then travel time. */
export function rankHospitals(incident: Pick<Incident, 'type' | 'lat' | 'lng' | 'declinedHospitalIds'>, hospitals: Hospital[]): HospitalRank[] {
  const need = REQUIRED_CAPABILITY[incident.type]
  return hospitals
    .filter((h) => !h.diverted && !incident.declinedHospitalIds.includes(h.id))
    .map((hospital) => {
      const eta = travelMinutes(incident, hospital)
      const capable = hospital.capabilities.includes(need)
      const noBeds = hospital.emergencyBeds <= 0
      const score = eta + (capable ? 0 : 1000) + (noBeds ? 500 : 0) - Math.min(hospital.emergencyBeds, 5)
      const reason = !capable ? `No ${need} capability` : noBeds ? 'No emergency beds' : `${hospital.emergencyBeds} bed(s), ${need} ready`
      return { hospital, etaMin: eta, distanceKm: Math.round(distanceKm(incident, hospital) * 10) / 10, capable, score, reason }
    })
    .sort((a, b) => a.score - b.score)
}

export function nearestAmbulance(point: LatLng, ambulances: Ambulance[]): Ambulance | null {
  const free = ambulances.filter((a) => a.available)
  if (!free.length) return null
  return free.reduce((best, a) => (distanceKm(a, point) < distanceKm(best, point) ? a : best))
}

export const STATUS_LABEL: Record<Incident['status'], string> = {
  reported: 'Reported',
  dispatched: 'Dispatched',
  onscene: 'On scene',
  transporting: 'Transporting',
  arrived: 'Arrived',
  closed: 'Closed',
}

export function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }
}
