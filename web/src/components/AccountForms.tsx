import { useState } from 'react'
import { friendlyAuthError, useAuth } from '../lib/auth'
import { ErrorBox } from './ui'

export function GoogleMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z" />
      <path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.9 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  )
}

export function GoogleButton({ label = 'Continue with Google', onDone }: { label?: string; onDone?: () => void }) {
  const { signInGoogle } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="stack-sm">
      <button type="button" className="btn btn-lg google-btn" disabled={busy} onClick={async () => {
        setBusy(true)
        setError(null)
        try { await signInGoogle(); onDone?.() } catch (e) { setError(friendlyAuthError(e)) } finally { setBusy(false) }
      }}>{busy ? <span className="spin" /> : <GoogleMark />} {label}</button>
      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  )
}

/** Email and password sign-up. For a guest this upgrades the same identity, so existing reports and receipts stay theirs. */
export function CreateAccountForm({ guest, onDone }: { guest: boolean; onDone?: () => void }) {
  const { createAccount } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const weak = password.length > 0 && password.length < 8
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (weak) return
    setBusy(true)
    setError(null)
    try { await createAccount(email, password); onDone?.() } catch (err) { setError(friendlyAuthError(err)) } finally { setBusy(false) }
  }
  return (
    <form className="stack" onSubmit={submit} aria-label="Create an account">
      {guest && <p className="sub measure">Your current reports and receipts move into the new account, and you can open them on any device.</p>}
      {error && <ErrorBox>{error}</ErrorBox>}
      <label className="field"><span className="field-label">Email</span>
        <input id="signup-email" type="email" name="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <div className="field">
        <label className="field-label" htmlFor="signup-password">Choose a password</label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input id="signup-password" type={show ? 'text' : 'password'} name="new-password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={weak} />
          <button type="button" className="btn btn-sm" onClick={() => setShow((s) => !s)} aria-pressed={show} aria-label={show ? 'Hide password' : 'Show password'}>{show ? 'Hide' : 'Show'}</button>
        </div>
        <span className={weak ? 'error-text' : 'hint'}>At least 8 characters.</span>
      </div>
      <button className="btn btn-ink btn-lg" disabled={busy || weak || !email || !password}>{busy ? <><span className="spin" /> Creating</> : 'Create account'}</button>
    </form>
  )
}
