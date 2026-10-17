/* oxlint-disable react/only-export-components -- hooks and small helpers intentionally live beside their components */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  createUserWithEmailAndPassword, EmailAuthProvider, GoogleAuthProvider, linkWithCredential, linkWithPopup, onIdTokenChanged, reauthenticateWithCredential, sendPasswordResetEmail,
  signInAnonymously, signInWithEmailAndPassword, signInWithPopup, signOut, updatePassword, type User,
} from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'
import { auth, db, wipeLocalData } from './firebase'
import type { UserProfile } from './types'
import type { Actor } from './workflow'

/**
 * What we know about the role of the signed-in person.
 *  guest    anonymous reporter session
 *  loading  signed in with email, role document not read yet
 *  staff    role document found and active
 *  norole   signed in with email, but no active role document: they can report like a guest and see nothing else
 */
export type RoleState = 'signed-out' | 'guest' | 'loading' | 'staff' | 'norole'

export interface AccountInfo { email: string | null; lastSignIn: string | null; created: string | null; provider: 'password' | 'google' | 'anonymous' | 'other' }

interface AuthState {
  status: 'loading' | 'out' | 'in'
  roleState: RoleState
  user: User | null
  profile: UserProfile | null
  actor: Actor | null
  account: AccountInfo | null
  signInStaff: (email: string, password: string) => Promise<void>
  ensureReporter: () => Promise<Actor>
  /** Sign out and wipe the offline cache, queued uploads and saved receipts from this browser. */
  logout: () => Promise<void>
  sendReset: (email: string) => Promise<void>
  /** Create an email account. A guest keeps its reports: the same identity is upgraded instead of replaced. */
  createAccount: (email: string, password: string) => Promise<void>
  /** Sign in with Google. A guest is upgraded in place when possible so existing reports stay theirs. */
  signInGoogle: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function friendlyAuthError(e: unknown): string {
  const code = (e as { code?: string }).code ?? ''
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found') || code.includes('invalid-email')) return 'Email or password is incorrect.'
  if (code.includes('weak-password')) return 'Choose a password with at least 8 characters.'
  if (code.includes('email-already-in-use')) return 'An account with this email already exists. Sign in instead, or use a different email.'
  if (code.includes('credential-already-in-use')) return 'That account already exists. Sign in with it instead. Your current reports stay available by receipt code.'
  if (code.includes('popup-closed') || code.includes('cancelled-popup')) return 'The Google window was closed before sign-in finished.'
  if (code.includes('popup-blocked')) return 'Your browser blocked the Google window. Allow pop-ups for this site and try again.'
  if (code.includes('unauthorized-domain')) return 'Google sign-in is not allowed on this address.'
  if (code.includes('account-exists-with-different-credential')) return 'This email already has an account with a different sign-in method.'
  if (code.includes('requires-recent-login')) return 'For safety, sign out and back in, then try again.'
  if (code.includes('too-many-requests')) return 'Too many attempts. Wait a minute and try again.'
  if (code.includes('network')) return 'No connection. Check your network and retry.'
  if (code.includes('operation-not-allowed') || code.includes('admin-restricted')) return 'This sign-in method is not enabled for the project yet.'
  if (code.includes('user-disabled')) return 'This account has been disabled. Contact your administrator.'
  return (e as Error).message || 'Something went wrong.'
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [profileDoc, setProfile] = useState<{ uid: string; profile: UserProfile | null } | null>(null)
  // Linking a guest to an email or Google account keeps the same User object, so a counter makes the screens notice the change.
  const [version, setVersion] = useState(0)

  useEffect(() => onIdTokenChanged(auth, (u) => { setUser(u); setReady(true); setVersion((v) => v + 1) }), [])

  useEffect(() => {
    if (!user || user.isAnonymous) return
    return onSnapshot(
      doc(db, 'users', user.uid),
      (s) => setProfile({ uid: user.uid, profile: s.exists() && (s.data() as UserProfile).active ? (s.data() as UserProfile) : null }),
      () => setProfile({ uid: user.uid, profile: null }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.uid, user?.isAnonymous])

  const value = useMemo<AuthState>(() => {
    // A role is only trusted when it was loaded for THIS user, so it can never carry over between sign-ins.
    const loaded = user && !user.isAnonymous && profileDoc?.uid === user.uid ? profileDoc : null
    const profile = loaded?.profile ?? null
    const roleState: RoleState = !ready || !user ? 'signed-out' : user.isAnonymous ? 'guest' : !loaded ? 'loading' : profile ? 'staff' : 'norole'
    const actor: Actor | null = user ? { uid: user.uid, role: profile?.role ?? 'reporter' } : null
    const account: AccountInfo | null = user ? {
      email: user.email, lastSignIn: user.metadata.lastSignInTime ?? null, created: user.metadata.creationTime ?? null,
      provider: user.isAnonymous ? 'anonymous' : user.providerData[0]?.providerId === 'password' ? 'password' : user.providerData[0]?.providerId === 'google.com' ? 'google' : 'other',
    } : null
    return {
      status: !ready ? 'loading' : user ? 'in' : 'out',
      roleState, user, profile, actor, account,
      signInStaff: async (email, password) => { await signInWithEmailAndPassword(auth, email.trim(), password) },
      ensureReporter: async () => {
        const u = auth.currentUser ?? (await signInAnonymously(auth)).user
        return { uid: u.uid, role: profile?.role ?? ('reporter' as const) }
      },
      logout: async () => {
        await signOut(auth)
        await wipeLocalData()
        window.location.assign('/')
      },
      sendReset: async (email) => { await sendPasswordResetEmail(auth, email.trim()) },
      createAccount: async (email, password) => {
        const cur = auth.currentUser
        if (cur?.isAnonymous) await linkWithCredential(cur, EmailAuthProvider.credential(email.trim(), password))
        else await createUserWithEmailAndPassword(auth, email.trim(), password)
      },
      signInGoogle: async () => {
        const provider = new GoogleAuthProvider()
        provider.setCustomParameters({ prompt: 'select_account' })
        const cur = auth.currentUser
        if (cur?.isAnonymous) {
          try { await linkWithPopup(cur, provider); return } catch (e) {
            // the Google account already exists: sign in to it (the guest's reports remain reachable by receipt code)
            if ((e as { code?: string }).code !== 'auth/credential-already-in-use') throw e
          }
        }
        await signInWithPopup(auth, provider)
      },
      changePassword: async (current, next) => {
        const u = auth.currentUser
        if (!u?.email) throw Object.assign(new Error('Only email accounts have a password.'), { code: 'none' })
        await reauthenticateWithCredential(u, EmailAuthProvider.credential(u.email, current))
        await updatePassword(u, next)
      },
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `version` forces a refresh when a guest is upgraded in place (same User object)
  }, [ready, user, profileDoc, version])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth outside AuthProvider')
  return v
}
