import { describe, expect, it } from 'vitest'
import { mkCase, mkHospital } from './fixtures'
import { findDuplicates } from './duplicates'
import { etasFrom, pointAlong, routePath } from './routing'

const ok = (body: unknown) => async () => ({ ok: true, json: async () => body })
const fail = async () => { throw new Error('network') }
const A = { lat: 12.87, lng: 74.84 }
const B = { lat: 12.9, lng: 74.86 }

describe('routing', () => {
  it('uses road durations when the router answers', async () => {
    const r = await etasFrom(A, [B, A], ok({ code: 'Ok', durations: [[0, 600, 0]] }))
    expect(r).toEqual([{ etaMin: 10, source: 'road' }, { etaMin: 1, source: 'road' }])
  })
  it('falls back to labelled estimates on network failure', async () => {
    const r = await etasFrom(A, [B], fail)
    expect(r[0].source).toBe('estimate')
    expect(r[0].etaMin).toBeGreaterThan(0)
  })
  it('falls back per target when a duration is null', async () => {
    const r = await etasFrom(A, [B, B], ok({ code: 'Ok', durations: [[0, null, 300]] }))
    expect(r[0].source).toBe('estimate')
    expect(r[1]).toEqual({ etaMin: 5, source: 'road' })
  })
  it('falls back on a malformed response', async () => {
    expect((await etasFrom(A, [B], ok({ code: 'NoRoute' })))[0].source).toBe('estimate')
  })
  it('returns road geometry or a straight line', async () => {
    const road = await routePath(A, B, ok({ code: 'Ok', routes: [{ duration: 120, geometry: { coordinates: [[74.84, 12.87], [74.85, 12.88], [74.86, 12.9]] } }] }))
    expect(road.source).toBe('road')
    expect(road.points).toHaveLength(3)
    const line = await routePath(A, B, fail)
    expect(line).toMatchObject({ source: 'estimate', points: [A, B] })
  })
  it('interpolates along a polyline', () => {
    const pts = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }]
    expect(pointAlong(pts, 0)).toEqual(pts[0])
    expect(pointAlong(pts, 1)).toEqual(pts[2])
    const mid = pointAlong(pts, 0.5)
    expect(mid.lat).toBeCloseTo(0, 1)
    expect(mid.lng).toBeCloseTo(1, 1)
  })
})

describe('duplicate detection', () => {
  const a = mkCase({ id: 'a', lat: 12.87, lng: 74.84, type: 'trauma' })
  it('flags nearby recent open cases of the same type', () => {
    expect(findDuplicates(a, [mkCase({ id: 'b', lat: 12.8712, lng: 74.8405, createdAtMs: a.createdAtMs + 60_000 })]).map((x) => x.id)).toEqual(['b'])
  })
  it('ignores far, old, closed, different-type and already-linked cases', () => {
    const others = [
      mkCase({ id: 'far', lat: 12.9 }),
      mkCase({ id: 'old', createdAtMs: a.createdAtMs + 30 * 60_000 }),
      mkCase({ id: 'closed', status: 'closed' }),
      mkCase({ id: 'cardiac', type: 'cardiac' }),
      mkCase({ id: 'linked', duplicateOf: 'x' }),
    ]
    expect(findDuplicates(a, others)).toEqual([])
  })
  it('stays quiet once dismissed', () => {
    expect(findDuplicates({ ...a, duplicateDismissed: true }, [mkCase({ id: 'b' })])).toEqual([])
  })
  it('uses the hospital fixture type correctly', () => {
    expect(mkHospital('x', 1, 1).availability.emergencyBeds).toBe(3)
  })
})
