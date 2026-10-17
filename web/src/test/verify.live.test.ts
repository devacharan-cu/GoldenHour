// @ts-nocheck -- deployment smoke script, intentionally untyped
// Live smoke test against the DEPLOYED project, as real signed-in users (no browser, no secrets printed).
// Adds ONE clearly-labelled test case, runs it through the whole workflow, and closes it. It never edits or deletes
// existing cases. Passwords come from ../.secrets/accounts.json (git-ignored). Usage: npm run verify:live
import assert from 'node:assert/strict'
import { it } from 'vitest'
import { readFileSync } from 'node:fs'
import { initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously, signInWithEmailAndPassword } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, initializeFirestore, memoryLocalCache, query, updateDoc, where } from 'firebase/firestore'
import { nextWave, planEscalation, nearestFreeAmbulance } from '../lib/matching'
import { estimateMinutes } from '../lib/geo'
import { acknowledgeAssignment, advanceStatus, applyPlan, closeCase, confirmArrival, createCase, dispatchCase, respondToOffer, selectDestination } from '../lib/workflow'

const secrets = JSON.parse(readFileSync(new URL('../../../.secrets/accounts.json', import.meta.url), 'utf8'))
const config = { apiKey: 'AIzaSyDU_4LEHP7R120mxs79fHrii1XL_UhAy3Y', authDomain: 'goldenhour-46131.firebaseapp.com', projectId: 'goldenhour-46131', appId: '1:647769322176:web:b2bd320a054e45041fb325' }

