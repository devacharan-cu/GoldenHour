import { useEffect } from 'react'
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import type { Ambulance, Hospital, Incident, LatLng } from '../lib/types'

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

interface Props {
  incidents?: Incident[]
  hospitals?: Hospital[]
  ambulances?: Ambulance[]
  focus?: LatLng[]
  height?: number
}

export default function MapView({ incidents = [], hospitals = [], ambulances = [], focus, height }: Props) {
  const active = incidents.filter((i) => i.status !== 'closed')
  const fitPoints = focus ?? [...active, ...hospitals]
  return (
    <MapContainer center={[MANGALORE.lat, MANGALORE.lng]} zoom={12} className="map" style={height ? { height } : undefined} scrollWheelZoom={false}>
      <TileLayer attribution="&copy; OpenStreetMap contributors" url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" className="dark-tiles" />
      <Fit points={fitPoints.length ? fitPoints : [MANGALORE]} />
      {hospitals.map((h) => (
        <CircleMarker key={h.id} center={[h.lat, h.lng]} radius={9} pathOptions={{ color: h.diverted ? '#8d95a8' : '#2ecc8f', fillColor: h.diverted ? '#8d95a8' : '#2ecc8f', fillOpacity: 0.85, weight: 2 }}>
          <Tooltip>{h.name} · {h.diverted ? 'DIVERTED' : `${h.emergencyBeds} beds`}</Tooltip>
        </CircleMarker>
      ))}
      {ambulances.map((a) => (
        <CircleMarker key={a.id} center={[a.lat, a.lng]} radius={6} pathOptions={{ color: '#4da3ff', fillColor: '#4da3ff', fillOpacity: a.available ? 0.9 : 0.35, weight: 2 }}>
          <Tooltip>{a.callSign} · {a.available ? 'available' : 'busy'}</Tooltip>
        </CircleMarker>
      ))}
      {active.map((i) => {
        const h = hospitals.find((x) => x.id === i.hospitalId)
        return (
          <span key={i.id}>
            {h && i.ambulancePos && <Polyline positions={[[i.ambulancePos.lat, i.ambulancePos.lng], [i.status === 'dispatched' ? i.lat : h.lat, i.status === 'dispatched' ? i.lng : h.lng]]} pathOptions={{ color: '#ffb020', dashArray: '6 8', weight: 2 }} />}
            <CircleMarker center={[i.lat, i.lng]} radius={11} pathOptions={{ color: '#ff4d4f', fillColor: '#ff4d4f', fillOpacity: 0.55, weight: 3 }}>
              <Tooltip permanent={false}>{i.type} · severity {i.severity}</Tooltip>
            </CircleMarker>
            {i.ambulancePos && (
              <CircleMarker center={[i.ambulancePos.lat, i.ambulancePos.lng]} radius={8} pathOptions={{ color: '#ffffff', fillColor: '#4da3ff', fillOpacity: 1, weight: 3 }}>
                <Tooltip>Ambulance</Tooltip>
              </CircleMarker>
            )}
          </span>
        )
      })}
    </MapContainer>
  )
}
