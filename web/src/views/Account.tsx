import { useEffect, useState } from 'react'
import { CreateAccountForm, GoogleButton } from '../components/AccountForms'
import { Icon, Notice, Panel, Pill, Switch, useInstall, type Notify } from '../components/ui'
import { askNotificationPermission, chime, notificationState } from '../lib/alerts'
import { friendlyAuthError, useAuth } from '../lib/auth'
import { useSettings, type TextSize, type ThemePref } from '../lib/settings'
import { useOnline } from '../lib/store'
import type { Ambulance, Hospital } from '../lib/types'

const ROLE_NAME = { dispatcher: 'Dispatcher', hospital: 'Hospital team', ambulance: 'Ambulance crew' } as const
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Unknown')

function ChangePassword({ notify }: { notify: Notify }) {
  const { changePassword } = useAuth()
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = next && next.length < 8 ? 'Use at least 8 characters.' : again && again !== next ? 'The two new passwords do not match.' : null
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (problem || !cur || !next) return
    setBusy(true)
    setError(null)
    try { await changePassword(cur, next); setCur(''); setNext(''); setAgain(''); notify('Password changed.', 'good') } catch (err) { setError(friendlyAuthError(err)) } finally { setBusy(false) }
  }
  return (
    <form className="stack" onSubmit={submit} aria-label="Change password">
      {error && <p className="error-text" role="alert">{error}</p>}
      <label className="field"><span className="field-label">Current password</span><input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
      <label className="field"><span className="field-label">New password</span><input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required aria-invalid={!!problem && !!next} /></label>
      <label className="field"><span className="field-label">New password again</span><input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required aria-invalid={!!again && again !== next} /></label>
      {problem && <p className="error-text">{problem}</p>}
      <button className="btn btn-ink" disabled={busy || !!problem || !cur || !next || !again}>{busy ? <><span className="spin" /> Changing</> : 'Change password'}</button>
    </form>
  )
}

