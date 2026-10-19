import { DOMSerializer, Schema } from 'prosemirror-model'
import type { DOMOutputSpec, Mark, Node as ModelNode } from 'prosemirror-model'

const blockTags = new Set(('address article aside blockquote caption dd details dialog div dl dt fieldset figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul').split(' '))
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '))
const transientClasses = new Set(['nv-focus-block', 'nv-change-flash', 'nv-comment-active', 'nv-mention-missing'])
// ProseMirror's own rendering aids. Re-reading the live DOM must never adopt
// them as content: each adopted aid is rendered with new aids around it, which
// grew the document (and its Yjs history) on every reconciliation.
const viewHelpers = ['img.ProseMirror-separator', 'br.ProseMirror-trailingBreak', '.ProseMirror-widget']

function isViewHelper(element: Element): boolean {
  return viewHelpers.some(selector => element.matches(selector))
}

function isBlock(element: Element): boolean {
  return blockTags.has(element.localName) || Array.from(element.children).some(isBlock)
}

/**
 * The `<br>` Chromium keeps in an otherwise empty paragraph so it has a line
 * height. It is a placeholder, not a line break the writer typed: adopting it as
 * content left a leading break in front of the first words typed into the line.
 */
function placeholderBreak(block: Element): Element | null {
  const content = Array.from(block.childNodes).filter(node => node instanceof Element
    ? !node.matches('img.ProseMirror-separator, .ProseMirror-widget')
    : node.nodeType !== Node.TEXT_NODE || node.textContent)
  return content.length === 1 && content[0] instanceof Element && content[0].localName === 'br' ? content[0] : null
}

function attributes(element: Element): Record<string, string> {
  const result = Object.fromEntries(Array.from(element.attributes)
    .filter(a => !a.name.startsWith('data-pm-') && a.name !== 'data-nv-src')
    .map(a => [a.name, a.value]))
  if (element.hasAttribute('data-nv-src')) result.src = element.getAttribute('data-nv-src')!
  if (result.class) {
    result.class = result.class.split(/\s+/).filter(value => !transientClasses.has(value)).join(' ')
    if (!result.class) delete result.class
  }
  return result
}

function attrs(element: Element) {
  return { tag: element.localName, html: attributes(element) }
}

const elementAttrs = { tag: { default: 'p' }, html: { default: {} } }

function renderElement(tag: string, html: Record<string, string>, content: boolean): DOMOutputSpec {
  const dom = document.createElement(tag)
  // DOMSerializer's array form assigns style.cssText, which reformats the
  // original style attribute. setAttribute keeps existing scene HTML stable.
  Object.entries(html).forEach(([name, value]) => dom.setAttribute(name, value))
  return content ? { dom, contentDOM: dom } : dom
}

/**
 * Compatibility schema: keep Novalist's actual HTML element/attribute vocabulary,
 * including table structure, rather than narrowing projects to schema-basic.
 * Inline formatting is represented as Yjs-backed marks. Transparent text runs
 * retain text between blocks without adding paragraphs to saved HTML.
 */
export const htmlSchema = new Schema({
  nodes: {
    doc: { content: 'block*' },
    textblock: {
      group: 'block', content: 'inline*', attrs: { ...elementAttrs, placeholder: { default: false } },
      parseDOM: [{ tag: '*', getAttrs: element => isBlock(element) && !voidTags.has(element.localName)
        && !Array.from(element.children).some(isBlock)
        ? { ...attrs(element), placeholder: !!placeholderBreak(element) } : false }],
      toDOM: node => renderElement(node.attrs.tag, node.attrs.html, true)
    },
    text_run: {
      group: 'block', content: 'inline*',
      parseDOM: [{ tag: 'nv-text-run', priority: 100 }],
      toDOM: () => ['nv-text-run', 0]
    },
    container: {
      group: 'block', content: 'block*', attrs: elementAttrs,
      parseDOM: [{ tag: '.nv-page', skip: true, priority: 100 }, {
        tag: '*', getAttrs: element => isBlock(element) && !voidTags.has(element.localName)
          && Array.from(element.children).some(isBlock) ? attrs(element) : false
      }],
      toDOM: node => renderElement(node.attrs.tag, node.attrs.html, true)
    },
    block_atom: {
      group: 'block', atom: true, attrs: elementAttrs,
      parseDOM: [{ tag: 'hr', getAttrs: attrs }],
      toDOM: node => renderElement(node.attrs.tag, node.attrs.html, false)
    },
    inline_atom: {
      group: 'inline', inline: true, atom: true, attrs: elementAttrs,
      parseDOM: [...viewHelpers.map(tag => ({ tag, ignore: true, priority: 200 })), {
        tag: 'br', ignore: true, priority: 150,
        getAttrs: element => element.parentElement && placeholderBreak(element.parentElement) === element ? null : false
      }, {
        tag: '*', getAttrs: element => element.localName !== 'hr'
          && element.localName !== 'template' && element.localName !== 'nv-source-comment'
          && (voidTags.has(element.localName) || (!isBlock(element) && !element.childNodes.length))
          ? attrs(element) : false
      }],
      toDOM: node => renderElement(node.attrs.tag, node.attrs.html, false),
      leafText: node => node.attrs.tag === 'br' ? '\n' : ''
    },
    template: {
      group: 'inline', inline: true, atom: true,
      attrs: { html: { default: {} }, content: { default: '' } },
      parseDOM: [{ tag: 'template', getAttrs: element => ({ html: attributes(element), content: element.innerHTML }) }],
      toDOM: node => {
        const template = document.createElement('template')
        Object.entries(node.attrs.html).forEach(([key, value]) => template.setAttribute(key, String(value)))
        template.innerHTML = node.attrs.content
        return template
      }
    },
    source_comment: {
      group: 'inline', inline: true, atom: true,
      attrs: { text: { default: '' } },
      parseDOM: [{ tag: 'nv-source-comment', priority: 100, getAttrs: element => ({ text: element.getAttribute('data-content') || '' }) }],
      toDOM: node => ['nv-source-comment', { hidden: '', 'data-content': node.attrs.text }]
    },
    text: { group: 'inline' }
  },
  marks: {
    html: {
      attrs: { ...elementAttrs, depth: { default: 0 } }, excludes: '',
      parseDOM: [
        { tag: '.grammar-issue', skip: true, priority: 100 },
        { tag: '.collaboration-cursor', ignore: true, priority: 100 },
        { tag: '.collaboration-selection', skip: true, priority: 100 },
        { tag: '*', getAttrs: element => !isBlock(element) && !voidTags.has(element.localName)
          && !['nv-text-run', 'template', 'nv-source-comment'].includes(element.localName)
          ? { ...attrs(element), depth: inlineDepth(element) } : false }
      ],
      toDOM: mark => renderElement(mark.attrs.tag, mark.attrs.html, true)
    }
  }
})

