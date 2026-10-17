import { describe, expect, it } from 'vitest'
import { mkCase, mkOffer, T0 } from './fixtures'
import { nextMover, relayDone, relayNotes, relayRoleOf } from './relay'

const accepted = (h: string) => mkOffer(h, { state: 'accepted', canReceive: true, confirmations: { trauma: true } })
const clock = (ms: number) => `t${ms - T0}`

describe('whose move is it', () => {
  it('walks the baton through every hand in order', () => {
    const steps: [Parameters<typeof mkCase>[0], ReturnType<typeof mkOffer>[], string, string][] = [
      [{ status: 'reported', ambulanceId: null }, [], 'dispatcher', 'Choose a crew'],
      [{ status: 'dispatched', ambulanceAckAtMs: null, offerWave: 0 }, [], 'crew', 'Accept or decline'],
      [{ status: 'enroute', offerWave: 0 }, [], 'dispatcher', 'Asking the nearest hospitals'],
      [{ status: 'enroute', offerWave: 1 }, [mkOffer('h1'), mkOffer('h2')], 'hospital', 'Confirm resources'],
      [{ status: 'enroute', offerWave: 1 }, [accepted('h1'), mkOffer('h2', { state: 'declined' })], 'dispatcher', 'Confirm the destination'],
      [{ status: 'enroute', selectedHospitalId: 'h1' }, [], 'crew', 'Acknowledge the destination'],
      [{ status: 'enroute', selectedHospitalId: 'h1', destinationAckAtMs: T0 }, [], 'crew', 'Drive to the scene'],
      [{ status: 'onscene', selectedHospitalId: 'h1', destinationAckAtMs: T0 }, [], 'crew', 'Pick up the patient'],
      [{ status: 'transporting', selectedHospitalId: 'h1', destinationAckAtMs: T0 }, [], 'crew', 'Drive to the hospital'],
      [{ status: 'arrived', selectedHospitalId: 'h1', destinationAckAtMs: T0 }, [], 'hospital', 'Confirm the patient arrived'],
      [{ status: 'arrived', selectedHospitalId: 'h1', destinationAckAtMs: T0, arrivalConfirmedAtMs: T0 }, [], 'dispatcher', 'Close the case'],
    ]
    for (const [over, offers, role, action] of steps) {
      const m = nextMover(mkCase(over), offers)
      expect(m.role, JSON.stringify(over)).toBe(role)
      expect(m.action).toContain(action)
    }
  })
  it('tells dispatch plainly when nobody has confirmed after hospitals were asked', () => {
    expect(nextMover(mkCase({ status: 'enroute', offerWave: 2 }), [mkOffer('h1', { state: 'declined' })])).toEqual({ role: 'dispatcher', action: 'No hospital has confirmed yet' })
  })
  it('treats an accept without full confirmation as not qualified, so the hospital still owes a move', () => {
    const half = mkOffer('h1', { state: 'accepted', canReceive: true, confirmations: {} })
    expect(nextMover(mkCase({ status: 'enroute', offerWave: 1 }), [half]).role).toBe('dispatcher') // nothing pending, nothing qualified
    expect(nextMover(mkCase({ status: 'enroute', offerWave: 1 }), [half]).action).toMatch(/No hospital has confirmed/)
  })
  it('has nobody to move once closed', () => {
    expect(nextMover(mkCase({ status: 'closed' }), [])).toEqual({ role: null, action: 'The case is closed' })
  })
})

describe('track state', () => {
  it('marks finished hands', () => {
    expect(relayDone(mkCase({ status: 'reported', ambulanceAckAtMs: null }))).toEqual({ reporter: true, dispatcher: false, crew: false, hospital: false })
    expect(relayDone(mkCase({ status: 'enroute' }))).toEqual({ reporter: true, dispatcher: true, crew: true, hospital: false })
    expect(relayDone(mkCase({ status: 'arrived', arrivalConfirmedAtMs: T0 })).hospital).toBe(true)
  })
  it('writes a short honest line for each hand', () => {
    const n = relayNotes(mkCase({ status: 'enroute' }), [mkOffer('h1'), mkOffer('h2', { state: 'declined' })], clock)
    expect(n.reporter).toBe('reported t0')
    expect(n.crew).toMatch(/Medic 1 accepted/)
    expect(n.hospital).toBe('1 of 2 answered')
    expect(relayNotes(mkCase({ status: 'reported', ambulanceId: null, ambulanceCallSign: null, ambulanceAckAtMs: null }), [], clock).crew).toBe('not assigned')
  })
  it('maps account roles to relay roles', () => {
    expect(relayRoleOf('ambulance')).toBe('crew')
    expect(relayRoleOf('hospital')).toBe('hospital')
    expect(relayRoleOf('dispatcher')).toBe('dispatcher')
    expect(relayRoleOf(undefined)).toBe('reporter')
    expect(relayRoleOf('reporter')).toBe('reporter')
  })
})
