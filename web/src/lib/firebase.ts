import { initializeApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'

// Public web-client identifiers (not secrets). Access control is enforced by firestore.rules.
const app = initializeApp({
  apiKey: 'AIzaSyDU_4LEHP7R120mxs79fHrii1XL_UhAy3Y',
  authDomain: 'goldenhour-46131.firebaseapp.com',
  projectId: 'goldenhour-46131',
  storageBucket: 'goldenhour-46131.firebasestorage.app',
  messagingSenderId: '647769322176',
  appId: '1:647769322176:web:b2bd320a054e45041fb325',
})

export const db = getFirestore(app)
