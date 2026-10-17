import { useEffect, useState } from 'react'
import { seedIfEmpty, useAmbulances, useHospitals, useIncidents } from './lib/store'
import AmbulanceView from './views/AmbulanceView'
import Dispatch from './views/Dispatch'
import HospitalView from './views/HospitalView'
import Report from './views/Report'

type Tab = 'report' | 'dispatch' | 'hospital' | 'ambulance'
const TABS: { id: Tab; icon: string; label: string }[] = [
  { id: 'report', icon: '🚨', label: 'Report' },
  { id: 'dispatch', icon: '🎛️', label: 'Dispatch' },
  { id: 'ambulance', icon: '🚑', label: 'Ambulance' },
  { id: 'hospital', icon: '🏥', label: 'Hospital' },
]

function load(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function save(key: string, v: string | null) {
  try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key) } catch { /* storage unavailable */ }
}

export default function App() {
  const [tab, setTab] = useState<Tab>((load('gh-tab') as Tab) || 'report')
  const [myId, setMyIdState] = useState<string | null>(load('gh-my'))
  const [toast, setToast] = useState<string | null>(null)
  const inc = useIncidents()
  const hos = useHospitals()
  const amb = useAmbulances()
  const error = inc.error || hos.error || amb.error

  useEffect(() => { save('gh-tab', tab) }, [tab])
  useEffect(() => {
    if (hos.ready && hos.data.length === 0) seedIfEmpty().catch((e) => setToast(`Seeding failed: ${e.message}`))
  }, [hos.ready, hos.data.length])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const setMyId = (id: string | null) => { setMyIdState(id); save('gh-my', id) }
  const shared = { incidents: inc.data, hospitals: hos.data, ambulances: amb.data, notify: setToast }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden>⏱</div>
          <div>GoldenHour<small>Every minute counts · emergency coordination</small></div>
        </div>
        <div className="live"><span className={`dot ${error ? 'off' : ''}`} />{error ? 'Offline' : 'Live'}</div>
      </header>
      <nav className="tabs" role="tablist" aria-label="Role">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
            <span aria-hidden>{t.icon}</span>{t.label}
          </button>
        ))}
      </nav>
      {error && <div className="err">Cannot reach the database: {error}</div>}
      {toast && <div className="toast" role="status">{toast}</div>}
      <main>
        {tab === 'report' && <Report {...shared} myId={myId} setMyId={setMyId} />}
        {tab === 'dispatch' && <Dispatch {...shared} />}
        {tab === 'ambulance' && <AmbulanceView {...shared} />}
        {tab === 'hospital' && <HospitalView {...shared} />}
      </main>
    </div>
  )
}
