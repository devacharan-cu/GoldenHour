# Security model and limitations

GoldenHour is a **demonstration**. It is not validated for real emergency dispatch, and nothing here makes it so.
Do not use it for real patients unless it is independently assessed, hardened, and operated by accountable people.

## What the security boundary is

There is **no backend**. The project stays on the Firebase Spark plan, where Cloud Functions, Cloud Run and Cloud Storage need a billing account. So:

- **Firestore Security Rules (`firestore.rules`) are the only trusted enforcement point.** Everything in the browser (React, the escalation engine, matching, the AI call) is *untrusted*: a determined user can modify it.
- The app is written so the UI follows the rules, never the reverse. Where a guarantee matters it is in the rules, and rules tests prove it.
- Browser logic is **not** a trusted server-side boundary, and this document does not claim it is.

## Roles and how they are provisioned (no backend)

| Role | Source of truth | Who can create it |
|---|---|---|
| dispatcher, hospital, ambulance | `users/{uid}` with `role`, `active`, `hospitalId` or `ambulanceId` | Only `web/scripts/provision.mjs`, run by a project owner with their own `gcloud` login |
| reporter | none: any signed-in user, including anonymous | Anyone |

- **No client can write `users/{uid}`**. A user cannot grant themselves or anyone else a role. Tested, and covered by a mutation check.
- `provision.mjs --prod` calls the Auth and Firestore REST APIs with your own `gcloud` token. No service-account key file is created. Random passwords go to `.secrets/accounts.json` (git-ignored) and are never printed.
- To disable someone set `active: false` on their `users/{uid}` document; every rule then denies them immediately.
- Email sign-up cannot be switched off without Identity Platform (billing). An account created that way has **no role document**, so it has exactly a reporter's powers. The app tells such users they have no staff access.
- A guest (anonymous) session never blocks staff sign-in. The earlier "login does not work" bug was exactly that: a persisted guest session made the app skip the sign-in screen.

## What the rules enforce (and the tests prove)

- **Role separation and least access.** Dispatch sees all cases. A crew sees only the case assigned to it, and loses it if it declines. A hospital sees a case only while it is **active** on it (asked and not declined, timed out or stood down); `activeHospitalIds` is changed atomically with the decline. A reporter sees only their own case, or one they proved they own by receipt.
- **Receipts, not IDs.** Case IDs grant nothing. A reporter's receipt is `<caseId>.<secret>`; only the **SHA-256 of the secret** is stored on the case, and presenting the secret creates a `claims/{uid}` document (checked with the rules' `hashing.sha256`) that grants read access to that one session. Guessing is infeasible (192-bit secret).
- **Patient data minimisation.** Hospitals asked only see a non-identifying brief. Phone number and free text are released to dispatch, the assigned crew, the reporter and, after dispatch confirms the destination, that one hospital.
- **Evidence access.** Files are readable only by people who can read the case (above). Hospitals lose access to files the moment they decline. Only the reporter (or receipt holder, or dispatch) may add files, only while the case is open, only with allow-listed MIME types, size caps and a consistent chunk count; chunks are immutable and finished evidence cannot be deleted.
- **Workflow integrity.** A destination can only be a hospital whose offer is accepted, able to receive, and has confirmed every required capability; a non-recommended choice needs a written reason; transport needs a confirmed destination **and** the crew's acknowledgement; a case that arrived cannot be closed before the hospital confirms receipt; crews can only move forward one step; deadlines use the server clock.
- **One ambulance, one case.** `currentCaseId` can only be set while empty and only for a case that names the unit, so two dispatchers racing cannot double-book it.
- **AI documents.** Only dispatch can write them, only if labelled AI-generated; the draft is dispatch-only; the shared handoff needs a named, timestamped reviewer and is readable only by the crew and active hospitals.
- **Audit trail.** Events are append-only, authored as the signed-in identity and role.
- **Preferences.** `userPrefs/{uid}` is private and validated.

Prove it yourself: `npm run test:emu` and `node web/scripts/mutate-rules.mjs` (each deliberately weakened rule set must make the tests fail).

## AI: privacy, abuse protection and limits

- Gemini is called through **Firebase AI Logic** (Gemini Developer API, Spark plan). The Gemini API key is held by Firebase and is **never** in the frontend, `.env` files or this repository.
- **App Check** with reCAPTCHA Enterprise (site key public by design) lets Firebase refuse calls from scripts and other sites; Firebase AI Logic also rate-limits per user. Enforcement for the AI endpoint is turned on only after a verified call.
- **Privacy:** report text and attached files are sent to Google to be analysed. Use **synthetic data only** here. Under Google's no-cost Gemini Developer API terms, content may be used to improve Google products, so do not send real patient information.
- The browser of the **dispatcher** sends the data, not the reporter's, so reporters cannot trigger or forge AI output.
- The model is constrained by instruction and by code: diagnosis, treatment advice, resource claims and dispatch recommendations are stripped and flagged; malformed answers are rejected.

## Known limitations (read before trusting this)

1. **Escalation runs in a browser.** The hospital pre-alert after a crew accepts, deadline handling and next-wave contact run in an open dispatcher console (idempotent and safe with several open). **With none open, nothing advances automatically.** A real system needs a server-side scheduler.
2. **A malicious dispatcher** is trusted by the rules. The audit trail records their actions but cannot stop them.
3. **A hospital can lie** about confirmations. The system records who confirmed what and when, but cannot verify that antivenom is on the shelf.
4. **Evidence is held as Firestore chunks, not in object storage.** It inherits Firestore's quotas (a flood of uploads can exhaust the free daily writes). A reporter can create up to the rule-bounded number of files per case; there is no per-user rate limit on this plan.
5. **Abuse:** anyone can start anonymous sessions and file spam reports. App Check protects the AI endpoint but is **not** enforced on Firestore here, because enforcing it for every client would block legitimate offline use and the receipt flow in this demonstration.
6. **Client caches.** Firestore keeps an offline cache and the app queues uploads on the device. Sign-out erases both, but if someone closes a shared browser without signing out, the next person could see cached data. Staff must sign out on shared computers.
7. **The `.secrets` folder lives inside a OneDrive-synced directory** on the developer machine, so Microsoft OneDrive may sync it. Move the repository out of OneDrive or exclude `.secrets` from sync, and rotate with `--reset-passwords` if in doubt.
8. **Location and routing:** scene location is visible to whoever may read the case. Ambulance GPS is shared only when the crew taps *Share my live GPS*; otherwise movement is a labelled simulation. Routing uses the public OSRM demo server with labelled estimates as fallback.
9. **Demo data:** hospital names are real institutions used for realism; coordinates are approximate and capabilities, beds and availability are invented.
10. No penetration test, privacy impact assessment, clinical safety review or regulatory approval has been done.
11. The legacy `incidents` collection from the first prototype still exists (untouched); the rules deny access to it. Older `cases` written before this version are read with safe defaults.

Report security issues by opening a private advisory on the GitHub repository.
