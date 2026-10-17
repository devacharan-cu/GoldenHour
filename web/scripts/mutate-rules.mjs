// Mutation check for the security rules: deliberately weaken one rule at a time and confirm the permission tests
// notice (the suite must FAIL for every mutant). Run: node scripts/mutate-rules.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rulesPath = new URL('../../firestore.rules', import.meta.url)
const original = readFileSync(rulesPath, 'utf8')

const mutants = [
  ['anyone may write role documents', "match /users/{userId} {\n      allow read: if signedIn() && userId == uid();\n      allow write: if false;", "match /users/{userId} {\n      allow read: if signedIn() && userId == uid();\n      allow write: if signedIn();"],
  ['destination no longer requires a confirmed offer', "&& qualified(get(offerPath(caseId, a.selectedHospitalId)).data, a.requiredCapabilities)\n                && (a.selectedHospitalId == a.recommendedHospitalId", "&& (a.selectedHospitalId == a.recommendedHospitalId"],
  ['override no longer needs a reason', "|| (a.overrideReason is string && a.overrideReason.size() >= 3))));", "|| true)));"],
  ['hospitals can read every case', "|| (isHospital() && d.notifiedHospitalIds.hasAny([prof().hospitalId]));", "|| isHospital();"],
  ['patient contact visible to every asked hospital', "|| (isHospital() && get(casePath(caseId)).data.selectedHospitalId == prof().hospitalId));", "|| isHospital());"],
  ['hospitals may answer after the deadline', "&& resource.data.state == 'pending' && nowMs() < resource.data.expiresAtMs", "&& resource.data.state == 'pending'"],
  ['dispatch may time out offers early', "&& ((resource.data.state == 'pending' && request.resource.data.state == 'timeout' && nowMs() >= resource.data.expiresAtMs)", "&& ((resource.data.state == 'pending' && request.resource.data.state == 'timeout')"],
  ['ambulance may start transport without a destination', "&& a.status == 'transporting' && b.selectedHospitalId != null)", "&& a.status == 'transporting')"],
  ['audit events can be edited', "allow update, delete: if false;\n      }\n    }\n\n    // ---------- offers", "allow update, delete: if signedIn();\n      }\n    }\n\n    // ---------- offers"],
  ['reporters can pre-set workflow fields on create', "&& d.ambulanceId == null && d.ambulanceCallSign == null", "&& true && d.ambulanceCallSign == null"],
  ['any hospital may edit another hospital', "allow update: if isHospital() && prof().hospitalId == hospitalId", "allow update: if isHospital()"],
]

const dir = mkdtempSync(join(tmpdir(), 'gh-rules-'))
let survived = 0
for (const [name, from, to] of mutants) {
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
