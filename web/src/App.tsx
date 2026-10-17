import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from 'react'
import { ConnectionBanner, ErrorBox, Icon, Loading, Notice, Slips, useToasts, type IconName, type Notify } from './components/ui'
import { AuthProvider, useAuth } from './lib/auth'
import { useAttention } from './lib/attention'
import { SettingsProvider, useSettings } from './lib/settings'
import { useAmbulances, useCaseById, useCases, useEscalationEngine, useHospitals, useOffers, useOnline } from './lib/store'
import Landing from './views/Landing'

// Each role downloads only its own screens (and the map library) instead of the whole app.
const Dispatcher = lazy(() => import('./views/Dispatcher'))
const HospitalView = lazy(() => import('./views/HospitalView'))
const Responder = lazy(() => import('./views/Responder'))
const History = lazy(() => import('./views/History'))
const Account = lazy(() => import('./views/Account'))
const ReportFlow = lazy(() => import('./views/Reporter').then((m) => ({ default: m.ReportFlow })))
const ReportTracking = lazy(() => import('./views/Reporter').then((m) => ({ default: m.ReportTracking })))
const MyReports = lazy(() => import('./views/Reporter').then((m) => ({ default: m.MyReports })))
const OpenByReceipt = lazy(() => import('./views/Reporter').then((m) => ({ default: m.OpenByReceipt })))

// ---------------------------------------------------------------- tiny hash router (so receipt links and the back button work)

