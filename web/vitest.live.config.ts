import { defineConfig } from 'vitest/config'

// Live checks against the deployed project. The real-Gemini check has its own config (npm run verify:ai) because it needs the AI Logic console step.
export default defineConfig({ test: { include: ['src/test/verify.live.test.ts'], testTimeout: 180_000, hookTimeout: 60_000 } })
