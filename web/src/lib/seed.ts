import type { Ambulance, Hospital } from './types'

// Demo data for the Mangalore region. Coordinates are approximate and capabilities/bed counts are
// illustrative placeholders, NOT real hospital data.
export const SEED_HOSPITALS: Hospital[] = [
  { id: 'yenepoya', name: 'Yenepoya Medical College Hospital', area: 'Deralakatte', lat: 12.8097, lng: 74.8652, capabilities: ['emergency', 'cardiac', 'stroke', 'trauma', 'obstetric'], emergencyBeds: 6, diverted: false },
  { id: 'kmc-attavar', name: 'KMC Hospital Attavar', area: 'Attavar', lat: 12.8672, lng: 74.8419, capabilities: ['emergency', 'cardiac', 'stroke', 'trauma'], emergencyBeds: 4, diverted: false },
  { id: 'wenlock', name: 'Wenlock District Hospital', area: 'Hampankatta', lat: 12.8707, lng: 74.8426, capabilities: ['emergency', 'trauma', 'burns', 'obstetric'], emergencyBeds: 8, diverted: false },
  { id: 'aj', name: 'A.J. Hospital', area: 'Kuntikana', lat: 12.904, lng: 74.835, capabilities: ['emergency', 'cardiac', 'stroke'], emergencyBeds: 3, diverted: false },
  { id: 'father-muller', name: 'Father Muller Medical College Hospital', area: 'Kankanady', lat: 12.8697, lng: 74.8588, capabilities: ['emergency', 'trauma', 'obstetric', 'burns'], emergencyBeds: 5, diverted: false },
]

export const SEED_AMBULANCES: Ambulance[] = [
  { id: 'amb-1', callSign: 'Medic 1', base: 'Hampankatta', lat: 12.8695, lng: 74.842, available: true },
  { id: 'amb-2', callSign: 'Medic 2', base: 'Kankanady', lat: 12.875, lng: 74.86, available: true },
  { id: 'amb-3', callSign: 'Medic 3', base: 'Deralakatte', lat: 12.815, lng: 74.86, available: true },
  { id: 'amb-4', callSign: 'Medic 4', base: 'Surathkal', lat: 12.99, lng: 74.795, available: true },
]
