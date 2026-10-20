import { baseKeymap, chainCommands, toggleMark } from 'prosemirror-commands'
import { history, redo, undo } from 'prosemirror-history'
import { keymap } from 'prosemirror-keymap'
import { Slice } from 'prosemirror-model'
import type { Node as ModelNode } from 'prosemirror-model'
import { liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list'
import { EditorState, Plugin, TextSelection } from 'prosemirror-state'
import type { Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import type { NodeViewConstructor } from 'prosemirror-view'
import 'prosemirror-view/style/prosemirror.css'
import type { EditorWindow, ProofingStatus } from '../renderer/src/views/editor/editorBridge'
import { convertScene } from '../sceneModel/convert.ts'
import { isSceneDocument, parseScene } from '../sceneModel/format.ts'
import { emptyScene, sceneFragmentToHtml, sceneFromHtml, sceneToHtml } from '../sceneModel/html.ts'
import { sceneSchema } from '../sceneModel/schema.ts'
import { bubbleMenu } from './bubbleMenu.ts'
import { formattingState, setAlignment, setParagraphStyle, toggleList } from './commands.ts'
import { createProofing } from './proofing.ts'
import './style.css'

declare global {
  interface Window {
    sanitizeSceneHtml(html: string): string
    applyFrameTheme(colors: string[], properties: string[]): void
  }
}

const { marks, nodes } = sceneSchema
const environment = { document, sanitize: (html: string) => window.sanitizeSceneHtml(html) }
const mount = document.getElementById('editor')!
const notice = document.getElementById('scene-notice')!

// ── Host messages ────────────────────────────────────────────────

function sendMessage(message: Record<string, unknown>): void {
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ novalistEditor: JSON.stringify(message) }, '*')
  }
}

// ── Document state ───────────────────────────────────────────────

/**
 * Set when a legacy HTML scene could not be converted without loss. The scene
 * is shown, but not editable, and its original body is what getContent keeps
 * returning, so nothing is saved over it.
 */
let unconverted: { body: string; reason: string } | null = null
let loading = false
let contentTimer: ReturnType<typeof setTimeout> | null = null
let lastReported = ''
let imageBase = ''
/** Localized labels the host pushes for menus and the proofing popup. */
let labels: Record<string, string> = {}

const proofing = createProofing({ sendMessage, labels: () => labels })

/**
 * An empty line the writer makes is stored like the old editor stored it,
 * `<p><br></p>` in HTML, so exports keep the gap.
 */
const emptyLines = new Plugin({
  appendTransaction(transactions, before, after) {
    if (!transactions.some(transaction => transaction.docChanged)) return null
    const start = before.doc.content.findDiffStart(after.doc.content)
    if (start === null) return null
    const end = Math.max(start, before.doc.content.findDiffEnd(after.doc.content)?.b ?? start)
    let transaction: Transaction | null = null
    after.doc.nodesBetween(start, Math.min(end, after.doc.content.size), (node, pos) => {
      if (node.type !== nodes.paragraph) return true
      if (!node.childCount && !node.attrs.placeholder) {
        transaction ??= after.tr
        transaction.setNodeAttribute(pos, 'placeholder', true).setMeta('addToHistory', false)
      }
      return false
    })
    return transaction
  }
})

function createState(doc: ModelNode): EditorState {
  return EditorState.create({
    doc,
    plugins: [
      history(),
      keymap({
        'Mod-z': undo,
        'Mod-y': redo,
        'Shift-Mod-z': redo,
        // Cmd+B/I/U stay in the frame on Apple keyboards; Ctrl+B/I/U are
        // forwarded to the host, which calls toggleBold and friends.
        'Mod-b': toggleMark(marks.bold),
        'Mod-i': toggleMark(marks.italic),
        'Mod-u': toggleMark(marks.underline),
        Enter: chainCommands(splitListItem(nodes.list_item), baseKeymap.Enter),
        'Shift-Enter': (state, dispatch) => {
          dispatch?.(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView())
          return true
        },
        Tab: sinkListItem(nodes.list_item),
        'Shift-Tab': liftListItem(nodes.list_item)
      }),
      keymap(baseKeymap),
      emptyLines,
      proofing.plugin,
      // The host owns dialogs: it asks for the address and calls applyLink.
      bubbleMenu(() => sendMessage({ type: 'requestLink' }))
    ]
  })
}

// ── Node views: what the editor shows differs from what is stored ─

/** Stored image paths are book-relative; the frame needs a URL to show one. */
function displayUrl(stored: string): string {
  if (!stored || stored.includes(':') || !imageBase) return stored
  return imageBase + stored.split('/').map(encodeURIComponent).join('/')
}

