// Provision trusted accounts, role documents and demo fleet/hospital data.
//
//   node scripts/provision.mjs --emulator            local emulators, fixed demo password (never used in production)
//   node scripts/provision.mjs --prod                the real project; random passwords written to ../.secrets/accounts.json
//   node scripts/provision.mjs --prod --reset-passwords   rotate every password
//   node scripts/provision.mjs --prod --reseed       also overwrite hospitals and ambulances with seed data
//
// This is the ONLY way roles are granted: the security rules forbid every client from writing users/{uid}.
// --prod uses your own gcloud login (project owner), so no service-account key or secret is ever stored.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { applicationDefault, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { SEED_ACCOUNTS, SEED_AMBULANCES, SEED_HOSPITALS } from '../src/lib/seed.ts'

const args = new Set(process.argv.slice(2))
const prod = args.has('--prod')
if (prod === args.has('--emulator')) { console.error('Choose exactly one of --emulator or --prod'); process.exit(1) }

const projectId = prod ? 'goldenhour-46131' : 'demo-goldenhour'
if (!prod) {
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8181'
  process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9199'
}

let credential
if (prod) {
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  credential = { getAccessToken: async () => ({ access_token: token, expires_in: 3000 }) }
}
const app = initializeApp({ projectId, ...(credential ? { credential } : { credential: applicationDefault() }) })
const auth = getAuth(app)
const db = getFirestore(app)
const now = Date.now()

const secretsDir = new URL('../../.secrets/', import.meta.url)
const secretsFile = new URL('accounts.json', secretsDir)
let saved = {}
if (prod) {
  mkdirSync(secretsDir, { recursive: true })
  if (existsSync(secretsFile)) saved = JSON.parse(readFileSync(secretsFile, 'utf8'))
}
const newPassword = () => `${randomBytes(9).toString('base64url')}-${randomBytes(3).toString('hex')}`

// Hospitals and fleet (demo data). Existing documents are kept unless --reseed.
const hospitals = db.collection('hospitals')
for (const { id, beds, icu, resources, ...h } of SEED_HOSPITALS) {
  const ref = hospitals.doc(id)
  if (!args.has('--reseed') && prod && (await ref.get()).exists && (await ref.get()).data()?.availability) continue
  await ref.set({
    ...h,
    capabilitiesUpdatedAtMs: now,
    availability: { emergencyBeds: beds, icuBeds: icu, resources: Object.fromEntries(h.capabilities.map((c) => [c, resources.includes(c)])), confirmedAtMs: now, confirmedByUid: 'provision-script' },
  })
}
for (const { id, ...a } of SEED_AMBULANCES) await db.collection('ambulances').doc(id).set(a)
console.log(`Seeded ${SEED_HOSPITALS.length} hospitals and ${SEED_AMBULANCES.length} ambulances in ${projectId}`)

const results = {}
for (const acct of SEED_ACCOUNTS) {
  let user
  try { user = await auth.getUserByEmail(acct.email) } catch { user = null }
  let password = saved[acct.email]
  if (!user) {
    password = prod ? newPassword() : 'Demo-pass-123!'
    user = await auth.createUser({ email: acct.email, password, displayName: acct.displayName, emailVerified: true })
  } else if (args.has('--reset-passwords') || (prod && !password)) {
    password = prod ? newPassword() : 'Demo-pass-123!'
    await auth.updateUser(user.uid, { password })
  }
  await db.collection('users').doc(user.uid).set({
    role: acct.role, displayName: acct.displayName, active: true,
    ...(acct.hospitalId ? { hospitalId: acct.hospitalId } : {}),
    ...(acct.ambulanceId ? { ambulanceId: acct.ambulanceId } : {}),
  })
  results[acct.email] = { uid: user.uid, role: acct.role, password }
}

if (prod) {
  const out = { ...saved }
  for (const [email, r] of Object.entries(results)) if (r.password) out[email] = r.password
  writeFileSync(secretsFile, JSON.stringify(out, null, 2))
  console.log(`Provisioned ${SEED_ACCOUNTS.length} accounts. Passwords are in .secrets/accounts.json (gitignored). Not printed here on purpose.`)
} else {
  console.log(`Provisioned ${SEED_ACCOUNTS.length} emulator accounts (password for all: Demo-pass-123!)`)
}
