import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'

// The scene editor runs in the editor iframe, outside the renderer's module
// graph, like the rest of public/editor. Built to a generated, ignored folder.
export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('../renderer/public/editor/scene-editor-generated', import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('./main.ts', import.meta.url)),
      formats: ['iife'], name: 'NovalistSceneEditor', fileName: () => 'scene-editor.js', cssFileName: 'scene-editor'
    }
  }
})
