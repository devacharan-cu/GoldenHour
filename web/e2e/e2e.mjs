// Real-browser, multi-user end-to-end test against the local Firebase emulators.
// Run with: npm run test:e2e   (starts emulators, provisions disposable test accounts, starts Vite, drives Chrome)
// Everything stays on localhost. The test password exists only in the emulator and is not valid anywhere else.
//
// "Laptops": the reporter, dispatcher and hospital run in separate browser contexts (separate sessions, cookies and
// storage), and the crews in two more, so every role is a genuinely distinct authenticated session.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const PORT = 5199
const BASE = `http://localhost:${PORT}`
const PASSWORD = 'Demo-pass-123!'
const OUT = fileURLToPath(new URL('../test-results/', import.meta.url))
mkdirSync(OUT, { recursive: true })
const ICON = readFileSync(fileURLToPath(new URL('../public/icons/icon-192.png', import.meta.url)))

const results = []
const step = async (name, fn) => {
  const t = Date.now()
  try { await fn(); results.push({ name, ok: true }); console.log(`  ✓ ${name} (${Date.now() - t} ms)`) } catch (e) {
    results.push({ name, ok: false }); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 7).join('\n      ')}`)
    throw e
  }
}
const section = (s) => console.log(`\n${s}`)

console.log('Provisioning emulator accounts…')
execFileSync('node', ['scripts/provision.mjs', '--emulator'], { stdio: 'inherit' })

console.log('Starting Vite against emulators…')
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', 'localhost'], { shell: true, env: { ...process.env, VITE_USE_EMULATORS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let viteLog = ''
vite.stdout.on('data', (d) => (viteLog += d))
vite.stderr.on('data', (d) => (viteLog += d))
const killVite = () => { try { execFileSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ } }
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(BASE)).ok) break } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500))
  if (i === 79) { console.error(viteLog); killVite(); process.exit(1) }
}

let browser
const contexts = []
let failed = false
async function waitUntil(fn, message, ms = 25000) {
  const start = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - start > ms) throw new Error(`timed out: ${message}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ channel: 'msedge', headless: true }))
  const phone = { width: 390, height: 844 }
  const laptop = { width: 1366, height: 860 }
  const T = { timeout: 25000 }

  const open = async (name, viewport, extra = {}) => {
    const ctx = await browser.newContext({ viewport, serviceWorkers: 'block', ...extra })
    contexts.push(ctx)
    const page = await ctx.newPage()
    page.name = name
    page.logs = []
    page.on('console', (m) => { if (m.type() === 'error') page.logs.push(m.text().slice(0, 240)) })
    page.on('pageerror', (e) => { if (!/ResizeObserver/.test(e.message)) page.logs.push(`pageerror: ${e.message}`) })
    return page
  }
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: true })
  const noOverflow = async (page, label) => {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
    assert.ok(o.sw <= o.cw + 1, `${label}: horizontal overflow (${o.sw} > ${o.cw})`)
  }
  const targets = async (page, label) => {
    const small = await page.evaluate(() => [...document.querySelectorAll('button, a.btn, select, input[type=checkbox], input[type=radio]')]
      .filter((el) => el.offsetParent && !el.closest('.leaflet-container') && !el.classList.contains('sr-only') && !el.closest('.switch'))
      .map((el) => { const b = (el.type === 'checkbox' ? el.closest('label') ?? el : el).getBoundingClientRect(); return { t: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 28), h: Math.round(b.height), w: Math.round(b.width) } })
      .filter((x) => x.h < 36 || x.w < 36))
    assert.equal(small.length, 0, `${label}: touch targets under 36px: ${JSON.stringify(small)}`)
  }
  const login = async (page, email) => {
    await page.goto(BASE)
    await page.locator('#signin-email').fill(email)
    await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  }
  const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme)
  const rem = (page) => page.evaluate(() => getComputedStyle(document.documentElement).fontSize)
  // Playwright's label matching takes strings, so find the full option text first.
  const pickOption = async (select, re) => {
    const labels = await select.locator('option').allInnerTexts()
    const hit = labels.find((l) => re.test(l))
    assert.ok(hit, `no option matching ${re} in ${JSON.stringify(labels)}`)
    await select.selectOption({ label: hit })
  }
  const strip = (page, text) => page.locator('button.strip', { hasText: text }).first()
  const mainNav = (page, name) => page.getByRole('navigation', { name: 'Main' }).first().getByRole('button', { name })

  // ===========================================================================================================
  section('Sign-in, sessions and roles')
  const guest = await open('guest-phone', phone, { hasTouch: true, isMobile: true })

  await step('landing is usable on a phone and offers sign-in without a click', async () => {
    await guest.goto(BASE)
    await guest.getByRole('button', { name: /Report an emergency/ }).first().waitFor(T)
    await guest.locator('#signin-email').waitFor(T)
    await noOverflow(guest, 'landing'); await targets(guest, 'landing')
    await shot(guest, '01-landing-light-phone')
  })

  await step('wrong password gives a clear message and does not sign in', async () => {
    await guest.locator('#signin-email').fill('dispatcher1@goldenhour.demo')
    await guest.getByLabel('Password', { exact: true }).fill('definitely-wrong')
    await guest.getByRole('button', { name: 'Sign in', exact: true }).click()
    await guest.getByText('Email or password is incorrect.').waitFor(T)
    assert.equal(await guest.getByRole('button', { name: 'Account menu' }).count(), 0)
  })

  await step('forgot-password path explains what will happen', async () => {
    await guest.getByRole('button', { name: 'Forgot your password?' }).click()
    await guest.getByRole('button', { name: 'Email me a reset link' }).waitFor(T)
    await guest.getByRole('button', { name: 'Back to sign in' }).click()
  })

  await step('ROOT-CAUSE REGRESSION: a guest session no longer hides staff sign-in', async () => {
    // Opening the report form creates an anonymous session. Previously that made the sign-in form unreachable.
    await guest.getByRole('button', { name: /Report an emergency/ }).first().click()
    await guest.getByRole('heading', { name: 'What happened' }).waitFor(T)
    await guest.waitForTimeout(1500) // let the quiet anonymous sign-in complete
    await guest.goto(BASE) // back to the front door, still holding the guest session
    await guest.locator('#signin-email').waitFor(T)
    await guest.locator('#signin-email').fill('dispatcher1@goldenhour.demo')
    await guest.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await guest.getByRole('button', { name: 'Sign in', exact: true }).click()
    await guest.locator('.kpis').waitFor(T) // the dispatcher console
  })

  await step('session is restored after a reload, and the role is right', async () => {
    await guest.reload()
    await guest.locator('.kpis').waitFor(T)
    assert.equal(await guest.getByLabel('Password', { exact: true }).count(), 0, 'must not show sign-in again')
  })

  await step('sign-out erases the device and a different role then gets its own dashboard, with nothing leaking', async () => {
    await guest.getByRole('button', { name: 'Account menu' }).click()
    await guest.getByRole('menuitem', { name: /Sign out/ }).click()
    await guest.locator('#signin-email').waitFor(T)
    await guest.reload()
    await guest.locator('#signin-email').waitFor(T) // still signed out after reload
    await guest.locator('#signin-email').fill('crew1@goldenhour.demo')
    await guest.getByLabel('Password', { exact: true }).fill(PASSWORD)
    await guest.getByRole('button', { name: 'Sign in', exact: true }).click()
    await guest.getByRole('heading', { name: 'Medic 1' }).waitFor(T)
    assert.equal(await guest.locator('.kpis').count(), 0, 'a crew account must never see dispatcher controls')
    assert.equal(await guest.getByText('Log a call').count(), 0)
    await shot(guest, '02-crew-standby-light-phone')
  })

  await step('each role lands on its own dashboard', async () => {
    const hosp = await open('hospital-check', laptop)
    await login(hosp, 'wenlock@goldenhour.demo')
    await hosp.getByRole('heading', { name: 'Wenlock District Hospital' }).waitFor(T)
    assert.equal(await hosp.locator('.kpis').count(), 0)
    await hosp.getByRole('tab', { name: 'Our hospital' }).click()
    await hosp.getByText('What this hospital can do').waitFor(T)
    await hosp.close()
  })

  await step('an account with no staff role is told so and cannot see staff screens', async () => {
    const r = await fetch('http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'norole@goldenhour.demo', password: PASSWORD, returnSecureToken: true }) })
    assert.equal(r.status, 200)
    const p = await open('norole', laptop)
    await login(p, 'norole@goldenhour.demo')
    await p.getByText('You are signed in, but this account has no staff access').waitFor(T)
    assert.equal(await p.locator('.kpis').count(), 0)
    await p.goto(`${BASE}/#/history`)
    await p.getByText('You are signed in, but this account has no staff access').waitFor(T)
    await p.close()
  })

  // ===========================================================================================================
  section('Appearance and settings')
  const settings = await open('settings', laptop)
  await step('light and dark themes switch instantly, persist across reloads, and follow the person to another device', async () => {
    await login(settings, 'dispatcher2@goldenhour.demo')
    await settings.locator('.kpis').waitFor(T)
    assert.equal(await theme(settings), 'light')
    await shot(settings, '03-dispatcher-empty-light')
    await settings.getByRole('button', { name: 'Switch to the dark theme' }).click()
    assert.equal(await theme(settings), 'dark')
    await shot(settings, '04-dispatcher-empty-dark')
    await settings.reload()
    await settings.locator('.kpis').waitFor(T)
    assert.equal(await theme(settings), 'dark', 'theme must survive a reload with no flash')
    const second = await open('settings-second-device', laptop)
    await login(second, 'dispatcher2@goldenhour.demo')
    await second.locator('.kpis').waitFor(T)
    await waitUntil(async () => (await theme(second)) === 'dark', 'preferences should sync to a second device')
    await second.close()
  })

  await step('settings page: profile details, theme choice, text size, calm motion and alerts', async () => {
    await settings.getByRole('button', { name: 'Account menu' }).click()
    await settings.getByRole('menuitem', { name: /Account and settings/ }).click()
    await settings.getByRole('heading', { name: 'Account and settings' }).waitFor(T)
    await settings.getByText('Dispatcher 2').first().waitFor(T)
    await settings.getByText('dispatcher2@goldenhour.demo').first().waitFor(T)
    await settings.getByRole('button', { name: /^Light/ }).click()
    assert.equal(await theme(settings), 'light')
    assert.equal(await rem(settings), '16px')
    await settings.getByRole('button', { name: 'Large', exact: true }).click()
    assert.equal(await rem(settings), '18px')
    await settings.getByRole('button', { name: 'Extra large' }).click()
    assert.equal(await rem(settings), '20px')
    await noOverflow(settings, 'account at extra large text')
    await settings.getByRole('button', { name: 'Normal', exact: true }).click()
    await settings.getByRole('switch', { name: /Calm motion/ }).check({ force: true })
    assert.equal(await settings.evaluate(() => document.documentElement.dataset.motion), 'reduced')
    await settings.getByRole('switch', { name: /Compact lists/ }).check({ force: true })
    assert.equal(await settings.evaluate(() => document.documentElement.dataset.compact), 'on')
    await settings.getByText('Alerts for new work').waitFor(T)
    await shot(settings, '05-account-light')
  })

  await step('password change validates input and rejects a wrong current password', async () => {
    await settings.getByLabel('Current password').fill('not-the-password')
    await settings.getByLabel('New password', { exact: true }).fill('short')
    await settings.getByLabel('New password again').fill('short')
    await settings.getByText('Use at least 8 characters.').waitFor(T)
    await settings.getByLabel('New password', { exact: true }).fill('a-new-long-password')
    await settings.getByLabel('New password again').fill('a-new-long-password')
    await settings.getByRole('button', { name: 'Change password' }).click()
    await settings.getByText('Email or password is incorrect.').waitFor(T) // wrong current password
  })

  // ===========================================================================================================
  section('The whole emergency, across independent sessions')
  const reporter = await open('laptop1-reporter', laptop)
  const dispatcher = await open('laptop2-dispatcher', laptop)
  const crew1 = await open('laptop2-crew1', phone, { hasTouch: true, isMobile: true })
  const crew2 = await open('laptop2-crew2', phone, { hasTouch: true, isMobile: true, permissions: ['geolocation'], geolocation: { latitude: 12.8712, longitude: 74.8431, accuracy: 20 } })
  const wenlock = await open('laptop3-hospital', laptop)
  const yenepoya = await open('hospital-declines', laptop)
  let receipt = ''

  await step('staff sign in on their own sessions', async () => {
    await login(dispatcher, 'dispatcher1@goldenhour.demo')
    await login(crew1, 'crew1@goldenhour.demo')
    await login(crew2, 'crew2@goldenhour.demo')
    await login(wenlock, 'wenlock@goldenhour.demo')
    await login(yenepoya, 'yenepoya@goldenhour.demo')
    await dispatcher.locator('.kpis').waitFor(T)
    await crew1.getByRole('heading', { name: 'Medic 1' }).waitFor(T)
    await wenlock.getByRole('heading', { name: 'Wenlock District Hospital' }).waitFor(T)
    await dispatcher.getByText('No open cases').waitFor(T)
  })

  await step('LAPTOP 1: the reporter files a snakebite with a photo, voice note, document and video', async () => {
    await reporter.goto(BASE)
    await reporter.getByRole('button', { name: /Report an emergency/ }).first().click()
    await reporter.getByRole('button', { name: 'Snakebite' }).click()
    await reporter.getByRole('button', { name: 'Critical' }).click()
    await reporter.getByRole('button', { name: 'Next' }).click()
    await reporter.getByRole('heading', { name: 'Where' }).waitFor(T)
    assert.ok(await reporter.getByRole('button', { name: /Set the location/ }).isDisabled(), 'cannot continue without a location')
    await reporter.getByLabel('Pick a demo place').selectOption({ label: 'Hampankatta junction' })
    await reporter.getByRole('button', { name: 'Next' }).click()
    await reporter.getByRole('heading', { name: 'Details and evidence' }).waitFor(T)
    await reporter.getByPlaceholder('Adult man, bitten on the leg, conscious').fill('Adult man, snake bite on the left leg, conscious')
    await reporter.getByPlaceholder('Landmark, how to reach the patient, what happened').fill('Next to the bus stop, LIVE TEST case')
    await reporter.getByPlaceholder('+91').fill('+91 90000 11111')
    await reporter.locator('#ev-files').setInputFiles([
      { name: 'bite-photo.png', mimeType: 'image/png', buffer: ICON },
      { name: 'voice-note.webm', mimeType: 'audio/webm', buffer: Buffer.alloc(900_000, 7) },
      { name: 'allergy-history.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF') },
      { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(1_700_000, 9) },
    ])
    await reporter.getByRole('list', { name: 'Files ready to send' }).waitFor(T)
    assert.equal(await reporter.locator('.tile').count(), 4)
    await shot(reporter, '06-reporter-composer-light')
  })

  await step('the composer rejects unsafe or oversized files with clear reasons and lets files be removed', async () => {
    await reporter.locator('#ev-files').setInputFiles([
      { name: 'run-me.exe', mimeType: 'application/x-msdownload', buffer: Buffer.alloc(100) },
      { name: 'huge.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(16 * 1024 * 1024) },
      { name: 'animation.gif', mimeType: 'image/gif', buffer: Buffer.alloc(100) },
    ])
    await reporter.getByText('Some files were not added').waitFor(T)
    await reporter.getByText(/run-me\.exe: application\/x-msdownload files are not supported/).waitFor(T)
    await reporter.getByText(/huge\.mp4: Video files can be at most 15\.0 MB/).waitFor(T)
    await reporter.getByText(/animation\.gif/).first().waitFor(T)
    assert.equal(await reporter.locator('.tile').count(), 4, 'rejected files must not be attached')
    await reporter.getByRole('button', { name: 'Dismiss' }).click()
    await reporter.getByRole('button', { name: 'Remove clip.mp4' }).click()
    assert.equal(await reporter.locator('.tile').count(), 3)
    await reporter.locator('#ev-files').setInputFiles([{ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(1_700_000, 9) }])
    await reporter.waitForFunction(() => document.querySelectorAll('.tile').length === 4)
  })

  await step('review shows everything, then it is sent; the receipt and live upload progress appear', async () => {
    await reporter.getByRole('button', { name: 'Next' }).click()
    await reporter.getByRole('heading', { name: 'Review and send' }).waitFor(T)
    await reporter.getByText('bite-photo.png').first().waitFor(T)
    await reporter.getByText('Who will see this').waitFor(T)
    await shot(reporter, '07-reporter-review-light')
    await reporter.getByRole('button', { name: 'Send to dispatch' }).click()
    await reporter.getByTestId('receipt-code').waitFor(T)
    receipt = (await reporter.getByTestId('receipt-code').innerText()).trim()
    assert.match(receipt, /^[A-Za-z0-9]{20}\.[A-Za-z0-9_-]{32}$/)
    await reporter.getByText('Evidence: 4 of 4 uploaded').waitFor({ timeout: 40000 })
    assert.equal(await reporter.getByText('Uploaded and confirmed by the server').count(), 4)
    await shot(reporter, '08-reporter-tracking-light')
  })

  await step('LAPTOP 2: the dispatcher sees it live, with private details and all four files, each checksum-verified', async () => {
    await strip(dispatcher, 'Snakebite').waitFor(T)
    await strip(dispatcher, 'Snakebite').click()
    await dispatcher.getByText('Your move').first().waitFor(T)
    await dispatcher.getByText('+91 90000 11111').waitFor(T)
    await dispatcher.getByRole('list', { name: 'Attached evidence' }).waitFor({ timeout: 40000 })
    await waitUntil(async () => (await dispatcher.locator('.tile').count()) >= 4, 'all four evidence tiles should arrive')
    await dispatcher.locator('.tile-media img').first().waitFor(T)
    await dispatcher.getByText('Checksum verified').first().waitFor(T)
    await dispatcher.getByRole('button', { name: /Load audio/ }).click()
    await dispatcher.locator('audio').first().waitFor(T)
    await dispatcher.getByRole('button', { name: /Load video/ }).click()
    await dispatcher.locator('video').first().waitFor(T)
    await dispatcher.getByRole('button', { name: /Load document/ }).click()
    await dispatcher.getByRole('link', { name: /Open document/ }).waitFor(T)
    await shot(dispatcher, '09-dispatcher-case-light')
  })

  await step('nothing has reached any hospital or crew yet (privacy before dispatch)', async () => {
    await wenlock.getByText('No requests yet').waitFor(T)
    assert.equal(await wenlock.getByText(/snake bite/).count(), 0)
    await crew1.getByText('Standing by').waitFor(T)
  })

  await step('the AI drafts a labelled briefing: transcript, facts, gaps, and it stays private until reviewed', async () => {
    await dispatcher.getByRole('button', { name: /Analyse report and 4 files/ }).click()
    await dispatcher.getByText('Draft: not yet shared').waitFor(T)
    await dispatcher.getByText('AI-generated').first().waitFor(T)
    await dispatcher.getByText(/test-fake-ai/).first().waitFor(T)
    await dispatcher.getByText('Audio transcript').waitFor(T)
    await dispatcher.getByText('Missing information').waitFor(T)
    assert.equal(await wenlock.getByText('Briefing from dispatch').count(), 0, 'hospitals must not see an unreviewed draft')
    await shot(dispatcher, '10-dispatcher-ai-draft-light')
  })

  await step('dispatch corrects the draft and shares the reviewed briefing', async () => {
    await dispatcher.getByLabel(/Handoff for crew and hospitals/).fill('Reporter says an adult man was bitten on the left leg and is conscious. Dispatcher note: reporter will stay at the bus stop.')
    await dispatcher.getByRole('button', { name: 'Review done: share with crew and hospitals' }).click()
    await dispatcher.getByText('Reviewed briefing shared with the crew and active hospitals.').waitFor(T)
  })

  await step('dispatch explicitly offers the case to Medic 1; the crew sees an incoming dispatch; hospitals still see nothing', async () => {
    await pickOption(dispatcher.getByLabel('Choose an ambulance'), /Medic 1/)
    await dispatcher.getByRole('button', { name: /Send the offer to Medic 1/ }).click()
    await dispatcher.getByText(/Waiting for the crew/).first().waitFor(T)
    await crew1.getByRole('region', { name: 'Incoming dispatch' }).waitFor(T)
    await crew1.getByText('Your move').first().waitFor(T)
    await crew1.getByRole('button', { name: 'Accept this dispatch' }).waitFor(T)
    await shot(crew1, '11-crew-offer-light-phone')
    assert.equal(await wenlock.locator('button.strip').count(), 0, 'no hospital may be contacted before a crew accepts')
    await noOverflow(crew1, 'crew offer'); await targets(crew1, 'crew offer')
  })

  await step('Medic 1 declines with a reason; the case returns to dispatch and Medic 1 cannot be offered it again', async () => {
    await crew1.getByRole('button', { name: 'Decline', exact: true }).click()
    await crew1.getByLabel('Why are you declining?').selectOption('Vehicle or equipment fault')
    await crew1.getByRole('button', { name: 'Decline the dispatch' }).click()
    await crew1.getByText('Standing by').waitFor(T)
    await dispatcher.getByText('Medic 1 declined this case').waitFor(T)
    await dispatcher.getByText(/Vehicle or equipment fault/).first().waitFor(T)
    const options = await dispatcher.getByLabel('Choose an ambulance').locator('option').allInnerTexts()
    assert.ok(!options.some((o) => o.includes('Medic 1')), 'a unit that declined must not be offered the case again')
    assert.equal(await wenlock.locator('button.strip').count(), 0)
  })

  await step('dispatch offers it to Medic 2, who accepts; hospitals are asked straight away while the crew drives', async () => {
    await pickOption(dispatcher.getByLabel('Choose an ambulance'), /Medic 2/)
    await dispatcher.getByRole('button', { name: /Send the offer to Medic 2/ }).click()
    await crew2.getByRole('region', { name: 'Incoming dispatch' }).waitFor(T)
    await crew2.getByRole('button', { name: 'Accept this dispatch' }).click()
    await crew2.getByText('Heading to the scene').waitFor(T)
    const t0 = Date.now()
    await strip(wenlock, 'Snakebite').waitFor({ timeout: 15000 })
    console.log(`      pre-alert reached the hospital ${Date.now() - t0} ms after the crew's acceptance was seen on the crew screen`)
    await dispatcher.getByText(/Hospitals were asked \d+ seconds? after the crew accepted/).waitFor(T)
    await strip(yenepoya, 'Snakebite').waitFor(T)
  })

  await step('LAPTOP 3: the hospital sees the case, the reviewed briefing and the evidence, and must confirm antivenom before it can accept', async () => {
    await strip(wenlock, 'Snakebite').click()
    await wenlock.getByText('Briefing from dispatch').waitFor(T)
    await wenlock.getByText('AI-generated').first().waitFor(T)
    await wenlock.getByText(/Dispatcher note: reporter will stay at the bus stop/).waitFor(T)
    await wenlock.getByRole('list', { name: 'Attached evidence' }).waitFor(T)
    await waitUntil(async () => (await wenlock.locator('.tile').count()) >= 4, 'the hospital may see all four files')
    await wenlock.locator('.tile-media img').first().waitFor(T)
    assert.equal(await wenlock.getByText('+91 90000 11111').count(), 0, 'the phone number is only for the chosen hospital')
    await wenlock.getByText('Confirm for this patient, right now').waitFor(T)
    assert.ok(await wenlock.getByRole('button', { name: 'Accept this patient' }).isDisabled())
    await wenlock.getByLabel(/Antivenom is physically in stock right now/).check()
    assert.ok(await wenlock.getByRole('button', { name: 'Accept this patient' }).isDisabled(), 'accept needs the receive confirmation too')
    await wenlock.getByLabel(/We can receive this patient/).check()
    await shot(wenlock, '12-hospital-case-light')
    await wenlock.getByRole('button', { name: 'Accept this patient' }).click()
    await wenlock.getByText('You accepted. Waiting for dispatch to choose').waitFor(T)
  })

  await step('another hospital declines and immediately loses access to the case, its files and the briefing', async () => {
    await strip(yenepoya, 'Snakebite').click()
    await yenepoya.getByRole('list', { name: 'Attached evidence' }).waitFor(T)
    await yenepoya.getByLabel('Reason for declining').selectOption('Required resource out of stock')
    await yenepoya.getByRole('button', { name: 'Decline', exact: true }).click()
    await yenepoya.getByText('Request closed').waitFor(T)
    assert.equal(await yenepoya.getByRole('list', { name: 'Attached evidence' }).count(), 0)
    assert.equal(await yenepoya.getByText('Briefing from dispatch').count(), 0)
    await yenepoya.getByText(/no longer available to you/).first().waitFor(T)
    await dispatcher.getByText('Declined: Required resource out of stock').first().waitFor(T)
  })

  await step('dispatch gets an explained recommendation and approves; the crew must acknowledge the destination', async () => {
    await dispatcher.getByText('Recommended', { exact: true }).waitFor({ timeout: 30000 })
    await dispatcher.getByText(/explicitly confirmed Antivenom/).waitFor(T)
    await shot(dispatcher, '13-dispatcher-recommendation-light')
    await dispatcher.getByRole('button', { name: /Approve and confirm Wenlock District Hospital/ }).click()
    await dispatcher.getByText(/Waiting for the crew to acknowledge the destination/).waitFor(T)
    await crew2.getByText(/Dispatch confirmed Wenlock District Hospital/).waitFor(T)
    await wenlock.getByText('You are the confirmed destination').waitFor(T)
  })

  await step('LIVE GPS: the crew shares real device GPS and every screen marks it as live, never simulated', async () => {
    await crew2.getByRole('button', { name: /Share my live GPS/ }).click()
    await dispatcher.locator('.stamp-live', { hasText: 'Live GPS' }).first().waitFor({ timeout: 30000 })
    await reporter.locator('.stamp-live', { hasText: 'Live GPS' }).first().waitFor({ timeout: 30000 })
    assert.equal(await dispatcher.locator('.stamp-sim').count(), 0)
    await crew2.getByRole('button', { name: /Sharing live GPS/ }).click()
  })

  await step('SIMULATED movement is clearly labelled as such everywhere', async () => {
    await crew2.getByRole('button', { name: /Demo: simulate this drive/ }).click()
    await dispatcher.locator('.stamp-sim', { hasText: 'Simulated' }).first().waitFor({ timeout: 30000 })
    await reporter.locator('.stamp-sim', { hasText: 'Simulated' }).first().waitFor({ timeout: 30000 })
    await crew2.getByRole('button', { name: /Simulating/ }).click()
  })

  await step('the crew arrives, acknowledges the destination, and can only then pick up the patient', async () => {
    await crew2.getByRole('button', { name: 'I am at the scene' }).click()
    const ack = crew2.getByRole('button', { name: /Acknowledge Wenlock District Hospital/ })
    await ack.waitFor(T)
    await shot(crew2, '14-crew-onscene-light-phone')
    await noOverflow(crew2, 'crew mission'); await targets(crew2, 'crew mission')
    await ack.click()
    await crew2.getByRole('button', { name: /Patient picked up, leave for hospital/ }).click()
    await crew2.getByText('Heading to Wenlock District Hospital').waitFor(T)
    await dispatcher.getByText(/The crew acknowledged it at/).waitFor(T)
  })

  await step('the crew reaches the hospital; the case cannot be closed until the hospital confirms receipt', async () => {
    await crew2.getByRole('button', { name: 'I am at the hospital' }).click()
    await dispatcher.getByText(/Waiting for the hospital to confirm it received the patient/).waitFor(T)
    assert.ok(await dispatcher.getByRole('button', { name: /Close the case and free the ambulance/ }).isDisabled())
    await wenlock.getByRole('button', { name: /Confirm we received the patient/ }).click()
    await wenlock.getByText(/You confirmed receipt at/).waitFor(T)
    await dispatcher.getByText(/confirmed it received the patient at/).waitFor(T)
  })

  await step('dispatch closes the case; the ambulance is released and every screen agrees', async () => {
    await dispatcher.getByRole('button', { name: /Close the case and free the ambulance/ }).click()
    await dispatcher.getByText('Case closed. The ambulance is free.').waitFor(T)
    await crew2.getByText('Standing by').waitFor(T)
    await reporter.getByText('Closed', { exact: true }).first().waitFor(T)
    await shot(dispatcher, '15-dispatcher-closed-light')
  })

  await step("the reporter's tracking page told the whole story, in order", async () => {
    const text = await reporter.locator('.log').innerText()
    for (const s of ['You sent the report', 'Dispatch offered it to Medic 2', 'Medic 2 accepted and is on the way', 'The nearest hospitals were asked to get ready', 'Wenlock District Hospital confirmed it can receive the patient', 'The crew picked up the patient', 'The hospital confirmed the patient arrived']) assert.ok(text.includes(s), `missing: ${s}`)
  })

  // ===========================================================================================================
  section('History and receipts')
  await step('closed cases stay on record: searchable, filterable, with the full audit trail, after reload', async () => {
    await mainNav(dispatcher, 'History').click()
    await dispatcher.getByRole('heading', { name: 'Incident history' }).waitFor(T)
    await dispatcher.getByRole('row').filter({ hasText: 'Snakebite' }).first().waitFor(T)
    await dispatcher.getByLabel('Search').fill('wenlock')
    await dispatcher.getByRole('row').filter({ hasText: 'Snakebite' }).first().waitFor(T)
    await dispatcher.getByLabel('Search').fill('no-such-thing-xyz')
    await dispatcher.getByText('No cases match these filters').waitFor(T)
    await dispatcher.getByRole('button', { name: 'Clear filters' }).first().click()
    await dispatcher.getByLabel('Status').selectOption('completed')
    await dispatcher.getByRole('row').filter({ hasText: 'Handed over' }).first().waitFor(T)
    await dispatcher.getByLabel('Status').selectOption('cancelled')
    await dispatcher.getByText('No cases match these filters').waitFor(T)
    await dispatcher.getByRole('button', { name: 'Clear filters' }).first().click()
    await dispatcher.reload()
    await dispatcher.getByRole('row').filter({ hasText: 'Snakebite' }).first().click()
    await dispatcher.getByText('Timeline').first().waitFor(T)
    const log = await dispatcher.locator('.log').last().innerText()
    for (const s of ['Emergency reported', 'declined', 'accepted the dispatch', 'Destination confirmed', 'acknowledged the destination', 'picked up', 'confirmed receipt', 'Case closed']) assert.ok(log.includes(s), `audit trail is missing "${s}"`)
    assert.ok((await dispatcher.getByRole('list', { name: 'Attached evidence' }).count()) > 0, 'evidence is still there for a closed case')
    await shot(dispatcher, '16-history-case-light')
  })

  await step('history is personal to each role: the confirmed hospital keeps the case, the one that declined does not', async () => {
    await mainNav(wenlock, 'History').click()
    await wenlock.getByRole('row').filter({ hasText: 'Snakebite' }).first().waitFor(T)
    await mainNav(yenepoya, 'History').click()
    await yenepoya.getByText('No cases yet').waitFor(T)
    await crew2.goto(`${BASE}/#/history`)
    await crew2.getByRole('row').filter({ hasText: 'Snakebite' }).first().waitFor(T)
    await crew1.goto(`${BASE}/#/history`)
    await crew1.getByText('No cases yet').waitFor(T) // Medic 1 declined, so it keeps no access
  })

  await step('a signed-out person reopens their report on another device with the receipt; a wrong code or a bare ID opens nothing', async () => {
    const other = await open('reporter-other-device', phone, { hasTouch: true, isMobile: true })
    await other.goto(BASE)
    await other.getByLabel('Receipt code or link').fill(receipt)
    await other.getByRole('button', { name: 'Open my report' }).click()
    await other.getByText(/Snakebite, 1 patient/).first().waitFor(T)
    await other.getByText('Closed', { exact: true }).first().waitFor(T)
    await noOverflow(other, 'reopened report')
    const caseId = receipt.split('.')[0]
    const wrong = await open('guesser', phone)
    await wrong.goto(`${BASE}/#/r/${caseId}.${'x'.repeat(32)}`)
    await wrong.getByText(/does not match any report/).waitFor(T)
    const idOnly = await open('id-only', phone)
    await idOnly.goto(`${BASE}/#/case/${caseId}`)
    await idOnly.getByText(/not available on this device/).waitFor(T)
    await other.close(); await wrong.close(); await idOnly.close()
  })

  // ===========================================================================================================
  section('Offline, AI failure modes and phone layouts')
  const rep2 = await open('reporter-offline', phone, { hasTouch: true, isMobile: true })
  await step('offline: a report with a photo is saved on the device only, clearly marked as not sent, then sends itself on reconnect', async () => {
    await rep2.goto(BASE)
    await rep2.getByRole('button', { name: /Report an emergency/ }).first().click()
    await rep2.getByRole('button', { name: 'Trauma' }).click()
    await rep2.getByRole('button', { name: 'Next' }).click()
    await rep2.getByLabel('Pick a demo place').selectOption({ label: 'Kankanady' })
    await rep2.getByRole('button', { name: 'Next' }).click()
    await rep2.getByPlaceholder('Adult man, bitten on the leg, conscious').fill('OFFLINE TEST fall from a bike')
    await rep2.locator('#ev-files').setInputFiles([{ name: 'scene.png', mimeType: 'image/png', buffer: ICON }])
    await rep2.getByRole('button', { name: 'Next' }).click()
    await rep2.waitForTimeout(1500)
    await rep2.context().setOffline(true)
    await rep2.getByText('You are offline').first().waitFor(T)
    await rep2.getByRole('button', { name: 'Save on this device' }).click()
    await rep2.getByTestId('receipt-code').waitFor(T)
    await rep2.getByText('Saved on this device only').first().waitFor(T)
    assert.equal(await rep2.getByText('Uploaded and confirmed by the server').count(), 0, 'must not claim an upload that has not happened')
    await shot(rep2, '17-offline-queued-light-phone')
    await rep2.context().setOffline(false)
    await rep2.getByText('Evidence: 1 of 1 uploaded').waitFor({ timeout: 45000 })
    await strip(dispatcher, 'Trauma').waitFor({ timeout: 30000 }).catch(() => undefined)
  })

  await step('AI failure modes: unavailable, malformed and overreaching answers are handled and nothing unsafe is shown', async () => {
    const d2 = await open('dispatcher-ai-modes', laptop)
    await login(d2, 'dispatcher2@goldenhour.demo')
    await d2.locator('.kpis').waitFor(T)
    await strip(d2, 'Trauma').click()
    await d2.evaluate(() => { window.__GH_AI_MODE__ = 'down' })
    await d2.getByRole('button', { name: /Analyse report/ }).click()
    await d2.getByText('The AI is not available').waitFor(T)
    await d2.evaluate(() => { window.__GH_AI_MODE__ = 'malformed' })
    await d2.getByRole('button', { name: /Analyse report/ }).click()
    await d2.getByText('The AI could not produce a usable draft').waitFor(T)
    await d2.getByText(/Nothing was saved/).waitFor(T)
    assert.equal(await d2.getByText('Draft: not yet shared').count(), 0)
    await d2.evaluate(() => { window.__GH_AI_MODE__ = 'overreach' })
    await d2.getByRole('button', { name: /Analyse report/ }).click()
    await d2.getByText("Parts of the AI's answer were removed").waitFor(T)
    const draft = await d2.getByLabel('AI draft').innerText()
    for (const bad of [/heart attack/i, /aspirin/i, /antivenom in stock/i, /taken there/i]) assert.ok(!bad.test(draft), `unsafe AI text survived: ${bad}`)
    await shot(d2, '18-ai-guardrails-light')
    await d2.close()
  })

  await step('every role is usable on a phone in both themes: no overflow and touch-sized controls', async () => {
    for (const th of ['light', 'dark']) {
      const p = await open(`phone-${th}`, phone, { hasTouch: true, isMobile: true, colorScheme: th })
      await p.goto(BASE)
      await p.getByRole('button', { name: /Report an emergency/ }).first().waitFor(T)
      assert.equal(await theme(p), th, 'follows the device colour scheme by default')
      await noOverflow(p, `landing ${th}`); await targets(p, `landing ${th}`)
      await shot(p, `19-landing-${th}-phone`)
      await p.getByRole('button', { name: /Report an emergency/ }).first().click()
      await noOverflow(p, `report step 1 ${th}`); await targets(p, `report step 1 ${th}`)
      await shot(p, `20-report-step1-${th}-phone`)
      await p.close()
    }
    const dm = await open('dispatcher-phone', phone, { hasTouch: true, isMobile: true })
    await login(dm, 'dispatcher1@goldenhour.demo')
    await dm.locator('.kpis').waitFor(T)
    await noOverflow(dm, 'dispatcher console on a phone'); await targets(dm, 'dispatcher console on a phone')
    if (await dm.locator('button.strip').count()) { await dm.locator('button.strip').first().click(); await noOverflow(dm, 'dispatcher case on a phone') }
    await shot(dm, '21-dispatcher-phone-light')
    await dm.goto(`${BASE}/#/account`)
    await dm.getByRole('heading', { name: 'Account and settings' }).waitFor(T)
    await noOverflow(dm, 'account on a phone'); await targets(dm, 'account on a phone')
    await dm.close()
  })

  await step('dark theme renders the dispatcher case, history and account without layout problems', async () => {
    const d = await open('dispatcher-dark', laptop, { colorScheme: 'dark' })
    await login(d, 'dispatcher1@goldenhour.demo')
    await d.locator('.kpis').waitFor(T)
    assert.equal(await theme(d), 'dark')
    await mainNav(d, 'History').click()
    await d.getByRole('row').filter({ hasText: 'Snakebite' }).first().click()
    await d.getByText('Timeline').first().waitFor(T)
    await noOverflow(d, 'dark history case')
    await shot(d, '22-history-case-dark')
    await d.goto(`${BASE}/#/account`)
    await d.getByRole('heading', { name: 'Account and settings' }).waitFor(T)
    await shot(d, '23-account-dark')
    await d.close()
  })

  await step('PWA: manifest, icons and service worker are served', async () => {
    const m = await (await fetch(`${BASE}/manifest.webmanifest`)).json()
    assert.equal(m.display, 'standalone')
    assert.ok(m.icons.some((i) => i.purpose === 'maskable'))
    for (const i of m.icons) assert.equal((await fetch(BASE + i.src)).status, 200, i.src)
    assert.equal((await fetch(`${BASE}/sw.js`)).status, 200)
  })

  await step('no unexpected browser errors were logged by any session', async () => {
    const noise = /Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR|auth\/network|Could not reach Cloud Firestore|WebChannel|the server responded with a status of (400|403)/i
    const bad = []
    for (const c of contexts) for (const p of c.pages()) for (const l of p.logs ?? []) if (!noise.test(l)) bad.push(`[${p.name}] ${l}`)
    assert.equal(bad.length, 0, `unexpected console errors:\n${bad.slice(0, 6).join('\n')}`)
  })
} catch (e) {
  failed = true
  console.log('\nE2E FAILED:', e.message)
  for (const c of contexts) for (const p of c.pages()) {
    const on = await p.evaluate(() => [...document.querySelectorAll('.slip, [role=alert], .notice')].map((x) => x.textContent?.slice(0, 160))).catch(() => [])
    if (on.length || p.logs?.length) console.log(`   [${p.name}] on-screen: ${JSON.stringify(on.slice(0, 4))} console: ${JSON.stringify((p.logs ?? []).slice(-3))}`)
  }
  for (const c of contexts) for (const p of c.pages()) await p.screenshot({ path: `${OUT}fail-${p.name ?? 'page'}.png`, fullPage: true }).catch(() => undefined)
} finally {
  await browser?.close().catch(() => undefined)
  killVite()
}

const ok = results.filter((r) => r.ok).length
console.log(`\n${ok}/${results.length} browser steps passed${failed ? ' (stopped at first failure; screenshots in web/test-results)' : ''}`)
process.exit(failed ? 1 : 0)
