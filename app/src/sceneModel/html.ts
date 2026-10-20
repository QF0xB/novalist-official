import { DOMSerializer } from 'prosemirror-model'
import type { Fragment, Mark, Node as ModelNode } from 'prosemirror-model'
import { sceneSchema, type ExtraAttributes } from './schema.ts'

/** Sanitizes scene HTML with the editor's policy, in a given DOM document. */
export interface SceneHtmlEnvironment {
  readonly document: Document
  sanitize(html: string): string
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const COMMENT_NODE = 8

export const BLOCK_TAGS = new Set(('address article aside blockquote caption dd details dialog div dl dt fieldset '
  + 'figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table '
  + 'tbody td tfoot th thead tr ul').split(' '))
const VOID_TAGS = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))
/** Structures stored verbatim: editing their inside could produce invalid HTML. */
const VERBATIM_BLOCKS = new Set('table caption tbody thead tfoot tr td th pre details summary dialog dl dt dd fieldset'.split(' '))
/** Classes the old editor added for display only; never content. */
export const TRANSIENT_CLASSES = new Set(['nv-focus-block', 'nv-change-flash', 'nv-comment-active', 'nv-mention-missing', 'grammar-issue'])

const STYLE_PREFIX = 'nv-style-'

function isElement(node: Node): node is Element {
  return node.nodeType === ELEMENT_NODE
}

function isBlock(element: Element): boolean {
  return BLOCK_TAGS.has(element.localName)
}

function hasBlockChild(element: Element): boolean {
  return Array.from(element.children).some(isBlock)
}

function isBlankText(node: Node): boolean {
  return node.nodeType === TEXT_NODE && !/\S/.test(node.textContent ?? '') && !(node.textContent ?? '').includes('\u00a0')
}

// Rendering writes styles through the CSS parser (ProseMirror assigns
// style.cssText), which reformats them. Stored styles use that same canonical
// form, so converting a rendered scene again gives the same document.
let styleProbe: HTMLElement | null = null

function canonicalStyle(value: string): string {
  if (!styleProbe) return value
  styleProbe.setAttribute('style', value)
  // Declarations the parser does not know are kept as written; the conversion
  // check reports the scene if they would not survive rendering.
  return styleProbe.style.cssText || value
}

/**
 * The element's attributes minus those a type stores in its own fields.
 * `classes` lists class tokens that are consumed; transient display classes
 * are always dropped.
 */
function extraAttributes(element: Element, consumed: string[] = [], classes: string[] = []): ExtraAttributes {
  const result: Record<string, string> = {}
  for (const attribute of Array.from(element.attributes)) {
    if (consumed.includes(attribute.name)) continue
    if (attribute.name === 'class') {
      const rest = attribute.value.split(/\s+/).filter(token => token && !classes.includes(token) && !TRANSIENT_CLASSES.has(token))
      if (rest.length) result.class = rest.join(' ')
      continue
    }
    result[attribute.name] = attribute.name === 'style' ? canonicalStyle(attribute.value) : attribute.value
  }
  return Object.keys(result).length ? result : null
}

