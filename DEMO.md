# Demo runbook: one phone and three laptops

A complete emergency from report to hospital handover. **The phone is the reporter. Laptop 1 is the dispatcher, Laptop 2 is the
ambulance crew, Laptop 3 is the hospital.** Every role is a separate signed-in session and nothing is shortcut: the dispatcher
really assigns the crew, the crew really accepts, the hospital really confirms resources, and the hospital really confirms
receipt before the case can close.

**Live app:** https://goldenhour-46131.web.app  ·  **Time:** about 8 to 10 minutes  ·  **Needs:** internet on all four devices.

> Demonstration with invented hospital data. Use synthetic patient details only. In a real emergency in India, call 112.

## Before you start (5 minutes, once)

1. **Logins.** Open `.secrets/DEMO-LOGINS.html` on the computer where the project lives. It is git-ignored and is never printed to a
   terminal or committed. It lists every account with *Copy* and *Show* buttons. All demo staff accounts share one short temporary
   password, so typing it on three laptops is easy. To change it later: `node web/scripts/provision.mjs --prod --easy`
   (a new temporary password) or `--reset-passwords` (long random passwords), then `node web/scripts/demo-logins.mjs --open`.
   Check the roles any time with `node web/scripts/verify-accounts.mjs`.
2. **Sign in on each laptop before the judges arrive**, so the screens are already open:

| Device | Who | Account (email) | What you see |
|---|---|---|---|
| Phone | Reporter | none (guest) | Report an emergency |
| Laptop 1 | Dispatcher | `dispatcher1@goldenhour.demo` | Live |
| Laptop 2 | Ambulance crew, Medic 1 | `crew1@goldenhour.demo` | Mission |
| Laptop 2, second window (Incognito) | Ambulance crew, Medic 2 | `crew2@goldenhour.demo` | Mission |
| Laptop 3 | Hospital that accepts | `wenlock@goldenhour.demo` | Cases |
| Laptop 3, second window (Incognito) | Hospital that declines | `yenepoya@goldenhour.demo` | Cases |

   Staff sign in at the home page (**Sign in** panel). A guest session never blocks this.
3. **Leave the Laptop 1 dispatcher window open for the whole demo.** It runs the hospital pre-alert, deadlines and re-routing. With
   no dispatcher window open nothing advances automatically (see *Known limits* in `SECURITY.md`).
4. **Phone.** Use Chrome or Safari. On first use allow the **camera**, **microphone** and **location** when asked.
   Optional: *Account and settings*, turn on sounds on the laptops; the sun/moon button switches light and dark.

For the snakebite scenario only hospitals that list **antivenom** are asked: Wenlock, Yenepoya, Father Muller and Srinivas.
Wenlock is closest to the demo location, so it is recommended first.

## The script

### 1. Phone: report an emergency
1. Open the app, tap **Report an emergency**.
2. **What happened:** **Snakebite**, **Critical**, 1 patient. Next.
3. **Where:** tap **Use my location** and allow GPS, or pick **Hampankatta junction** from the demo places. Next.
4. **Details and evidence:** type *Adult man, snake bite on the left leg, conscious*, a phone number and a short note. Then:
   - **Take a photo** opens the live rear camera with a shutter. Take one, try **Retake**, then **Use this photo**.
   - **Record a voice note** (microphone), **Record a video** (up to 45 seconds), **PDF or audio file** or **Photo or video from gallery** for existing files.
   - (Optional) try an `.exe` or an oversized video to show the clear rejection messages. Next.
5. **Review** everything, then **Send to dispatch**.

**Expect on the phone:** a tracking page with the **Relay Track** (the baton is on *Dispatcher*), a golden-hour ring, a **receipt code**,
and each file moving from *Uploading* to *Uploaded and confirmed by the server*. Say what you see: nothing is called uploaded while it
is only on the phone. Copy the receipt code (or use *Share*) for step 10.

### 2. Laptop 1 (dispatcher): the incident arrives live
1. The new case appears at the top of the queue instantly, marked **Your move**. Open it.
2. See the private phone number and the files. Press **Load** on the audio, video and document: each shows *Checksum verified*.
3. **AI-assisted briefing:** press **Analyse report**. A draft labelled **AI-generated** appears (transcript, facts, missing information,
   uncertainties). Edit the handoff text, then **Review done: share with crew and hospitals**.
   *(Requires the one-time AI setup, see "Gemini" below. The rest of the demo works without it.)*

**Expect:** the crew and hospitals only ever see the reviewed briefing, never the draft.

### 3. Laptop 1: assign a crew (and show a decline)
1. In **Crew**, pick **Medic 1**, press **Send the offer to Medic 1**.
2. Laptop 2, window Medic 1: an **Incoming dispatch** card appears (*Your move*). Choose **Decline**, give a reason, confirm.
3. Laptop 1: *Medic 1 declined* with the reason, and Medic 1 cannot be offered this case again. Offer it to **Medic 2**.

**Expect on Laptop 3:** nothing yet. No hospital is contacted until a crew **accepts**.

