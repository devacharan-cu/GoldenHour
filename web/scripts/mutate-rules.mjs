// Mutation check for the security rules: deliberately weaken one rule at a time and confirm the permission tests
// notice (the suite must FAIL for every mutant). Run: node scripts/mutate-rules.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rulesPath = new URL('../../firestore.rules', import.meta.url)
// Normalise line endings so the multi-line patterns below match on Windows checkouts too.
const original = readFileSync(rulesPath, 'utf8').split(String.fromCharCode(13)).join('')

const mutants = [
  ['anyone may write role documents', "allow read: if signedIn() && userId == uid();\n      allow write: if false;", "allow read: if signedIn() && userId == uid();\n      allow write: if signedIn();"],
  ['destination no longer requires a confirmed offer', "&& qualified(get(offerPath(caseId, a.selectedHospitalId)).data, a.requiredCapabilities)\n                && a.destinationAckAtMs == null", "&& a.destinationAckAtMs == null"],
  ['override no longer needs a reason', "(a.overrideReason is string && a.overrideReason.size() >= 3)", "true"],
  ['recommendation need not be a confirmed hospital', "|| qualified(get(offerPath(caseId, a.recommendedHospitalId)).data, a.requiredCapabilities))", "|| true)"],
  ['hospitals can read every case', "|| (isHospital() && d.activeHospitalIds.hasAny([prof().hospitalId]));", "|| isHospital();"],
  ['a declined hospital keeps the case (case document)', "|| (isHospital() && d.activeHospitalIds.hasAny([prof().hospitalId]));", "|| (isHospital() && d.notifiedHospitalIds.hasAny([prof().hospitalId]));"],
  ['a declined hospital keeps the evidence', "|| (isHospital() && caseData(caseId).activeHospitalIds.hasAny([prof().hospitalId]));\n    }\n\n    // ---------- offers", "|| (isHospital() && caseData(caseId).notifiedHospitalIds.hasAny([prof().hospitalId]));\n    }\n\n    // ---------- offers"],
  ['patient contact visible to every asked hospital', "|| (isHospital() && caseData(caseId).selectedHospitalId == prof().hospitalId));", "|| isHospital());"],
  ['hospitals may answer after the deadline', "&& resource.data.state == 'pending' && nowMs() < resource.data.expiresAtMs", "&& resource.data.state == 'pending'"],
  ['dispatch may time out offers early', "request.resource.data.state == 'timeout' && nowMs() >= resource.data.expiresAtMs)", "request.resource.data.state == 'timeout')"],
  ['transport can start without the crew acknowledging the destination', "&& b.selectedHospitalId != null && b.destinationAckAtMs != null\n              && near(a.pickupAtMs)", "&& b.selectedHospitalId != null\n              && near(a.pickupAtMs)"],
  ['a case can be closed before the hospital confirms receipt', "(b.status != 'arrived' || b.arrivalConfirmedAtMs != null)", "true"],
  ['crew can act on a case that is not theirs', "return isAmbulance() && b.ambulanceId == prof().ambulanceId\n        && validPos(a.ambulancePos)", "return isAmbulance()\n        && validPos(a.ambulancePos)"],
  ['a declining crew need not be recorded as having declined', "&& a.declinedAmbulanceIds == b.declinedAmbulanceIds.concat([prof().ambulanceId])", "&& true"],
  ['an ambulance can hold two cases', "(resource.data.currentCaseId == null && request.resource.data.currentCaseId is string", "(request.resource.data.currentCaseId is string"],
  ['a receipt works without the secret', "\n          && hashing.sha256(request.resource.data.secret).toHexString().lower() == caseData(caseId).receiptHash;", ";"],
  ['evidence accepts any image type', "request.resource.data.mime in ['image/jpeg','image/png','image/webp'] && request.resource.data.size <= 5242880", "request.resource.data.size <= 5242880"],
  ['evidence accepts files of any size', "request.resource.data.size <= 15728640", "true"],
  ['stored evidence chunks can be overwritten', "allow update: if false;\n          allow delete: if signedIn() && get(", "allow update: if signedIn();\n          allow delete: if signedIn() && get("],
  ['anyone may add evidence to any case', "&& (isDispatcher() || caseData(caseId).reporterUid == uid() || isClaimant(caseId))\n          && request.resource.data.keys()", "&& request.resource.data.keys()"],
  ['hospitals can read the unreviewed AI draft', "allow read: if (docId == 'draft' && isDispatcher())", "allow read: if (docId == 'draft' && isStaff())"],
  ['every hospital can read the shared AI handoff', "|| (isHospital() && caseData(caseId).activeHospitalIds.hasAny([prof().hospitalId]))));\n        allow create, update: if isDispatcher() && docId in", "|| isHospital()));\n        allow create, update: if isDispatcher() && docId in"],
  ['audit events can be edited', "allow update, delete: if false;\n      }\n\n      // Evidence", "allow update, delete: if signedIn();\n      }\n\n      // Evidence"],
  ['reporters can pre-set workflow fields on create', "&& d.ambulanceId == null && d.ambulanceCallSign == null", "&& true && d.ambulanceCallSign == null"],
  ['any hospital may edit another hospital', "allow update: if isHospital() && prof().hospitalId == hospitalId", "allow update: if isHospital()"],
  ['anyone may write anyone else\'s display preferences', "allow create, update: if signedIn() && userId == uid()\n        && request.resource.data.keys().hasOnly(['theme'", "allow create, update: if signedIn()\n        && request.resource.data.keys().hasOnly(['theme'"],
]

const dir = mkdtempSync(join(tmpdir(), 'gh-rules-'))
let survived = 0
const only = process.argv[2] // optional: run only mutants whose name contains this text
for (const [name, from, to] of mutants) {
  if (only && !name.includes(only)) continue
  if (!original.includes(from)) { console.log(`?  could not apply mutant "${name}" (rules text changed; update this script)`); survived++; continue }
  const file = join(dir, 'mutant.rules')
  writeFileSync(file, original.replace(from, to))
  let killed = false
  try {
    execFileSync('npx', ['firebase', 'emulators:exec', '--only', 'firestore', '--project', 'demo-goldenhour', 'npx vitest run --config vitest.emu.config.ts src/test/rules.emu.test.ts'], { shell: true, stdio: 'ignore', env: { ...process.env, RULES_PATH: file } })
  } catch { killed = true }
  console.log(`${killed ? '✓ killed  ' : '✗ SURVIVED'}  ${name}`)
  if (!killed) survived++
}
console.log(survived ? `\n${survived} mutant(s) survived: the tests have a gap.` : `\nAll ${mutants.length} mutants were caught by the tests.`)
process.exit(survived ? 1 : 0)
