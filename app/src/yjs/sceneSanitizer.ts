import { readFileSync } from 'node:fs'
import {JSDOM} from 'jsdom'

// Load the editor's sanitizer scripts unchanged to share its HTML safety policy.
// Matching scripts does not guarantee identical parsing in JSDOM and Electron.
const editorDirectory = new URL('../renderer/public/editor/', import.meta.url)

export interface SceneSanitizer {
    readonly document: Document
    sanitize(html: string): string
}

/**
 * Creates a DOM environment for scene conversion outside the editor iframe.
 * Loads the editor's sanitizer scripts so the codec shares its HTML safety policy.
 * Intended for the Node-based Yjs host and tests, not the browser renderer.
 */
export function createSceneSanitizer(): SceneSanitizer {
    // Only explicitly evaluated application scripts execute. Scene HTML is supplied
    // to the sanitizer as data; scripts embedded in it must never be executed.
    const { window } = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only' })

    // Evaluate trusted, bundled editor scripts—not scene content.
    window.eval(readFileSync(new URL('purify.min.js', editorDirectory), 'utf8'))
    window.eval(readFileSync(new URL('scene-html.js', editorDirectory), 'utf8'))

    const { sanitizeSceneHtml } = window as unknown as { sanitizeSceneHtml(html: string): string }

    return {
        document: window.document,
        sanitize: (html) => sanitizeSceneHtml(html)
    }
}
