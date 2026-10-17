// @ts-nocheck -- deployment smoke script, intentionally untyped
// Live smoke test against the DEPLOYED project, as real signed-in users (no browser, no secrets printed).
// Adds ONE clearly-labelled test case, runs it through the whole workflow, and closes it. It never edits or deletes
// existing cases. Passwords come from ../../../.secrets/accounts.json (git-ignored). Usage: npm run verify:live
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'vitest'
import { initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously, signInWithEmailAndPassword } from 'firebase/auth'
import { collection, doc, getDoc, getDocs, initializeFirestore, memoryLocalCache, query, updateDoc, where } from 'firebase/firestore'
import { planEscalation } from '../lib/matching'
import { estimateMinutes } from '../lib/geo'
import { downloadEvidence, uploadEvidence } from '../lib/evidence'
import { claimCase } from '../lib/workflow'
import { parseReceipt } from '../lib/crypto'
import {
  acknowledgeDestination, advanceStatus, applyPlan, closeCase, confirmArrival, createCaseQueued, crewAccept, crewDecline, dispatchCase, respondToOffer, selectDestination,
} from '../lib/workflow'

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
  const stranger = await session('stranger')
  const disp = await session('disp', 'dispatcher1@goldenhour.demo')
  const crew1 = await session('crew1', 'crew1@goldenhour.demo')
  const crew2 = await session('crew2', 'crew2@goldenhour.demo')
  const wen = await session('wen', 'wenlock@goldenhour.demo')
  const yen = await session('yen', 'yenepoya@goldenhour.demo')
  const kmc = await session('kmc', 'kmc-attavar@goldenhour.demo')
  const actor = (s, role) => ({ uid: s.uid, role })
  ok('reporter (anonymous), dispatcher, two crews and three hospitals signed in')

  const read = async (s, id) => ({ ...(await getDoc(doc(s.db, 'cases', id))).data(), id })
  const hospitals = async () => (await getDocs(collection(disp.db, 'hospitals'))).docs.map((d) => ({ ...d.data(), id: d.id }))
  const ambulances = async () => (await getDocs(collection(disp.db, 'ambulances'))).docs.map((d) => ({ ...d.data(), id: d.id }))
  const offers = async (id) => (await getDocs(query(collection(disp.db, 'offers'), where('caseId', '==', id)))).docs.map((d) => ({ ...d.data(), id: d.id }))
  const mine = async (s, hospitalId, id) => (await getDocs(query(collection(s.db, 'offers'), where('hospitalId', '==', hospitalId)))).docs.map((d) => ({ ...d.data(), id: d.id })).find((o) => o.caseId === id)
  const pos = (lat = 12.87, lng = 74.84) => ({ lat, lng, atMs: Date.now(), source: 'simulated' })

  // Self-heal: close stale cases created by an interrupted run of THIS script (only ones labelled LIVE VERIFY), so they cannot hold an ambulance.
  for (const d of (await getDocs(collection(disp.db, 'cases'))).docs) {
    const x = { ...d.data(), id: d.id }
    if (x.status !== 'closed' && String(x.brief).startsWith('LIVE VERIFY')) {
      await closeCase(disp.db, actor(disp, 'dispatcher'), x, 'Cancelled: stale live-verification case from an interrupted run')
      ok(`closed a stale live-verification case ${d.id.slice(0, 6)} left by an interrupted run`)
    }
  }

  console.log('\nReport with evidence (live):')
  const made = await createCaseQueued(rep.db, actor(rep, 'reporter'), { type: 'snakebite', severity: 2, patients: 1, needsIcu: false, brief: 'LIVE VERIFY: automated test case, please ignore', contact: '', note: 'automated deployment check', lat: 12.8704, lng: 74.8419, locationSource: 'manual', evidenceExpected: 1 })
  await made.done
  const id = made.id
  const bytes = Uint8Array.from({ length: 900_000 }, (_, i) => (i * 7 + 3) % 251)
  await uploadEvidence(rep.db, actor(rep, 'reporter'), id, 'photo1', bytes, { name: 'live-verify.jpg', mime: 'image/jpeg', kind: 'image', origin: 'file' })
  ok(`reported case ${id.slice(0, 6)} with a 900 KB file stored as chunks`)
  const ev = { ...(await getDoc(doc(rep.db, 'cases', id, 'evidence', 'photo1'))).data(), id: 'photo1' }
  assert.equal(ev.status, 'ready')
  assert.equal(Buffer.compare(new Uint8Array(await (await downloadEvidence(disp.db, id, ev)).arrayBuffer()), bytes), 0)
  ok('dispatch downloaded the file and its checksum verified')

  console.log('\nReceipts (live):')
  const { caseId, secret } = parseReceipt(made.receipt)
  await expectDenied('another reporter reading the case by ID alone', getDoc(doc(other.db, 'cases', caseId)))
  await expectDenied('a wrong receipt secret', claimCase(other.db, actor(other, 'reporter'), caseId, 'x'.repeat(32)))
  await claimCase(other.db, actor(other, 'reporter'), caseId, secret)
  await getDoc(doc(other.db, 'cases', caseId))
  ok('the right receipt opens the case on a second device')

  console.log('\nCrew assignment (live):')
  let c = await read(disp, id)
  const hs = await hospitals()
  const free = (await ambulances()).filter((a) => a.id === 'amb-1' || a.id === 'amb-2')
  assert.equal(free.length, 2, 'seeded ambulances must exist (run provision --prod)')
  const [m1, m2] = [free.find((a) => a.id === 'amb-1'), free.find((a) => a.id === 'amb-2')]
  assert.equal(m1.currentCaseId, null, 'Medic 1 must be free before the test')
  await dispatchCase(disp.db, actor(disp, 'dispatcher'), c, { ambulance: m1, etaSceneMin: 2, etaSource: 'estimate' })
  assert.equal((await offers(id)).length, 0)
  ok('dispatcher offered the case to Medic 1; no hospital was contacted')
  await expectDenied('a hospital reading the case before the crew accepts', getDoc(doc(wen.db, 'cases', id)))
  await expectDenied('Medic 2 accepting Medic 1\'s offer', crewAccept(crew2.db, actor(crew2, 'ambulance'), await read(disp, id)))
  await crewDecline(crew1.db, actor(crew1, 'ambulance'), await read(crew1, id), 'Live verification: decline path')
  c = await read(disp, id)
  assert.equal(c.status, 'reported')
  assert.deepEqual(c.declinedAmbulanceIds, ['amb-1'])
  ok('Medic 1 declined; the case is back with dispatch and Medic 1 is free')
  await expectDenied('re-offering the case to the unit that declined', dispatchCase(disp.db, actor(disp, 'dispatcher'), { ...c, declinedAmbulanceIds: [] }, { ambulance: m1, etaSceneMin: 2, etaSource: 'estimate' }))
  await dispatchCase(disp.db, actor(disp, 'dispatcher'), c, { ambulance: m2, etaSceneMin: 2, etaSource: 'estimate' })
  await crewAccept(crew2.db, actor(crew2, 'ambulance'), await read(crew2, id))
  c = await read(disp, id)
  assert.equal(c.status, 'enroute')
  ok('Medic 2 accepted')

  console.log('\nHospital pre-alert (live):')
  const etaFor = (h) => ({ etaMin: estimateMinutes(c, h), source: 'estimate' })
  const plan = planEscalation({ c, offers: [], hospitals: hs, nowMs: Date.now(), etaFor })
  await applyPlan(disp.db, actor(disp, 'dispatcher'), c, plan)
  c = await read(disp, id)
  assert.equal(c.offerWave, 1)
  assert.ok(c.hospitalAlertAtMs >= c.ambulanceAckAtMs)
  const asked = new Set(c.activeHospitalIds)
  assert.ok(asked.has('wenlock') && asked.has('yenepoya'), 'antivenom hospitals should be asked')
  ok(`asked ${[...asked].join(', ')} after the crew accepted`)

  console.log('\nPermission checks (live rules):')
  await getDoc(doc(wen.db, 'cases', id))
  await getDocs(collection(wen.db, 'cases', id, 'evidence'))
  ok('an asked hospital can read the case and its evidence')
  await expectDenied('an asked hospital reading patient contact details', getDoc(doc(wen.db, 'cases', id, 'private', 'patient')))
  if (!asked.has('kmc-attavar')) await expectDenied('a hospital that was not asked reading the case', getDoc(doc(kmc.db, 'cases', id)))
  if (!asked.has('kmc-attavar')) await expectDenied('a hospital that was not asked reading the evidence', getDocs(collection(kmc.db, 'cases', id, 'evidence')))
  await expectDenied('an unrelated guest reading the case', getDoc(doc(stranger.db, 'cases', id)))
  await expectDenied('an unrelated guest reading patient details', getDoc(doc(stranger.db, 'cases', id, 'private', 'patient')))
  await expectDenied('an unrelated guest reading the evidence', getDocs(collection(stranger.db, 'cases', id, 'evidence')))
  await expectDenied('anyone granting themselves a role', updateDoc(doc(rep.db, 'users', rep.uid), { role: 'dispatcher', active: true }))
  await expectDenied('hospital editing another hospital', updateDoc(doc(wen.db, 'hospitals', 'yenepoya'), { diverted: true }))
  await expectDenied('hospital reading another hospital\'s offers', getDocs(query(collection(wen.db, 'offers'), where('hospitalId', '==', 'yenepoya'))))
  await expectDenied('a hospital selecting a destination', updateDoc(doc(wen.db, 'cases', id), { selectedHospitalId: 'wenlock', recommendedHospitalId: 'wenlock', selectedByUid: wen.uid }))
  await expectDenied('dispatcher selecting an unconfirmed hospital', updateDoc(doc(disp.db, 'cases', id), { selectedHospitalId: 'wenlock', selectedHospitalName: 'x', selectedByUid: disp.uid, selectedAtMs: Date.now(), recommendedHospitalId: 'wenlock' }))
  await expectDenied('uploading an unsupported file type', uploadEvidence(rep.db, actor(rep, 'reporter'), id, 'bad1', new Uint8Array(100), { name: 'x.gif', mime: 'image/gif', kind: 'image', origin: 'file' }))

  console.log('\nHospital responses and decision (live):')
  await respondToOffer(yen.db, actor(yen, 'hospital'), await mine(yen, 'yenepoya', id), { accept: false, canReceive: false, confirmations: {}, declineReason: 'Required resource out of stock' })
  await expectDenied('a hospital that declined reading the case', getDoc(doc(yen.db, 'cases', id)))
  await expectDenied('a hospital that declined reading the evidence', getDocs(collection(yen.db, 'cases', id, 'evidence')))
  ok('Yenepoya declined and immediately lost access')
  await respondToOffer(wen.db, actor(wen, 'hospital'), await mine(wen, 'wenlock', id), { accept: true, canReceive: true, confirmations: { antivenom: true }, declineReason: null })
  ok('Wenlock accepted and confirmed antivenom')
  c = await read(disp, id)
  await applyPlan(disp.db, actor(disp, 'dispatcher'), c, planEscalation({ c, offers: await offers(id), hospitals: hs, nowMs: Date.now(), etaFor }))
  c = await read(disp, id)
  assert.equal(c.recommendedHospitalId, 'wenlock')
  await selectDestination(disp.db, actor(disp, 'dispatcher'), c, await offers(id), 'wenlock', null)
  ok('the engine recommended Wenlock and the dispatcher confirmed it')
  await getDoc(doc(wen.db, 'cases', id, 'private', 'patient'))
  ok('the confirmed hospital can now read patient details')

  console.log('\nCrew run and handover (live):')
  await expectDenied('starting transport before acknowledging the destination', updateDoc(doc(crew2.db, 'cases', id), { status: 'transporting', pickupAtMs: Date.now() }))
  await advanceStatus(crew2.db, actor(crew2, 'ambulance'), await read(crew2, id), pos())
  // the app's own guard fires first; the rules refusal for the same action is the line above
  await assert.rejects(advanceStatus(crew2.db, actor(crew2, 'ambulance'), await read(crew2, id), pos()), /Acknowledge the confirmed destination/)
  ok('the app also refuses to start transport before acknowledgement')
  await acknowledgeDestination(crew2.db, actor(crew2, 'ambulance'), await read(crew2, id))
  await advanceStatus(crew2.db, actor(crew2, 'ambulance'), await read(crew2, id), pos())
  await advanceStatus(crew2.db, actor(crew2, 'ambulance'), await read(crew2, id), pos())
  c = await read(disp, id)
  assert.equal(c.status, 'arrived')
  ok('crew: on scene, acknowledged, picked up, arrived')
  await expectDenied('closing before the hospital confirms receipt', updateDoc(doc(disp.db, 'cases', id), { status: 'closed', closedAtMs: Date.now(), closeReason: 'Too early' }))
  await confirmArrival(wen.db, actor(wen, 'hospital'), c)
  await closeCase(disp.db, actor(disp, 'dispatcher'), await read(disp, id), 'Live verification complete')
  c = await read(disp, id)
  assert.equal(c.status, 'closed')
  const amb = await ambulances()
  assert.equal(amb.find((a) => a.id === 'amb-2').currentCaseId, null)
  assert.equal(amb.find((a) => a.id === 'amb-1').currentCaseId, null)
  ok('hospital confirmed receipt, dispatch closed the case, both ambulances are free')

  const events = (await getDocs(collection(disp.db, 'cases', id, 'events'))).docs.map((d) => d.data().kind)
  for (const k of ['reported', 'evidence', 'dispatched', 'crew_declined', 'ack', 'wave', 'offer_declined', 'offer_accepted', 'selected', 'destination_ack', 'pickup', 'arrival_confirmed', 'closed']) assert.ok(events.includes(k), `audit trail missing ${k}`)
  ok(`audit trail holds ${events.length} events covering every actor`)
  console.log('\nLIVE VERIFICATION PASSED')

}, 240_000)
