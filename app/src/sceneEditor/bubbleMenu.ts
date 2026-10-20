import { toggleMark } from 'prosemirror-commands'
import { redo, redoDepth, undo, undoDepth } from 'prosemirror-history'
import type { MarkType } from 'prosemirror-model'
import { Plugin } from 'prosemirror-state'
import type { Command, EditorState } from 'prosemirror-state'
import type { EditorView } from 'prosemirror-view'
import { sceneSchema } from '../sceneModel/schema.ts'
import { formattingState, setParagraphStyle, toggleList } from './commands.ts'
import './bubbleMenu.css'

const { marks, nodes } = sceneSchema

// Lucide icon geometry (ISC), the app's own icon set.
const icons: Record<string, string> = {
  bold: '<path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8"/>',
  italic: '<line x1="19" x2="10" y1="4" y2="4"/><line x1="14" x2="5" y1="20" y2="20"/><line x1="15" x2="9" y1="4" y2="20"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" x2="20" y1="20" y2="20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" x2="20" y1="12" y2="12"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
  quote: '<path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>'
    + '<path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"/>',
  heading: '<path d="M6 12h12"/><path d="M6 20V4"/><path d="M18 20V4"/>',
  list: '<path d="M3 12h.01"/><path d="M3 18h.01"/><path d="M3 6h.01"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M8 6h13"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>'
}