it('live workflow against the deployed project', async () => {
let n = 0
const session = async (label, email) => {
  const app = initializeApp(config, `${label}-${n++}`)
  const auth = getAuth(app)
  const db = initializeFirestore(app, { localCache: memoryLocalCache() })
  const cred = email ? await signInWithEmailAndPassword(auth, email, secrets[email]) : await signInAnonymously(auth)
  return { db, uid: cred.user.uid }
}
const expectDenied = async (label, p) => { try { await p; assert.fail(`${label}: should have been denied`) } catch (e) { assert.match(String(e.code ?? e.message), /permission-denied|PERMISSION_DENIED/, `${label}: ${e.message}`); console.log(`  ✓ denied: ${label}`) } }
const ok = (m) => console.log(`  ✓ ${m}`)

console.log('Signing in as real production accounts…')
const rep = await session('rep')
const other = await session('other')
const disp = await session('disp', 'dispatcher1@goldenhour.demo')
const wen = await session('wen', 'wenlock@goldenhour.demo')
const yen = await session('yen', 'yenepoya@goldenhour.demo')
const kmc = await session('kmc', 'kmc-attavar@goldenhour.demo')
const crew = await session('crew', 'crew1@goldenhour.demo')
const actor = (s, role) => ({ uid: s.uid, role })
ok('reporter (anonymous), dispatcher, 3 hospitals and an ambulance crew signed in')

const read = async (s, id) => ({ ...(await getDoc(doc(s.db, 'cases', id))).data(), id })
const hospitals = async () => (await getDocs(collection(disp.db, 'hospitals'))).docs.map((d) => ({ ...d.data(), id: d.id }))
const ambulances = async () => (await getDocs(collection(disp.db, 'ambulances'))).docs.map((d) => ({ ...d.data(), id: d.id }))
const offers = async (id) => (await getDocs(query(collection(disp.db, 'offers'), where('caseId', '==', id)))).docs.map((d) => ({ ...d.data(), id: d.id }))

console.log('\nWorkflow (snakebite, live):')
const id = await createCase(rep.db, actor(rep, 'reporter'), { type: 'snakebite', severity: 2, patients: 1, needsIcu: false, brief: 'LIVE VERIFY: automated test case, please ignore', contact: '', note: 'automated deployment check', lat: 12.8704, lng: 74.8419, locationSource: 'manual' })
ok(`reported (case ${id.slice(0, 6)})`)

let c = await read(disp, id)
const hs = await hospitals()
const amb = nearestFreeAmbulance(c, await ambulances())
assert.ok(amb, 'an ambulance must be available')
const candidates = nextWave(c, hs, [], (h) => ({ etaMin: estimateMinutes(c, h), source: 'estimate' }))
assert.ok(candidates.length >= 2, 'need at least two antivenom hospitals')
await dispatchCase(disp.db, actor(disp, 'dispatcher'), c, { ambulance: amb, candidates, etaSceneMin: 2, etaSource: 'estimate' })
ok(`dispatched ${amb.callSign}; asked ${candidates.map((x) => x.hospital.id).join(', ')}`)

const mine = async (s, hospitalId) => (await getDocs(query(collection(s.db, 'offers'), where('hospitalId', '==', hospitalId)))).docs.map((d) => ({ ...d.data(), id: d.id })).find((o) => o.caseId === id)
const asked = new Set(candidates.map((x) => x.hospital.id))
assert.ok(asked.has('wenlock'), 'wenlock should be asked')
const wOffer = await mine(wen, 'wenlock')
assert.equal(wOffer.state, 'pending')
ok('Wenlock sees its pending request in real time')

console.log('\nPermission checks (live rules):')
await expectDenied('reporter B reading reporter A\'s case', getDoc(doc(other.db, 'cases', id)))
await expectDenied('reporter B reading patient details', getDoc(doc(other.db, 'cases', id, 'private', 'patient')))
await expectDenied('anyone granting themselves a role', updateDoc(doc(rep.db, 'users', rep.uid), { role: 'dispatcher', active: true }))
await expectDenied('hospital editing another hospital', updateDoc(doc(wen.db, 'hospitals', 'yenepoya'), { diverted: true }))
if (!asked.has('kmc-attavar')) await expectDenied('hospital not asked reading the case', getDoc(doc(kmc.db, 'cases', id)))
await expectDenied('hospital reading another hospital\'s offers', getDocs(query(collection(wen.db, 'offers'), where('hospitalId', '==', 'yenepoya'))))
await expectDenied('reporter reading the offers collection', getDocs(collection(rep.db, 'offers')))
await expectDenied('hospital selecting a destination', updateDoc(doc(wen.db, 'cases', id), { selectedHospitalId: 'wenlock', recommendedHospitalId: 'wenlock', selectedByUid: wen.uid }))
await expectDenied('dispatcher selecting an unconfirmed hospital', updateDoc(doc(disp.db, 'cases', id), { selectedHospitalId: 'wenlock', selectedHospitalName: 'x', selectedByUid: disp.uid, selectedAtMs: Date.now(), recommendedHospitalId: 'wenlock' }))

console.log('\nHospital responses and decision:')
if (asked.has('yenepoya')) { await respondToOffer(yen.db, actor(yen, 'hospital'), await mine(yen, 'yenepoya'), { accept: false, canReceive: false, confirmations: {}, declineReason: 'Required resource out of stock' }); ok('Yenepoya declined') }
await respondToOffer(wen.db, actor(wen, 'hospital'), wOffer, { accept: true, canReceive: true, confirmations: { antivenom: true }, declineReason: null })
ok('Wenlock accepted and confirmed antivenom')

c = await read(disp, id)
const plan = planEscalation({ c, offers: await offers(id), hospitals: hs, nowMs: Date.now(), etaFor: (h) => ({ etaMin: estimateMinutes(c, h), source: 'estimate' }) })
await applyPlan(disp.db, actor(disp, 'dispatcher'), c, plan)
c = await read(disp, id)
assert.equal(c.recommendedHospitalId, 'wenlock')
ok('engine recommended Wenlock (the only hospital that confirmed)')
await selectDestination(disp.db, actor(disp, 'dispatcher'), c, await offers(id), 'wenlock', null)
c = await read(disp, id)
assert.equal(c.selectedHospitalId, 'wenlock')
ok('dispatcher confirmed the destination while the ambulance was en route')
await getDoc(doc(wen.db, 'cases', id, 'private', 'patient')) // now readable by the confirmed hospital
ok('confirmed hospital can now read patient details')
if (asked.has('yenepoya')) await expectDenied('declined hospital reading patient details', getDoc(doc(yen.db, 'cases', id, 'private', 'patient')))

console.log('\nAmbulance run:')
await acknowledgeAssignment(crew.db, actor(crew, 'ambulance'), c)
for (let i = 0; i < 3; i++) await advanceStatus(crew.db, actor(crew, 'ambulance'), await read(crew, id), { lat: 12.87, lng: 74.84, atMs: Date.now(), source: 'simulated' })
c = await read(disp, id)
assert.equal(c.status, 'arrived')
ok('crew: acknowledged → on scene → transporting → arrived')
await confirmArrival(wen.db, actor(wen, 'hospital'), c)
await closeCase(disp.db, actor(disp, 'dispatcher'), await read(disp, id), 'Live verification complete')
c = await read(disp, id)
assert.equal(c.status, 'closed')
assert.equal((await ambulances()).find((a) => a.id === amb.id).available, true)
ok('hospital confirmed arrival; dispatcher closed the case; ambulance released')

const events = (await getDocs(collection(disp.db, 'cases', id, 'events'))).size
assert.ok(events >= 8)
ok(`audit trail holds ${events} events`)
console.log('\nLIVE VERIFICATION PASSED')

}, 180_000)
