// Real-browser, multi-user end-to-end test against the local Firebase emulators.
// Run with: npm run test:e2e   (starts emulators, provisions disposable test accounts, starts Vite, drives Chrome)
// Everything stays on localhost. Test passwords exist only in the emulator and are not valid anywhere else.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'

const PORT = 5199
const BASE = `http://localhost:${PORT}`
const PASSWORD = 'Demo-pass-123!'
const OUT = fileURLToPath(new URL('../test-results/', import.meta.url))
mkdirSync(OUT, { recursive: true })

const results = []
const step = async (name, fn) => {
  const t = Date.now()
  try { await fn(); results.push({ name, ok: true, ms: Date.now() - t }); console.log(`  ✓ ${name} (${Date.now() - t} ms)`) } catch (e) {
    results.push({ name, ok: false, error: e }); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 6).join('\n      ')}`)
    throw e
  }
}

console.log('Provisioning emulator accounts…')
execFileSync('node', ['scripts/provision.mjs', '--emulator'], { stdio: 'inherit' })

console.log('Starting Vite against emulators…')
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', 'localhost'], { shell: true, env: { ...process.env, VITE_USE_EMULATORS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let viteLog = ''
vite.stdout.on('data', (d) => (viteLog += d))
vite.stderr.on('data', (d) => (viteLog += d))
const killVite = () => { try { execFileSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ } }
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE)).ok) break } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 500))
  if (i === 59) { console.error(viteLog); killVite(); process.exit(1) }
}

let browser
const contexts = []
let failed = false
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ channel: 'msedge', headless: true }))
  const newPage = async (name, viewport, extra = {}) => {
    const ctx = await browser.newContext({ viewport, ...extra })
    contexts.push(ctx)
    const page = await ctx.newPage()
    page.on('pageerror', (e) => { if (!/ResizeObserver/.test(e.message)) console.log(`   [${name}] page error: ${e.message}`) })
    page.name = name
    page.logs = []
    page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) page.logs.push(m.text().slice(0, 300)) })
    return page
  }
  const phone = { width: 390, height: 844 }
  const desktop = { width: 1360, height: 900 }
  const shot = (page, n) => page.screenshot({ path: `${OUT}${n}.png`, fullPage: true })
  const noHorizontalScroll = async (page, label) => {
    const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
    assert.ok(o.sw <= o.cw + 1, `${label}: horizontal overflow (${o.sw} > ${o.cw})`)
  }
  const bigEnoughTargets = async (page, label) => {
    const small = await page.evaluate(() => [...document.querySelectorAll('button, a.btn, select, input[type=checkbox]')].filter((el) => el.offsetParent && !el.closest('.leaflet-container')).map((el) => { const box = (el.type === 'checkbox' ? el.closest('label') ?? el : el).getBoundingClientRect(); return { t: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 30), h: box.height, w: box.width } }).filter((x) => x.h < 34 || x.w < 34))
    assert.equal(small.length, 0, `${label}: touch targets under 34px: ${JSON.stringify(small)}`)
  }
  const login = async (page, email) => {
    await page.goto(BASE)
    await page.getByRole('button', { name: 'Staff sign in' }).click()
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  }
  const T = { timeout: 20000 }

  console.log('\nScenario: snakebite, five actors, real time')
  const rep = await newPage('reporter', phone, { geolocation: undefined, hasTouch: true, isMobile: true })
  const disp = await newPage('dispatcher', desktop)
  const wen = await newPage('wenlock', phone, { hasTouch: true, isMobile: true })
  const yen = await newPage('yenepoya', phone, { hasTouch: true, isMobile: true })
  const fmc = await newPage('father-muller', phone, { hasTouch: true, isMobile: true })
  const crew = await newPage('crew1', phone, { hasTouch: true, isMobile: true })

  await step('landing page renders and is usable on a phone', async () => {
    await rep.goto(BASE)
    await rep.getByRole('button', { name: /Report an emergency/ }).waitFor(T)
    await noHorizontalScroll(rep, 'landing')
    await bigEnoughTargets(rep, 'landing')
    await shot(rep, '01-landing-mobile')
  })

  await step('staff sign-in rejects a wrong password with a clear message', async () => {
    await rep.getByRole('button', { name: 'Staff sign in' }).click()
    await rep.getByLabel('Email').fill('dispatcher1@goldenhour.demo')
    await rep.getByLabel('Password').fill('definitely-wrong')
    await rep.getByRole('button', { name: 'Sign in', exact: true }).click()
    await rep.getByText('Email or password is incorrect.').waitFor(T)
  })

  await step('reporter files a snakebite SOS from a phone (no GPS permission needed)', async () => {
    await rep.getByRole('button', { name: /Report an emergency/ }).click()
    await rep.getByRole('button', { name: /Snakebite/ }).click()
    await rep.getByRole('button', { name: 'Send SOS' }).isDisabled().then((d) => assert.ok(d, 'SOS must be disabled until a location is set'))
    await rep.getByLabel('Pick a demo location').selectOption({ label: 'Hampankatta junction' })
    await rep.getByPlaceholder('e.g. Adult male, chest pain, conscious').fill('Adult male, bitten on the leg, conscious')
    await rep.getByPlaceholder('+91…').fill('+91 90000 11111')
    await noHorizontalScroll(rep, 'report form')
    await bigEnoughTargets(rep, 'report form')
    await shot(rep, '02-report-form-mobile')
    await rep.getByRole('button', { name: /Send SOS/ }).click()
    await rep.getByText(/Snakebite · 1 patient/).waitFor(T)
    await rep.getByText('Awaiting dispatch').first().waitFor(T)
    await noHorizontalScroll(rep, 'tracking')
  })

  await step('dispatcher signs in and sees the new case instantly, sorted into the queue', async () => {
    await login(disp, 'dispatcher1@goldenhour.demo')
    await disp.getByRole('button', { name: /Snakebite/ }).first().waitFor(T)
    await disp.getByText('Adult male, bitten on the leg, conscious').first().waitFor(T)
    await disp.getByText(/reporter|📞 \+91 90000 11111/).first().waitFor(T) // private contact details visible to dispatch
    await shot(disp, '03-dispatcher-new-case')
  })

  await step('dispatch preview lists only antivenom-capable hospitals and explains exclusions', async () => {
    await disp.getByText(/Will ask the 4 nearest eligible hospitals/).waitFor(T)
    await disp.getByText(/hospitals excluded/).click()
    await disp.getByText(/Antivenom not on hospital profile/).first().waitFor(T)
  })

  await step('hospitals sign in; none sees the case before dispatch (privacy)', async () => {
    await login(wen, 'wenlock@goldenhour.demo')
    await login(yen, 'yenepoya@goldenhour.demo')
    await login(fmc, 'father-muller@goldenhour.demo')
    for (const p of [wen, yen, fmc]) {
      await p.getByText('No requests waiting').waitFor(T)
      assert.equal(await p.getByText(/bitten on the leg/).count(), 0, `${p.name} must not see the case before it is sent`)
    }
  })

  await step('dispatcher dispatches: ambulance assigned and hospitals asked in one action', async () => {
    await disp.getByRole('button', { name: /Dispatch .* and ask hospitals/ }).click()
    await disp.getByText('Hospital responses').waitFor(T)
    await disp.getByText('Waiting').first().waitFor(T)
    await rep.getByText(/Medic \d/).first().waitFor(T) // reporter sees the ambulance in real time
    await shot(disp, '04-dispatcher-offers-sent')
  })

  await step('every asked hospital sees the request in real time, with the live antivenom question', async () => {
    for (const p of [wen, yen, fmc]) {
      await p.getByText(/Snakebite · 1 patient/).first().waitFor(T)
      await p.getByText(/Antivenom is physically in stock right now/).waitFor(T)
    }
    await noHorizontalScroll(wen, 'hospital request')
    await bigEnoughTargets(wen, 'hospital request')
    await shot(wen, '05-hospital-request-mobile')
  })

  await step('a hospital cannot accept without confirming; the dispatcher sees "seen" acknowledgements', async () => {
    const accept = wen.getByRole('button', { name: /Accept patient/ })
    assert.ok(await accept.isDisabled(), 'Accept must be locked until every resource is confirmed')
    await disp.getByText(/✓ seen/).first().waitFor(T)
  })

  await step('Yenepoya declines with a reason; dispatcher sees it live', async () => {
    await yen.getByLabel('Reason for declining').selectOption('Required resource out of stock')
    await yen.getByRole('button', { name: 'Decline', exact: true }).click()
    await disp.getByText('Declined: Required resource out of stock', { exact: true }).waitFor(T)
  })

  await step('Wenlock confirms antivenom and acceptance; dispatcher gets an explainable recommendation', async () => {
    await wen.getByLabel(/Antivenom is physically in stock/).check()
    await wen.getByLabel(/We can receive this patient/).check()
    await wen.getByRole('button', { name: /Accept patient/ }).click()
    await wen.getByText(/You accepted/).waitFor(T)
    await disp.getByText('Recommended', { exact: true }).waitFor({ timeout: 25000 }) // engine tick
    await disp.getByText(/explicitly confirmed Antivenom/).waitFor(T)
    await shot(disp, '06-dispatcher-recommendation')
  })

  await step('dispatcher approves; others are told another hospital was chosen; reporter sees the hospital', async () => {
    await disp.getByRole('button', { name: /Approve and confirm Wenlock/ }).click()
    await disp.getByText(/matches the recommendation/).waitFor(T)
    await fmc.getByText(/Dispatch chose another hospital/).waitFor(T)
    await rep.getByText(/Wenlock District Hospital is ready/).waitFor(T)
  })

  await step('ambulance crew sees only its own job and the destination', async () => {
    await login(crew, 'crew1@goldenhour.demo')
    await crew.getByText(/Snakebite · 1 patient/).waitFor(T)
    assert.equal(await crew.getByText('Dispatcher console').count(), 0)
    await crew.getByRole('button', { name: /Acknowledge and start/ }).click()
    await crew.getByRole('button', { name: /Arrived on scene/ }).waitFor(T)
    await shot(crew, '07-crew-mobile')
    await noHorizontalScroll(crew, 'crew view')
    await bigEnoughTargets(crew, 'crew view')
  })

  await step('simulated drive is labelled SIMULATED on every other screen (never confused with GPS)', async () => {
    await crew.getByRole('button', { name: /simulate this drive/ }).click()
    await disp.getByText(/SIMULATED/).first().waitFor({ timeout: 30000 })
    await rep.getByText(/SIMULATED/).first().waitFor(T)
    await crew.getByRole('button', { name: /Simulating/ }).click() // stop
  })

  await step('crew completes the run: on scene → transport (needs destination) → arrived', async () => {
    await crew.getByRole('button', { name: /Arrived on scene/ }).click()
    await crew.getByText(/Destination: Wenlock District Hospital/).waitFor(T)
    await crew.getByRole('button', { name: /Patient loaded/ }).click()
    await crew.getByRole('button', { name: /Arrived at hospital/ }).click()
    await crew.getByText(/You are at/).waitFor(T)
    await rep.getByText('Arrived at hospital').first().waitFor(T)
  })

  await step('destination hospital confirms arrival; others never see patient contact details', async () => {
    await wen.getByRole('tab', { name: /Incoming patients/ }).click()
    await wen.getByText(/\+91 90000 11111/).waitFor(T) // contact released only to the confirmed hospital
    await wen.getByRole('button', { name: /Confirm patient has arrived/ }).click()
    await wen.getByText(/Arrival confirmed/).waitFor(T)
    assert.equal(await fmc.getByText(/\+91 90000 11111/).count(), 0)
    await shot(wen, '08-hospital-patient-mobile')
  })

  await step('dispatcher closes the case and the ambulance is released', async () => {
    await disp.getByText(/confirmed arrival/).waitFor(T)
    await disp.getByRole('button', { name: /Close case and release ambulance/ }).click()
    await disp.getByText(/Recently closed/).waitFor(T)
    await disp.getByText('4/4').first().waitFor(T)
  })

  console.log('\nScenario: escalation, offline and responsive layout')
  const rep2 = await newPage('reporter2', phone, { hasTouch: true, isMobile: true })
  await step('a reporter who goes offline is told, and the report queues instead of failing', async () => {
    await rep2.goto(BASE)
    await rep2.getByRole('button', { name: /Report an emergency/ }).click()
    await rep2.getByLabel('Pick a demo location').selectOption({ label: 'Kankanady' })
    await rep2.context().setOffline(true)
    await rep2.getByText(/You are offline/).first().waitFor(T)
    await rep2.getByRole('button', { name: /Send SOS/ }).click()
    await rep2.getByText(/saved on this device|saved and will send/).first().waitFor(T)
    await rep2.context().setOffline(false)
  })

  await step('queued offline report reaches dispatch once the connection returns', async () => {
    await disp.getByRole('button', { name: /Trauma|Cardiac/ }).first().waitFor({ timeout: 30000 })
  })

  await step('dispatcher console is usable on a phone (queue, case and controls)', async () => {
    const dm = await newPage('dispatcher-mobile', phone, { hasTouch: true, isMobile: true })
    await login(dm, 'dispatcher2@goldenhour.demo')
    await dm.getByRole('button', { name: /Cardiac|Trauma|Snakebite/ }).first().waitFor(T)
    await noHorizontalScroll(dm, 'dispatcher mobile')
    await shot(dm, '09-dispatcher-mobile')
  })

  await step('every role is blocked from the others\' screens (UI follows the server-side role)', async () => {
    // The hospital console has no dispatcher controls; the crew console has no hospital or dispatcher controls.
    for (const t of ['Log a phoned-in call', 'Dispatch now', 'Hospital responses']) assert.equal(await wen.getByText(t).count(), 0, `hospital page shows "${t}"`)
    for (const t of ['Log a phoned-in call', 'Hospital responses', 'Profile & availability', 'Accept patient']) assert.equal(await crew.getByText(t).count(), 0, `crew page shows "${t}"`)
    assert.ok(await wen.getByRole('tab', { name: /Profile & availability/ }).count() > 0)
  })

  await step('PWA: manifest, icons and service worker file are served', async () => {
    const m = await (await fetch(`${BASE}/manifest.webmanifest`)).json()
    assert.equal(m.display, 'standalone')
    assert.ok(m.icons.some((i) => i.purpose === 'maskable'))
    for (const i of m.icons) assert.equal((await fetch(BASE + i.src)).status, 200, i.src)
    assert.equal((await fetch(`${BASE}/sw.js`)).status, 200)
  })
} catch (e) {
  failed = true
  console.log('\nE2E FAILED:', e.message)
  for (const c of contexts) for (const p of c.pages()) {
    const toasts = await p.evaluate(() => [...document.querySelectorAll('.toast, .err')].map((e) => e.textContent)).catch(() => [])
    if (toasts.length || p.logs?.length) console.log(`   [${p.name}] on-screen: ${JSON.stringify(toasts)} console: ${JSON.stringify((p.logs ?? []).slice(-4))}`)
  }
  for (const c of contexts) for (const p of c.pages()) await p.screenshot({ path: `${OUT}fail-${p.name ?? 'page'}.png`, fullPage: true }).catch(() => undefined)
} finally {
  await browser?.close().catch(() => undefined)
  killVite()
}
const ok = results.filter((r) => r.ok).length
console.log(`\n${ok}/${results.length} browser steps passed${failed ? ' (stopped at first failure; screenshots in web/test-results)' : ''}`)
process.exit(failed ? 1 : 0)
