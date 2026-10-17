// @ts-nocheck -- deployment smoke script, intentionally untyped
// REAL Gemini check through the app's own code path (analyseCase + createFirebaseAiClient + Firebase AI Logic), against the
// deployed project, as a real dispatcher. One clearly labelled synthetic case, closed again at the end. No secrets printed.
// Usage: npm run verify:ai
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { it } from 'vitest'
import { initializeApp } from 'firebase/app'
import { getAuth, signInAnonymously, signInWithEmailAndPassword } from 'firebase/auth'
import { doc, getDoc, getDocs, collection, initializeFirestore, memoryLocalCache } from 'firebase/firestore'
import { analyseCase, createFirebaseAiClient } from '../lib/ai'
import { uploadEvidence } from '../lib/evidence'
import { closeCase, createCaseQueued } from '../lib/workflow'

const secrets = JSON.parse(readFileSync(new URL('../../../.secrets/accounts.json', import.meta.url), 'utf8'))
const config = { apiKey: 'AIzaSyDU_4LEHP7R120mxs79fHrii1XL_UhAy3Y', authDomain: 'goldenhour-46131.firebaseapp.com', projectId: 'goldenhour-46131', appId: '1:647769322176:web:b2bd320a054e45041fb325' }

// A small valid PNG (a red cross on white) so there is real image evidence to send.
function png() {
  const W = 64, H = 64
  const raw = Buffer.alloc((W * 3 + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0
    for (let x = 0; x < W; x++) {
      const cross = (x > 26 && x < 38) || (y > 26 && y < 38)
      const o = y * (W * 3 + 1) + 1 + x * 3
      raw[o] = cross ? 200 : 255; raw[o + 1] = cross ? 30 : 255; raw[o + 2] = cross ? 30 : 255
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
}

it('real Gemini briefing through GoldenHour', async () => {
  const app = initializeApp(config, 'ai-live')
  const auth = getAuth(app)
  const db = initializeFirestore(app, { localCache: memoryLocalCache() })
  const rapp = initializeApp(config, 'ai-live-reporter')
  const rdb = initializeFirestore(rapp, { localCache: memoryLocalCache() })
  const ru = (await signInAnonymously(getAuth(rapp))).user
  const du = (await signInWithEmailAndPassword(auth, 'dispatcher1@goldenhour.demo', secrets['dispatcher1@goldenhour.demo'])).user
  const R = { uid: ru.uid, role: 'reporter' }, D = { uid: du.uid, role: 'dispatcher' }

  const made = await createCaseQueued(rdb, R, { type: 'snakebite', severity: 2, patients: 1, needsIcu: false, brief: 'LIVE VERIFY (AI): synthetic test, please ignore', contact: '', note: 'Synthetic: a man bitten on the left ankle by a snake about ten minutes ago in a paddy field near Kulur. He is awake but scared and the ankle is swelling. We could not see what snake it was. Photo attached.', lat: 12.9, lng: 74.84, locationSource: 'manual', evidenceExpected: 1 })
  await made.done
  await uploadEvidence(rdb, R, made.id, 'img1', png(), { name: 'ankle.png', mime: 'image/png', kind: 'image', origin: 'file' })
  const c = { ...(await getDoc(doc(db, 'cases', made.id))).data(), id: made.id }
  const evidence = (await getDocs(collection(db, 'cases', made.id, 'evidence'))).docs.map((d) => ({ ...d.data(), id: d.id }))
  const client = await createFirebaseAiClient(app)
  console.log(`  model: ${client.model}`)
  let r
  try {
    r = await analyseCase(db, client, c, evidence, 'Reporter note: ' + c.brief)
  } finally {
    await closeCase(db, D, c, 'Cancelled: automated AI verification case')
  }
  console.log('  result ok:', r.ok, r.ok ? '' : r.error)
  if (r.ok) {
    console.log('  summary:', r.briefing.summary)
    console.log('  handoff:', r.briefing.handoff)
    console.log('  missing:', JSON.stringify(r.briefing.missingInformation))
    console.log('  flags:', JSON.stringify(r.briefing.flags ?? []), 'skipped:', JSON.stringify(r.skipped))
    const draft = await getDoc(doc(db, 'cases', made.id, 'ai', 'draft'))
    assert.ok(draft.exists(), 'draft saved for the dispatcher')
  }
  assert.ok(r.ok, r.ok ? '' : r.error)
})
