import { useEffect, useState } from 'react'
import { addDoc, arrayUnion, collection, doc, getDocs, onSnapshot, updateDoc, writeBatch } from 'firebase/firestore'
import { db } from './firebase'
import { SEED_AMBULANCES, SEED_HOSPITALS } from './seed'
import { nearestAmbulance, rankHospitals } from './triage'
import type { Ambulance, EmergencyType, Hospital, Incident, IncidentStatus, LatLng, Severity } from './types'

function useCollection<T extends { id: string }>(name: string): { data: T[]; error: string | null; ready: boolean } {
  const [data, setData] = useState<T[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(
    () =>
      onSnapshot(
        collection(db, name),
        (snap) => {
          setData(snap.docs.map((d) => ({ ...(d.data() as object), id: d.id }) as T))
          setReady(true)
          setError(null)
        },
        (e) => setError(e.message),
      ),
    [name],
  )
  return { data, error, ready }
}

export const useIncidents = () => useCollection<Incident>('incidents')
export const useHospitals = () => useCollection<Hospital>('hospitals')
export const useAmbulances = () => useCollection<Ambulance>('ambulances')

export async function seedIfEmpty(): Promise<boolean> {
  const existing = await getDocs(collection(db, 'hospitals'))
  if (!existing.empty) return false
  const batch = writeBatch(db)
  SEED_HOSPITALS.forEach(({ id, ...h }) => batch.set(doc(db, 'hospitals', id), h))
  SEED_AMBULANCES.forEach(({ id, ...a }) => batch.set(doc(db, 'ambulances', id), a))
  await batch.commit()
  return true
}

const entry = (text: string) => ({ atMs: Date.now(), text })

export async function reportIncident(i: { type: EmergencyType; severity: Severity; patients: number; note: string; contact: string } & LatLng): Promise<string> {
  const status: IncidentStatus = 'reported'
  const ref = await addDoc(collection(db, 'incidents'), {
    ...i,
    createdAtMs: Date.now(),
    status,
    hospitalId: null,
    ambulanceId: null,
    alert: 'none',
    declinedHospitalIds: [],
    ambulancePos: null,
    timeline: [entry('Emergency reported')],
  })
  return ref.id
}

/** Dispatch: nearest free ambulance + best-ranked capable hospital, with a pre-arrival alert. */
export async function dispatch(incident: Incident, hospitals: Hospital[], ambulances: Ambulance[], hospitalId?: string): Promise<string> {
  const amb = incident.ambulanceId ? (ambulances.find((a) => a.id === incident.ambulanceId) ?? null) : nearestAmbulance(incident, ambulances)
  if (!amb) return 'No ambulance available'
  const hospital = hospitalId ? hospitals.find((h) => h.id === hospitalId) : rankHospitals(incident, hospitals)[0]?.hospital
  if (!hospital) return 'No hospital available'
  if (!incident.ambulanceId) await updateDoc(doc(db, 'ambulances', amb.id), { available: false })
  await updateDoc(doc(db, 'incidents', incident.id), {
    status: incident.status === 'reported' ? 'dispatched' : incident.status,
    ambulanceId: amb.id,
    hospitalId: hospital.id,
    alert: 'pending',
    ambulancePos: incident.ambulancePos ?? { lat: amb.lat, lng: amb.lng },
    timeline: arrayUnion(entry(incident.ambulanceId ? `Pre-alert sent to ${hospital.name}` : `${amb.callSign} dispatched; pre-alert sent to ${hospital.name}`)),
  })
  return `${amb.callSign} → ${hospital.name}`
}

export async function respondToAlert(incident: Incident, hospital: Hospital, accept: boolean) {
  await updateDoc(doc(db, 'incidents', incident.id), {
    alert: accept ? 'accepted' : 'declined',
    ...(accept ? {} : { declinedHospitalIds: arrayUnion(hospital.id), hospitalId: null }),
    timeline: arrayUnion(entry(`${hospital.name} ${accept ? 'accepted the patient and is preparing' : 'declined - awaiting re-route'}`)),
  })
}

export async function setStatus(incident: Incident, status: IncidentStatus, text: string, pos?: LatLng) {
  await updateDoc(doc(db, 'incidents', incident.id), {
    status,
    ...(pos ? { ambulancePos: pos } : {}),
    timeline: arrayUnion(entry(text)),
  })
}

export async function movePosition(incidentId: string, ambId: string, pos: LatLng) {
  await updateDoc(doc(db, 'incidents', incidentId), { ambulancePos: pos })
  await updateDoc(doc(db, 'ambulances', ambId), pos)
}

export async function releaseAmbulance(ambId: string) {
  await updateDoc(doc(db, 'ambulances', ambId), { available: true })
}

export async function setBeds(hospitalId: string, emergencyBeds: number) {
  await updateDoc(doc(db, 'hospitals', hospitalId), { emergencyBeds: Math.max(0, emergencyBeds) })
}

export async function setDiverted(hospitalId: string, diverted: boolean) {
  await updateDoc(doc(db, 'hospitals', hospitalId), { diverted })
}
