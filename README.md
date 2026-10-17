# GoldenHour

Real-time emergency coordination for the first critical hour. When an ambulance is dispatched, the **five nearest eligible
hospitals are asked at the same moment, while the crew is still driving to the scene.** Each hospital explicitly confirms,
for *that case*, the resources it needs (for a snakebite: antivenom physically in stock). The dispatcher sees an
explainable recommendation and confirms the destination, so it is ready before the patient is loaded.

**Live demo:** https://goldenhour-46131.web.app  ·  **Demonstration only, not for real dispatch. In India call 112.**
Read [SECURITY.md](SECURITY.md) for the security model and its limits.

## What it does

| Role | Dashboard |
|---|---|
| **Reporter** (no account) | One-screen SOS, real GPS only when tapped (or tap the map), live status, ambulance position, confirmed hospital |
| **Dispatcher** | Prioritised queue, dispatch preview, live per-hospital responses (seen / confirmed / ETA), explainable recommendation, approve-or-override with a written reason, escalations, duplicate warnings, audit trail |
| **Hospital** | Incoming requests with a countdown, per-case confirmation checklist, accept/decline, withdraw, incoming patients with live ambulance, arrival confirmation, capability profile, availability, specialty diversion |
| **Ambulance crew** | Assignment + acknowledgement, patient/scene details, navigation link, real GPS or clearly-labelled simulated drive, step controls gated on a confirmed destination |

Everything updates in real time through Firestore listeners. It is an installable, offline-tolerant **PWA**.

### Matching and escalation (explainable, never invented)

1. **Eligible** = not diverted, and the hospital's *permanent* capability profile lists every capability the case needs
   (trauma, cardiac, stroke, antivenom, paediatrics, burns, ICU, obstetrics).
2. **Ask** the 5 nearest eligible by travel time from the scene (road routing; otherwise a *labelled* straight-line estimate).
3. **Qualified** = accepted *and* can receive *and* confirmed **every** required capability live. Anything less is never a destination.
4. **Recommend** the fastest qualified hospital with the reasons shown; a human approves or overrides (reason required).
5. **Decline, silence (90 s deadline), or a later withdrawal** triggers the next wave automatically. If nobody qualifies and
   nobody is left to ask, it **escalates loudly to the dispatcher** instead of picking something unsuitable.
6. Permanent capabilities, live availability (with "last confirmed" time) and diversion are three separate things.

## Architecture

React + TypeScript + Vite · Leaflet/OpenStreetMap · Firebase Auth · Cloud Firestore · Firebase Hosting (Spark plan, no billing).

```
web/src/lib/matching.ts     pure engine: eligibility, waves, qualification, ranking, escalation planner
web/src/lib/workflow.ts     every state change as a function (db + actor), shared by the app and the tests
web/src/lib/store.ts        role-scoped live queries + the escalation engine hook
firestore.rules             the trust boundary (roles, privacy, validation, deadlines, transitions)
web/scripts/provision.mjs   creates trusted accounts + role documents (the only way roles are granted)
```

Data model: `users/{uid}` (role, no client writes) · `hospitals/{id}` (profile + availability) · `ambulances/{id}` ·
`cases/{id}` (+ `private/patient`, `events/*` append-only) · `offers/{caseId_hospitalId}`.

## Run it

```bash
cd web && npm install
npm run dev          # http://localhost:5173 against the real project (needs accounts, see below)
npm run check        # lint + types + 38 unit tests + 57 emulator tests + build
npm run test:e2e     # real Chrome, 5 simultaneous users, local emulators
npm run check:all    # everything
node scripts/mutate-rules.mjs   # prove the rules tests catch broken rules
```

Emulator tests need the Firebase CLI and a Java runtime (the Firestore emulator is a Java program).

**Local demo with emulators** (no cloud, safe to play with):

```bash
firebase emulators:start --only auth,firestore --project demo-goldenhour
node web/scripts/provision.mjs --emulator          # in a second terminal; every account password: Demo-pass-123!
VITE_USE_EMULATORS=1 npm run dev --prefix web
```

Accounts: `dispatcher1@goldenhour.demo`, `crew1…4@goldenhour.demo`, and one per hospital (`wenlock@`, `yenepoya@`, `kmc-attavar@`, …).
Those emulator passwords are public test values and work **only** against the local emulator.

## Production setup (project owner)

1. Firebase console → Authentication → *Get started* → enable **Email/Password** and **Anonymous** (both are required: reporters sign in anonymously) (free; do not upgrade to Identity Platform).
2. `node web/scripts/provision.mjs --prod` (Auth REST + Firestore REST, no key file) creates the staff accounts and seeds the demo hospitals/fleet using your own
   `gcloud` login. Passwords go to `.secrets/accounts.json` (git-ignored) and are never printed.
3. `firebase deploy --only firestore:rules,hosting`
4. `npm run verify:live --prefix web` signs in as the real production accounts (passwords read from `.secrets/`, never printed) and runs one clearly-labelled test case through the whole workflow plus negative permission checks. It adds a new closed case and never edits or deletes existing records.

## Tests (what they cover)

- **Unit (38):** eligibility, waves, qualification (missing capability, unavailable resource, ICU, antivenom), ranking, explanation,
  timeout / decline / withdraw / exhaustion planning, duplicates, routing fallback.
- **Emulator (57):** the security rules from every role's point of view (privilege escalation, privacy, validation, deadlines,
  transitions, audit immutability) plus full workflows: accept, decline, re-route, timeout, escalation, concurrent incidents,
  racing dispatchers, and multi-user real-time propagation.
- **Browser (22 steps):** five users in separate Chrome sessions through one complete case, phone-width layout and touch-target checks,
  offline queueing, role isolation, PWA files.
- **Mutation check (11):** deliberately broken rules must make the tests fail.

## Honest limitations

See [SECURITY.md](SECURITY.md). The important ones: there is no server, so **timeouts and re-routing only advance while a dispatcher
console is open**; the demo hospital data is invented; routing uses a best-effort public server; and this has had no clinical,
privacy or penetration review.
