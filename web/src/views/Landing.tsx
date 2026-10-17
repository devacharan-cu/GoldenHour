import { useRef, useState } from 'react'
import { ErrorBox, Icon, InstallHint, Notice, Panel, RelayTrack } from '../components/ui'
import { CreateAccountForm, GoogleButton } from '../components/AccountForms'
import { friendlyAuthError, useAuth } from '../lib/auth'
import { parseReceipt } from '../lib/crypto'

function SignIn() {
  const { signInStaff, sendReset } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forgot, setForgot] = useState(false)
  const [creating, setCreating] = useState(false)
  const { roleState } = useAuth()
  const [resetNote, setResetNote] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try { await signInStaff(email, password) } catch (err) { setError(friendlyAuthError(err)); setBusy(false) }
  }

  async function reset(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await sendReset(email)
      setResetNote('If that address has an account, a reset link is on its way. Accounts issued for this demonstration use addresses that cannot receive email, so ask your administrator to reset the password instead.')
    } catch (err) { setError(friendlyAuthError(err)) } finally { setBusy(false) }
  }

  return (
    <Panel title={forgot ? 'Reset your password' : creating ? 'Create an account' : 'Sign in'}>
      {!creating && <p className="sub measure">Dispatchers, ambulance crews and hospital teams sign in here with the account an administrator gave them. Anyone else can report as a guest, or sign in to keep their reports across devices.</p>}
      {error && <ErrorBox>{error}</ErrorBox>}
      {resetNote && <Notice tone="go" title="Check your inbox">{resetNote}</Notice>}
      {creating ? (
        <>
          <CreateAccountForm guest={roleState === 'guest'} />
          <div className="divider"><span>or</span></div>
          <GoogleButton label="Sign up with Google" />
          <button type="button" className="btn btn-quiet" onClick={() => setCreating(false)}>I already have an account</button>
        </>
      ) : !forgot ? (
        <form className="stack" onSubmit={submit} aria-label="Sign in">
          <label className="field"><span className="field-label">Email</span>
            <input id="signin-email" type="email" name="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!error} />
          </label>
          <div className="field">
            <label className="field-label" htmlFor="signin-password">Password</label>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input id="signin-password" type={show ? 'text' : 'password'} name="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error} />
              <button type="button" className="btn btn-sm" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'Hide' : 'Show'}</button>
            </div>
          </div>
          <button className="btn btn-ink btn-lg" disabled={busy}>{busy ? <><span className="spin" /> Signing in</> : 'Sign in'}</button>
          <div className="divider"><span>or</span></div>
          <GoogleButton />
          <div className="row row-between">
            <button type="button" className="btn btn-quiet" onClick={() => { setForgot(true); setError(null) }}>Forgot your password?</button>
            <button type="button" className="btn btn-quiet" onClick={() => { setCreating(true); setError(null) }}>Create an account</button>
          </div>
        </form>
      ) : (
        <form className="stack" onSubmit={reset} aria-label="Reset password">
          <label className="field"><span className="field-label">Account email</span><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
          <button className="btn btn-ink" disabled={busy || !!resetNote}>{busy ? <><span className="spin" /> Sending</> : 'Email me a reset link'}</button>
          <button type="button" className="btn btn-quiet" onClick={() => { setForgot(false); setResetNote(null); setError(null) }}>Back to sign in</button>
        </form>
      )}
    </Panel>
  )
}

function ReopenReport({ onOpen }: { onOpen: (code: string) => void }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <Panel title="Reopen a report" quiet>
      <p className="sub measure">Lost the page or switching device? Paste the receipt code or link you were given when you sent the report. The code proves the report is yours; an ID alone opens nothing.</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!parseReceipt(code)) setError('That does not look like a receipt code. It is the long code shown after you sent the report.'); else { setError(null); onOpen(code) } }}>
        <label className="field"><span className="field-label">Receipt code or link</span><input type="text" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={!!error} /></label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="btn" disabled={!code.trim()}>Open my report</button>
      </form>
    </Panel>
  )
}

export default function Landing({ onReport, onOpenReceipt, hasOpenReports, onMine }: { onReport: () => void; onOpenReceipt: (code: string) => void; hasOpenReports: boolean; onMine: () => void }) {
  const signInRef = useRef<HTMLDivElement>(null)
  return (
    <div className="stack-lg">
      <div className="landing-hero">
        <div className="stack-lg">
          <div className="stack">
            <h1 className="display">Get the right hospital ready before the ambulance arrives.</h1>
            <p className="lede">Report an emergency in about a minute. Dispatch sends a crew. While the crew is still driving, the nearest hospitals that can treat this patient confirm their resources, and one is chosen.</p>
          </div>
          <div className="row">
            <button className="btn btn-go btn-lg" onClick={onReport}><Icon name="alert" /> Report an emergency</button>
            <button className="btn btn-lg" onClick={() => { signInRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); document.getElementById('signin-email')?.focus() }}>Sign in or sign up</button>
            {hasOpenReports && <button className="btn btn-lg btn-quiet" onClick={onMine}>Your reports</button>}
          </div>
          <p className="fine measure">In a real emergency in India, call 112. This is a demonstration system and is not used for real dispatch.</p>
        </div>
        <div ref={signInRef}><SignIn /></div>
      </div>

      <section className="stack" aria-labelledby="how">
        <h2 className="title" id="how">Every case is a hand-off.</h2>
        <p className="lede">Each screen shows who holds the case right now. Whoever must act sees &ldquo;Your move&rdquo;, and everyone else sees who they are waiting on.</p>
        <RelayTrack c={null} viewer="reporter" demo={{ holder: 'dispatcher', notes: { reporter: 'You describe it', dispatcher: 'Sends a crew', crew: 'Accepts and drives', hospital: 'Confirms it can treat' } }} />
        <div className="landing-steps">
          {[
            ['person', 'You', 'Say what happened, where, and add photos, a voice note or a document if you can.'],
            ['radio', 'Dispatcher', 'Reads the report and its evidence, then chooses one ambulance and sends it the case.'],
            ['ambulance', 'Crew', 'Accepts or declines. Once they accept, they head to the scene.'],
            ['hospital', 'Hospital', 'Confirms, for this patient, that the right team and resources are ready. Nothing is assumed from a profile.'],
          ].map(([icon, who, text]) => (
            <div key={who} className="stack-sm"><Icon name={icon as 'person'} size={28} /><h3 className="h-sm">{who}</h3><p className="sub">{text}</p></div>
          ))}
        </div>
      </section>

      <div className="cols-2"><ReopenReport onOpen={onOpenReceipt} /><InstallHint /></div>
    </div>
  )
}
