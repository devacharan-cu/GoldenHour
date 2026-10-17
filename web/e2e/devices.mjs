// Device matrix: the reporter flow and every staff role on emulated phones and tablets, in both themes, in Chromium and WebKit
// (the Safari engine). Run with: npm run test:devices   (needs the emulators and Vite; started for you).
//
// HONESTY NOTE: these are Playwright device PROFILES (screen size, pixel ratio, touch, user agent) running desktop builds of the
// Chromium and WebKit engines. They catch layout, overflow, tap-target and engine differences. They are NOT physical phones: real camera
// hardware, real mobile keyboards, iOS Safari quirks, battery/network behaviour and the install flow still need a real device.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium, devices, webkit } from 'playwright-core'

const PORT = 5198
const BASE = `http://localhost:${PORT}`
const PASSWORD = 'Demo-pass-123!'
const OUT = fileURLToPath(new URL('../test-results/devices/', import.meta.url))
mkdirSync(OUT, { recursive: true })

console.log('Provisioning emulator accounts…')
execFileSync('node', ['scripts/provision.mjs', '--emulator'], { stdio: 'inherit' })
console.log('Starting Vite against emulators…')
const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort', '--host', 'localhost'], { shell: true, env: { ...process.env, VITE_USE_EMULATORS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
const killVite = () => { try { execFileSync('taskkill', ['/pid', String(vite.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
for (let i = 0; i < 80; i++) {
  try { if ((await fetch(BASE)).ok) break } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 500))
  if (i === 79) { killVite(); process.exit(1) }
}

// [profile name, engine]. WebKit stands in for iOS Safari; Chromium for Android Chrome.
const MATRIX = [
  ['iPhone SE', 'webkit'], ['iPhone 12', 'webkit'], ['iPhone 14 Pro Max', 'webkit'], ['iPhone 15', 'webkit'],
  ['Pixel 5', 'chromium'], ['Pixel 7', 'chromium'], ['Galaxy S9+', 'chromium'], ['Galaxy S8', 'chromium'], ['Galaxy A55', 'chromium'],
  ['iPad Mini', 'webkit'], ['Galaxy Tab S4', 'chromium'],
].filter(([n]) => devices[n] && (!process.env.ONLY || process.env.ONLY.split(',').includes(n)))
const skipped = ['iPhone SE', 'iPhone 12', 'iPhone 14 Pro Max', 'iPhone 15', 'Pixel 5', 'Pixel 7', 'Galaxy S9+', 'Galaxy S8', 'Galaxy A55', 'iPad Mini', 'Galaxy Tab S4'].filter((n) => !devices[n])

const T = { timeout: 25000 }
const problems = []
let checks = 0
const check = (cond, msg) => { checks++; if (!cond) problems.push(msg) }

const browsers = {}
async function launch(engine) {
  if (browsers[engine]) return browsers[engine]
  const chrome = () => chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ channel: 'msedge', headless: true }))
  browsers[engine] = engine === 'webkit' ? await webkit.launch() : await chrome()
  return browsers[engine]
}

async function audit(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }))
  check(o.sw <= o.cw + 1, `${label}: horizontal overflow (${o.sw} > ${o.cw})`)
  const small = await page.evaluate(() => [...document.querySelectorAll('button, a.btn, select, input[type=checkbox], input[type=radio]')]
    .filter((el) => el.offsetParent && !el.closest('.leaflet-container') && !el.classList.contains('sr-only') && !el.closest('.switch'))
    .map((el) => { const b = (el.type === 'checkbox' || el.type === 'radio' ? el.closest('label') ?? el : el).getBoundingClientRect(); return { t: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24), h: Math.round(b.height), w: Math.round(b.width) } })
    .filter((x) => x.h < 36 || x.w < 36))
  check(small.length === 0, `${label}: touch targets under 36px ${JSON.stringify(small)}`)
  // text that spills out of its box is the commonest small-screen bug
  const clipped = await page.evaluate(() => [...document.querySelectorAll('.btn, .pill, .strip-title, h1, h2, h3')].filter((el) => el.offsetParent && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== 'visible' && getComputedStyle(el).textOverflow !== 'ellipsis').map((el) => el.textContent.trim().slice(0, 30)))
  check(clipped.length === 0, `${label}: clipped text ${JSON.stringify(clipped)}`)
}