function useHash(): [string, (to: string) => void] {
  const read = () => window.location.hash.replace(/^#/, '') || '/'
  const [hash, setHash] = useState(read)
  useEffect(() => { const h = () => setHash(read()); window.addEventListener('hashchange', h); return () => window.removeEventListener('hashchange', h) }, [])
  return [hash, useCallback((to: string) => { window.location.hash = to }, [])]
}

const ROLE_LABEL = { dispatcher: 'Dispatcher', hospital: 'Hospital team', ambulance: 'Ambulance crew' } as const

interface NavItem { to: string; label: string; icon: IconName; match: (p: string) => boolean }

function GuestCase({ id, notify, onBack }: { id: string; notify: Notify; onBack: () => void }) {
  const { user } = useAuth()
  const mine = useCases(user?.uid ?? null, null)
  const own = mine.data.find((c) => c.id === id)
  const other = useCaseById(own ? null : id)
  const c = own ?? other.data
  if (!own && !other.ready) return <Loading label="Opening your report" />
  if (!c) return <div className="stack"><ErrorBox>That report is not available on this device. Use its receipt code to reopen it.</ErrorBox><button className="btn" onClick={onBack}>Back</button></div>
  return <ReportTracking c={c} notify={notify} onBack={onBack} />
}

function Shell() {
  const { status, roleState, user, profile, actor, logout } = useAuth()
  const { theme, set } = useSettings()
  const { messages, notify } = useToasts()
  const online = useOnline()
  const [hash, go] = useHash()
  const [menuAt, setMenuAt] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const staff = roleState === 'staff' && !!profile
  const cases = useCases(user?.uid ?? null, profile)
  const offers = useOffers(profile)
  const hospitals = useHospitals(staff)
  const ambulances = useAmbulances(staff)
  useEscalationEngine(profile?.role === 'dispatcher', actor, cases.data, offers.data, hospitals.data, (m) => notify(m))
  useAttention(profile, cases.data, offers.data, cases.ready && (profile?.role !== 'hospital' || offers.ready))

  const error = cases.error || offers.error || hospitals.error || ambulances.error
  const path = hash.split('?')[0]
  const seg = path.split('/').filter(Boolean)
  const menu = menuAt === path // the menu closes by itself whenever the page changes
  const setMenu = (open: boolean) => setMenuAt(open ? path : null)

  // Keep people on screens their role can use (for example right after signing in from a guest page)
  useEffect(() => {
    if (!staff) return
    if (['', 'report', 'mine', 'case', 'r'].includes(seg[0] ?? '')) go('/live')
  }, [staff, seg[0]]) // eslint-disable-line react-hooks/exhaustive-deps

  const nav: NavItem[] = !profile
    ? [{ to: '/report', label: 'Report', icon: 'alert', match: (p) => p.startsWith('/report') }, { to: '/mine', label: 'Your reports', icon: 'list', match: (p) => p.startsWith('/mine') || p.startsWith('/case') }]
    : profile.role === 'dispatcher'
      ? [{ to: '/live', label: 'Live', icon: 'radio', match: (p) => p.startsWith('/live') }, { to: '/history', label: 'History', icon: 'history', match: (p) => p.startsWith('/history') }, { to: '/log', label: 'Log a call', icon: 'phone', match: (p) => p.startsWith('/log') }]
      : [{ to: '/live', label: profile.role === 'ambulance' ? 'Mission' : 'Cases', icon: profile.role === 'ambulance' ? 'ambulance' : 'hospital', match: (p) => p.startsWith('/live') }, { to: '/history', label: 'History', icon: 'history', match: (p) => p.startsWith('/history') }]

  let body: ReactNode
  if (status === 'loading') body = <Loading label="Starting" />
  else if (roleState === 'loading') body = <Loading label="Signing you in" />
  else if (staff && profile && actor) {
    if (path.startsWith('/account')) body = <Account hospitals={hospitals.data} ambulances={ambulances.data} notify={notify} />
    else if (!hospitals.ready || !cases.ready || (profile.role !== 'ambulance' && profile.role !== 'hospital' ? !ambulances.ready : false)) body = <Loading />
    else if (path.startsWith('/history')) {
      body = <History profile={profile} uid={user!.uid} actor={actor} hospitals={hospitals.data} ambulances={ambulances.data} offers={offers.data} allCases={cases.data} notify={notify} openId={seg[1] ?? null} onOpen={(id) => go(id ? `/history/${id}` : '/history')} />
    } else if (profile.role === 'dispatcher') {
      body = path.startsWith('/log')
        ? <ReportFlow notify={notify} onSent={(id) => { setSelected(id); go('/live') }} onCreated={() => undefined} />
        : <Dispatcher cases={cases.data} offers={offers.data} hospitals={hospitals.data} ambulances={ambulances.data} actor={actor} notify={notify} selected={selected} onSelect={setSelected} />
    } else if (profile.role === 'hospital') {
      body = <HospitalView profile={profile} actor={actor} hospital={hospitals.data.find((h) => h.id === profile.hospitalId)} cases={cases.data} offers={offers.data} hospitals={hospitals.data} notify={notify} selected={selected} onSelect={setSelected} />
    } else {
      body = <Responder actor={actor} ambulance={ambulances.data.find((a) => a.id === profile.ambulanceId)} cases={cases.data} hospitals={hospitals.data} notify={notify} />
    }
  } else {
    // signed out, guest, or signed in without a staff role: everything a reporter can do
    const first = seg[0] ?? ''
    if (first === 'account') body = <Account hospitals={[]} ambulances={[]} notify={notify} />
    else if (first === 'report') body = <ReportFlow notify={notify} onCreated={(c) => go(`/case/${c.id}`)} />
    else if (first === 'mine') body = <MyReports cases={cases.data} onOpen={(id) => go(`/case/${id}`)} onNew={() => go('/report')} />
    else if (first === 'case' && seg[1]) body = <GuestCase id={seg[1]} notify={notify} onBack={() => go('/mine')} />
    else if (first === 'r' && seg[1]) body = <OpenByReceipt code={decodeURIComponent(path.slice(3))} notify={notify} onClose={() => go('/')} />
    else body = (
      <>
        {roleState === 'norole' && <div style={{ marginBottom: 20 }}><Notice tone="go" title={`Signed in as ${user?.email ?? 'your account'}`} actions={<button className="btn btn-sm" onClick={() => void logout()}>Sign out</button>}>Your reports are saved to this account. Dispatch, crew and hospital screens are only for staff accounts assigned by an administrator.</Notice></div>}
        <Landing onReport={() => go('/report')} onOpenReceipt={(code) => go(`/r/${code}`)} hasOpenReports={cases.data.length > 0} onMine={() => go('/mine')} />
      </>
    )
  }

  const initials = (profile?.displayName ?? (roleState === 'guest' ? 'Guest' : user?.email ?? '?')).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()

  return (
    <div className="app">
      <header className="rail">
        <div className="rail-inner">
          <button className="brand" onClick={() => go(staff ? '/live' : '/')} aria-label="GoldenHour home">
            <span className="brand-mark" aria-hidden><Icon name="clock" size={20} /></span><span className="brand-name">GoldenHour</span>
          </button>
          <nav className="rail-links" aria-label="Main">
            {nav.map((n) => <button key={n.to} className="rail-link" aria-current={n.match(path) ? 'page' : undefined} onClick={() => go(n.to)}>{n.label}</button>)}
          </nav>
          <div className="rail-spacer" />
          <span className={`conn ${!online || error ? 'off' : ''}`} role="status"><i />{!online ? 'Offline' : error ? 'Problem' : 'Live'}</span>
          <button className="btn btn-sm" onClick={() => set({ theme: theme === 'dark' ? 'light' : 'dark' })} aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'} title={theme === 'dark' ? 'Light theme' : 'Dark theme'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></button>
          {status === 'in' && (
            <div className="menu-wrap">
              <button className="avatar" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} aria-label="Account menu">{initials || '?'}</button>
              {menu && (
                <>
                  <div className="scrim" onClick={() => setMenu(false)} />
                  <div className="menu" role="menu">
                    <div className="menu-head"><b>{profile?.displayName ?? (roleState === 'guest' ? 'Guest' : user?.email)}</b><span className="fine">{profile ? ROLE_LABEL[profile.role] : roleState === 'guest' ? 'Not signed in with an account' : 'Reporter account'}</span></div>
                    <button role="menuitem" onClick={() => go('/account')}><Icon name="gear" size={18} /> Account and settings</button>
                    <button role="menuitem" onClick={() => void logout()}><Icon name="logout" size={18} /> {profile ? 'Sign out' : 'Leave and erase this device'}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </header>
      <ConnectionBanner pendingWrites={online && (cases.hasPendingWrites || offers.hasPendingWrites)} />
      {error && <div className="page" style={{ paddingBottom: 0, flex: 'none' }}><ErrorBox retry={() => window.location.reload()}>Some live data could not load: {error}</ErrorBox></div>}
      <main id="main" className="page"><Suspense fallback={<Loading />}>{body}</Suspense></main>
      <nav className="tabbar" aria-label="Main">
        {nav.map((n) => <button key={n.to} aria-current={n.match(path) ? 'page' : undefined} onClick={() => go(n.to)}><Icon name={n.icon} size={22} />{n.label}</button>)}
        <button aria-current={path.startsWith('/account') ? 'page' : undefined} onClick={() => go('/account')}><Icon name="gear" size={22} />Account</button>
      </nav>
      <Slips messages={messages} />
    </div>
  )
}

function Root() {
  const { user } = useAuth()
  return <SettingsProvider uid={user?.uid ?? null}><Shell /></SettingsProvider>
}

export default function App() {
  return <AuthProvider><Root /></AuthProvider>
}