function classTokens(element: Element): string[] {
  return (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
}

/** Splits `text-align` out of an inline style, keeping every other declaration. */
function splitAlignment(element: Element): { align: string | null; rest: string | null } {
  const style = element.getAttribute('style')
  if (!style) return { align: null, rest: null }
  let align: string | null = null
  const rest = style.split(';').map(part => part.trim()).filter(part => {
    const match = /^text-align\s*:\s*(left|right|center|justify|start|end)$/i.exec(part)
    if (match) align = match[1].toLowerCase()
    return part && !match
  })
  return { align, rest: rest.length ? canonicalStyle(rest.join('; ') + ';') : null }
}

/** Attributes for a paragraph or heading: style class and alignment split out. */
function blockFields(element: Element) {
  const style = classTokens(element).find(token => token.startsWith(STYLE_PREFIX))
  const { align, rest } = splitAlignment(element)
  const remaining = extraAttributes(element, ['style'], style ? [style] : [])
  const merged = rest ? { ...(remaining ?? {}), style: rest } : remaining
  return { style: style ? style.slice(STYLE_PREFIX.length) : null, align, extra: merged }
}

/** `<p><br></p>`: the break only gives an empty line its height. */
function placeholderBreak(element: Element): Element | null {
  const only = element.childNodes.length === 1 ? element.firstChild : null
  return only && isElement(only) && only.localName === 'br' && !only.attributes.length ? only : null
}

function outerHtml(node: Node): string {
  if (isElement(node)) return node.outerHTML
  if (node.nodeType === COMMENT_NODE) return `<!--${node.textContent ?? ''}-->`
  return node.textContent ?? ''
}

function verbatimBlock(node: Node): ModelNode {
  return sceneSchema.nodes.html_block.create({ html: outerHtml(node) })
}

function markFor(element: Element, depth: number): Mark | null {
  const tag = element.localName
  const classes = classTokens(element)
  const { marks } = sceneSchema
  if (tag === 'a' && element.hasAttribute('href')) {
    return marks.link.create({ href: element.getAttribute('href'), extra: extraAttributes(element, ['href']) })
  }
  if (tag === 'span' && classes.includes('nv-comment')) {
    return marks.comment.create({ id: element.getAttribute('data-comment-id') ?? '', extra: extraAttributes(element, ['data-comment-id'], ['nv-comment']) })
  }
  if (tag === 'span' && classes.includes('nv-entity-mention')) {
    return marks.mention.create({ entityId: element.getAttribute('data-entity-id') ?? '', extra: extraAttributes(element, ['data-entity-id'], ['nv-entity-mention']) })
  }
  if (tag === 'span' && classes.includes('nv-highlight')) {
    return marks.highlight.create({ extra: extraAttributes(element, [], ['nv-highlight']) })
  }
  if (tag === 'ins') return marks.insertion.create({ extra: extraAttributes(element) })
  if (tag === 'del') return marks.deletion.create({ extra: extraAttributes(element) })
  if (tag === 'b' || tag === 'strong') return marks.bold.create({ tag, extra: extraAttributes(element) })
  if (tag === 'i' || tag === 'em') return marks.italic.create({ tag, extra: extraAttributes(element) })
  if (tag === 'u') return marks.underline.create({ extra: extraAttributes(element) })
  if (tag === 's' || tag === 'strike') return marks.strike.create({ tag, extra: extraAttributes(element) })
  if (tag === 'sup') return marks.superscript.create({ extra: extraAttributes(element) })
  if (tag === 'sub') return marks.subscript.create({ extra: extraAttributes(element) })
  return marks.element.create({ tag, extra: extraAttributes(element), depth })
}

function inline(nodes: ArrayLike<Node>, marks: readonly Mark[] = []): ModelNode[] {
  const { nodes: types } = sceneSchema
  return Array.from(nodes).flatMap((node): ModelNode[] => {
    if (node.nodeType === TEXT_NODE) return node.textContent ? [sceneSchema.text(node.textContent, marks)] : []
    if (node.nodeType === COMMENT_NODE) return [types.html_inline.create({ html: outerHtml(node) }, null, marks)]
    if (!isElement(node)) return []
    const tag = node.localName
    if (tag === 'br') return [types.hard_break.create({ extra: extraAttributes(node) }, null, marks)]
    if (tag === 'img') {
      return [types.image.create({ src: node.getAttribute('src') ?? '', alt: node.getAttribute('alt'), extra: extraAttributes(node, ['src', 'alt']) }, null, marks)]
    }
    if (tag === 'sup' && classTokens(node).includes('nv-fn') && Array.from(node.childNodes).every(child => child.nodeType === TEXT_NODE)) {
      return [types.footnote.create({
        id: node.getAttribute('data-fn-id') ?? '', label: node.textContent ?? '',
        extra: extraAttributes(node, ['data-fn-id'], ['nv-fn'])
      }, null, marks)]
    }
    // Empty wrappers (anchors, templates), voids and misplaced blocks: verbatim.
    if (VOID_TAGS.has(tag) || tag === 'template' || !node.childNodes.length || hasBlockChild(node) || isBlock(node)) {
      return [types.html_inline.create({ html: outerHtml(node) }, null, marks)]
    }
    const mark = markFor(node, marks.length)
    return inline(node.childNodes, mark ? [...marks, mark] : marks)
  })
}

function blocks(nodes: ArrayLike<Node>): ModelNode[] {
  const { nodes: types } = sceneSchema
  const output: ModelNode[] = []
  let run: Node[] = []
  const flush = () => {
    if (run.some(node => !isBlankText(node))) output.push(types.loose_text.create(null, inline(run)))
    run = []
  }
  for (const node of Array.from(nodes)) {
    if (!isElement(node) || !isBlock(node)) {
      run.push(node)
      continue
    }
    flush()
    output.push(block(node))
  }
  flush()
  return output
}

function block(element: Element): ModelNode {
  const { nodes: types } = sceneSchema
  const tag = element.localName
  if (VERBATIM_BLOCKS.has(tag)) return verbatimBlock(element)
  if (tag === 'hr') return types.horizontal_rule.create({ extra: extraAttributes(element) })
  if ((tag === 'p' || tag === 'div') && !hasBlockChild(element)) {
    const placeholder = placeholderBreak(element)
    return types.paragraph.create({ tag, ...blockFields(element), placeholder: !!placeholder },
      placeholder ? null : inline(element.childNodes))
  }
  const heading = /^h([1-6])$/.exec(tag)
  if (heading) {
    if (hasBlockChild(element)) return verbatimBlock(element)
    return types.heading.create({ level: Number(heading[1]), ...blockFields(element) }, inline(element.childNodes))
  }
  if (tag === 'ul' || tag === 'ol') {
    const items = Array.from(element.childNodes).filter(child => !isBlankText(child))
    if (!items.length || !items.every(child => isElement(child) && child.localName === 'li')) return verbatimBlock(element)
    const listItems = (items as Element[]).map(item =>
      types.list_item.create({ extra: extraAttributes(item) }, nonEmpty(blocks(item.childNodes))))
    return (tag === 'ul' ? types.bullet_list : types.ordered_list).create({ extra: extraAttributes(element) }, listItems)
  }
  if (tag === 'blockquote') return types.blockquote.create({ extra: extraAttributes(element) }, nonEmpty(blocks(element.childNodes)))
  return types.container.create({ tag, extra: extraAttributes(element) }, nonEmpty(blocks(element.childNodes)))
}

/** Content for a `block+` node; an empty element keeps one empty loose run. */
function nonEmpty(content: ModelNode[]): ModelNode[] {
  return content.length ? content : [sceneSchema.nodes.loose_text.create()]
}

/** Converts (sanitized) scene HTML into a scene document. */
export function sceneFromHtml(environment: SceneHtmlEnvironment, html: string): ModelNode {
  const template = environment.document.createElement('template')
  template.innerHTML = environment.sanitize(html)
  styleProbe = environment.document.createElement('div')
  try {
    return sceneSchema.nodes.doc.create(null, blocks(template.content.childNodes))
  } finally {
    styleProbe = null
  }
}

/**
 * Renders a scene document as the HTML Novalist stored before version 1, for
 * exports, previews and the conversion check. Not used for editing.
 */
export function sceneToHtml(document: Document, doc: ModelNode): string {
  return sceneFragmentToHtml(document, doc.content)
}

/** The same rendering for any part of a scene, e.g. a copied selection. */
export function sceneFragmentToHtml(document: Document, content: Fragment): string {
  const base = DOMSerializer.nodesFromSchema(sceneSchema)
  const serializer = new DOMSerializer({
    ...base,
    loose_text: () => {
      const run = document.createElement('nv-loose')
      return { dom: run, contentDOM: run }
    },
    html_block: node => raw(document, node.attrs.html),
    html_inline: node => raw(document, node.attrs.html),
    paragraph: node => {
      const rendered = DOMSerializer.renderSpec(document, base.paragraph(node))
      if (node.attrs.placeholder && !node.childCount) rendered.dom.appendChild(document.createElement('br'))
      return rendered
    }
  }, DOMSerializer.marksFromSchema(sceneSchema))
  const holder = document.createElement('div')
  holder.appendChild(serializer.serializeFragment(content, { document }))
  holder.querySelectorAll('nv-loose, nv-raw').forEach(wrapper => {
    if (wrapper.localName === 'nv-raw') {
      const template = document.createElement('template')
      template.innerHTML = wrapper.getAttribute('data-html') ?? ''
      wrapper.replaceWith(template.content)
    } else {
      wrapper.replaceWith(...Array.from(wrapper.childNodes))
    }
  })
  return holder.innerHTML
}

function raw(document: Document, html: string): HTMLElement {
  const wrapper = document.createElement('nv-raw')
  wrapper.setAttribute('data-html', html)
  return wrapper
}

export const emptyScene = (): ModelNode => sceneSchema.nodes.doc.create(null,
  sceneSchema.nodes.paragraph.create({ placeholder: true }))
