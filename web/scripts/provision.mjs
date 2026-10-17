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

// Two backends behind one tiny interface: the Admin SDK for the emulator, plain REST (your gcloud login) for production.
const now = Date.now()
let backend
if (!prod) {
  const app = initializeApp({ projectId, credential: applicationDefault() })
  const auth = getAuth(app)
  const db = getFirestore(app)
  backend = {
    async getUser(email) { try { const u = await auth.getUserByEmail(email); return { uid: u.uid } } catch { return null } },
    async createUser(email, password, displayName) { const u = await auth.createUser({ email, password, displayName, emailVerified: true }); return { uid: u.uid } },
    async setPassword(uid, password) { await auth.updateUser(uid, { password }) },
    async setDoc(path, data) { await db.doc(path).set(data) },
    async getDoc(path) { const d = await db.doc(path).get(); return d.exists ? d.data() : null },
  }
} else {
  const token = execFileSync('gcloud', ['auth', 'print-access-token'], { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const headers = { Authorization: `Bearer ${token}`, 'x-goog-user-project': projectId, 'content-type': 'application/json' }
  const call = async (url, method, body) => {
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
    const text = await r.text()
    if (!r.ok) throw Object.assign(new Error(`${method} ${url.split('?')[0].replace(/^https:\/\/[^/]+/, '')} -> ${r.status} ${text.slice(0, 300)}`), { status: r.status })
    return text ? JSON.parse(text) : {}
  }
  const idt = `https://identitytoolkit.googleapis.com/v1/projects/${projectId}`
  const fs = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`
  const toValue = (v) => v === null ? { nullValue: null } : Array.isArray(v) ? { arrayValue: { values: v.map(toValue) } } : typeof v === 'string' ? { stringValue: v }
    : typeof v === 'boolean' ? { booleanValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
    : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toValue(x)])) } }
  backend = {
    async getUser(email) { const r = await call(`${idt}/accounts:lookup`, 'POST', { email: [email] }); return r.users?.[0] ? { uid: r.users[0].localId } : null },
    async createUser(email, password, displayName) { const r = await call(`${idt}/accounts`, 'POST', { email, password, displayName, emailVerified: true }); return { uid: r.localId } },
    async setPassword(uid, password) { await call(`${idt}/accounts:update`, 'POST', { localId: uid, password }) },
    async setDoc(path, data) { await call(`${fs}/${path}`, 'PATCH', { fields: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toValue(v)])) }) },
    async getDoc(path) { try { await call(`${fs}/${path}`, 'GET'); return { exists: true } } catch (e) { if (e.status === 404) return null; throw e } },
  }
}

const secretsDir = new URL('../../.secrets/', import.meta.url)
const secretsFile = new URL('accounts.json', secretsDir)
let saved = {}
if (prod) {
  mkdirSync(secretsDir, { recursive: true })
  if (existsSync(secretsFile)) saved = JSON.parse(readFileSync(secretsFile, 'utf8'))
}
const newPassword = () => `${randomBytes(9).toString('base64url')}-${randomBytes(3).toString('hex')}`

// Hospitals and fleet (demo data). In production, hospitals that already have availability data are kept unless --reseed.
for (const { id, beds, icu, resources, ...h } of SEED_HOSPITALS) {
  if (prod && !args.has('--reseed') && (await backend.getDoc(`hospitals/${id}`))?.availability) continue
  await backend.setDoc(`hospitals/${id}`, {
    ...h,
    capabilitiesUpdatedAtMs: now,
    availability: { emergencyBeds: beds, icuBeds: icu, resources: Object.fromEntries(h.capabilities.map((c) => [c, resources.includes(c)])), confirmedAtMs: now, confirmedByUid: 'provision-script' },
  })
}
for (const { id, ...a } of SEED_AMBULANCES) await backend.setDoc(`ambulances/${id}`, a)
console.log(`Seeded ${SEED_HOSPITALS.length} hospitals and ${SEED_AMBULANCES.length} ambulances in ${projectId}`)

const results = {}
for (const acct of SEED_ACCOUNTS) {
  let user = await backend.getUser(acct.email)
  let password = saved[acct.email]
  if (!user) {
    password = prod ? newPassword() : 'Demo-pass-123!'
    user = await backend.createUser(acct.email, password, acct.displayName)
  } else if (args.has('--reset-passwords') || (prod && !password)) {
    password = prod ? newPassword() : 'Demo-pass-123!'
    await backend.setPassword(user.uid, password)
  }
  await backend.setDoc(`users/${user.uid}`, {
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
