import { useState } from 'react'
import { ErrorBox } from '../components/bits'
import { friendlyAuthError, useAuth } from '../lib/auth'

export default function Landing({ onReport }: { onReport: () => void }) {
  const { signInStaff } = useAuth()
  const [staff, setStaff] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try { await signInStaff(email, password) } catch (err) { setError(friendlyAuthError(err)) } finally { setBusy(false) }
  }

  return (
    <div className="landing">
      <section className="hero">
        <p className="eyebrow">Emergency coordination · demo</p>
        <h1>The first hour decides.<br />Get the right hospital ready <em>before</em> the ambulance arrives.</h1>
        <p className="lede">GoldenHour asks the five nearest capable hospitals to confirm resources while the crew is still driving to the scene, then lets a dispatcher confirm the destination.</p>
        <div className="row">
          <button className="btn primary big" onClick={onReport}>🚨 Report an emergency</button>
          <button className="btn big" onClick={() => setStaff((s) => !s)} aria-expanded={staff}>Staff sign in</button>
        </div>
        <p className="sub" style={{ marginTop: 12 }}>In a real emergency in India, call <b>112</b>. This is a demonstration system and is not for real dispatch.</p>
      </section>

      {staff && (
        <form className="card stack signin" onSubmit={submit} aria-label="Staff sign in">
          <div>
            <h2 className="h">Staff sign in</h2>
            <p className="sub">Dispatchers, hospital teams and ambulance crews. Accounts are issued by an administrator; there is no self-registration.</p>
          </div>
          {error && <ErrorBox>{error}</ErrorBox>}
          <label>Email<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      )}

      <section className="features" aria-label="How it works">
        {[
          ['📨', 'Parallel requests', 'Five nearest eligible hospitals are asked at the moment of dispatch.'],
          ['✅', 'Explicit confirmation', 'Hospitals confirm the live resources for this case, never a static profile.'],
          ['🧭', 'Explainable choice', 'Dispatch sees why a hospital is recommended and can override with a reason.'],
          ['🔔', 'Automatic escalation', 'Declines and silence trigger the next wave, or a clear human escalation.'],
        ].map(([icon, title, text]) => (
          <div key={title} className="card feature"><div className="feature-icon" aria-hidden>{icon}</div><b>{title}</b><p className="sub">{text}</p></div>
        ))}
      </section>
    </div>
  )
}