const nodeViews: Record<string, NodeViewConstructor> = {
  image: node => {
    const image = document.createElement('img')
    image.src = displayUrl(node.attrs.src)
    if (node.attrs.alt != null) image.alt = node.attrs.alt
    return { dom: image }
  },
  // Structures kept verbatim are shown read-only, through the sanitizer.
  html_block: node => {
    const block = document.createElement('div')
    block.className = 'nv-verbatim'
    block.contentEditable = 'false'
    block.innerHTML = window.sanitizeSceneHtml(node.attrs.html)
    return { dom: block }
  },
  html_inline: node => {
    const span = document.createElement('span')
    span.className = 'nv-verbatim'
    span.contentEditable = 'false'
    span.innerHTML = window.sanitizeSceneHtml(node.attrs.html)
    return { dom: span }
  }
}

// ── Clipboard: the same HTML the scene model reads and writes ────

function copySelection(view: EditorView, event: ClipboardEvent, cut: boolean): boolean {
  if (view.state.selection.empty || !event.clipboardData) return false
  const slice = view.state.selection.content()
  event.clipboardData.setData('text/html', sceneFragmentToHtml(document, slice.content))
  event.clipboardData.setData('text/plain', view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, '\n\n', leaf => leaf.type === nodes.hard_break ? '\n' : ''))
  event.preventDefault()
  if (cut) view.dispatch(view.state.tr.deleteSelection().scrollIntoView().setMeta('uiEvent', 'cut'))
  return true
}

function pastedSlice(event: ClipboardEvent | DragEvent): Slice | null {
  const data = 'clipboardData' in event ? event.clipboardData : event.dataTransfer
  const html = data?.getData('text/html')
  const text = data?.getData('text/plain')
  let doc: ModelNode
  if (html) doc = sceneFromHtml(environment, html)
  else if (text) {
    const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n/).map(line =>
      nodes.paragraph.create({ placeholder: !line }, line ? sceneSchema.text(line) : null))
    doc = nodes.doc.create(null, paragraphs)
  } else return null
  return Slice.maxOpen(doc.content)
}

// ── The view ─────────────────────────────────────────────────────

let formattingFrame = 0

const view = new EditorView({ mount }, {
  state: createState(emptyScene()),
  nodeViews,
  attributes: { 'data-editor-engine': 'prosemirror-scene' },
  editable: () => !unconverted,
  dispatchTransaction(transaction) {
    const next = view.state.apply(transaction)
    view.updateState(next)
    if (transaction.docChanged && !loading) scheduleContentChanged()
    if (!formattingFrame) {
      formattingFrame = requestAnimationFrame(() => {
        formattingFrame = 0
        reportSelection()
      })
    }
  },
  handlePaste(view, event) {
    const slice = pastedSlice(event)
    if (!slice) return false
    view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta('uiEvent', 'paste'))
    return true
  },
  handleDOMEvents: {
    copy: (view, event) => copySelection(view, event, false),
    cut: (view, event) => copySelection(view, event, true),
    keydown: (_view, event) => forwardHotkey(event),
    focus: () => { sendMessage({ type: 'focused' }); return false },
    mousedown: () => { sendMessage({ type: 'pointerPressed' }); return false }
  }
})

function reportSelection(): void {
  sendMessage({ type: 'formattingChanged', ...formattingState(view.state) })
  const { $head } = view.state.selection
  const line = view.state.doc.childCount ? $head.index(0) + 1 : 1
  sendMessage({ type: 'caretPosition', line, column: $head.parentOffset + 1 })
}

function plainText(doc: ModelNode): string {
  return doc.textBetween(0, doc.content.size, '\n', leaf => leaf.type === nodes.hard_break ? '\n' : '')
}

function reportContentChanged(): void {
  if (unconverted) return
  const body = sceneHtml(view.state.doc)
  if (body === lastReported) return
  lastReported = body
  sendMessage({ type: 'contentChanged', html: body, plainText: plainText(view.state.doc) })
}

function scheduleContentChanged(): void {
  if (contentTimer) clearTimeout(contentTimer)
  contentTimer = setTimeout(() => {
    contentTimer = null
    reportContentChanged()
  }, 50)
}

function showNotice(text: string | null): void {
  notice.textContent = text ?? ''
  notice.hidden = !text
}

/**
 * Loads a scene body: HTML, read into the editing model when that is lossless,
 * or a scene document saved by an earlier build of this prototype. Both are
 * saved back as HTML.
 */
