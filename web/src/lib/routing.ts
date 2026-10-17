import { estimateMinutes } from './geo'
import type { LatLng } from './types'

// Public OSRM demo server: free, no key, but best-effort only. Every call has a short timeout and a
// labelled straight-line fallback so routing trouble never delays dispatch.
const OSRM = 'https://router.project-osrm.org'
const TIMEOUT_MS = 3500

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>

async function getJson(url: string, fetchFn: FetchLike, timeoutMs = TIMEOUT_MS): Promise<unknown | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetchFn(url, { signal: ctrl.signal })
    return r.ok ? await r.json() : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const coord = (p: LatLng) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`

export interface EtaResult { etaMin: number; source: 'road' | 'estimate' }

/** Travel time from one origin to many destinations, one request. Falls back per-target to an estimate. */
export async function etasFrom(origin: LatLng, targets: LatLng[], fetchFn: FetchLike = fetch as unknown as FetchLike, timeoutMs = TIMEOUT_MS): Promise<EtaResult[]> {
  const fallback = targets.map((t) => ({ etaMin: estimateMinutes(origin, t), source: 'estimate' as const }))
  if (!targets.length) return []
  const coords = [origin, ...targets].map(coord).join(';')
  const data = (await getJson(`${OSRM}/table/v1/driving/${coords}?sources=0&annotations=duration`, fetchFn, timeoutMs)) as { code?: string; durations?: (number | null)[][] } | null
  const row = data?.code === 'Ok' ? data.durations?.[0] : undefined
  if (!row || row.length !== targets.length + 1) return fallback
  return targets.map((_t, i) => {
    const sec = row[i + 1]
    return typeof sec === 'number' ? { etaMin: Math.max(1, Math.round(sec / 60)), source: 'road' as const } : fallback[i]
  })
}

export interface RoutePath { points: LatLng[]; durationMin: number; source: 'road' | 'estimate' }

/** Road geometry for map display and the simulated drive. Falls back to a straight line. */
export async function routePath(from: LatLng, to: LatLng, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<RoutePath> {
  const data = (await getJson(`${OSRM}/route/v1/driving/${coord(from)};${coord(to)}?overview=full&geometries=geojson`, fetchFn)) as {
    code?: string
    routes?: { duration: number; geometry: { coordinates: [number, number][] } }[]
  } | null
  const r = data?.code === 'Ok' ? data.routes?.[0] : undefined
  if (r?.geometry?.coordinates?.length) {
    return { points: r.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })), durationMin: Math.max(1, Math.round(r.duration / 60)), source: 'road' }
  }
  return { points: [from, to], durationMin: estimateMinutes(from, to), source: 'estimate' }
}

/** Position along a polyline at progress t in [0,1], by cumulative distance. */
export function pointAlong(points: LatLng[], t: number): LatLng {
  if (points.length === 1 || t <= 0) return points[0]
  if (t >= 1) return points[points.length - 1]
  const seg: number[] = []
  let total = 0
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i].lat - points[i - 1].lat, (points[i].lng - points[i - 1].lng) * Math.cos((points[i].lat * Math.PI) / 180))
    seg.push(d)
    total += d
  }
  let target = t * total
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const f = seg[i] === 0 ? 0 : Math.min(1, target / seg[i])
      return { lat: points[i].lat + (points[i + 1].lat - points[i].lat) * f, lng: points[i].lng + (points[i + 1].lng - points[i].lng) * f }
    }
    target -= seg[i]
  }
  return points[points.length - 1]
}
