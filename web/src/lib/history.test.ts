import { describe, expect, it } from 'vitest'
import { filterCases, searchText } from './history'
import { mkCase, T0 } from './fixtures'

const none = { q: '', status: 'all', type: 'all', severity: 'all', from: '', to: '' }
const day = 86_400_000
const rows = [
  mkCase({ id: 'aaaaaaaaaaaaaaaaaaaa', type: 'snakebite', severity: 1, brief: 'Man bitten on the leg', status: 'closed', arrivalConfirmedAtMs: T0, closedAtMs: T0 + 1, closeReason: 'Handed over', selectedHospitalName: 'Wenlock District Hospital', createdAtMs: T0 }),
  mkCase({ id: 'bbbbbbbbbbbbbbbbbbbb', type: 'trauma', severity: 2, brief: 'Fall from a bike', status: 'closed', closedAtMs: T0 + 2, closeReason: 'Cancelled: False alarm', createdAtMs: T0 - 3 * day }),
  mkCase({ id: 'cccccccccccccccccccc', type: 'cardiac', severity: 3, brief: 'Chest pain', status: 'enroute', createdAtMs: T0 - 10 * day }),
]

describe('incident history filters', () => {
  it('returns everything with no filters', () => { expect(filterCases(rows, none)).toHaveLength(3) })
  it('searches summary, hospital, crew, id, type and close reason, ignoring case', () => {
    expect(filterCases(rows, { ...none, q: 'wenlock' }).map((c) => c.id[0])).toEqual(['a'])
    expect(filterCases(rows, { ...none, q: 'BIKE' }).map((c) => c.id[0])).toEqual(['b'])
    expect(filterCases(rows, { ...none, q: 'cccccccc' }).map((c) => c.id[0])).toEqual(['c'])
    expect(filterCases(rows, { ...none, q: 'false alarm' }).map((c) => c.id[0])).toEqual(['b'])
    expect(filterCases(rows, { ...none, q: 'medic 1' })).toHaveLength(3) // every fixture is on Medic 1
    expect(filterCases(rows, { ...none, q: 'nothing like this' })).toEqual([])
  })
  it('separates completed handovers from cancellations and open cases', () => {
    expect(filterCases(rows, { ...none, status: 'completed' }).map((c) => c.id[0])).toEqual(['a'])
    expect(filterCases(rows, { ...none, status: 'cancelled' }).map((c) => c.id[0])).toEqual(['b'])
    expect(filterCases(rows, { ...none, status: 'open' }).map((c) => c.id[0])).toEqual(['c'])
    expect(filterCases(rows, { ...none, status: 'closed' })).toHaveLength(2)
  })
  it('filters by type and severity', () => {
    expect(filterCases(rows, { ...none, type: 'trauma' })).toHaveLength(1)
    expect(filterCases(rows, { ...none, severity: '1' })).toHaveLength(1)
    expect(filterCases(rows, { ...none, type: 'trauma', severity: '1' })).toHaveLength(0)
  })
  it('filters by an inclusive date range', () => {
    const d = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    expect(filterCases(rows, { ...none, from: d(T0 - 4 * day), to: d(T0) }).map((c) => c.id[0]).sort()).toEqual(['a', 'b'])
    expect(filterCases(rows, { ...none, from: d(T0 + day) })).toEqual([])
  })
  it('builds searchable text without crashing on missing fields', () => {
    expect(searchText(mkCase({ selectedHospitalName: null, closeReason: null }))).toContain('trauma')
  })
})