function setContent(body: string): void {
  if (body === getContent()) return
  let doc: ModelNode
  unconverted = null
  try {
    if (isSceneDocument(body)) doc = parseScene(body)
    else if (!body.trim()) doc = emptyScene()
    else {
      const result = convertScene(environment, body)
      if (result.ok) doc = result.doc
      else {
        // Show what can be shown, but never save a lossy conversion.
        unconverted = { body, reason: result.reason }
        doc = sceneFromHtml(environment, body)
      }
    }
  } catch (error) {
    unconverted = { body, reason: (error as Error).message }
    doc = emptyScene()
  }
  loading = true
  try {
    view.updateState(createState(doc))
    view.setProps({})
  } finally {
    loading = false
  }
  lastReported = getContent()
  proofing.reset()
  showNotice(unconverted ? `This scene could not be converted without loss and is read-only. (${unconverted.reason})` : null)
  reportSelection()
}

/**
 * Scenes stay HTML on disk, exactly as Novalist has always stored them: the
 * editing model is converted from HTML on load and back to HTML on save, so
 * exports, search, Git and every other reader of scene files keep working.
 */
function sceneHtml(doc: ModelNode): string {
  return sceneToHtml(document, doc)
}

function getContent(): string {
  return unconverted ? unconverted.body : sceneHtml(view.state.doc)
}

// ── Hotkeys: the host owns every shortcut that is not text editing ─

function isTextEditingShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false
  const key = event.key.toLowerCase()
  if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'backspace', 'delete'].includes(key)) return !event.altKey
  if (!event.shiftKey && !event.altKey) return 'acvxzy'.includes(key) || (event.metaKey && !event.ctrlKey && 'biu'.includes(key))
  return event.shiftKey && !event.altKey && key === 'z'
}

function forwardHotkey(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return false
  const functionKey = /^F\d{1,2}$/.test(event.code)
  if (!functionKey && event.key !== 'Escape' && !((event.ctrlKey || event.metaKey || event.altKey) && !isTextEditingShortcut(event))) return false
  event.preventDefault()
  sendMessage({
    type: 'hotkey', key: event.key, code: event.code,
    ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey
  })
  return true
}

// ── Bridge ───────────────────────────────────────────────────────

function run(command: (state: EditorState, dispatch?: (transaction: Transaction) => void) => boolean): void {
  view.focus()
  command(view.state, view.dispatch)
}

const root = document.documentElement
let fontOverride: HTMLStyleElement | null = null

