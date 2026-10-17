import type { LatLng } from './types'

const AVG_SPEED_KMH = 35 // conservative urban ambulance average, used only for labelled estimates

export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371
  const rad = (d: number) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Straight-line estimate (x1.3 for road winding). Always label as an estimate in the UI. */
export function estimateMinutes(a: LatLng, b: LatLng): number {
  return Math.max(1, Math.round(((distanceKm(a, b) * 1.3) / AVG_SPEED_KMH) * 60))
}

export function lerp(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }
}

export function formatClock(ms: number): string {
  const sign = ms < 0 ? '+' : ''
  const s = Math.floor(Math.abs(ms) / 1000)
  return `${sign}${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function agoText(ms: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export const GOLDEN_HOUR_MS = 60 * 60 * 1000
export const goldenHourRemainingMs = (createdAtMs: number, nowMs: number) => GOLDEN_HOUR_MS - (nowMs - createdAtMs)