const svg = (name: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`

interface Choice {
  label: string
  run: Command
  active: (state: EditorState) => boolean
}

interface Item {
  id: string
  label: string
  run?: (view: EditorView) => void
  active?: (state: EditorState) => boolean
  enabled?: (state: EditorState) => boolean
  /** A dropdown instead of a direct action. */
  choices?: Choice[]
}

const markActive = (type: MarkType) => (state: EditorState) =>
  state.doc.rangeHasMark(state.selection.from, state.selection.to, type)
const command = (run: Command) => (view: EditorView) => { run(view.state, view.dispatch, view) }
const styleIs = (style: string) => (state: EditorState) => formattingState(state).paragraphStyle === style

function words(state: EditorState): number {
  const text = state.doc.textBetween(state.selection.from, state.selection.to, ' ', ' ')
  return text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word)).length
}

/**
 * The formatting bubble over a selection, after NovelCrafter's: a small tab
 * with the selection's word count and undo/redo, and the bar beneath it,
 * left-aligned with the start of the selection. Formatting belongs to selected
 * words, so it appears with them and stays out of the way while writing.
 */
export function bubbleMenu(requestLink: () => void): Plugin {
  const bar: Item[][] = [
    [
      { id: 'bold', label: 'Bold', run: command(toggleMark(marks.bold)), active: markActive(marks.bold) },
      { id: 'italic', label: 'Italic', run: command(toggleMark(marks.italic)), active: markActive(marks.italic) },
      { id: 'underline', label: 'Underline', run: command(toggleMark(marks.underline)), active: markActive(marks.underline) },
      { id: 'strike', label: 'Strikethrough', run: command(toggleMark(marks.strike)), active: markActive(marks.strike) }
    ],
    [
      { id: 'highlight', label: 'Highlight', run: command(toggleMark(marks.highlight)), active: markActive(marks.highlight) },
      { id: 'link', label: 'Link', run: () => requestLink(), active: markActive(marks.link) }
    ],
    [
      { id: 'quote', label: 'Quote', run: view => command(setParagraphStyle(styleIs('blockquote')(view.state) ? '' : 'blockquote'))(view), active: styleIs('blockquote') },
      {
        id: 'heading', label: 'Paragraph style', active: state => ['heading', 'subheading', 'poetry'].includes(formattingState(state).paragraphStyle),
        choices: [
          { label: 'Body', run: setParagraphStyle(''), active: styleIs('') },
          { label: 'Heading', run: setParagraphStyle('heading'), active: styleIs('heading') },
          { label: 'Subheading', run: setParagraphStyle('subheading'), active: styleIs('subheading') },
          { label: 'Poetry', run: setParagraphStyle('poetry'), active: styleIs('poetry') }
        ]
      },
      {
        id: 'list', label: 'List', active: state => formattingState(state).bulletList || formattingState(state).numberList,
        choices: [
          { label: 'Bulleted list', run: toggleList(nodes.bullet_list), active: state => formattingState(state).bulletList },
          { label: 'Numbered list', run: toggleList(nodes.ordered_list), active: state => formattingState(state).numberList }
        ]
      }
    ]
  ]
  const history: Item[] = [
    { id: 'undo', label: 'Undo', run: command(undo), enabled: state => undoDepth(state) > 0 },
    { id: 'redo', label: 'Redo', run: command(redo), enabled: state => redoDepth(state) > 0 }
  ]

  return new Plugin({
    view(view) {
      const menu = document.createElement('div')
      menu.className = 'nv-bubble'
      menu.setAttribute('role', 'toolbar')
      menu.setAttribute('aria-label', 'Formatting')
      const tab = document.createElement('div')
      tab.className = 'nv-bubble-tab'
      const count = document.createElement('span')
      count.className = 'nv-bubble-count'
      tab.append(count)
      const row = document.createElement('div')
      row.className = 'nv-bubble-bar'
      const popup = document.createElement('div')
      popup.className = 'nv-bubble-popup'
      popup.setAttribute('role', 'menu')
      menu.append(tab, row, popup)

      const buttons = new Map<HTMLButtonElement, Item>()
      const button = (item: Item, parent: HTMLElement) => {
        const element = document.createElement('button')
        element.type = 'button'
        element.title = item.label
        element.setAttribute('aria-label', item.label)
        element.dataset.command = item.id
        element.innerHTML = svg(item.id) + (item.choices ? `<span class="nv-bubble-chevron">${svg('chevron')}</span>` : '')
        if (item.choices) element.setAttribute('aria-haspopup', 'menu')
        parent.append(element)
        buttons.set(element, item)
      }
      history.forEach(item => button(item, tab))
      bar.forEach((group, index) => {
        if (index) row.append(Object.assign(document.createElement('span'), { className: 'nv-bubble-separator' }))
        group.forEach(item => button(item, row))
      })

      let open: Item | null = null
      const openChoices = (item: Item, anchor: HTMLElement) => {
        open = item
        popup.replaceChildren(...item.choices!.map(choice => {
          const entry = document.createElement('button')
          entry.type = 'button'
          entry.setAttribute('role', 'menuitemradio')
          entry.textContent = choice.label
          entry.classList.toggle('active', choice.active(view.state))
          entry.setAttribute('aria-checked', String(choice.active(view.state)))
          entry.addEventListener('mousedown', event => {
            event.preventDefault()
            event.stopPropagation()
            choice.run(view.state, view.dispatch, view)
            closeChoices()
            update()
          })
          return entry
        }))
        popup.style.left = `${anchor.offsetLeft}px`
        popup.classList.add('visible')
      }
      const closeChoices = () => {
        open = null
        popup.classList.remove('visible')
      }

      // Pressing a button must not move focus or the selection out of the prose.
      menu.addEventListener('mousedown', event => {
        event.preventDefault()
        const element = (event.target as Element).closest('button')
        const item = element && buttons.get(element as HTMLButtonElement)
        if (!item || (element as HTMLButtonElement).disabled) return
        if (item.choices) {
          if (open === item) closeChoices()
          else openChoices(item, element as HTMLElement)
          return
        }
        closeChoices()
        item.run?.(view)
        update()
      })
      document.body.append(menu)

      let dragging = false
      const onDown = () => { dragging = true; hide() }
      const onUp = () => { if (dragging) { dragging = false; setTimeout(update) } }
      view.dom.addEventListener('mousedown', onDown)
      document.addEventListener('mouseup', onUp)

      function hide() {
        menu.classList.remove('visible')
        closeChoices()
      }

      function update() {
        const { state } = view
        const { from, to, empty } = state.selection
        if (dragging || empty || !view.hasFocus() || !view.editable || !state.doc.textBetween(from, to, ' ').trim()) {
          hide()
          return
        }
        for (const [element, item] of buttons) {
          element.classList.toggle('active', item.active?.(state) ?? false)
          element.disabled = item.enabled ? !item.enabled(state) : false
        }
        const total = words(state)
        count.textContent = `${total} ${total === 1 ? 'word' : 'words'}`
        menu.classList.add('visible')
        const start = view.coordsAtPos(from)
        const end = view.coordsAtPos(to)
        const gap = 6
        const left = Math.min(Math.max(gap, start.left), window.innerWidth - menu.offsetWidth - gap)
        let top = start.top - menu.offsetHeight - gap
        menu.classList.toggle('below', top < gap)
        if (top < gap) top = end.bottom + gap
        menu.style.left = `${left}px`
        menu.style.top = `${top}px`
      }

      const onBlur = () => setTimeout(() => { if (!view.hasFocus()) hide() })
      view.dom.addEventListener('blur', onBlur)
      const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && open) { closeChoices(); event.stopPropagation() } }
      view.dom.addEventListener('keydown', onKey, true)
      const wrapper = view.dom.closest('#editor-wrapper')
      wrapper?.addEventListener('scroll', update, { passive: true })

      return {
        update,
        destroy() {
          view.dom.removeEventListener('mousedown', onDown)
          view.dom.removeEventListener('blur', onBlur)
          view.dom.removeEventListener('keydown', onKey, true)
          document.removeEventListener('mouseup', onUp)
          wrapper?.removeEventListener('scroll', update)
          menu.remove()
        }
      }
    }
  })
}
