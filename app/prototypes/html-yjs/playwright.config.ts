import { defineConfig } from '@playwright/test'
import { resolve } from 'node:path'

export default defineConfig({
  testDir: '.',
  testMatch: 'prototype.spec.ts',
  outputDir: 'test-results',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5187', trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
  },
  webServer: {
    command: 'npm run prototype:html',
    cwd: resolve(__dirname, '../..'),
    url: 'http://127.0.0.1:5187',
    reuseExistingServer: !process.env.CI
  }
})
