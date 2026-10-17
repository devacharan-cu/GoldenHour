# GoldenHour

Real-time emergency coordination for the first critical hour. A reporter describes an emergency and attaches photos, a voice
note, video or documents. A dispatcher reviews it, assigns a crew, and the crew accepts. **While the crew is driving to the
scene,** the five nearest hospitals that can treat the patient are asked to confirm their resources for *that* case. The
dispatcher approves a destination, the crew acknowledges it, and the hospital confirms receipt before the case can close.

**Live demo:** https://goldenhour-46131.web.app  ·  **Run it on three laptops:** [DEMO.md](DEMO.md)  ·  **Security:** [SECURITY.md](SECURITY.md)

**This is a demonstration system, not a clinically validated emergency service. In a real emergency in India, call 112.**

## The idea: whose move is it?

Every case is a hand-off between four people: **reporter, dispatcher, crew, hospital**. The **Relay Track** at the top of
every screen shows who holds the case right now. Whoever must act sees **Your move** (the highlighter colour is used for
nothing else); everyone else sees who they are waiting on. It is derived purely from the case, so all laptops agree.

## The workflow (every step is a distinct actor with a timestamp)

1. **Reporter** files the emergency: type, severity, location (real GPS only when tapped), description, optional evidence.
2. **Dispatcher** reviews it and its evidence, optionally runs the AI briefing, and **explicitly offers** the case to one ambulance.
3. **Crew** sees an incoming dispatch and **accepts or declines** (declines return the case to dispatch and that unit cannot be re-offered it).
4. **En route:** the crew drives to the scene with real GPS (labelled *Live GPS*) or a demonstration drive (labelled *Simulated*).
5. **Hospital pre-alert:** on acceptance, the five nearest eligible hospitals are asked, with the permitted evidence and briefing.
6. **Each hospital independently** confirms, for this patient, every required resource (for a snakebite: antivenom physically in stock) and that it can receive, then accepts or declines. A decline removes its access to the case and files immediately.
7. **Destination:** dispatch sees an explained recommendation (the nearest hospital that accepted *and* confirmed everything) and approves or overrides with a written reason.
8. **Crew acknowledges** the destination, and only then can start transport after picking up the patient.
9. **Hospital handover:** the hospital explicitly confirms it received the patient.
10. **Closure:** dispatch can close only after that confirmation. The ambulance is released and every screen and the audit trail update.

Declines, missed deadlines (90 s), withdrawals, simultaneous incidents and competing dispatchers are handled. An ambulance can
hold only one case (enforced by the database rules, not just the app).

## What is in it

| Area | Detail |
|---|---|
| **Reporter** | 4-step flow with review, **evidence composer** (camera, voice recorder, files, drag and drop, previews, per-type validation), live tracking, a secret **receipt code** to reopen a report on any device |
| **Dispatcher** | Live queue with "your move" markers, evidence viewer (checksum verified), AI briefing review, crew assignment, hospital responses, destination approval, handover and close, duplicate warnings, escalation, **searchable incident history** |
| **Crew** | Incoming dispatch, accept or decline, navigation link, real GPS or simulated drive, destination acknowledgement, pickup, big thumb-reach actions |
| **Hospital** | Request inbox with countdown, per-case confirmation form, reviewed briefing and evidence, arrival confirmation, withdraw, capability profile, live availability, diversion |
| **Everyone** | Light, dark or follow-device theme, text size, calm motion, sound and desktop alerts for new work, profile, password change, device-data erase. Installable PWA that works offline. |

