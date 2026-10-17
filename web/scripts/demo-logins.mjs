// Writes ../.secrets/DEMO-LOGINS.html: a local page (git-ignored) with each demo account and its password, grouped by laptop,
// with copy buttons. Passwords are never printed to the terminal. Usage: node scripts/demo-logins.mjs [--open]
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SEED_ACCOUNTS, SEED_HOSPITALS, SEED_AMBULANCES } from '../src/lib/seed.ts'

const file = fileURLToPath(new URL('../../.secrets/accounts.json', import.meta.url))
const out = fileURLToPath(new URL('../../.secrets/DEMO-LOGINS.html', import.meta.url))
let pw
try { pw = JSON.parse(readFileSync(file, 'utf8')) } catch { console.error('No .secrets/accounts.json yet. Run: node scripts/provision.mjs --prod'); process.exit(1) }

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const row = (a, note = '') => `<tr><td><b>${esc(a.displayName)}</b>${note ? `<br><small>${esc(note)}</small>` : ''}</td><td><code>${esc(a.email)}</code></td><td><button onclick="navigator.clipboard.writeText('${esc(a.email)}')">Copy email</button> <button onclick="navigator.clipboard.writeText('${esc(pw[a.email] ?? '')}')">Copy password</button> <button onclick="var s=this.nextElementSibling;s.hidden=!s.hidden">Show</button><code hidden>${esc(pw[a.email] ?? '')}</code></td></tr>`
const find = (role, id) => SEED_ACCOUNTS.find((a) => a.role === role && (a.hospitalId === id || a.ambulanceId === id))
const antivenom = new Set(SEED_HOSPITALS.filter((h) => h.capabilities.includes('antivenom')).map((h) => h.id))
const site = 'https://goldenhour-46131.web.app'

const html = `<!doctype html><meta charset="utf-8"><title>GoldenHour demo logins (private)</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:980px;margin:24px auto;padding:0 16px;color:#0b1a2c}h1{font-size:1.8rem}h2{margin-top:2rem;border-bottom:3px solid #0b1a2c}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #c3cdd8;padding:8px}button{padding:6px 10px;border:2px solid #0b1a2c;background:#fff;cursor:pointer;font-weight:700}code{background:#e8edf1;padding:2px 6px}.warn{background:#fdf0d3;border-left:8px solid #8a5200;padding:10px 14px}</style>
<h1>GoldenHour demo logins</h1>
<p class="warn"><b>Private.</b> This file is on your computer only (the <code>.secrets</code> folder is git-ignored). Passwords are not shown on screen: use the copy buttons. Do not email or screenshot this page.</p>
<p>App: <a href="${site}">${site}</a></p>
<h2>Laptop 1: the reporter</h2><p>No login is needed. Open the app and choose <b>Report an emergency</b>.</p>
<h2>Laptop 2: dispatcher and ambulance crew</h2>
<p>Use two separate browser windows (or one normal and one private window) so the dispatcher and the crew are different sessions.</p>
<table>${row(find('dispatcher', undefined) ?? SEED_ACCOUNTS[0], 'Dispatcher window')}${SEED_AMBULANCES.slice(0, 2).map((a) => row(find('ambulance', a.id), `${a.callSign} crew window`)).join('')}</table>
<h2>Laptop 3: hospital staff</h2>
<p>Hospitals marked <b>antivenom</b> are asked for the snakebite scenario in the runbook. Use one to accept and, optionally, a second to decline.</p>
<table>${SEED_HOSPITALS.map((h) => row(find('hospital', h.id), antivenom.has(h.id) ? 'asked for snakebite (antivenom)' : 'not asked for snakebite')).join('')}</table>
<h2>Other accounts</h2><table>${[SEED_ACCOUNTS.find((a) => a.key === 'dispatcher2'), ...SEED_AMBULANCES.slice(2).map((a) => find('ambulance', a.id))].filter(Boolean).map((a) => row(a)).join('')}</table>
`
writeFileSync(out, html)
console.log(`Wrote ${out} (${SEED_ACCOUNTS.length} accounts). Passwords are not printed here.`)
if (process.argv.includes('--open')) execFileSync('cmd', ['/c', 'start', '', out], { stdio: 'ignore' })
