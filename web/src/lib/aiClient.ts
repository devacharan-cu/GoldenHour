import { initializeApp } from 'firebase/app'
import { app, PROD_CONFIG, USE_EMULATORS } from './firebase'
import { FakeAiClient, createFirebaseAiClient, type AiClient } from './ai'

let real: Promise<AiClient> | null = null

/**
 * Which AI backs the briefing panel.
 * Production: Gemini through Firebase AI Logic (the API key stays inside Firebase, App Check guards the call).
 * Local emulators only: a clearly labelled fake, so tests and offline demos can exercise the whole review flow.
 * A test can force a failure mode with window.__GH_AI_MODE__ = 'down' | 'malformed' | 'overreach'.
 */
export function getAiClient(): Promise<AiClient> {
  if (USE_EMULATORS) {
    const mode = (window as unknown as { __GH_AI_MODE__?: 'ok' | 'down' | 'malformed' | 'overreach' | 'real' }).__GH_AI_MODE__ ?? 'ok'
    // 'real' (emulator builds only): cases and people stay on the local emulators, but the briefing is produced by the real Gemini through
    // the production project's Firebase AI Logic, from the real browser SDK. It lets the browser tests exercise the genuine AI path. Use synthetic data.
    if (mode === 'real') return (realOnEmulators ??= createFirebaseAiClient(initializeApp(PROD_CONFIG, 'ai-only')))
    return Promise.resolve(new FakeAiClient(mode))
  }
  real ??= createFirebaseAiClient(app)
  return real
}

let realOnEmulators: Promise<AiClient> | null = null
