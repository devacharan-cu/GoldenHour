import { useEffect } from 'react'
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { CASE_TYPES } from '../lib/capabilities'
import type { Ambulance, Case, Hospital, LatLng, OfferState } from '../lib/types'

const MANGALORE: LatLng = { lat: 12.8738, lng: 74.8426 }

function Fit({ points }: { points: LatLng[] }) {
  const map = useMap()
  const key = points.map((p) => `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`).join('|')
  useEffect(() => {
    if (points.length > 1) map.fitBounds(points.map((p) => [p.lat, p.lng] as [number, number]), { padding: [40, 40], maxZoom: 15 })
    else if (points.length === 1) map.setView([points[0].lat, points[0].lng], 14)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, map])
  return null
}

function Picker({ onPick }: { onPick: (p: LatLng) => void }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) })
  return null
}

const HOSPITAL_COLOR: Record<OfferState | 'none', string> = {
  none: '#5b6b86', pending: '#ffb020', accepted: '#7be3b1', declined: '#6b7280', timeout: '#6b7280', withdrawn: '#6b7280', selected: '#2ecc8f',
}

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
  return (
    <div role="img" aria-label={label}>
      <MapContainer center={[MANGALORE.lat, MANGALORE.lng]} zoom={12} className="map" style={height ? { height } : undefined} scrollWheelZoom={false}>
        <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" />
        <Fit points={fitPoints.length ? fitPoints : [MANGALORE]} />
        {onPick && <Picker onPick={onPick} />}
        {pin && <CircleMarker center={[pin.lat, pin.lng]} radius={11} pathOptions={{ color: '#ff4d4f', fillColor: '#ff4d4f', fillOpacity: 0.6, weight: 3 }}><Tooltip permanent direction="top">Emergency here</Tooltip></CircleMarker>}
        {route && route.length > 1 && <Polyline positions={route.map((p) => [p.lat, p.lng] as [number, number])} pathOptions={{ color: '#4da3ff', weight: 4, opacity: 0.8 }} />}
        {hospitals.map((h) => {
          const st: OfferState | 'none' = hospitalStates[h.id] ?? 'none'
          const hot = st === 'selected' || st === 'accepted' || st === 'pending'
          return (
            <CircleMarker key={h.id} center={[h.lat, h.lng]} radius={hot ? 10 : 7} pathOptions={{ color: HOSPITAL_COLOR[st], fillColor: HOSPITAL_COLOR[st], fillOpacity: hot ? 0.9 : 0.45, weight: st === 'selected' ? 4 : 2 }}>
              <Tooltip>{h.name}{st !== 'none' ? ` · ${st}` : ''}{h.diverted ? ' · DIVERTED' : ''}</Tooltip>
            </CircleMarker>
          )
        })}
        {ambulances.map((a) => (
          <CircleMarker key={a.id} center={[a.lat, a.lng]} radius={6} pathOptions={{ color: '#4da3ff', fillColor: '#4da3ff', fillOpacity: a.available ? 0.9 : 0.3, weight: 2 }}>
            <Tooltip>{a.callSign} · {a.available ? 'available' : 'on call'} · base position</Tooltip>
          </CircleMarker>
        ))}
        {active.map((c) => (
          <span key={c.id}>
            <CircleMarker center={[c.lat, c.lng]} radius={11} pathOptions={{ color: '#ff4d4f', fillColor: '#ff4d4f', fillOpacity: 0.55, weight: 3 }}>
              <Tooltip>{CASE_TYPES[c.type].icon} {CASE_TYPES[c.type].label} · {['', 'critical', 'serious', 'stable'][c.severity]}</Tooltip>
            </CircleMarker>
            {c.ambulancePos && (
              <CircleMarker
                center={[c.ambulancePos.lat, c.ambulancePos.lng]}
                radius={9}
                pathOptions={c.ambulancePos.source === 'gps'
                  ? { color: '#ffffff', fillColor: '#2ecc8f', fillOpacity: 1, weight: 3 }
                  : { color: '#c4a1ff', fillColor: '#4da3ff', fillOpacity: 0.85, weight: 3, dashArray: '3 4' }}
              >
                <Tooltip>{c.ambulanceCallSign ?? 'Ambulance'} · {c.ambulancePos.source === 'gps' ? 'live GPS' : 'SIMULATED'}</Tooltip>
              </CircleMarker>
            )}
          </span>
        ))}
      </MapContainer>
    </div>
  )
}