### 4. Laptop 2: the crew accepts and drives
1. Medic 2 window: **Accept this dispatch**. See the incident details and the map.
2. Choose **Share my live GPS** (allow location) for a real position, or **Demo: simulate this drive** for movement along the road route.

**Expect on all screens:** the crew marker moves, stamped **Live GPS** (real) or **Simulated** (demonstration drive) everywhere.

### 5. Laptop 3 (hospital): the pre-alert, while the ambulance is still travelling
Within about a second of the crew accepting, the case appears in the hospital's **Cases** list with a countdown.

1. Open it. See the reviewed AI briefing, the evidence, the live ambulance position and ETA. The reporter's phone number is **not** shown.
2. **Accept** is locked. Tick **Antivenom is physically in stock right now** and **We can receive this patient**, then **Accept this patient**.
3. In the second window (Yenepoya): choose a reason, optionally pick **another hospital you think is better placed**, press **Decline**.
   It **immediately loses access** to the case, files and briefing.

**Expect on Laptop 1:** each hospital's answer (opened, confirmations, answer time). Under the decline you see *"Yenepoya suggests X
instead. This is a suggestion only."* with **Ask X now**. That hospital gets an ordinary request and must still accept and confirm
before it can be chosen. A decline never skips a confirmation.

### 6. Laptop 1: destination
A **Recommended** hospital appears with plain reasons. Press **Approve and confirm**. (To show an override, choose another confirmed
hospital and give a written reason, which goes into the audit trail.)

**Expect:** Laptop 2 is told the destination and must **acknowledge** it. Laptop 3 shows *You are the confirmed destination* and now
receives the reporter's phone number. The phone tracking page names the hospital.

### 7. Laptop 2: pickup and transport
**I am at the scene**, then **Acknowledge** the destination, then **Patient picked up, leave for hospital**. (Transport cannot start
before the acknowledgement.) Then **I am at the hospital**.

### 8. Laptop 3: handover
Press **Confirm we received the patient**. Until then the dispatcher's **Close the case** button is locked.

### 9. Laptop 1: close
Press **Close the case and free the ambulance**. The ambulance is available again on every screen, and the phone shows the report as
closed (*completed*).

### 10. Show the history, the receipt and an account
- **Laptop 1, History:** search *snakebite* or *Wenlock*, filter by status, open the case for the full audit trail and files.
  Reload or sign out and in: it is still there.
- **Phone (or a private window):** paste the **receipt code or link** into *Reopen a report*. It opens on a second device. A wrong code,
  or only the case ID, opens nothing.
- **Phone, Account and settings, Create an account:** the guest enters an email and password (or **Continue with Google**). The
  report moves into the account; sign out and back in and it is still listed under *Your reports*.

## Extra moments worth showing
- **False or accidental report.** Report a second case. As the reporter, tap *Sent by mistake? Withdraw this report* (only possible before a
  crew has been offered the case). Or as dispatcher open a case and use **End this case without a hospital**: choose *False report*,
  *Accidental report*, *Duplicate* or *Cancelled*, write a reason, tick the confirmation. Nothing is deleted: it stays in
  **History** (filter *False reports*) with the reason and an audit entry, the ambulance is released and hospitals are stood down.
  It is not possible once the patient is on board; the hand-over finishes the case.
- **Offline.** On the phone turn on airplane mode after filling in a report with a photo, then send. It says **Saved on this device only**.
  Turn the network back on: it uploads itself and flips to *Uploaded and confirmed*.
- **Escalation.** Let every asked hospital decline, or ignore a request for 90 seconds: the next hospitals are asked automatically.
- **Dark mode.** The sun/moon button. Dark is true black; the logo reverses (white paper, black watch).

## Gemini (real AI)
The code calls `gemini-3.5-flash` through Firebase AI Logic. It works only after the one-time console step: open the Firebase console for
`goldenhour-46131`, **AI Logic, Get started, Gemini Developer API**. Verify with `cd web && npm run verify:ai`, which sends one labelled
synthetic case with a real image through the app's own code path and prints the briefing. Until that passes, say plainly that the AI step
was not shown live.

## If something looks wrong
| Symptom | Fix |
|---|---|
| Cannot sign in | Check the email and password in the logins page. A guest session never blocks sign-in. *Account menu, Leave and erase this device* resets a shared browser. |
| Nothing reaches hospitals after the crew accepts | A dispatcher window must be open; check it is signed in and online. |
| Camera does not open on the phone | Allow the camera for the site (lock icon in the address bar). The camera screen offers *Use my phone's camera app* as a fallback. |
| No sound | Browsers allow sound only after the page was clicked once; turn it on in *Account and settings*. |
| GPS does nothing | Allow location. Desktop GPS can be inaccurate: use the simulated drive. |
| "The AI is not available" | The Firebase AI Logic console step has not been done (see above). Everything else works without it. |

Demo cases stay on record (closed) in History. Use clearly fake details so they are easy to recognise.
