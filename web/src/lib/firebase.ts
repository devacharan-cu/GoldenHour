import { initializeApp } from 'firebase/app'
import { connectAuthEmulator, getAuth } from 'firebase/auth'
import { connectFirestoreEmulator, initializeFirestore, memoryLocalCache, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore'

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

// Offline-capable: reads come from the local cache and writes queue until the connection returns.
export const db = initializeFirestore(app, {
  localCache: USE_EMULATORS ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})
export const auth = getAuth(app)

if (USE_EMULATORS) {
  connectFirestoreEmulator(db, '127.0.0.1', 8181)
  connectAuthEmulator(auth, 'http://127.0.0.1:9199', { disableWarnings: true })
}
