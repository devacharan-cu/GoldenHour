import { initializeApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { clearIndexedDbPersistence, connectFirestoreEmulator, initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager, terminate } from 'firebase/firestore'

// VITE_USE_EMULATORS=1 points the app at local emulators (used by the browser tests). Never set in production builds.
export const USE_EMULATORS = import.meta.env.VITE_USE_EMULATORS === '1'

// Public web-client identifiers, not secrets. Access control is enforced by firestore.rules.
const app = initializeApp(
  USE_EMULATORS
    ? { apiKey: 'demo-key', authDomain: 'localhost', projectId: 'demo-goldenhour', appId: 'demo-app' }
    : {
        apiKey: 'AIzaSyDU_4LEHP7R120mxs79fHrii1XL_UhAy3Y',
        authDomain: 'goldenhour-46131.firebaseapp.com',
        projectId: 'goldenhour-46131',
        storageBucket: 'goldenhour-46131.firebasestorage.app',
        messagingSenderId: '647769322176',
        appId: '1:647769322176:web:b2bd320a054e45041fb325',
      },
)

// App Check proves requests come from this genuine app (reCAPTCHA Enterprise, registered for goldenhour-46131.web.app).
// It is what lets the AI endpoint refuse scripts and other sites. The site key is public by design; the secret never leaves Google.
// Disabled for local emulators, where there is nothing to protect.
const APP_CHECK_SITE_KEY = '6LeUK_MtAAAAAGD_Kxti1DCP7-WY6AQJcQk2t1E8'
if (!USE_EMULATORS && typeof window !== 'undefined') {
  try { initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(APP_CHECK_SITE_KEY), isTokenAutoRefreshEnabled: true }) } catch (e) { console.warn('App Check could not start:', (e as Error).message) }
}

// Offline-capable: reads come from the local cache and writes queue until the connection returns.
export const db = initializeFirestore(app, {
  localCache: USE_EMULATORS ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})
export const auth = getAuth(app)

if (USE_EMULATORS) {
  connectFirestoreEmulator(db, '127.0.0.1', 8181)
  connectAuthEmulator(auth, 'http://127.0.0.1:9199', { disableWarnings: true })
}

export { app }

/**
 * Remove everything this browser holds about the signed-in person: Firestore's offline cache (cases, evidence, offers),
 * queued uploads, saved receipts and per-user flags. Run on sign-out so the next person on the device sees nothing.
 * Theme and text size are kept: they are display preferences, not case data.
 */
export async function wipeLocalData(): Promise<void> {
  try { await terminate(db) } catch { /* already stopped */ }
  try { await clearIndexedDbPersistence(db) } catch { /* memory cache (emulators) or another tab still holds it */ }
  try { indexedDB.deleteDatabase('gh-uploads') } catch { /* unavailable */ }
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('gh-') && k !== 'gh-settings' && k !== 'gh-install-dismissed') localStorage.removeItem(k)
    sessionStorage.clear()
  } catch { /* storage unavailable */ }
}
