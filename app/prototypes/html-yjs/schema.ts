import { Schema } from 'prosemirror-model'
import type { DOMOutputSpec, Mark, Node as ProseMirrorNode, MarkSpec, NodeSpec, TagParseRule } from 'prosemirror-model'
import { schema as basic } from 'prosemirror-schema-basic'
import { addListNodes } from 'prosemirror-schema-list'

// These are content attributes, not the current editor's presentation wrappers.
// Unsupported attributes/elements are deliberately exposed by the fidelity report.
function htmlAttrs(element: HTMLElement): Record<string, string> {
  return Object.fromEntries(Array.from(element.attributes)
    .filter(({ name }) => ['class', 'style', 'id', 'title', 'dir', 'lang', 'width', 'height'].includes(name)
      || name.startsWith('data-'))
    .map(({ name, value }) => [name, value]))
}

function withAttrs<T extends NodeSpec | MarkSpec>(spec: T): T {
  const render = spec.toDOM as (value: ProseMirrorNode | Mark, inline: boolean) => DOMOutputSpec
  return {
    ...spec,
    attrs: { ...spec.attrs, htmlAttrs: { default: {} } },
    parseDOM: spec.parseDOM?.map(rule => {
      if (!('tag' in rule)) return rule
      const tagRule = rule as TagParseRule
      return {
        ...tagRule,
        getAttrs(element: HTMLElement) {
          const original = tagRule.getAttrs ? tagRule.getAttrs(element) : tagRule.attrs
          return original === false ? false : { ...original, htmlAttrs: htmlAttrs(element) }
        }
      }
    }),
    toDOM(value: ProseMirrorNode | Mark, inline: boolean) {
      const output = render(value, inline) as [string, ...unknown[]]
      const [tag, second, ...rest] = output
      const attrs = value.attrs.htmlAttrs
      if (typeof second === 'object' && second !== null && !Array.isArray(second)) {
        return [tag, { ...second, ...attrs }, ...rest] as DOMOutputSpec
      }
      return [tag, attrs, ...output.slice(1)] as DOMOutputSpec
    }
  } as T
}

let nodes = addListNodes(basic.spec.nodes, 'paragraph block*', 'block')
nodes.forEach((name, spec) => {
  if (spec.toDOM) nodes = nodes.update(name, withAttrs(spec) as NodeSpec)
})
nodes = nodes.addBefore('text', 'footnote', {
  inline: true,
  group: 'inline',
  content: 'text*',
  atom: true,
  attrs: { htmlAttrs: { default: {} } },
  parseDOM: [{ tag: 'sup.nv-fn[data-fn-id]', getAttrs: element => ({ htmlAttrs: htmlAttrs(element) }) }],
  toDOM: node => ['sup', node.attrs.htmlAttrs, 0]
})

let marks = basic.spec.marks
marks.forEach((name, spec) => {
  if (spec.toDOM) marks = marks.update(name, withAttrs(spec) as MarkSpec)
})
for (const [name, tag] of [
  ['span', 'span'], ['underline', 'u'], ['strike', 's'],
  ['superscript', 'sup'], ['subscript', 'sub'], ['insertion', 'ins'], ['deletion', 'del']
]) {
  marks = marks.addToEnd(name, {
    attrs: { htmlAttrs: { default: {} } },
    // Multiple differently annotated spans may overlap; editing behavior still
    // needs evaluation, especially boundary typing and pasted nested spans.
    excludes: '',
    parseDOM: [{ tag, getAttrs: element => ({ htmlAttrs: htmlAttrs(element) }) }],
    toDOM: mark => [tag, mark.attrs.htmlAttrs, 0]
  })
}

export const sceneSchema = new Schema({ nodes, marks })
