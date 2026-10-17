import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['src/test/verify.ai.live.test.ts'], testTimeout: 180_000, hookTimeout: 60_000 } })
