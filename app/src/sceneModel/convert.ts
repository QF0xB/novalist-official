import type { Node as ModelNode } from 'prosemirror-model'
import { BLOCK_TAGS, TRANSIENT_CLASSES, sceneFromHtml, sceneToHtml, type SceneHtmlEnvironment } from './html.ts'
import { serializeScene } from './format.ts'

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const COMMENT_NODE = 8
const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))

export type SceneConversion =
  | { ok: true; doc: ModelNode; body: string }
  | { ok: false; reason: string }

/**
 * Converts legacy scene HTML to a version 1 document, but only when nothing is
 * lost: the document must render back to HTML that means exactly the same as
 * the sanitized original (same text, same formatting on every character, same
 * blocks and attributes), and converting that rendering again must give the
 * same document. Otherwise the scene stays HTML and the reason is reported.
 */
export function convertScene(environment: SceneHtmlEnvironment, html: string): SceneConversion {
  const original = environment.sanitize(html)
  const doc = sceneFromHtml(environment, original)
  const rendered = sceneToHtml(environment.document, doc)
  const before = signature(environment.document, original)
  const after = signature(environment.document, rendered)
  if (before !== after) return { ok: false, reason: firstDifference(before, after) }
  if (!sceneFromHtml(environment, rendered).eq(doc)) return { ok: false, reason: 'conversion is not stable' }
  return { ok: true, doc, body: serializeScene(doc) }
}

/**
 * What a fragment of scene HTML means, independent of serialization details:
 * attribute order, class order, style spacing, b-inside-i versus i-inside-b,
 * and whitespace between blocks. One line per text run, atom or block start.
 */
export function signature(document: Document, html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const lines: string[] = []
  const walk = (node: Node, block: string, inline: string[]) => {
    if (node.nodeType === TEXT_NODE) {
      const text = node.textContent ?? ''
      const betweenBlocks = !/\S/.test(text) && !text.includes('\u00a0')
        && Array.from(node.parentNode?.childNodes ?? []).some(sibling => sibling.nodeType === ELEMENT_NODE && BLOCK_TAGS.has((sibling as Element).localName))
      if (!text || betweenBlocks) return
      // Control characters separate the fields: text can contain anything else.
      const prefix = `T\u0001${block}\u0001${[...inline].sort().join('\u0002')}\u0001`
      // Adjacent runs with the same formatting are one run, however split.
      if (lastWasText && lines[lines.length - 1].startsWith(prefix)) lines[lines.length - 1] += text
      else lines.push(prefix + text)
      lastWasText = true
      return
    }
    lastWasText = false
    if (node.nodeType === COMMENT_NODE) {
      lines.push(`C ${block} ${node.textContent ?? ''}`)
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return
    const element = node as Element
    const tag = element.localName
    if (tag === 'template') {
      lines.push(`E ${block} ${describe(element)} ${element.innerHTML}`)
      return
    }
    if (BLOCK_TAGS.has(tag)) {
      const path = `${block}/${describe(element)}`
      lines.push(`B ${path}`)
      element.childNodes.forEach(child => walk(child, path, []))
      lastWasText = false
      return
    }
    if (VOID_TAGS.has(tag) || !element.childNodes.length) {
      lines.push(`V ${block} ${[...inline].sort().join(' ')} ${describe(element)}`)
      return
    }
    const nested = [...inline, describe(element)]
    element.childNodes.forEach(child => walk(child, block, nested))
    lastWasText = false
  }
  let lastWasText = false
  template.content.childNodes.forEach(child => walk(child, '', []))
  return lines.join('\n')
}

/** A tag with its attributes in a canonical form. */
function describe(element: Element): string {
  const attributes = Array.from(element.attributes).map(attribute => {
    if (attribute.name === 'class') {
      const classes = attribute.value.split(/\s+/).filter(token => token && !TRANSIENT_CLASSES.has(token)).sort()
      return classes.length ? `class=${classes.join('.')}` : ''
    }
    if (attribute.name === 'style') {
      const declarations = attribute.value.split(';').map(part => part.trim().replace(/\s*:\s*/, ':')).filter(Boolean).sort()
      return declarations.length ? `style=${declarations.join(';')}` : ''
    }
    return `${attribute.name}=${JSON.stringify(attribute.value)}`
  }).filter(Boolean).sort()
  return [element.localName, ...attributes].join('|')
}

function firstDifference(before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] !== b[index]) {
      return `differs at ${index + 1}: expected ${JSON.stringify(a[index] ?? '(end)')}, got ${JSON.stringify(b[index] ?? '(end)')}`
    }
  }
  return 'differs'
}
