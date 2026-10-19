import { Schema } from 'prosemirror-model'
import type { DOMOutputSpec, Mark, Node as ModelNode } from 'prosemirror-model'

/**
 * The scene document model, version 1.
 *
 * Novalist's own vocabulary (paragraph styles, alignment, inline formatting,
 * comments, footnotes, mentions, tracked changes, images) has explicit types.
 * Anything else a scene can contain after sanitizing keeps its HTML: unknown
 * inline wrappers become generic marks, unknown block wrappers generic
 * containers, and structures the editor cannot edit (tables, preformatted
 * text) are stored as raw HTML atoms. Converting a scene is therefore lossless,
 * and every attribute without a dedicated field is kept in `extra`.
 */

/** Attributes without a dedicated field, verbatim. */
export type ExtraAttributes = Record<string, string> | null

const extra = { extra: { default: null } }

/** DOM attributes for a node or mark: its own fields merged with `extra`. */
export function domAttributes(own: Record<string, string | null | undefined>, rest: ExtraAttributes): Record<string, string> {
  const result: Record<string, string> = { ...(rest ?? {}) }
  for (const [name, value] of Object.entries(own)) {
    if (value == null || value === '') continue
    if (name === 'class') result.class = [value, result.class].filter(Boolean).join(' ')
    else if (name === 'style') result.style = [value, result.style].filter(Boolean).join(' ')
    else result[name] = value
  }
  return result
}

/** Block attributes shared by paragraphs and headings. */
function blockAttributes(node: ModelNode): Record<string, string> {
  return domAttributes({
    class: node.attrs.style ? `nv-style-${node.attrs.style}` : null,
    style: node.attrs.align ? `text-align: ${node.attrs.align};` : null
  }, node.attrs.extra)
}

function element(tag: string, attrs: Record<string, string>, content: boolean): DOMOutputSpec {
  return content ? [tag, attrs, 0] : [tag, attrs]
}

