// Signs in to PRODUCTION as every provisioned demo account and checks the role the app would really give it
// (users/{uid} role, hospital or ambulance link, active). Passwords come from ../.secrets/accounts.json and are never printed.
// Usage: node scripts/verify-accounts.mjs
import { readFileSync } from 'node:fs'
import { initializeApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { doc, getDoc, initializeFirestore, memoryLocalCache } from 'firebase/firestore'
import { SEED_ACCOUNTS } from '../src/lib/seed.ts'

const secrets = JSON.parse(readFileSync(new URL('../../.secrets/accounts.json', import.meta.url), 'utf8'))
const config = { apiKey: 'AIzaSyDU_4LEHP7R120mxs79fHrii1XL_UhAy3Y', authDomain: 'goldenhour-46131.firebaseapp.com', projectId: 'goldenhour-46131', appId: '1:647769322176:web:b2bd320a054e45041fb325' }
let bad = 0
for (const a of SEED_ACCOUNTS) {
  const app = initializeApp(config, a.email)
  try {
    const cred = await signInWithEmailAndPassword(getAuth(app), a.email, secrets[a.email])
    const db = initializeFirestore(app, { localCache: memoryLocalCache() })
    const p = (await getDoc(doc(db, 'users', cred.user.uid))).data()
    const good = p && p.active === true && p.role === a.role && (a.hospitalId ? p.hospitalId === a.hospitalId : true) && (a.ambulanceId ? p.ambulanceId === a.ambulanceId : true)
    if (!good) bad++
    console.log(`${good ? 'ok ' : 'BAD'}  ${a.email.padEnd(34)} ${p ? `${p.role}${p.hospitalId ? ` / ${p.hospitalId}` : ''}${p.ambulanceId ? ` / ${p.ambulanceId}` : ''}` : 'no role document'}`)
  } catch (e) { bad++; console.log(`BAD  ${a.email.padEnd(34)} ${e.code ?? e.message}`) }
}
console.log(bad ? `\n${bad} account(s) are wrong.` : `\nAll ${SEED_ACCOUNTS.length} demo accounts sign in with the right role.`)
process.exit(bad ? 1 : 0)
