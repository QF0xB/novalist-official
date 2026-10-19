import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Reuse exactly the sanitizer shipped with the existing scene editor.
  publicDir: fileURLToPath(new URL('../../src/renderer/public', import.meta.url)),
  server: { host: '127.0.0.1', port: 5187, strictPort: true },
  plugins: [{
    name: 'prototype-sanitizer-assets',
    generateBundle() {
      for (const name of ['purify.min.js', 'scene-html.js']) {
        this.emitFile({
          type: 'asset', fileName: `editor/${name}`,
          source: readFileSync(new URL(`../../src/renderer/public/editor/${name}`, import.meta.url))
        })
      }
    }
  }],
  build: { outDir: 'dist', emptyOutDir: true, copyPublicDir: false }
})