export const sceneSchema = new Schema({
  nodes: {
    doc: { content: 'block*' },

    paragraph: {
      group: 'block',
      content: 'inline*',
      // tag: p or div. placeholder: the scene stored an empty line as <p><br></p>.
      attrs: { tag: { default: 'p' }, style: { default: null }, align: { default: null }, placeholder: { default: false }, ...extra },
      toDOM: node => element(node.attrs.tag, blockAttributes(node), true)
    },

    heading: {
      group: 'block',
      content: 'inline*',
      defining: true,
      attrs: { level: { default: 1 }, style: { default: null }, align: { default: null }, ...extra },
      toDOM: node => element(`h${node.attrs.level}`, blockAttributes(node), true)
    },

    /**
     * Prose that sits directly between blocks, or directly in a list item,
     * without a paragraph of its own. Stored HTML keeps it unwrapped.
     */
    loose_text: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['div', { 'data-nv-loose': '' }, 0]
    },

    blockquote: {
      group: 'block',
      content: 'block+',
      defining: true,
      attrs: { ...extra },
      toDOM: node => ['blockquote', domAttributes({}, node.attrs.extra), 0]
    },

    bullet_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { ...extra },
      toDOM: node => ['ul', domAttributes({}, node.attrs.extra), 0]
    },

    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { ...extra },
      toDOM: node => ['ol', domAttributes({}, node.attrs.extra), 0]
    },

    list_item: {
      content: 'block+',
      defining: true,
      attrs: { ...extra },
      toDOM: node => ['li', domAttributes({}, node.attrs.extra), 0]
    },

    /** A block wrapper without a dedicated type (div of paragraphs, section …). */
    container: {
      group: 'block',
      content: 'block+',
      attrs: { tag: { default: 'div' }, ...extra },
      toDOM: node => [node.attrs.tag, domAttributes({}, node.attrs.extra), 0]
    },

    horizontal_rule: {
      group: 'block',
      attrs: { ...extra },
      toDOM: node => ['hr', domAttributes({}, node.attrs.extra)]
    },

    /** A block structure the editor does not edit (table, pre …), verbatim. */
    html_block: {
      group: 'block',
      atom: true,
      attrs: { html: { default: '' } },
      toDOM: node => ['div', { 'data-nv-html': node.attrs.html, contenteditable: 'false' }]
    },

    text: { group: 'inline' },

    hard_break: {
      group: 'inline',
      inline: true,
      attrs: { ...extra },
      leafText: () => '\n',
      toDOM: node => ['br', domAttributes({}, node.attrs.extra)]
    },

    image: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { src: { default: '' }, alt: { default: null }, ...extra },
      toDOM: node => ['img', domAttributes({ src: node.attrs.src, alt: node.attrs.alt }, node.attrs.extra)]
    },

    /** A footnote marker; the note's text lives in the scene record. */
    footnote: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { id: { default: '' }, label: { default: '' }, ...extra },
      leafText: node => node.attrs.label,
      toDOM: node => ['sup', domAttributes({ class: 'nv-fn', 'data-fn-id': node.attrs.id }, node.attrs.extra), node.attrs.label]
    },

    /** An inline element the editor does not edit (empty anchor, template, comment …). */
    html_inline: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { html: { default: '' } },
      toDOM: node => ['span', { 'data-nv-html': node.attrs.html, contenteditable: 'false' }]
    }
  },

  // Order is nesting order when serializing: annotations outermost, formatting
  // inside them, generic wrappers innermost.
  marks: {
    link: {
      attrs: { href: { default: '' }, ...extra },
      inclusive: false,
      toDOM: mark => ['a', domAttributes({ href: mark.attrs.href }, mark.attrs.extra), 0]
    },
    comment: {
      attrs: { id: { default: '' }, ...extra },
      excludes: '',
      inclusive: false,
      toDOM: mark => ['span', domAttributes({ class: 'nv-comment', 'data-comment-id': mark.attrs.id }, mark.attrs.extra), 0]
    },
    mention: {
      attrs: { entityId: { default: '' }, ...extra },
      inclusive: false,
      toDOM: mark => ['span', domAttributes({ class: 'nv-entity-mention', 'data-entity-id': mark.attrs.entityId }, mark.attrs.extra), 0]
    },
    insertion: {
      attrs: { ...extra },
      excludes: '',
      toDOM: mark => ['ins', domAttributes({}, mark.attrs.extra), 0]
    },
    deletion: {
      attrs: { ...extra },
      excludes: '',
      toDOM: mark => ['del', domAttributes({}, mark.attrs.extra), 0]
    },
    highlight: {
      attrs: { ...extra },
      toDOM: mark => ['span', domAttributes({ class: 'nv-highlight' }, mark.attrs.extra), 0]
    },
    bold: {
      attrs: { tag: { default: 'strong' }, ...extra },
      toDOM: mark => [mark.attrs.tag, domAttributes({}, mark.attrs.extra), 0]
    },
    italic: {
      attrs: { tag: { default: 'em' }, ...extra },
      toDOM: mark => [mark.attrs.tag, domAttributes({}, mark.attrs.extra), 0]
    },
    underline: {
      attrs: { ...extra },
      toDOM: mark => ['u', domAttributes({}, mark.attrs.extra), 0]
    },
    strike: {
      attrs: { tag: { default: 's' }, ...extra },
      toDOM: mark => [mark.attrs.tag, domAttributes({}, mark.attrs.extra), 0]
    },
    superscript: {
      attrs: { ...extra },
      excludes: 'subscript',
      toDOM: mark => ['sup', domAttributes({}, mark.attrs.extra), 0]
    },
    subscript: {
      attrs: { ...extra },
      excludes: 'superscript',
      toDOM: mark => ['sub', domAttributes({}, mark.attrs.extra), 0]
    },
    /** Any other inline wrapper (styled span, code, small …), verbatim. */
    element: {
      attrs: { tag: { default: 'span' }, ...extra, depth: { default: 0 } },
      excludes: '',
      toDOM: mark => [mark.attrs.tag, domAttributes({}, mark.attrs.extra), 0]
    }
  }
})

export type SceneNode = ModelNode
export type SceneMark = Mark

/** The paragraph styles Novalist offers. Body text is the absence of one. */
export const PARAGRAPH_STYLES = ['heading', 'subheading', 'blockquote', 'poetry'] as const
