import { useEffect, useMemo } from 'react'
import L from 'leaflet'
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { CASE_TYPES } from '../lib/capabilities'
import type { Ambulance, Case, Hospital, LatLng, OfferState } from '../lib/types'

const MANGALORE: LatLng = { lat: 12.8738, lng: 74.8426 }

function Fit({ points }: { points: LatLng[] }) {
  const map = useMap()
  const key = points.map((p) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).join('|')
  useEffect(() => {
    if (points.length > 1) map.fitBounds(points.map((p) => [p.lat, p.lng] as [number, number]), { padding: [44, 44], maxZoom: 15 })
    else if (points.length === 1) map.setView([points[0].lat, points[0].lng], 14)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map])
  return null
}

function Picker({ onPick }: { onPick: (p: LatLng) => void }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) })
  return null
}

const icon = (cls: string, size: number, inner = '') => L.divIcon({ className: '', html: `<span class="mk ${cls}">${inner}</span>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] })

interface Props {
  cases?: Case[]
  hospitals?: Hospital[]
  ambulances?: Ambulance[]
  /** Offer state per hospital for the case being viewed. */
  hospitalStates?: Partial<Record<string, OfferState>>
  route?: LatLng[]
  focus?: LatLng[]
  height?: number
  label?: string
  /** When set, tapping the map picks a location. */
  onPick?: (p: LatLng) => void
  pin?: LatLng | null
}

export default function MapView({ cases = [], hospitals = [], ambulances = [], hospitalStates = {}, route, focus, height, label = 'Map', onPick, pin }: Props) {
  const active = cases.filter((c) => c.status !== 'closed')
  const fitPoints = focus ?? [...active, ...hospitals.filter((h) => hospitalStates[h.id])]
  const icons = useMemo(() => ({
    incident: icon('mk-incident', 34),
    pin: icon('mk-pin', 34),
    crew: { gps: icon('mk-crew gps', 30), sim: icon('mk-crew sim', 30), base: icon('mk-crew', 24) },
    hospital: (st: OfferState | 'none') => icon(`mk-hospital ${st === 'declined' || st === 'timeout' || st === 'withdrawn' ? 'out' : st === 'none' ? '' : st}`, st === 'none' ? 24 : 30, 'H'),
  }), [])
  return (
    <div role="img" aria-label={label}>
      <MapContainer center={[MANGALORE.lat, MANGALORE.lng]} zoom={12} className="map" style={height ? { height } : undefined} scrollWheelZoom={false}>
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
        <Fit points={fitPoints.length ? fitPoints : [MANGALORE]} />
        {onPick && <Picker onPick={onPick} />}
        {pin && <Marker position={[pin.lat, pin.lng]} icon={icons.pin}><Tooltip permanent direction="top" offset={[0, -14]}>Emergency here</Tooltip></Marker>}
        {route && route.length > 1 && <Polyline positions={route.map((p) => [p.lat, p.lng] as [number, number])} pathOptions={{ color: '#1456c8', weight: 5, opacity: 0.9 }} />}
        {hospitals.map((h) => {
          const st: OfferState | 'none' = hospitalStates[h.id] ?? 'none'
          return (
            <Marker key={h.id} position={[h.lat, h.lng]} icon={icons.hospital(st)} zIndexOffset={st === 'selected' ? 600 : st === 'none' ? 0 : 300}>
              <Tooltip>{h.name}{st !== 'none' ? `, ${st}` : ''}{h.diverted ? ', on diversion' : ''}</Tooltip>
            </Marker>
          )
        })}
        {ambulances.map((a) => (
          <Marker key={a.id} position={[a.lat, a.lng]} icon={icons.crew.base} opacity={a.available ? 1 : 0.45}>
            <Tooltip>{a.callSign}, {a.available ? 'available' : 'on a call'} (base position)</Tooltip>
          </Marker>
        ))}
        {active.map((c) => (
          <span key={c.id}>
            <Marker position={[c.lat, c.lng]} icon={icons.incident} zIndexOffset={400}>
              <Tooltip>{CASE_TYPES[c.type].label}, {['', 'critical', 'serious', 'stable'][c.severity]}</Tooltip>
            </Marker>
            {c.ambulancePos && (
              <Marker position={[c.ambulancePos.lat, c.ambulancePos.lng]} icon={c.ambulancePos.source === 'gps' ? icons.crew.gps : icons.crew.sim} zIndexOffset={800}>
                <Tooltip>{c.ambulanceCallSign ?? 'Ambulance'}, {c.ambulancePos.source === 'gps' ? 'live GPS' : 'SIMULATED movement'}</Tooltip>
              </Marker>
            )}
          </span>
        ))}
      </MapContainer>
    </div>
  )
}