### Evidence storage (and why it is not Cloud Storage)
Cloud Storage for Firebase **requires the paid Blaze plan** and is unavailable on Spark ([Firebase FAQ](https://firebase.google.com/docs/storage/faqs-storage-changes-announced-sept-2024)),
so it is not used. Files are stored as **binary chunks in Firestore** (700 KiB each, not base64), under the same security rules as the case:
only the reporter (or whoever holds the receipt), dispatch, the assigned crew and hospitals that are *still active on the case* can read them.
Each file has a SHA-256 checksum verified before display. Limits: photo 5 MB (compressed on the device first), PDF 8 MB, audio 10 MB, video 15 MB, 10 files per report.
Allowed types: JPEG, PNG, WebP, PDF, common audio (webm, ogg, mp3, m4a, wav, aac, flac, opus) and video (mp4, webm, quicktime, 3gpp). Uploads are resumable, retryable and
marked *uploaded* only after the server has confirmed every part. Quotas (Spark: 1 GiB stored, 50k reads and 20k writes a day) are the practical limit.

### AI briefing (assistive only)
**Provider:** Google Gemini through **Firebase AI Logic** with the **Gemini Developer API**, model `gemini-3.5-flash` (stable, multimodal, no billing needed).
The API key stays inside Firebase; the browser never holds it, and **App Check (reCAPTCHA Enterprise)** guards the endpoint.
The dispatcher's browser sends the report text and attached files inline (Gemini Developer API does not read Cloud Storage URLs) and receives a JSON briefing:
audio **transcript**, **summary**, extracted **facts**, **missing information**, **uncertainties**, **conflicts** and a short **handoff**.
Safeguards: the model is told not to diagnose, advise treatment, claim hospital resources or choose dispatch; any sentence that does so is **removed and flagged**;
output is strictly validated (malformed answers are rejected and nothing is saved); it is stored as a **draft visible to dispatch only**; a human reviews and may edit it before
it is shared with the crew and active hospitals, always labelled *AI-generated*; the original report is never changed. Matching and destination decisions stay with the deterministic engine and people.
Use synthetic data only.

## Architecture

React + TypeScript + Vite · Leaflet/OpenStreetMap · Firebase Auth · Cloud Firestore · Firebase Hosting · Firebase AI Logic. Free **Spark** plan, no billing.

```
firestore.rules                 the trust boundary: roles, privacy, validation, deadlines, transitions
web/src/lib/relay.ts            whose move is it (pure)
web/src/lib/matching.ts         eligibility, waves, qualification, ranking, escalation planner (pure)
web/src/lib/workflow.ts         every state change as a function (db + actor), shared by the app and the tests
web/src/lib/evidence.ts         chunked evidence storage, validation, compression, checksums
web/src/lib/uploadQueue.ts      device-side upload queue: queued, uploading, uploaded, failed
web/src/lib/ai.ts               prompt, schema, strict parsing, guardrails, Gemini via Firebase AI Logic
web/src/lib/store.ts            role-scoped live queries and the escalation engine hook
web/scripts/provision.mjs       creates trusted accounts and role documents (the only way roles are granted)
```

Data: `users/{uid}` (role; no client writes) · `userPrefs/{uid}` · `hospitals/{id}` · `ambulances/{id}` (`currentCaseId`) · `offers/{caseId_hospitalId}` ·
`cases/{id}` with sub-collections `private/patient`, `events/*` (append-only), `evidence/*/chunks/*`, `ai/draft`, `ai/handoff`, `claims/{uid}`.

### Retention
Cases, their events, evidence and AI documents are **kept permanently** (nothing in the app can delete them) so history survives sign-out and new deployments.
A hospital that declines keeps only its own offer record, not the case. Per-device caches and queued uploads are erased on sign-out.

## Run it

```bash
cd web && npm install
npm run dev             # against the real project (needs an account)
npm run check           # lint + types + unit tests + emulator tests + build
npm run test:e2e        # real Chrome, many independent sessions, local emulators
npm run check:all       # everything
npm run verify:live     # deployed project: one labelled case through the real rules (adds a closed test case)
node scripts/mutate-rules.mjs   # prove the rules tests catch broken rules
```
Emulator tests need the Firebase CLI and a Java runtime. Local demo with no cloud: `firebase emulators:start --only auth,firestore --project demo-goldenhour`,
`node web/scripts/provision.mjs --emulator` (every password is `Demo-pass-123!`, valid only on the emulator), then `VITE_USE_EMULATORS=1 npm run dev --prefix web`.
Under emulators the AI panel uses a clearly labelled fake model so the review flow is testable offline.

### Production setup (project owner, one time)
1. Firebase console, Authentication: enable **Email/Password** and **Anonymous**.
2. Firebase console, **AI Logic, Get started, Gemini Developer API** (the no-cost provider; not the Vertex/Agent Platform option, which needs billing).
3. `node web/scripts/provision.mjs --prod` creates accounts (random passwords go to the git-ignored `.secrets/accounts.json`), then `node web/scripts/demo-logins.mjs --open`.
4. `firebase deploy --only firestore:rules,hosting`.

## Tests

Unit tests (matching, escalation, relay, evidence validation, upload queue, AI parsing and guardrails, history filters), Firestore emulator tests
(rules from every role's viewpoint and full multi-user workflows), a real-browser suite with independent sessions (login and session restore, themes, the full
three-laptop scenario with every media type, decline and re-assignment, real GPS vs simulation, history and receipts, offline, AI failure modes, phone layouts in both themes),
and a mutation check that deliberately breaks the rules. See [SECURITY.md](SECURITY.md) for what the tests prove and what they do not.

## Honest limitations
- **No server:** the hospital pre-alert, deadlines and re-routing run in an *open dispatcher console*. With none open, they pause.
- Evidence in Firestore is capped by file size and by Spark quotas; it is not a media archive.
- Demo hospital capabilities and availability are invented. Routing uses a public best-effort server with labelled estimates as fallback.
- No clinical, privacy or penetration review. Not for real dispatch.
