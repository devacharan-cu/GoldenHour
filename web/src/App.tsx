import { Suspense, lazy, useState } from 'react'
import { ConnectionBanner, ErrorBox, InstallPrompt, Loading, Toasts, useToasts } from './components/bits'
import { AuthProvider, useAuth } from './lib/auth'
import { useAmbulances, useCases, useEscalationEngine, useHospitals, useOffers, useOnline } from './lib/store'
import Landing from './views/Landing'

// Each role downloads only its own screen (and the map library) instead of the whole app.
const AmbulanceView = lazy(() => import('./views/Responder'))
const Dispatcher = lazy(() => import('./views/Dispatcher'))
const HospitalView = lazy(() => import('./views/HospitalView'))
const Reporter = lazy(() => import('./views/Reporter'))

function load(key: string): string | null { try { return localStorage.getItem(key) } catch { return null } }
function save(key: string, v: string | null) { try { if (v) localStorage.setItem(key, v); else localStorage.removeItem(key) } catch { /* storage unavailable */ } }

const ROLE_LABEL = { dispatcher: 'Dispatcher', hospital: 'Hospital team', ambulance: 'Ambulance crew' } as const

function Shell() {
  const { status, user, profile, actor, logout } = useAuth()
  const { messages, notify } = useToasts()
  const online = useOnline()
  const [reporting, setReporting] = useState(false)
  const [dispTab, setDispTab] = useState<'console' | 'log'>('console')
  const [myId, setMyIdState] = useState<string | null>(load('gh-my'))
  const setMyId = (id: string | null) => { setMyIdState(id); save('gh-my', id) }

  const staff = !!profile
  const cases = useCases(user?.uid ?? null, profile)
  const offers = useOffers(profile)
  const hospitals = useHospitals(staff)
  const ambulances = useAmbulances(staff)
  useEscalationEngine(profile?.role === 'dispatcher', actor, cases.data, offers.data, hospitals.data, (m) => notify(m))

  const error = cases.error || offers.error || hospitals.error || ambulances.error
  const pending = cases.fromCache && online === true && cases.ready

  let body
  if (status === 'loading') body = <Loading label="Starting…" />
  else if (status === 'out' && !reporting) body = <Landing onReport={() => setReporting(true)} />
  else if (!profile) {
    body = (
      <Reporter
        cases={cases.data} myId={myId} setMyId={setMyId} notify={notify} online={online}
      />
    )
  } else if (profile.role === 'dispatcher') {
    body = !hospitals.ready || !ambulances.ready || !cases.ready ? <Loading /> : dispTab === 'log'
      ? <Reporter cases={[]} myId={null} setMyId={() => undefined} notify={notify} online={online} onSent={() => setDispTab('console')} />
      : <Dispatcher cases={cases.data} offers={offers.data} hospitals={hospitals.data} ambulances={ambulances.data} actor={actor!} notify={notify} onLogCall={() => setDispTab('log')} />
  } else if (profile.role === 'hospital') {
    body = !hospitals.ready || !cases.ready ? <Loading /> : <HospitalView profile={profile} actor={actor!} hospital={hospitals.data.find((h) => h.id === profile.hospitalId)} cases={cases.data} offers={offers.data} notify={notify} />
  } else {
    body = !hospitals.ready || !ambulances.ready ? <Loading /> : <AmbulanceView actor={actor!} ambulance={ambulances.data.find((a) => a.id === profile.ambulanceId)} cases={cases.data} hospitals={hospitals.data} notify={notify} />
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="logo" aria-hidden>⏱</div>
          <div>GoldenHour<small>Every minute counts</small></div>
        </div>
        <div className="row tight">
          <span className="live" role="status"><span className={`dot ${error || !online ? 'off' : ''}`} />{!online ? 'Offline' : error ? 'Problem' : 'Live'}</span>
          {profile && <span className="chip-user">{ROLE_LABEL[profile.role]} · {profile.displayName}</span>}
          {profile?.role === 'dispatcher' && (
            <div className="seg-mini" role="tablist"><button role="tab" aria-selected={dispTab === 'console'} onClick={() => setDispTab('console')}>Console</button><button role="tab" aria-selected={dispTab === 'log'} onClick={() => setDispTab('log')}>Log call</button></div>
          )}
          {status === 'in' && <button className="btn sm" onClick={() => { void logout(); setReporting(false) }}>{profile ? 'Sign out' : 'Leave'}</button>}
          {status === 'out' && reporting && <button className="btn sm" onClick={() => setReporting(false)}>Back</button>}
        </div>
      </header>
      <ConnectionBanner pendingWrites={pending} />
      <InstallPrompt compact={!!profile} />
      {error && <ErrorBox retry={() => window.location.reload()}>Some live data could not load: {error}</ErrorBox>}
      <Toasts messages={messages} />
      <main id="main"><Suspense fallback={<Loading />}>{body}</Suspense></main>
      <footer className="foot">Demonstration system · not for real emergency dispatch · call 112 in India</footer>
    </div>
  )
}

export default function App() {
  return <AuthProvider><Shell /></AuthProvider>
}