async function signIn(page, email) {
  await page.goto(BASE)
  await page.locator('#signin-email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
// The Firebase SDK adds a fixed warning banner when it talks to the local emulators. It does not exist in production, so it must not count as overflow.
const HIDE_BANNER = () => document.addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '.firebase-emulator-warning{display:none!important}'; document.head.append(st) })
let failed = false
try {
  for (const [name, engine] of MATRIX) {
    for (const scheme of ['light', 'dark']) {
      const label = `${name} (${engine}, ${scheme})`
      const browser = await launch(engine)
      const ctx = await browser.newContext({ ...devices[name], colorScheme: scheme, serviceWorkers: 'block' })
      const logs = []
      const wire = (p) => { p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR|WebChannel|Could not reach/.test(m.text())) logs.push(m.text().slice(0, 200)) }); p.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`)) }
      await ctx.addInitScript(HIDE_BANNER)
      const page = await ctx.newPage()
      wire(page)
      const t0 = Date.now()
      let stage = 'start'
      try {
        // reporter: landing -> 4-step flow -> tracking
        stage = 'landing'
        await page.goto(BASE)
        await page.getByRole('button', { name: /Report an emergency/ }).first().waitFor(T)
        check((await page.evaluate(() => document.documentElement.dataset.theme)) === scheme, `${label}: theme should follow the device`)
        await audit(page, `${label} landing`)
        await page.screenshot({ path: `${OUT}${name.replace(/\W+/g, '-')}-${scheme}-1-landing.png`, fullPage: true })
        stage = 'step 1'
        await page.getByRole('button', { name: /Report an emergency/ }).first().click()
        await page.getByRole('heading', { name: 'What happened' }).waitFor(T)
        await audit(page, `${label} step 1`)
        await page.getByRole('button', { name: 'Cardiac' }).click()
        await page.getByRole('button', { name: 'Next' }).click()
        await page.getByLabel('Pick a demo place').selectOption({ label: 'Kankanady' })
        await audit(page, `${label} step 2 (map)`)
        await page.getByRole('button', { name: 'Next' }).click()
        stage = 'step 3 composer'
        await page.getByPlaceholder('Adult man, bitten on the leg, conscious').fill(`DEVICE TEST ${name} ${scheme}`)
        await page.locator('#ev-files').setInputFiles([{ name: 'scene.png', mimeType: 'image/png', buffer: PNG }])
        await page.locator('.tile').first().waitFor(T)
        await audit(page, `${label} step 3 (composer)`)
        await page.screenshot({ path: `${OUT}${name.replace(/\W+/g, '-')}-${scheme}-2-composer.png`, fullPage: true })
        // the camera button either opens the in-app camera or the phone camera app: never nothing
        const opened = await Promise.race([
          page.getByRole('button', { name: 'Take a photo' }).click().then(() => new Promise((r) => setTimeout(r, 1200))).then(async () => (await page.getByRole('dialog').count()) > 0 ? 'dialog' : 'none'),
          page.waitForEvent('filechooser', { timeout: 4000 }).then(() => 'filechooser').catch(() => new Promise(() => undefined)),
        ])
        check(opened === 'dialog' || opened === 'filechooser', `${label}: Take a photo did nothing`)
        if (opened === 'dialog') { await audit(page, `${label} camera`); await page.getByRole('button', { name: 'Close the camera' }).click() }
        await page.getByRole('button', { name: 'Next' }).click()
        await audit(page, `${label} review`)
        stage = 'sending'
        await page.getByRole('button', { name: 'Send to dispatch' }).click()
        await page.getByTestId('receipt-code').waitFor(T)
        stage = 'waiting for the upload to be confirmed'
        await page.getByText('Evidence: 1 of 1 uploaded').waitFor({ timeout: 40000 })
        await audit(page, `${label} tracking`)
        await page.screenshot({ path: `${OUT}${name.replace(/\W+/g, '-')}-${scheme}-3-tracking.png`, fullPage: true })

        // each staff role, on the same device
        for (const [email, heading] of [['dispatcher1@goldenhour.demo', null], ['crew1@goldenhour.demo', 'Medic 1'], ['wenlock@goldenhour.demo', 'Wenlock District Hospital']]) {
          stage = `staff ${email}`
          // a separate context: staff must not share the reporter's browser session
          const sctx = await browser.newContext({ ...devices[name], colorScheme: scheme, serviceWorkers: 'block' })
          await sctx.addInitScript(HIDE_BANNER)
          const staff = await sctx.newPage()
          wire(staff)
          await signIn(staff, email)
          if (heading) await staff.getByRole('heading', { name: heading }).waitFor(T)
          else {
            await staff.locator('.kpis').waitFor(T)
            await staff.locator('button.strip', { hasText: `DEVICE TEST ${name}` }).first().click().catch(() => undefined)
          }
          await audit(staff, `${label} ${email.split('@')[0]}`)
          await staff.screenshot({ path: `${OUT}${name.replace(/\W+/g, '-')}-${scheme}-4-${email.split('@')[0]}.png`, fullPage: true })
          await staff.goto(`${BASE}/#/account`)
          await staff.getByRole('heading', { name: 'Account and settings' }).waitFor(T)
          await audit(staff, `${label} account`)
          await sctx.close()
        }
        check(logs.length === 0, `${label}: console errors ${JSON.stringify(logs.slice(0, 3))}`)
        console.log(`  ${problems.some((p) => p.startsWith(label)) ? '✗' : '✓'} ${label} (${((Date.now() - t0) / 1000).toFixed(1)} s)`)
      } catch (e) {
        problems.push(`${label} [${stage}]: ${String(e.message).split('\n')[0]}`)
        console.log(`  ✗ ${label} [${stage}]: ${String(e.message).split('\n')[0]}`)
        if (logs.length) console.log(`      console: ${JSON.stringify(logs.slice(0, 4))}`)
        console.log(`      on screen: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.slip, [role=alert], .notice')].map((x) => x.textContent?.slice(0, 200))).catch(() => []))}`)
        await page.screenshot({ path: `${OUT}FAIL-${name.replace(/\W+/g, '-')}-${scheme}.png`, fullPage: true }).catch(() => undefined)
      }
      await ctx.close()
    }
  }
} catch (e) {
  failed = true
  console.log('DEVICE RUN CRASHED:', e.message)
} finally {
  for (const b of Object.values(browsers)) await b.close().catch(() => undefined)
  killVite()
}
if (skipped.length) console.log(`\nProfiles not available in this Playwright version (skipped): ${skipped.join(', ')}`)
console.log(`\n${MATRIX.length} device profiles x 2 themes, ${checks} checks.`)
if (problems.length || failed) { console.log(`\n${problems.length} problem(s):\n - ${problems.join('\n - ')}`); process.exit(1) }
console.log('All device checks passed (emulated profiles; see the honesty note at the top of e2e/devices.mjs).')
