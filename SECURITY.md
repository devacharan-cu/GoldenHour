# Security model and limitations

GoldenHour is a **demonstration**. It is not validated for real emergency dispatch, and nothing here makes it so.
Do not use it for real patients unless it is independently assessed, hardened, and operated by accountable people.

## What the security boundary is

There is **no backend**. The project stays on the Firebase Spark plan, where Cloud Functions and Cloud Run need a
billing account. That means:

- The **Firestore Security Rules (`firestore.rules`) are the only trusted enforcement point.** Everything in the
  browser (React code, the escalation engine, the matching logic) is *untrusted*: a determined user can modify it.
- The rules decide who can read and write what. The app is written so the UI follows the rules, never the other way round.
- Browser logic is **not** a trusted server-side boundary. Where a guarantee matters, it is enforced in the rules
  (see "What the rules enforce").

## Roles and how they are provisioned (no backend)

| Role | Source of truth | Who can create it |
|---|---|---|
| dispatcher, hospital, ambulance | document `users/{uid}` with `role`, `active`, `hospitalId` / `ambulanceId` | Only `web/scripts/provision.mjs`, run by a project owner |
| reporter | none: any signed-in user, including anonymous | Anyone (anonymous sign-in) |

- **No client can write `users/{uid}`** (`allow write: if false`). A user cannot grant themselves, or anyone else, a role.
  This is covered by tests and by a mutation check (flip that rule and the suite fails).
- `provision.mjs --prod` uses *your own `gcloud` login* (project owner) through the Admin SDK. No service-account key
  file is created or stored. Random passwords are written to `.secrets/accounts.json`, which is git-ignored.
- To add a hospital user: add an entry to `SEED_ACCOUNTS` in `web/src/lib/seed.ts` and run
  `node scripts/provision.mjs --prod`. To disable someone, set `active: false` on their `users/{uid}` document
  (console or script); the rules then deny them everything immediately.
- Staff accounts are email/password. There is no self-registration UI, **but** Firebase Auth's email sign-up endpoint
  is reachable by anyone who knows the project's public API key. An account created that way has *no role document*,
  so it has exactly the same powers as an anonymous reporter (it can file and read its own case, nothing else).
  Disabling sign-up outright needs Identity Platform, which needs billing, so it is not available here.

## What the rules enforce (and the tests prove)

- **Role separation:** hospitals see only cases they were asked about, and only their own offers; crews see only the
  case assigned to them; reporters see only their own case; unauthenticated users see nothing.
- **Patient data minimisation:** hospitals that were merely *asked* see a non-identifying clinical brief only. The
  reporter's phone number and free text (`cases/{id}/private/patient`) are released to dispatch, the assigned crew, the
  reporter, and the one hospital the dispatcher confirmed as the destination.
- **Destination integrity:** a case can only be given a destination whose offer is `accepted`, `canReceive == true`
  and has every required capability explicitly confirmed. An accept without full confirmation can never be selected,
  server-side. Choosing a hospital other than the recommendation requires a written reason in the same write.
- **Deadlines:** a hospital cannot answer after the offer deadline; dispatch cannot mark an offer timed out early.
  Both use the server's `request.time`.
- **Transitions:** crews can only move a case forward one step; transport cannot start without a confirmed destination.
- **Write validation:** field allow-lists, types, ranges, sizes and timestamps near server time; immutable
  reporter-supplied facts; no deletes anywhere.
- **Audit trail:** events are append-only (no update/delete), and the author fields must match the signed-in identity
  and role.

Run the proof yourself: `npm run test:emu` (57 tests) and `node scripts/mutate-rules.mjs` (11 deliberately broken
rule sets, all must be detected).

## Known limitations (read before trusting this)

1. **Escalation runs in a browser.** Timeouts, next-wave contact and re-recommendation are executed by an open
   dispatcher console (idempotent, safe with several consoles open). **If no dispatcher console is open, nothing
   advances automatically.** A real system needs a server-side scheduler.
2. **A compromised or malicious dispatcher** is trusted by the rules. The audit trail records what they did but
   cannot stop them. Dispatchers can also still read every case.
3. **A hospital can lie** about confirmations. The system records who confirmed what and when, but cannot verify
   that antivenom is really on the shelf.
4. **Public read of the Firebase web API key and project id** is normal and not secret, but means abuse of anonymous
   sign-in (spam cases) is possible. There is no rate limiting or App Check on this plan. Spark quotas
   (20k writes/day, 50k reads/day) would also be exhausted by a flood.
5. **Location data:** the scene location is visible to whoever may read the case. Ambulance GPS is only shared when the
   crew taps *Share my live GPS*; otherwise movement is a labelled simulation.
6. **Routing** uses the public OSRM demo server, which is best-effort. When it is slow or down, times fall back to
   straight-line estimates, and every estimate is labelled as such in the UI.
7. **Demo data:** hospital names are real institutions used for realism only. Coordinates are approximate, and
   capabilities, bed counts and availability are invented. They are **not** real records.
8. **Browser storage:** Firestore keeps an offline cache on the device. On shared devices, staff should sign out.
9. No penetration test, privacy impact assessment, clinical safety review, or regulatory approval has been done.
10. The legacy `incidents` collection from the first prototype still exists in the database (untouched); the new rules
    deny access to it.

Report security issues by opening a private advisory on the GitHub repository.
