import { DOMParser as ProseMirrorParser, DOMSerializer } from 'prosemirror-model'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { sceneSchema } from './schema'

declare global {
  interface Window {
    sanitizeSceneHtml: (html: string) => string
    sanitizeSceneFragment: (html: string) => DocumentFragment
  }
}

export function parseHtml(html: string): ProseMirrorNode {
  const holder = document.createElement('div')
  holder.append(window.sanitizeSceneFragment(html))
  return ProseMirrorParser.fromSchema(sceneSchema).parse(holder, { preserveWhitespace: 'full' })
}

export function exportHtml(doc: ProseMirrorNode): string {
  const holder = document.createElement('div')
  holder.append(DOMSerializer.fromSchema(sceneSchema).serializeFragment(doc.content))
  return window.sanitizeSceneHtml(holder.innerHTML)
}

// Compare parsed DOM, ignoring only attribute order and browser HTML serialization.
// Do not declare b/strong, whitespace, removed wrappers, etc. equivalent: a
// conservative mismatch is preferable to claiming a lossy import is compatible.
function canonical(html: string): string {
  // Parse as a fragment, not a whole document: a whole-document parser can move
  // leading scripts/styles into <head>, hiding their removal from the report.
  const fragment = document.createElement('template')
  fragment.innerHTML = html
  function visit(node: Node): unknown {
    if (node.nodeType === Node.TEXT_NODE) return ['text', node.textContent]
    if (node instanceof Element) {
      return [node.tagName.toLowerCase(),
        Array.from(node.attributes).map(a => [a.name, a.value]).sort(([a], [b]) => a.localeCompare(b)),
        Array.from(node instanceof HTMLTemplateElement ? node.content.childNodes : node.childNodes).map(visit)]
    }
    return [node.nodeType, node.textContent]
  }
  return JSON.stringify(Array.from(fragment.content.childNodes).map(visit))
}

export function fidelityReport(original: string, projected: string) {
  const sanitized = window.sanitizeSceneHtml(original)
  const sanitizerChanged = canonical(original) !== canonical(sanitized)
  const schemaChanged = canonical(sanitized) !== canonical(projected)
  return {
    exactSourceMatch: original === projected,
    parsedHtmlMatch: !sanitizerChanged && !schemaChanged,
    sanitizerChanged,
    schemaChanged,
    original,
    sanitized,
    projected,
    note: 'This compares the initial import only. A match is not proof of full editor feature parity. DOM comparison ignores attribute order and browser serialization; inspect exactSourceMatch for byte fidelity.'
  }
}
