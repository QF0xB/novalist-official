import { toggleMark } from 'prosemirror-commands'
import { liftListItem, wrapInList } from 'prosemirror-schema-list'
import type { MarkType, Node as ModelNode, NodeType } from 'prosemirror-model'
import type { Command, EditorState } from 'prosemirror-state'
import { sceneSchema } from '../sceneModel/schema.ts'

const { marks, nodes } = sceneSchema

/** Blocks whose text the selection touches and that carry style and alignment. */
function selectedTextBlocks(state: EditorState): Array<{ node: ModelNode; pos: number }> {
  const result: Array<{ node: ModelNode; pos: number }> = []
  const { from, to } = state.selection
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === nodes.paragraph || node.type === nodes.heading) {
      result.push({ node, pos })
      return false
    }
    return true
  })
  return result
}

function setBlockAttribute(name: 'align' | 'style', value: string | null): Command {
  return (state, dispatch) => {
    const blocks = selectedTextBlocks(state)
    if (!blocks.length) return false
    if (dispatch) {
      const transaction = state.tr
      for (const { pos } of blocks) transaction.setNodeAttribute(pos, name, value)
      dispatch(transaction.scrollIntoView())
    }
    return true
  }
}

/** Left is the default, stored as no alignment at all. */
export const setAlignment = (align: 'left' | 'center' | 'right' | 'justify'): Command =>
  setBlockAttribute('align', align === 'left' ? null : align)

/** A named paragraph style; '' is body text. */
export const setParagraphStyle = (style: string): Command => setBlockAttribute('style', style || null)

export const toggle = (type: MarkType): Command => toggleMark(type)

function listAround(state: EditorState): NodeType | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const type = $from.node(depth).type
    if (type === nodes.bullet_list || type === nodes.ordered_list) return type
  }
  return null
}

/** Lists the selection, unlists it, or switches between list kinds. */
export function toggleList(type: NodeType): Command {
  return (state, dispatch) => {
    const current = listAround(state)
    if (current === type) return liftListItem(nodes.list_item)(state, dispatch)
    if (current) {
      // Switching kinds keeps the items and only changes the list around them.
      const { $from } = state.selection
      for (let depth = $from.depth; depth > 0; depth--) {
        if ($from.node(depth).type === current) {
          if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(depth), type))
          return true
        }
      }
    }
    return wrapInList(type)(state, dispatch)
  }
}

/** What the toolbar shows for the current selection. */
export function formattingState(state: EditorState) {
  const { from, to, empty, $from } = state.selection
  const active = (type: MarkType) => empty
    ? !!type.isInSet(state.storedMarks ?? $from.marks())
    : state.doc.rangeHasMark(from, to, type)
  const blocks = selectedTextBlocks(state)
  const first = blocks[0]?.node
  const same = (name: 'align' | 'style') => blocks.every(block => block.node.attrs[name] === first?.attrs[name])
  const list = listAround(state)
  return {
    bold: active(marks.bold),
    italic: active(marks.italic),
    underline: active(marks.underline),
    strikethrough: active(marks.strike),
    highlight: active(marks.highlight),
    alignment: first && same('align') ? (first.attrs.align ?? 'left') : 'left',
    paragraphStyle: first && same('style') ? (first.attrs.style ?? '') : '',
    bulletList: list === nodes.bullet_list,
    numberList: list === nodes.ordered_list,
    hasSelection: !empty && state.doc.textBetween(from, to, ' ').trim() !== '',
    linkActive: active(marks.link),
    entityAtCaret: false
  }
}
