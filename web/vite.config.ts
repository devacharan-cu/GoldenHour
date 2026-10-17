import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  test: {
    // Emulator and browser suites run through their own scripts (npm run test:emu / test:e2e).
    exclude: ['**/node_modules/**', '**/*.emu.test.ts', '**/*.live.test.ts', 'e2e/**'],
  },
})
