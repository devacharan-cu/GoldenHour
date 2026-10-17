/* oxlint-disable react/only-export-components -- the settings hook and helpers intentionally live beside their provider */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { doc, onSnapshot, setDoc } from 'firebase/firestore'
import { db } from './firebase'

export type ThemePref = 'system' | 'light' | 'dark'
export type TextSize = 'normal' | 'large' | 'xlarge'

export interface Settings {
  theme: ThemePref
  textSize: TextSize
  /** 'system' follows the OS "reduce motion" setting; 'on' always calms animation. */
  reduceMotion: 'system' | 'on'
  /** Play a short chime when a request needs this screen's attention. */
  sound: boolean
  /** Show a desktop notification for new requests while this tab is in the background. */
  desktopAlerts: boolean
  /** Tighter lists for dispatchers who watch many cases. */
  compact: boolean
}

export const DEFAULT_SETTINGS: Settings = { theme: 'system', textSize: 'normal', reduceMotion: 'system', sound: true, desktopAlerts: false, compact: false }
const KEY = 'gh-settings'

export function sanitizeSettings(raw: unknown): Settings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d)
  return {
    theme: pick(o.theme, ['system', 'light', 'dark'] as const, DEFAULT_SETTINGS.theme),
    textSize: pick(o.textSize, ['normal', 'large', 'xlarge'] as const, DEFAULT_SETTINGS.textSize),
    reduceMotion: pick(o.reduceMotion, ['system', 'on'] as const, DEFAULT_SETTINGS.reduceMotion),
    sound: typeof o.sound === 'boolean' ? o.sound : DEFAULT_SETTINGS.sound,
    desktopAlerts: typeof o.desktopAlerts === 'boolean' ? o.desktopAlerts : DEFAULT_SETTINGS.desktopAlerts,
    compact: typeof o.compact === 'boolean' ? o.compact : DEFAULT_SETTINGS.compact,
  }
}

export function loadLocalSettings(): Settings {
  try { return sanitizeSettings(JSON.parse(localStorage.getItem(KEY) ?? '{}')) } catch { return DEFAULT_SETTINGS }
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Apply settings to the document. Also run by an inline script in index.html before first paint, to avoid a flash. */
export function applySettings(s: Settings): void {
  const el = document.documentElement
  const theme = resolveTheme(s.theme)
  el.dataset.theme = theme
  el.dataset.text = s.textSize
  el.dataset.motion = s.reduceMotion === 'on' ? 'reduced' : 'system'
  el.dataset.compact = s.compact ? 'on' : 'off'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#000000' : '#e8edf1')
}

interface Ctx { settings: Settings; set: (patch: Partial<Settings>) => void; reset: () => void; theme: 'light' | 'dark' }
const SettingsCtx = createContext<Ctx | null>(null)

export function SettingsProvider({ uid, children }: { uid: string | null; children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadLocalSettings)
  const [system, setSystem] = useState(0)

  // Preferences follow a signed-in person across devices. Guests keep them on this device only.
  useEffect(() => {
    if (!uid) return
    return onSnapshot(doc(db, 'userPrefs', uid), (s) => {
      if (!s.exists()) return
      const remote = sanitizeSettings(s.data())
      setSettings(remote)
      try { localStorage.setItem(KEY, JSON.stringify(remote)) } catch { /* storage unavailable */ }
    }, () => undefined)
  }, [uid])

  useEffect(() => { applySettings(settings) }, [settings, system])
  useEffect(() => {
    if (settings.theme !== 'system' || typeof matchMedia === 'undefined') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const h = () => setSystem((n) => n + 1)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [settings.theme])

  const persist = useCallback((next: Settings) => {
    setSettings(next)
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
    if (uid) void setDoc(doc(db, 'userPrefs', uid), next).catch(() => undefined)
  }, [uid])

  const value = useMemo<Ctx>(() => ({
    settings,
    set: (patch) => persist({ ...settings, ...patch }),
    reset: () => persist(DEFAULT_SETTINGS),
    theme: resolveTheme(settings.theme),
  }), [settings, persist])

  return <SettingsCtx.Provider value={value}>{children}</SettingsCtx.Provider>
}

export function useSettings(): Ctx {
  const v = useContext(SettingsCtx)
  if (!v) throw new Error('useSettings outside SettingsProvider')
  return v
}
