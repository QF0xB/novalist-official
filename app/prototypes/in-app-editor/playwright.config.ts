import { defineConfig } from '@playwright/test'
import base from '../html-yjs/playwright.config'

export default defineConfig({ ...base, testDir: __dirname, testMatch: ['parity.spec.ts', 'typing.spec.ts'] })