function inlineDepth(element: Element): number {
  let depth = 0
  for (let parent = element.parentElement; parent && !isBlock(parent); parent = parent.parentElement) depth++
  return depth
}

function inline(nodes: NodeListOf<ChildNode>, marks: readonly Mark[] = []): ModelNode[] {
  return Array.from(nodes).flatMap(node => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ? [htmlSchema.text(node.textContent, marks)] : []
    if (node.nodeType === Node.COMMENT_NODE) return [htmlSchema.nodes.source_comment.create({ text: node.textContent }, null, marks)]
    if (!(node instanceof Element) || isViewHelper(node)) return []
    if (node.localName === 'template') return [htmlSchema.nodes.template.create({ html: attributes(node), content: node.innerHTML }, null, marks)]
    if (voidTags.has(node.localName) || !node.childNodes.length) return [htmlSchema.nodes.inline_atom.create(attrs(node), null, marks)]
    if (node.classList.contains('grammar-issue') || node.classList.contains('collaboration-selection')) return inline(node.childNodes, marks)
    if (node.classList.contains('collaboration-cursor')) return []
    const mark = htmlSchema.marks.html.create({ ...attrs(node), depth: marks.length })
    return inline(node.childNodes, [...marks, mark])
  })
}

function blocks(nodes: NodeListOf<ChildNode>): ModelNode[] {
  const output: ModelNode[] = []
  let run: ChildNode[] = []
  const flush = () => {
    if (!run.length) return
    const holder = document.createElement('div')
    run.forEach(node => holder.append(node.cloneNode(true)))
    const content = inline(holder.childNodes)
    if (content.length) output.push(htmlSchema.nodes.text_run.create(null, content))
    run = []
  }
  for (const node of Array.from(nodes)) {
    if (!(node instanceof Element) || !isBlock(node)) { run.push(node); continue }
    flush()
    if (node.classList.contains('nv-page')) { output.push(...blocks(node.childNodes)); continue }
    if (voidTags.has(node.localName)) output.push(htmlSchema.nodes.block_atom.create(attrs(node)))
    else if (Array.from(node.children).some(isBlock)) output.push(htmlSchema.nodes.container.create(attrs(node), blocks(node.childNodes)))
    else {
      const placeholder = !!placeholderBreak(node)
      output.push(htmlSchema.nodes.textblock.create({ ...attrs(node), placeholder }, placeholder ? null : inline(node.childNodes)))
    }
  }
  flush()
  return output
}

export function importHtml(html: string): ModelNode {
  const fragment = window.sanitizeSceneFragment(html)
  return htmlSchema.nodes.doc.create(null, blocks(fragment.childNodes))
}

// Saved HTML keeps the placeholder break of an empty line, as the native editor
// did. The live view gets ProseMirror's own trailing break instead.
const serializer = new DOMSerializer({
  ...DOMSerializer.nodesFromSchema(htmlSchema),
  textblock: node => {
    const spec = renderElement(node.attrs.tag, node.attrs.html, true) as { dom: HTMLElement; contentDOM: HTMLElement }
    if (node.attrs.placeholder && !node.childCount) spec.dom.append(document.createElement('br'))
    return spec
  }
}, DOMSerializer.marksFromSchema(htmlSchema))

export function projectHtml(doc: ModelNode): string {
  const holder = document.createElement('div')
  holder.append(serializer.serializeFragment(doc.content))
  holder.querySelectorAll('nv-text-run').forEach(run => run.replaceWith(...Array.from(run.childNodes)))
  holder.querySelectorAll('nv-source-comment').forEach(comment => comment.replaceWith(document.createComment(comment.getAttribute('data-content') || '')))
  return window.sanitizeSceneHtml(holder.innerHTML)
}
