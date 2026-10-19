import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('../../src/renderer/public/editor/prototype-generated', import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('./engine.ts', import.meta.url)),
      formats: ['iife'], name: 'NovalistPrototypeEditor', fileName: () => 'engine.js', cssFileName: 'engine'
    }
  }
})
