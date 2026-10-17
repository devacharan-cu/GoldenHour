import { app, USE_EMULATORS } from './firebase'
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
    const mode = (window as unknown as { __GH_AI_MODE__?: 'ok' | 'down' | 'malformed' | 'overreach' }).__GH_AI_MODE__ ?? 'ok'
    return Promise.resolve(new FakeAiClient(mode))
  }
  real ??= createFirebaseAiClient(app)
  return real
}
