import { describe, expect, it } from 'vitest'
import { distanceKm, formatCountdown, goldenHourRemainingMs, nearestAmbulance, rankHospitals, travelMinutes } from './triage'
import type { Ambulance, Hospital } from './types'

const mk = (id: string, lat: number, lng: number, caps: Hospital['capabilities'], beds = 3, diverted = false): Hospital => ({
  id, name: id, area: '', lat, lng, capabilities: caps, emergencyBeds: beds, diverted,
})
const near = mk('near-noncardiac', 12.87, 74.84, ['emergency'])
const far = mk('far-cardiac', 12.95, 74.9, ['emergency', 'cardiac'])
const inc = { type: 'cardiac' as const, lat: 12.871, lng: 74.842, declinedHospitalIds: [] as string[] }

describe('triage', () => {
  it('computes haversine distance (~111km per degree latitude)', () => {
    expect(distanceKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.19, 1)
  })
  it('estimates travel time', () => {
    expect(travelMinutes({ lat: 12.87, lng: 74.84 }, { lat: 12.87, lng: 74.84 })).toBe(0)
  })
  it('prefers a capable hospital over a nearer incapable one', () => {
    const r = rankHospitals(inc, [near, far])
    expect(r[0].hospital.id).toBe('far-cardiac')
    expect(r[1].capable).toBe(false)
  })
  it('excludes diverted and declined hospitals', () => {
    const r = rankHospitals({ ...inc, declinedHospitalIds: ['far-cardiac'] }, [near, far, mk('x', 12.9, 74.9, ['cardiac'], 2, true)])
    expect(r.map((x) => x.hospital.id)).toEqual(['near-noncardiac'])
  })
  it('penalises hospitals with no beds', () => {
    const full = mk('full', 12.8711, 74.8421, ['cardiac'], 0)
    const open = mk('open', 12.9, 74.88, ['cardiac'], 4)
    expect(rankHospitals(inc, [full, open])[0].hospital.id).toBe('open')
  })
  it('counts down the golden hour', () => {
    expect(goldenHourRemainingMs(0, 10 * 60 * 1000)).toBe(50 * 60 * 1000)
    expect(formatCountdown(50 * 60 * 1000)).toBe('50:00')
    expect(formatCountdown(-5000)).toBe('+00:05')
  })
  it('picks nearest available ambulance only', () => {
    const a = (id: string, lat: number, available: boolean): Ambulance => ({ id, callSign: id, base: '', lat, lng: 74.8, available })
    expect(nearestAmbulance({ lat: 12.9, lng: 74.8 }, [a('busy', 12.9, false), a('ok', 13.0, true)])?.id).toBe('ok')
    expect(nearestAmbulance({ lat: 12.9, lng: 74.8 }, [a('busy', 12.9, false)])).toBeNull()
  })
})