const implemented: Partial<EditorWindow> = {
  setContent,
  getContent,
  getPlainText: () => plainText(view.state.doc),
  setSceneContext: () => undefined,
  flushPendingContentChange: () => {
    if (contentTimer) clearTimeout(contentTimer)
    contentTimer = null
    reportContentChanged()
  },
  focusEditor: () => view.focus(),

  toggleBold: () => run(toggleMark(marks.bold)),
  toggleItalic: () => run(toggleMark(marks.italic)),
  toggleUnderline: () => run(toggleMark(marks.underline)),
  toggleStrikethrough: () => run(toggleMark(marks.strike)),
  toggleHighlight: () => run(toggleMark(marks.highlight)),
  alignLeft: () => run(setAlignment('left')),
  alignCenter: () => run(setAlignment('center')),
  alignRight: () => run(setAlignment('right')),
  alignJustify: () => run(setAlignment('justify')),
  setParagraphStyle: style => run(setParagraphStyle(style)),
  toggleBulletList: () => run(toggleList(nodes.bullet_list)),
  toggleNumberList: () => run(toggleList(nodes.ordered_list)),
  applyLink: href => run((state, dispatch) => {
    const { from, to, empty } = state.selection
    if (empty) return false
    const transaction = state.tr.removeMark(from, to, marks.link)
    if (href) transaction.addMark(from, to, marks.link.create({ href }))
    dispatch?.(transaction)
    return true
  }),

  footnoteOrder: () => {
    const ids: string[] = []
    view.state.doc.descendants(node => {
      if (node.type === nodes.footnote && node.attrs.id) ids.push(node.attrs.id)
    })
    return ids
  },
  getProofingStatus: (): ProofingStatus => proofing.status(),
  setGrammarCheckEnabled: enabled => proofing.setEnabled(enabled),
  setGrammarIssues: (issuesJson, requestId) => proofing.setFindings(issuesJson, requestId),
  scrollToNextIssue: type => proofing.scrollToNext(type),
  // Desktop shows proofing status in the shell; there is no in-frame bar yet.
  setProofingStatusHosted: enabled => document.body.classList.toggle('proofing-status-hosted', enabled),
  setContextMenuLabels: labelsJson => {
    try { labels = { ...labels, ...JSON.parse(labelsJson) } } catch { /* keep the previous labels */ }
  },

  setTheme: (...colors: string[]) => {
    window.applyFrameTheme(colors, ['--bg', '--fg', '--caret', '--selection-bg', '--page-bg', '--page-fg',
      '--scrollbar-thumb', '--scrollbar-thumb-hover', '--scrollbar-thumb-active'])
    root.style.setProperty('--caret', colors[2] || colors[1])
  },
  setFont: (family, size) => {
    if (family) root.style.setProperty('--font-family', `'${family}', sans-serif`)
    if (size) root.style.setProperty('--font-size', `${size}px`)
    fontOverride ??= document.head.appendChild(document.createElement('style'))
    // Beats sizes and faces pasted in as inline styles. Headings stay relative
    // to the body size; a fixed size on every element made them body text.
    const headings = '.nv-style-heading, .nv-style-subheading, h1, h2, h3, h4, h5, h6'
    fontOverride.textContent = `#editor, #editor * { font-family: ${family ? `'${family}', sans-serif` : 'var(--font-family)'} !important; }`
      + `#editor { font-size: ${size ? `${size}px` : 'var(--font-size)'} !important; }`
      + `#editor *:not(${headings}):not(:is(${headings}) *) { font-size: inherit !important; }`
  },
  setBookWidth: (enabled, widthPx) =>
    root.style.setProperty('--book-width', enabled ? `calc(${widthPx}px + 2 * var(--padding-h))` : 'none'),
  setReadingComfort: (lineHeight, letterSpacing, paragraphSpacing, firstLineIndent) => {
    root.style.setProperty('--line-height', lineHeight > 0 ? String(lineHeight) : '1.7')
    root.style.setProperty('--letter-spacing', letterSpacing ? `${letterSpacing}px` : 'normal')
    root.style.setProperty('--paragraph-spacing', `${paragraphSpacing >= 0 ? paragraphSpacing : 0.75}em`)
    root.style.setProperty('--first-line-indent', `${firstLineIndent >= 0 ? firstLineIndent : 0}em`)
    // Prose is book-set by default; a configured indent replaces the default.
    root.style.setProperty('--scene-indent', firstLineIndent > 0 ? `${firstLineIndent}em` : '1.5em')
  },
  setBookParagraphSpacing: enabled => mount.classList.toggle('book-spacing', enabled),
  setLanguage: lang => {
    root.lang = lang || 'en'
    view.dom.lang = lang || 'en'
  },
  setSpellCheck: enabled => { view.dom.spellcheck = enabled },
  setMobile: enabled => document.body.classList.toggle('mobile', enabled),
  setImageBase: base => {
    imageBase = base || ''
    // Image views read the base when drawn; new node views redraw them all.
    view.setProps({ nodeViews: { ...nodeViews } })
  },
  insertImageAtCaret: (storedPath, alt) => run((state, dispatch) => {
    const image = nodes.image.create({ src: storedPath, alt: alt || '' })
    const paragraph = nodes.paragraph.create({ extra: { class: 'nv-image' } }, image)
    // On a line of its own, after the caret's top-level block.
    const { $from } = state.selection
    const after = $from.depth ? $from.after(1) : state.doc.content.size
    const transaction = state.tr.insert(after, paragraph)
    transaction.setSelection(TextSelection.near(transaction.doc.resolve(after + paragraph.nodeSize)))
    dispatch?.(transaction.scrollIntoView())
    return true
  })
}

// Every other bridge function exists so the host can call it unconditionally;
// the features behind them are not part of this editor yet.
const answers: Record<string, unknown> = {
  captureDictationAnchor: false,
  focusDictationCaret: false,
  insertDictationText: false,
  peekEntityAtCaret: false
}

export const bridgeFunctions = [
  'captureDictationAnchor', 'focusDictationCaret', 'insertDictationText', 'setWritingZoom', 'setReadabilityEnabled',
  'setReadability', 'startReadAloud', 'onSentenceSpoken', 'stopReadAloud', 'setTypewriterScroll', 'setPageView',
  'setCommentsData', 'setFootnotesData', 'setEntityNames', 'setMentionCandidates', 'setMentionLabels',
  'resolvePendingMention', 'setAutoReplacements', 'setDialogueCorrectionConfig', 'setContextMenuLabels',
  'setSuggestionMode', 'scrollToSuggestionById', 'setInlineActions', 'setExtensionContextMenuItems',
  'applyInlineActionResult', 'setGrammarCheckEnabled', 'setProofingStatusHosted', 'scrollToNextIssue',
  'setGrammarIssues', 'addCommentToSelection', 'setComposeDimming', 'setCompletionList', 'removeCommentById',
  'scrollToCommentById', 'insertFootnoteAtSelection', 'removeFootnoteById', 'scrollToFootnoteById',
  'peekEntityAtCaret', 'runContextAction', 'setSpellingSuggestions'
]

for (const name of bridgeFunctions) {
  if (!(name in implemented)) Object.assign(window, { [name]: () => answers[name] })
}
Object.assign(window, implemented, { novalistSceneView: () => view })

sendMessage({ type: 'ready' })
