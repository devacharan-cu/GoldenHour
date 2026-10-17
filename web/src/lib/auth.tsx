/* oxlint-disable react/only-export-components -- hooks and small helpers intentionally live beside their components */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db } from './firebase'
import type { UserProfile } from './types'
import type { Actor } from './workflow'

interface AuthState {
  status: 'loading' | 'out' | 'in'
  user: User | null
  /** Role document from users/{uid}. null for reporters and for accounts nobody has provisioned. */
  profile: UserProfile | null
  actor: Actor | null
  signInStaff: (email: string, password: string) => Promise<void>
  ensureReporter: () => Promise<Actor>
  logout: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function friendlyAuthError(e: unknown): string {
  const code = (e as { code?: string }).code ?? ''
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found') || code.includes('invalid-email')) return 'Email or password is incorrect.'
  if (code.includes('too-many-requests')) return 'Too many attempts. Wait a minute and try again.'
  if (code.includes('network')) return 'No connection. Check your network and retry.'
  if (code.includes('operation-not-allowed') || code.includes('admin-restricted')) return 'This sign-in method is not enabled for the project yet.'
  return (e as Error).message || 'Sign-in failed.'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [profileDoc, setProfile] = useState<{ uid: string; profile: UserProfile | null } | null>(null)

  useEffect(() => onAuthStateChanged(auth, (u) => { setUser(u); setReady(true) }), [])

  useEffect(() => {
    if (!user || user.isAnonymous) return
    return onSnapshot(
      doc(db, 'users', user.uid),
      (s) => setProfile({ uid: user.uid, profile: s.exists() && (s.data() as UserProfile).active ? (s.data() as UserProfile) : null }),
      () => setProfile({ uid: user.uid, profile: null }),
    )
  }, [user])

  const value = useMemo<AuthState>(() => {
    // A role is only trusted when it was loaded for THIS user, so it can never carry over between sign-ins.
    const profile = user && !user.isAnonymous && profileDoc?.uid === user.uid ? profileDoc.profile : null
    const actor: Actor | null = user ? { uid: user.uid, role: profile?.role ?? 'reporter' } : null
    return {
      status: !ready ? 'loading' : user ? 'in' : 'out',
      user, profile, actor,
      signInStaff: async (email, password) => { await signInWithEmailAndPassword(auth, email.trim(), password) },
      ensureReporter: async () => {
        const u = auth.currentUser ?? (await signInAnonymously(auth)).user
        return { uid: u.uid, role: profile?.role ?? ('reporter' as const) }
      },
      logout: async () => { await signOut(auth) },
    }
  }, [ready, user, profileDoc])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
