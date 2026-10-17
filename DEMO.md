# Three-laptop demonstration runbook

A complete emergency from report to hospital handover, on three physical laptops. Every role is a separate signed-in
session, and nothing is shortcut: the dispatcher really assigns the crew, the crew really accepts, hospitals really
confirm, and the hospital really confirms receipt before the case can close.

**Live app:** https://goldenhour-46131.web.app  ·  **Time:** about 10 minutes  ·  **Needs:** Chrome on each laptop, internet.

> This is a demonstration with invented hospital data. Use synthetic patient details only. In a real emergency in India, call 112.

## Before you start

1. **Logins.** Open `.secrets/DEMO-LOGINS.html` (a private file on the computer where the project lives; it is git-ignored and
   never printed). It lists every account with copy buttons. Regenerate it any time with
   `node web/scripts/provision.mjs --prod` then `node web/scripts/demo-logins.mjs --open`.
   Copy the file to the other laptops by a private route (USB, not email or chat).
2. **Windows.** Laptop 2 needs two separate sessions: one normal Chrome window and one **Incognito** window (or two Chrome profiles).
3. **Optional polish.** On each staff screen open the account menu, then *Account and settings*: turn on a sound for new work,
   and (Laptop 3 / Laptop 2) allow desktop notifications. Light and dark themes are one tap in the top bar.
4. **Dispatcher console stays open.** The hospital pre-alert, deadlines and re-routing are handled by the open dispatcher
   console. Do not close that window during the demo.

| Laptop | Who | Account | Screen |
|---|---|---|---|
| 1 | Reporter | none needed (guest) | Report an emergency |
| 2, window A | Dispatcher | `dispatcher1@goldenhour.demo` | Live |
| 2, window B (Incognito) | Ambulance crew, Medic 1 | `crew1@goldenhour.demo` | Mission |
| 2 (optional second crew) | Medic 2 | `crew2@goldenhour.demo` | Mission |
| 3 | Hospital A (accepts) | `wenlock@goldenhour.demo` | Cases |
| 3 (second window, optional) | Hospital B (declines) | `yenepoya@goldenhour.demo` | Cases |

For the snakebite scenario below, only hospitals that list **antivenom** on their profile are asked: Wenlock, Yenepoya,
Father Muller and Srinivas. Wenlock is the closest to the demo location, so it is recommended first.

## The script

### 1. Laptop 1: the reporter files an emergency
1. Open the app. Choose **Report an emergency**.
2. **What happened:** pick **Snakebite**, **Critical**, 1 patient. Next.
3. **Where:** choose **Hampankatta junction** from the demo places (or tap *Use my location* and allow GPS). Next.
4. **Details and evidence:** type a summary such as *Adult man, snake bite on the left leg, conscious*. Add a phone number and some detail.
   Add evidence: **Take a photo** (camera), **Record a voice note** (microphone), **Choose files** for a PDF and a short video.
   Try an `.exe` or a very large video to see the clear rejection messages. Next.
5. **Review:** check everything, then **Send to dispatch**.

**Expect (Laptop 1):** a tracking page with the **Relay Track** showing the baton on *Dispatcher*, a golden-hour ring, a **receipt code**
(copy it), and an upload list moving from *Uploading* to *Uploaded and confirmed by the server* for every file.

### 2. Laptop 2, window A: the dispatcher reviews and uses the AI
1. The new case appears at the top of the queue instantly with **Your move**. Open it.
2. See the private phone number and detail, and the files. Click **Load audio / Load video / Load document**: each shows *Checksum verified*.
3. In **AI-assisted briefing**, press **Analyse report**. A draft appears labelled **AI-generated**: an audio transcript, facts, missing information and uncertainties.
4. Correct the handoff text, then **Review done: share with crew and hospitals**.

**Expect:** hospitals and the crew can only see the *reviewed* briefing, never the draft.