export default function Account({ hospitals, ambulances, notify }: { hospitals: Hospital[]; ambulances: Ambulance[]; notify: Notify }) {
  const { profile, account, user, roleState, logout } = useAuth()
  const { settings, set, reset } = useSettings()
  const install = useInstall()
  const online = useOnline()
  const [perm, setPerm] = useState(notificationState())
  const [usage, setUsage] = useState<string | null>(null)
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [busy, setBusy] = useState(false)
  const staff = !!profile
  const linked = profile?.hospitalId ? hospitals.find((h) => h.id === profile.hospitalId)?.name ?? profile.hospitalId : profile?.ambulanceId ? ambulances.find((a) => a.id === profile.ambulanceId)?.callSign ?? profile.ambulanceId : null
  const name = profile?.displayName ?? (roleState === 'guest' ? 'Guest' : account?.email ?? 'Signed in')
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || 'G'

  useEffect(() => {
    void navigator.storage?.estimate?.().then((e) => { if (e.usage !== undefined) setUsage(`${(e.usage / 1024 / 1024).toFixed(1)} MB used by GoldenHour on this device`) }).catch(() => undefined)
  }, [])

  return (
    <div className="stack-lg page--narrow" style={{ width: '100%', margin: '0 auto' }}>
      <h1 className="title">Account and settings</h1>

      <Panel title="Profile">
        <div className="profile-head">
          <div className="profile-badge" aria-hidden>{initials}</div>
          <div className="stack-sm"><p className="h">{name}</p><div className="row row-tight">{staff ? <Pill tone="star">{ROLE_NAME[profile!.role]}</Pill> : <Pill>{roleState === 'guest' ? 'Guest session' : 'Reporter account'}</Pill>}{linked && <Pill>{linked}</Pill>}</div></div>
        </div>
        <dl className="facts">
          <div><dt>Sign-in</dt><dd>{account?.provider === 'password' ? 'Email and password' : account?.provider === 'anonymous' ? 'Guest, no account' : 'Not signed in'}</dd></div>
          {account?.email && <div><dt>Email</dt><dd>{account.email}</dd></div>}
          <div><dt>Last sign-in</dt><dd>{when(account?.lastSignIn ?? null)}</dd></div>
          <div><dt>Account created</dt><dd>{when(account?.created ?? null)}</dd></div>
          {user && <div><dt>Account ID</dt><dd className="num">{user.uid.slice(0, 8)}</dd></div>}
          <div><dt>Session</dt><dd>Restored automatically on this device until you sign out</dd></div>
        </dl>
        {roleState === 'norole' && <Notice tone="go" title="Reporter account">Your reports are saved to this account and open on any device you sign in on. Dispatch, crew and hospital screens need a staff role, which only an administrator can assign.</Notice>}
        {staff && <p className="fine">Your role, hospital and unit are set by an administrator. They cannot be changed from here, which is what keeps one role from acting as another.</p>}
      </Panel>

      {roleState === 'guest' && (
        <Panel title="Create an account">
          <p className="sub measure">Guest reporting keeps working without one. An account keeps your reports on every device you sign in on, instead of only this browser. Everything you have reported so far moves into it.</p>
          <GoogleButton label="Continue with Google" />
          <div className="divider"><span>or use an email</span></div>
          <CreateAccountForm guest onDone={() => notify('Account created. Your reports are now saved to it.', 'good')} />
        </Panel>
      )}

      <Panel title="Appearance">
        <div className="settings-row"><span className="field-label">Colour theme</span>
          <div className="theme-cards" role="group" aria-label="Colour theme">
            {([['system', 'Match my device', 'system'], ['light', 'Light', 'light'], ['dark', 'Dark', 'dark']] as [ThemePref, string, string][]).map(([v, label, cls]) => (
              <button key={v} type="button" className="theme-card" aria-pressed={settings.theme === v} onClick={() => set({ theme: v })}><span className={`theme-swatch ${cls}`}><i /></span><span className="strong">{label}</span></button>
            ))}
          </div>
          <p className="hint">Dark is easier in a dim control room. Light is easier in sunlight.</p>
        </div>
        <div className="settings-row"><span className="field-label">Text size</span>
          <div className="seg seg-full" role="group" aria-label="Text size">{([['normal', 'Normal'], ['large', 'Large'], ['xlarge', 'Extra large']] as [TextSize, string][]).map(([v, l]) => <button key={v} type="button" aria-pressed={settings.textSize === v} onClick={() => set({ textSize: v })}>{l}</button>)}</div>
        </div>
        {staff && <div className="settings-row"><Switch checked={settings.compact} onChange={(v) => set({ compact: v })} label="Compact lists" hint="Fit more cases on screen. Best for dispatchers watching many cases." /></div>}
        <div className="settings-row"><Switch checked={settings.reduceMotion === 'on'} onChange={(v) => set({ reduceMotion: v ? 'on' : 'system' })} label="Calm motion" hint="Turn off sliding and blinking. This already follows your device setting unless you turn it on here." /></div>
        <p className="fine">{staff ? 'These settings follow you to any device you sign in on.' : 'These settings stay on this device.'}</p>
      </Panel>

      {staff && (
        <Panel title="Alerts for new work">
          <div className="settings-row"><Switch checked={settings.sound} onChange={(v) => { set({ sound: v }); if (v) chime() }} label="Play a sound" hint={profile!.role === 'dispatcher' ? 'For new reports and cases that need attention.' : profile!.role === 'ambulance' ? 'For a new dispatch offer.' : 'For a new request to confirm resources.'} />
            <div><button className="btn btn-sm" onClick={() => chime()}>Play a test sound</button></div></div>
          <div className="settings-row"><Switch checked={settings.desktopAlerts && perm === 'granted'} disabled={perm === 'unsupported' || perm === 'denied'} onChange={async (v) => {
            if (!v) return set({ desktopAlerts: false })
            const p = perm === 'granted' ? 'granted' : await askNotificationPermission()
            setPerm(p)
            set({ desktopAlerts: p === 'granted' })
            if (p !== 'granted') notify('Notifications are blocked. Allow them for this site in your browser settings.', 'warn')
          }} label="Show a desktop notification" hint={perm === 'unsupported' ? 'This browser does not support notifications.' : perm === 'denied' ? 'Blocked in this browser. Change it in the site settings (the lock icon in the address bar).' : 'Only while this tab is in the background.'} /></div>
          <p className="fine">Browsers only play sounds after you have clicked or tapped the page once.</p>
        </Panel>
      )}

      {user && !user.isAnonymous && account?.provider === 'password' && (
        <Panel title="Password"><ChangePassword notify={notify} />
          <p className="fine">Forgot it? Sign out and use &ldquo;Forgot your password?&rdquo; on the sign-in page, or ask your administrator.</p></Panel>
      )}

      <Panel title="This device">
        <div className="row"><Pill tone={online ? 'go' : 'wait'}>{online ? 'Online' : 'Offline'}</Pill>{usage && <span className="sub">{usage}</span>}</div>
        {!install.standalone && (install.available ? <div className="row"><button className="btn btn-ink" onClick={() => void install.install()}><Icon name="device" size={18} /> Install GoldenHour</button><span className="sub">Opens like an app and keeps working with a weak connection.</span></div>
          : <p className="sub measure">{install.ios ? 'To install on iPhone, tap Share, then Add to Home Screen.' : 'To install, use your browser menu (Install app) or the install icon in the address bar.'}</p>)}
        {install.standalone && <Pill tone="go">Installed as an app</Pill>}
        <div className="stack-sm"><p className="sub measure">Cases, files and receipts are cached on this device so GoldenHour works offline. Signing out, or the button below, removes them. Do this on a shared computer.</p>
          {confirmWipe ? <div className="row"><button className="btn btn-danger" disabled={busy} onClick={() => { setBusy(true); void logout() }}>Sign out and erase this device</button><button className="btn" onClick={() => setConfirmWipe(false)}>Keep it</button></div>
            : <button className="btn btn-danger btn-sm" style={{ justifySelf: 'start' }} onClick={() => setConfirmWipe(true)}>Erase data on this device</button>}</div>
      </Panel>

      <Panel title="About this demonstration" quiet>
        <p className="sub measure">GoldenHour is a demonstration of emergency coordination. It is not validated for real dispatch. In a real emergency in India, call 112. Hospital names are real institutions used for realism, but their capabilities and availability here are invented. Use synthetic data only.</p>
        <div className="row"><button className="btn btn-sm" onClick={reset}>Reset appearance to default</button></div>
      </Panel>

      {user && (
        <div className="row">
          <button className="btn btn-ink btn-lg" disabled={busy} onClick={() => { setBusy(true); void logout() }}><Icon name="logout" /> Sign out</button>
          <span className="fine">Signing out removes cached cases, files and receipts from this device.</span>
        </div>
      )}
    </div>
  )
}
