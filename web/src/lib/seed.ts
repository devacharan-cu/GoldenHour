import type { Ambulance, Capability, Hospital, Role } from './types'

// DEMO DATA for the Mangalore region. Names are used for realism only: coordinates are approximate, and
// capabilities and bed counts are ILLUSTRATIVE PLACEHOLDERS. They are not real hospital records.
const T = 0 // stamped at provisioning time
const all: Capability[] = ['emergency', 'trauma', 'cardiac', 'stroke', 'antivenom', 'paediatrics', 'burns', 'icu', 'obstetric']

const base = (id: string, name: string, area: string, lat: number, lng: number, capabilities: Capability[], beds: number, icu: number, resources: Capability[]): Omit<Hospital, 'capabilitiesUpdatedAtMs' | 'availability'> & { beds: number; icu: number; resources: Capability[] } => ({
  id, name, area, lat, lng, capabilities, diverted: false, divertedCapabilities: [], beds, icu, resources,
})

export const SEED_HOSPITALS = [
  base('yenepoya', 'Yenepoya Medical College Hospital', 'Deralakatte', 12.8097, 74.8652, all, 6, 3, ['emergency', 'trauma', 'cardiac', 'stroke', 'antivenom', 'paediatrics', 'icu', 'obstetric']),
  base('kmc-attavar', 'KMC Hospital Attavar', 'Attavar', 12.8672, 74.8419, ['emergency', 'trauma', 'cardiac', 'stroke', 'icu', 'paediatrics'], 4, 2, ['emergency', 'trauma', 'cardiac', 'stroke', 'icu']),
  base('wenlock', 'Wenlock District Hospital', 'Hampankatta', 12.8707, 74.8426, ['emergency', 'trauma', 'burns', 'obstetric', 'antivenom', 'paediatrics', 'icu'], 8, 2, ['emergency', 'trauma', 'burns', 'antivenom']),
  base('aj', 'A.J. Hospital', 'Kuntikana', 12.904, 74.835, ['emergency', 'cardiac', 'stroke', 'icu', 'trauma'], 3, 1, ['emergency', 'cardiac', 'stroke']),
  base('father-muller', 'Father Muller Medical College Hospital', 'Kankanady', 12.8697, 74.8588, ['emergency', 'trauma', 'obstetric', 'burns', 'paediatrics', 'antivenom', 'icu'], 5, 2, ['emergency', 'trauma', 'obstetric', 'burns']),
  base('indiana', 'Indiana Hospital', 'Pumpwell', 12.8814, 74.8629, ['emergency', 'cardiac', 'trauma', 'stroke', 'icu'], 3, 1, ['emergency', 'cardiac']),
  base('srinivas', 'Srinivas Hospital', 'Mukka', 13.0224, 74.7968, ['emergency', 'trauma', 'obstetric', 'paediatrics', 'antivenom'], 4, 0, ['emergency', 'trauma', 'antivenom']),
  base('ks-hegde', 'K.S. Hegde Hospital', 'Deralakatte', 12.8085, 74.8639, ['emergency', 'trauma', 'cardiac', 'stroke', 'icu', 'paediatrics', 'burns'], 4, 1, ['emergency', 'trauma', 'cardiac']),
]
void T

export const SEED_AMBULANCES: Ambulance[] = [
  { id: 'amb-1', callSign: 'Medic 1', base: 'Hampankatta', lat: 12.8695, lng: 74.842, available: true, currentCaseId: null },
  { id: 'amb-2', callSign: 'Medic 2', base: 'Kankanady', lat: 12.875, lng: 74.86, available: true, currentCaseId: null },
  { id: 'amb-3', callSign: 'Medic 3', base: 'Deralakatte', lat: 12.815, lng: 74.86, available: true, currentCaseId: null },
  { id: 'amb-4', callSign: 'Medic 4', base: 'Surathkal', lat: 12.99, lng: 74.795, available: true, currentCaseId: null },
]

export interface SeedAccount { key: string; email: string; displayName: string; role: Role; hospitalId?: string; ambulanceId?: string }

/** Trusted accounts created by scripts/provision.mjs. Emails use a non-routable demo domain. */
export const SEED_ACCOUNTS: SeedAccount[] = [
  { key: 'dispatcher1', email: 'dispatcher1@goldenhour.demo', displayName: 'Dispatcher 1', role: 'dispatcher' },
  { key: 'dispatcher2', email: 'dispatcher2@goldenhour.demo', displayName: 'Dispatcher 2', role: 'dispatcher' },
  ...SEED_AMBULANCES.map((a, i) => ({ key: `crew${i + 1}`, email: `crew${i + 1}@goldenhour.demo`, displayName: `${a.callSign} crew`, role: 'ambulance' as const, ambulanceId: a.id })),
  ...SEED_HOSPITALS.map((h) => ({ key: `hospital-${h.id}`, email: `${h.id}@goldenhour.demo`, displayName: `${h.name} staff`, role: 'hospital' as const, hospitalId: h.id })),
]