### 3. Laptop 2: assign a crew (and show a decline)
1. In **Crew**, choose **Medic 1** and **Send the offer to Medic 1**.
2. Window B (crew): an **Incoming dispatch** card appears with **Your move**. Choose **Decline**, give a reason, confirm.
3. Window A: *Medic 1 declined this case* with the reason. Medic 1 can no longer be chosen for this case. Choose **Medic 2** (or accept as Medic 1 if you skip the decline).

**Expect (Laptop 3):** still nothing. No hospital is contacted until a crew **accepts**.

### 4. The crew accepts and drives
1. The crew taps **Accept this dispatch**.
2. On the crew screen choose **Share my live GPS** (allow location) for a real position, or **Demo: simulate this drive** for movement along the road route.

**Expect (all screens):** the crew marker moves. Real GPS is stamped **Live GPS**; the demonstration drive is stamped **Simulated** on every screen.

### 5. Laptop 3: the hospital pre-alert
**Within about a second of the crew accepting,** the case appears in the hospital's **Cases** list with a countdown.

1. Open it. See the reviewed AI briefing (labelled AI-generated), the evidence, the live ambulance position and ETA. The reporter's phone number is **not** shown.
2. The **Accept** button is locked. Tick **Antivenom is physically in stock right now** and **We can receive this patient**, then **Accept this patient**.
3. (Optional) In a second window, the other hospital chooses **Decline**. It immediately loses access to the case, files and briefing.

### 6. Laptop 2, window A: destination
The dispatcher sees each hospital's response (opened, confirmed, answer time) and a **Recommended** hospital with the reasons.
Press **Approve and confirm**. (To demonstrate an override, choose another confirmed hospital and give a written reason.)

**Expect:** the crew is told the destination and must **acknowledge** it; the hospital sees *You are the confirmed destination* and now gets the reporter's phone number.

### 7. The crew picks up and delivers
1. Crew: **I am at the scene**, then **Acknowledge** the destination, then **Patient picked up, leave for hospital**. Transport cannot start before the acknowledgement.
2. Crew: **I am at the hospital**.

### 8. Laptop 3: handover
Press **Confirm we received the patient**. Until then the dispatcher's **Close the case** button is locked.

### 9. Laptop 2, window A: close
Press **Close the case and free the ambulance**. The ambulance becomes available again on every screen.

### 10. Show the history and the receipt
- Dispatcher: **History** shows the case. Search for *snakebite* or *Wenlock*, filter by status, open it to see the full audit trail and files. Reload or sign out and in: it is still there.
- Laptop 1 (or a phone in a new private window): paste the **receipt code** into *Reopen a report* on the home page: the report opens on a second device. A wrong code, or just the case ID, opens nothing.

## Extra moments worth showing
- **Offline.** On a phone, turn on airplane mode after filling in a report with a photo, then send. It says **Saved on this device only** and shows the file as *not sent*. Turn the network back on: it sends itself and the status changes to *Uploaded and confirmed*.
- **Dark and light mode.** The sun/moon button in the top bar; *Account and settings* offers *Match my device*, text size and calm motion.
- **Escalation.** Have every asked hospital decline, or ignore a request for 90 seconds: the next hospitals are asked automatically, and if nobody qualifies the dispatcher is told clearly.

## If something looks wrong
| Symptom | Fix |
|---|---|
| Cannot sign in | Check the email and password from the logins page. If a guest session was open, just use the sign-in form: it replaces it. *Account menu, Leave and erase this device* resets a shared browser. |
| Nothing reaches hospitals after the crew accepts | A dispatcher console must be open (it runs the pre-alert). Check the dispatcher window is signed in and online. |
| No sound | Browsers allow sound only after the page has been clicked once; turn it on in *Account and settings*. |
| GPS does nothing | Allow location for the site. Desktop browsers may be inaccurate; use the demonstration drive instead. |
| "The AI is not available" | The AI needs the one-time Firebase AI Logic setup (README, *Production setup*). Everything else works without it. |

Demo cases stay on record (closed) in History. They are labelled by their summary text; use clearly fake details.
