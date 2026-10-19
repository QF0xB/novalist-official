import * as Y from 'yjs'
import { EditorState, TextSelection } from 'prosemirror-state'
import { DOMParser as ModelParser } from 'prosemirror-model'
import type { Node as ModelNode } from 'prosemirror-model'
import type { Transaction } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { initProseMirrorDoc, prosemirrorToYXmlFragment, redo, undo, yCursorPlugin, ySyncPlugin, yUndoPlugin, yUndoPluginKey } from 'y-prosemirror'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { htmlSchema, importHtml, projectHtml } from './html-model'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'
import type {} from '../html-yjs/html'
import './style.css'

type Callback = (update: Uint8Array) => void
interface Session {
  doc: Y.Doc
  clients: Map<symbol, Callback>
  presence: Map<number, { latest?: Uint8Array; receive: Callback }>
  publish(update: Uint8Array, sender: symbol): void
}
interface Host { sessions: Map<string, Session>; counter: number }
interface LegacyState {
  editor: HTMLElement
  wrapper: HTMLElement
  isComposing: boolean
  isSettingContent: boolean
  suggestionMode: boolean
  pageViewEnabled: boolean
  lastHtml: string
  grammarIssues: Array<{ offset: number; length: number }>
  lastReadabilityGrading: unknown
  dictationAnchor: unknown
}
type Legacy = EditorWindow & {
  NovalistEditorState: LegacyState
  getCleanContentHtml(): string
  applyGrammarHighlights(): void
  clearGrammarHighlights(): void
  repaginatePageView(): void
  unwrapPages(): void
  reapplyReadability(): void
  toDisplayImages(root: HTMLElement): void
  notifyFormattingChanged(): void
  handleEditorInput(): void
  sendMessage(message: object): void
  insertSuggested(text: string): void
  selectOneCharacter(backward: boolean): boolean
  markSelectionDeleted(): boolean
  hideGrammarPopup(): void
  hideContextMenu(): void
  updateGrammarStatusBar(): void
  requestGrammarCheck(): void
  clearReadability(): void
  requestReadability(delay?: number): void
  buildGrammarPlainTextMap(): { textNodes: Array<{ node: Text; start: number; end: number }> }
}

// This host is deliberately window-local, for evaluating split panes in the
// ordinary application. Only binary updates cross iframe boundaries. Replacing
// this in-memory host with the utility-process host remains separate sync work.
const owner = window.parent as Window & { novalistPrototypeHost?: Host }
const host = owner.novalistPrototypeHost ??= { sessions: new Map(), counter: 0 }
const ordinal = ++host.counter
const legacy = window as unknown as Legacy
const state = legacy.NovalistEditorState
const root = state.editor
const originalSetContent = legacy.setContent
const originalSetSceneContext = legacy.setSceneContext
const originalExec = document.execCommand.bind(document)
const originalGetCleanContentHtml = legacy.getCleanContentHtml
let view: EditorView | undefined
let doc: Y.Doc | undefined
let awareness: Awareness | undefined
let detach: (() => void) | undefined
let sceneKey = ''
let awaitingScene = false
let renderDepth = 0
let generation = 0
let compositionPaused = false
const compositionUpdates: Uint8Array[] = []
const remoteOrigin = Symbol('prototype remote')
const peerToken = Symbol('prototype peer')

// The existing layout and proofing modules decorate/reparent DOM nodes. This
// single compatibility seam isolates those changes from ProseMirror's observer.
// It is intentionally version-sensitive and covered by the editor parity suite.
function observer() {
  return (view as unknown as { domObserver: {
    stop(): void; start(): void; flush(): void; setCurSelection(): void; pendingRecords(): MutationRecord[]
  } }).domObserver
}

function flush(): void {
  if (view && !view.isDestroyed && !renderDepth && !state.isComposing && !compositionPaused) observer().flush()
}

function restoreModelSelection(): void {
  if (!view || view.isDestroyed || state.isComposing || compositionPaused || !view.hasFocus()
    || !(view.state.selection instanceof TextSelection)) return
  const { anchor, head } = view.state.selection
  // view.domAtPos is imprecise once grammar spans or pages wrap ProseMirror's
  // nodes (it threw "offset is larger than the node's length"). Paragraph plus
  // text offset is unambiguous in both representations.
  const caret = modelCaretPoint(anchor) && modelCaretPoint(head)
    ? { anchor: modelCaretPoint(anchor)!, focus: modelCaretPoint(head)! } : null
  if (restoreCaret(caret)) return
  const from = view.domAtPos(anchor)
  const to = view.domAtPos(head)
  try {
    window.getSelection()?.setBaseAndExtent(from.node, from.offset, to.node, to.offset)
  } catch { /* A root-boundary selection is restored by the next view update. */ }
}

const textOnly = () => ''

/** A model position as top-level block DOM plus text offset within it. */
function modelCaretPoint(pos: number): CaretPoint | null {
  const $pos = view!.state.doc.resolve(pos)
  if ($pos.depth < 1) return null
  const block = view!.nodeDOM($pos.before(1))
  if (!block || !root.contains(block)) return null
  return { block, offset: view!.state.doc.textBetween($pos.before(1) + 1, pos, '', textOnly).length }
}

/** The start of the top-level node a block element renders, if it renders one. */
function blockStart(block: Node): number | null {
  const desc = (block as unknown as { pmViewDesc?: { dom: Node; parent: unknown; posBefore: number } }).pmViewDesc
  return desc && desc.dom === block && desc.parent === (view as unknown as { docView: unknown }).docView ? desc.posBefore : null
}

/** The model position of a text offset inside the top-level node at start. */
function modelPosition(doc: ModelNode, start: number, offset: number): number | null {
  const node = doc.nodeAt(start)
  if (!node || node.isLeaf) return null
  let remaining = offset
  let found: number | null = null
  node.descendants((child, pos) => {
    if (found !== null) return false
    if (child.isText) {
      if (remaining <= child.text!.length) found = start + 1 + pos + remaining
      else remaining -= child.text!.length
    }
    return true
  })
  return found ?? (offset === 0 || remaining === 0 ? start + 1 + node.content.size : null)
}

interface CaretPoint { block: Node; offset: number }
interface Caret { anchor: CaretPoint; focus: CaretPoint }

// The paragraph-level node a point sits in: a direct child of the editor or of
// a page wrapper. Decoration only unwraps and rewraps around these elements.
function caretBlock(node: Node): Node {
  let current = node
  while (current.parentNode && current.parentNode !== root
    && !(current.parentNode instanceof Element && current.parentNode.classList.contains('nv-page'))) {
    current = current.parentNode
  }
  return current
}

function caretPoint(node: Node, offset: number): CaretPoint {
  const block = caretBlock(node)
  const before = document.createRange()
  before.selectNodeContents(block)
  before.setEnd(node, offset)
  return { block, offset: before.toString().length }
}

function caretDomPoint({ block, offset }: CaretPoint): { node: Node; offset: number } {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  for (let text = walker.nextNode() as Text | null; text; text = walker.nextNode() as Text | null) {
    if (offset <= text.length) return { node: text, offset }
    offset -= text.length
    last = text
  }
  return last ? { node: last, offset: last.length } : { node: block, offset: 0 }
}

/**
 * The browser's own caret, in terms that survive decoration: grammar spans
 * being unwrapped, text nodes being merged and pages being rebuilt. Stored as
 * paragraph plus text offset, the same way the native proofing code does.
 */
function captureCaret(): Caret | null {
  const selection = window.getSelection()
  if (!selection?.anchorNode || !selection.focusNode || !root.contains(selection.anchorNode)
    || !root.contains(selection.focusNode) || selection.anchorNode === root || selection.focusNode === root) return null
  return { anchor: caretPoint(selection.anchorNode, selection.anchorOffset), focus: caretPoint(selection.focusNode, selection.focusOffset) }
}

function restoreCaret(saved: Caret | null): boolean {
  if (!saved || !root.contains(saved.anchor.block) || !root.contains(saved.focus.block)) return false
  const anchor = caretDomPoint(saved.anchor)
  const focus = caretDomPoint(saved.focus)
  try {
    window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
    return true
  } catch { return false }
}

// Decoration is presentation only: it must leave the writer's caret where the
// browser put it. The model selection can be older than the DOM one (during a
// click ProseMirror reads the new selection only on mouseup), so writing the
// model selection back here moved every click to wherever the caret was before.
function presentation<T>(action: () => T): T {
  if (!view || view.isDestroyed || renderDepth || state.isComposing) return action()
  flush()
  const caret = captureCaret()
  observer().stop()
  renderDepth++
  try { return action() }
  finally {
    renderDepth--
    settleCaret(caret)
    observer().start()
  }
}

// A restored browser caret is left for ProseMirror to read like any other
// selection change. Only the model fallback is already known to the observer.
function settleCaret(caret: Caret | null): void {
  if (restoreCaret(caret)) return
  restoreModelSelection()
  observer().setCurSelection()
}

/**
 * Removes grammar spans without Node.normalize(). Painting splits a text node
 * ProseMirror renders, and the native clear then normalized the editor, which
 * kept the merged text in whichever piece came first - often the new one - and
 * dropped the node ProseMirror tracks. Later updates went to a detached node, so
 * words vanished from the screen and the next DOM re-read deleted them.
 * Here every stray piece is merged into the text node ProseMirror owns.
 */
function clearGrammarSpans(): void {
  const parents = new Set<Node>()
  root.querySelectorAll('.grammar-issue').forEach(span => {
    const parent = span.parentNode!
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    span.remove()
    parents.add(parent)
  })
  parents.forEach(parent => {
    let run: Text[] = []
    const merge = () => {
      if (run.length > 1) {
        const owners = run.filter(text => 'pmViewDesc' in text)
        // Each split-off piece belongs to the owned node before it (or, at the
        // start of the run, after it). Two owned nodes stay separate.
        let owner = owners[0] ?? run[0]
        const pieces = new Map<Text, string[]>(owners.length ? owners.map(text => [text, []]) : [[owner, []]])
        for (const text of run) {
          if (pieces.has(text) && text !== owner && 'pmViewDesc' in text) owner = text
          pieces.get(owner)!.push(text.data)
        }
        pieces.forEach((data, text) => { if (text.data !== data.join('')) text.data = data.join('') })
        run.forEach(text => { if (!pieces.has(text)) text.remove() })
      }
      run = []
    }
    Array.from(parent.childNodes).forEach(child => {
      if (child instanceof Text) run.push(child)
      else merge()
    })
    merge()
  })
}

const rawPresentation = new Map<string, (...args: unknown[]) => unknown>()
Object.assign(legacy, { clearGrammarHighlights: clearGrammarSpans })
for (const name of ['applyGrammarHighlights', 'clearGrammarHighlights', 'repaginatePageView',
  'unwrapPages', 'toDisplayImages', 'refreshSceneBreakClasses', 'updateFocusBlock',
  'scrollToSuggestionById', 'scrollToCommentById']) {
  const globals = legacy as unknown as Record<string, unknown>
  const original = globals[name] as (...args: unknown[]) => unknown
  if (typeof original !== 'function') continue
  rawPresentation.set(name, original)
  globals[name] = (...args: unknown[]) => presentation(() => original(...args))
}

// Grammar offsets index the plain text as it was when the check ran. After an
// edit they point at other characters, so painting them again underlined the
// letters being typed, and typing inside those fresh spans lost the caret.
// Like the native editor, edited text shows no underline until a new result.
let grammarStale = false
const paintGrammar = legacy.applyGrammarHighlights
legacy.applyGrammarHighlights = () => {
  if (grammarStale) legacy.clearGrammarHighlights()
  else paintGrammar()
}
const acceptGrammarIssues = (legacy as unknown as Record<string, (...args: unknown[]) => unknown>).setGrammarIssues
Object.assign(legacy, {
  setGrammarIssues: (...args: unknown[]) => {
    const previous = state.grammarIssues
    const result = acceptGrammarIssues(...args)
    // A result checked against older text is rejected and re-requested; only
    // an accepted one (a new issue list) describes the text on screen.
    if (state.grammarIssues !== previous) {
      grammarStale = false
      legacy.applyGrammarHighlights()
    }
    return result
  }
})

/**
 * Has ProseMirror redraw edited top-level blocks that contain DOM it did not
 * create. Proofing spans split ProseMirror's text nodes; when a native edit
 * removes such a span, the split-off pieces stay beside the node ProseMirror
 * updates, which showed the edited text two or three times. A redrawn block
 * is rebuilt from the model and drops every unknown node.
 */
function redrawForeignBlocks(before: ModelNode, after: ModelNode): void {
  const start = before.content.findDiffStart(after.content)
  if (start === null) return
  const end = Math.max(start, before.content.findDiffEnd(after.content)!.a)
  const docView = (view as unknown as { docView: { markDirty(from: number, to: number): void } }).docView
  before.forEach((node, offset) => {
    if (offset + node.nodeSize < start || offset > end || node.isAtom || !node.content.size) return
    const dom = view!.nodeDOM(offset)
    if (dom && hasForeignNodes(dom)) docView.markDirty(offset + 1, offset + node.nodeSize - 1)
  })
}

// A node is foreign when it sits directly in content ProseMirror renders (a
// block's or mark's content element) without a view description of its own.
// Inside widgets and decorated text, undescribed nodes are ProseMirror's own.
function hasForeignNodes(dom: Node): boolean {
  const walker = document.createTreeWalker(dom, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentNode as (Node & { pmViewDesc?: { contentDOM?: Node | null } }) | null
    if (!('pmViewDesc' in node) && parent?.pmViewDesc?.contentDOM === parent) return true
  }
  return false
}

function decorationsChanged(before: EditorState, after: EditorState): boolean {
  return after.plugins.some(plugin => {
    const decorations = plugin.props.decorations
    return decorations && decorations.call(plugin, before) !== decorations.call(plugin, after)
  })
}

function undecorate(): void {
  rawPresentation.get('unwrapPages')?.()
  rawPresentation.get('clearGrammarHighlights')?.()
}

function decorate(): void {
  rawPresentation.get('toDisplayImages')?.(root)
  if (!grammarStale) rawPresentation.get('applyGrammarHighlights')?.()
  if (state.pageViewEnabled) rawPresentation.get('repaginatePageView')?.()
  legacy.reapplyReadability()
}

function reconcileDom(): void {
  if (!view || view.isDestroyed || compositionPaused || renderDepth) return
  // The parser cannot place positions inside skipped wrappers (grammar spans,
  // page wrappers) reliably; it put the caret before each typed letter, so text
  // came out backwards. The browser's caret is the truth for a native edit.
  const caret = captureCaret()
  const selection = window.getSelection()
  const points: Array<{ node: Node; offset: number; pos?: number }> = []
  if (selection?.anchorNode && selection.focusNode && root.contains(selection.anchorNode)
    && root.contains(selection.focusNode)) {
    points.push({ node: selection.anchorNode, offset: selection.anchorOffset },
      { node: selection.focusNode, offset: selection.focusOffset })
  }
  // A fresh parse is required for explicit DOM-based legacy commands: the
  // observer intentionally reuses existing view descriptors and their attrs.
  const imported = ModelParser.fromSchema(htmlSchema).parse(root, {
    preserveWhitespace: 'full', findPositions: points
  })
  // Existing proofing targets follow their DOM fragments through a native
  // correction. Restate their offsets before repainting from the new model.
  const start = view.state.doc.content.findDiffStart(imported.content)
  let transaction = view.state.tr
  if (start !== null) {
    const spans = Array.from(root.querySelectorAll('.grammar-issue'))
    if (spans.length) {
      const { textNodes } = legacy.buildGrammarPlainTextMap()
      state.grammarIssues.forEach((issue, index) => {
        const own = spans.filter(span => span.getAttribute('data-issue-index') === String(index))
        const fragments = textNodes.filter(part => own.some(span => span.contains(part.node)))
        if (fragments.length) {
          issue.offset = fragments[0].start
          issue.length = fragments[fragments.length - 1].end - issue.offset
        }
      })
    }
    const end = view.state.doc.content.findDiffEnd(imported.content)!
    const overlap = Math.max(0, start - Math.min(end.a, end.b))
    transaction = transaction.replace(start, end.a + overlap, imported.slice(start, end.b + overlap))
  }
  const anchor = caret && caretPosition(transaction, caret.anchor)
  const head = caret && caretPosition(transaction, caret.focus)
  if (anchor != null && head != null) {
    transaction = transaction.setSelection(TextSelection.create(transaction.doc, anchor, head))
  } else if (points.length === 2 && points.every(point => point.pos !== undefined)) {
    transaction = transaction.setSelection(TextSelection.create(transaction.doc, points[0].pos!, points[1].pos!))
  }
  observer().pendingRecords().length = 0
  if (!transaction.docChanged && transaction.selection.eq(view.state.selection)) return
  observer().stop()
  view.dispatch(transaction)
}

/** Makes the model selection follow a programmatic DOM selection. */
function syncSelectionFromDom(): void {
  if (!view || view.isDestroyed || compositionPaused || renderDepth) return
  const caret = captureCaret()
  if (!caret) return
  const identity = view.state.tr
  const anchor = caretPosition(identity, caret.anchor)
  const head = caretPosition(identity, caret.focus)
  if (anchor == null || head == null) return
  const next = TextSelection.create(view.state.doc, anchor, head)
  if (!next.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(next))
}

/**
 * Where a browser caret point lands in the document a reconciliation produces.
 * The block's start is mapped through the change; its text must then match the
 * DOM, or the caret is left to the parser's (less exact) positions.
 */
function caretPosition(transaction: Transaction, point: CaretPoint): number | null {
  const start = blockStart(point.block)
  if (start === null) return null
  const mapped = transaction.mapping.map(start, -1)
  const node = transaction.doc.nodeAt(mapped)
  if (!node || node.textBetween(0, node.content.size, '', textOnly) !== (point.block.textContent ?? '')) return null
  return modelPosition(transaction.doc, mapped, point.offset)
}

const presenceList = document.createElement('ul')
presenceList.className = 'prototype-presence'
document.body.append(presenceList)

function publishParticipants(): void {
  if (!awareness) return
  presenceList.replaceChildren(...Array.from(awareness.getStates().values()).flatMap(value => {
    if (typeof value.user?.name !== 'string') return []
    const item = document.createElement('li')
    item.textContent = value.user.name
    return [item]
  }))
}

function cursor(user: { name: string; color: string }): HTMLElement {
  const caret = document.createElement('span')
  caret.className = 'collaboration-cursor'
  caret.contentEditable = 'false'
  caret.setAttribute('aria-hidden', 'true')
  caret.style.setProperty('--presence-color', user.color)
  const label = document.createElement('span')
  // Generated content stays out of innerText/textContent-based proofing, word
  // counts, read-aloud, and the existing contentChanged plain-text field.
  label.dataset.label = user.name
  caret.append(label)
  return caret
}

function sessionFor(key: string, initial: ReturnType<typeof importHtml>): Session {
  let session = host.sessions.get(key)
  if (session) return session
  const shared = new Y.Doc()
  prosemirrorToYXmlFragment(initial, shared.getXmlFragment('scene'))
  const created: Session = {
    doc: shared, clients: new Map(), presence: new Map(),
    publish(update, sender) {
      Y.applyUpdate(shared, update)
      this.clients.forEach((receive, client) => { if (client !== sender) receive(update) })
    }
  }
  host.sessions.set(key, created)
  return created
}

function mount(html: string): void {
  const imported = importHtml(html || '<p><br></p>')
  const session = sessionFor(sceneKey || `unscoped-${ordinal}`, imported)
  const nextDoc = new Y.Doc()
  Y.applyUpdate(nextDoc, Y.encodeStateAsUpdate(session.doc))
  const nextAwareness = new Awareness(nextDoc)
  const currentGeneration = ++generation
  detach?.()
  if (view && !view.isDestroyed) presentation(() => undecorate())
  view?.destroy()
  doc?.destroy()
  doc = nextDoc
  awareness = nextAwareness
  const receive = (update: Uint8Array) => {
    // Avoid dispatching into another view in the middle of its transaction.
    queueMicrotask(() => {
      if (generation !== currentGeneration) return
      if (compositionPaused) compositionUpdates.push(update)
      else Y.applyUpdate(nextDoc, update, remoteOrigin)
    })
  }
  session.clients.set(peerToken, receive)
  const relay = (update: Uint8Array, origin: unknown) => {
    if (origin !== remoteOrigin) session.publish(update, peerToken)
  }
  nextDoc.on('update', relay)
  session.presence.set(nextDoc.clientID, { receive: update => {
    queueMicrotask(() => {
      if (generation === currentGeneration) applyAwarenessUpdate(nextAwareness, update, remoteOrigin)
    })
  } })
  const relayPresence = ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    publishParticipants()
    if (origin === remoteOrigin) return
    const payload = encodeAwarenessUpdate(nextAwareness, [...added, ...updated, ...removed])
    const own = session.presence.get(nextDoc.clientID)
    if (own) own.latest = payload
    session.presence.forEach((peer, id) => { if (id !== nextDoc.clientID) peer.receive(payload) })
  }
  nextAwareness.on('update', relayPresence)
  session.presence.forEach((peer, id) => {
    if (id !== nextDoc.clientID && peer.latest) applyAwarenessUpdate(nextAwareness, peer.latest, remoteOrigin)
  })
  const parentStyle = owner.document ? getComputedStyle(owner.document.documentElement) : getComputedStyle(document.documentElement)
  nextAwareness.setLocalStateField('user', {
    name: `Editor ${ordinal}`,
    color: parentStyle.getPropertyValue(ordinal % 2 ? '--nl-accent' : '--nl-book-cover-cream').trim()
      || getComputedStyle(document.documentElement).getPropertyValue('--caret').trim()
  })
  detach = () => {
    nextAwareness.setLocalState(null)
    nextAwareness.off('update', relayPresence)
    session.presence.delete(nextDoc.clientID)
    session.clients.delete(peerToken)
    nextDoc.off('update', relay)
  }
  root.replaceChildren()
  const fragment = nextDoc.getXmlFragment('scene')
  const initial = initProseMirrorDoc(fragment, htmlSchema)
  view = new EditorView({ mount: root }, {
    state: EditorState.create({ doc: initial.doc, schema: htmlSchema, plugins: [
      ySyncPlugin(fragment, { mapping: initial.mapping }),
      yCursorPlugin(nextAwareness, { cursorBuilder: cursor, selectionBuilder: user => ({
        class: 'collaboration-selection', style: `--presence-color: ${user.color}`
      }) }),
      yUndoPlugin(),
      keymap({
        'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo,
        Enter: () => originalExec('insertParagraph'),
        Backspace: () => {
          if (!state.suggestionMode) return false
          if (legacy.selectOneCharacter(true)) legacy.markSelectionDeleted()
          return true
        },
        Delete: () => {
          if (!state.suggestionMode) return false
          if (legacy.selectOneCharacter(false)) legacy.markSelectionDeleted()
          return true
        }
      }),
      keymap(baseKeymap)
    ] }),
    attributes: { 'data-editor-engine': 'prosemirror-yjs' },
    handleDOMEvents: {
      compositionstart: () => true,
      compositionupdate: () => true,
      compositionend: () => true,
      keydown: (_view, event) => state.isComposing || event.isComposing || event.keyCode === 229,
      beforeinput: (_view, event) => state.isComposing || event.isComposing
    },
    dispatchTransaction(this: EditorView, transaction) {
      if (this.isDestroyed || compositionPaused) return
      const obs = observer()
      // Only a transaction that edits or selects owns the selection. Others
      // (presence, plugin metadata) arrive at any time, including between the
      // mousedown and mouseup of a click, and must keep the browser's caret.
      const caret = transaction.docChanged || transaction.selectionSet ? null : captureCaret()
      const next = this.state.apply(transaction)
      // Pages and proofing spans do not depend on the selection. Rebuilding
      // them for caret moves cost a full pass per arrow key, and in the middle
      // of a native correction it replaced the very spans being corrected.
      // ProseMirror only re-renders inside them when the document or its own
      // decorations (remote cursors) change.
      const redecorate = !state.isComposing && (transaction.docChanged || decorationsChanged(this.state, next))
      obs.stop()
      renderDepth++
      if (transaction.docChanged) grammarStale = true
      try {
        if (redecorate) undecorate()
        if (transaction.docChanged) redrawForeignBlocks(this.state.doc, next.doc)
        try {
          this.updateState(next)
        } catch (error) {
          // ProseMirror's own selection write can address a text node a
          // proofing span has split. The state is applied; settleCaret below
          // places the selection precisely.
          if (!(error instanceof DOMException) || this.state !== next) throw error
        }
        if (redecorate) decorate()
      } finally {
        renderDepth--
        settleCaret(caret)
        obs.start()
      }
      if (transaction.docChanged && !state.isSettingContent) {
        // The existing file/annotation/save pipeline remains the application
        // boundary; the document model supplies clean HTML to that pipeline.
        queueMicrotask(() => {
          if (generation !== currentGeneration) return
          legacy.handleEditorInput()
          legacy.notifyFormattingChanged()
        })
      }
    }
  })
  const obs = observer()
  const originalFlush = obs.flush.bind(obs)
  const mountedView = view
  obs.flush = () => {
    if (view !== mountedView || mountedView.isDestroyed || compositionPaused || renderDepth) return
    if (state.pageViewEnabled || root.querySelector('.grammar-issue')) reconcileDom()
    else originalFlush()
  }
  presentation(decorate)
  publishParticipants()
}

legacy.setSceneContext = (id: string, scope = '') => {
  const key = JSON.stringify([scope, id])
  if (key === sceneKey) return
  flush()
  const previousHtml = view ? projectHtml(view.state.doc) : ''
  sceneKey = key
  awaitingScene = true
  originalSetSceneContext(id)
  // Identical-HTML scene switches intentionally skip setContent in the host.
  queueMicrotask(() => { if (awaitingScene && sceneKey === key) legacy.setContent(previousHtml) })
}

legacy.setContent = html => {
  const initial = awaitingScene || !view
  awaitingScene = false
  if (initial) {
    // Preserve the existing setter's scene-specific resets and layout behavior.
    state.isSettingContent = true
    try {
      if (view) presentation(undecorate)
      presentation(() => originalSetContent(html))
      mount(html)
    } finally { state.isSettingContent = false }
  } else {
    const imported = importHtml(html || '<p><br></p>')
    const activeView = view!
    const start = activeView.state.doc.content.findDiffStart(imported.content)
    if (start === null) return
    const end = activeView.state.doc.content.findDiffEnd(imported.content)!
    const overlap = start - Math.min(end.a, end.b)
    state.isSettingContent = true
    try {
      activeView.dispatch(activeView.state.tr.replace(start,
        end.a + Math.max(0, overlap), imported.slice(start, end.b + Math.max(0, overlap)))
        .setMeta('addToHistory', false))
      yUndoPluginKey.getState(activeView.state)?.undoManager.clear()
      state.grammarIssues = []
      state.lastReadabilityGrading = null
      state.dictationAnchor = null
      legacy.hideGrammarPopup()
      legacy.hideContextMenu()
      legacy.clearReadability()
      legacy.applyGrammarHighlights()
      legacy.requestGrammarCheck()
      legacy.updateGrammarStatusBar()
      legacy.requestReadability(0)
    } finally { state.isSettingContent = false }
  }
  state.lastHtml = projectHtml(view!.state.doc)
}

legacy.getCleanContentHtml = () => {
  flush()
  return view ? projectHtml(view.state.doc) : ''
}
legacy.getContent = legacy.getCleanContentHtml
legacy.getPlainText = () => {
  flush()
  return view?.state.doc.textBetween(0, view.state.doc.content.size, '\n', node => node.attrs.tag === 'br' ? '\n' : '') ?? ''
}

for (const name of ['setParagraphStyle', 'toggleHighlight', 'addCommentToSelection', 'removeCommentById',
  'insertFootnoteAtSelection', 'removeFootnoteById', 'setFootnotesData', 'setCommentsData',
  'resolvePendingMention', 'insertImageAtCaret', 'footnoteOrder', 'insertDictationText', 'applyInlineActionResult',
  'applyGrammarSuggestion']) {
  const globals = legacy as unknown as Record<string, unknown>
  const original = globals[name] as (...args: unknown[]) => unknown
  globals[name] = (...args: unknown[]) => {
    const result = original(...args)
    reconcileDom()
    if (name === 'applyGrammarSuggestion') {
      // reconcileDom restated the remaining issues from their spans.
      grammarStale = false
      legacy.applyGrammarHighlights()
    }
    return result
  }
}

// Native toolbar/popup operations continue to operate on the real editing DOM;
// ProseMirror observes these user operations and y-prosemirror turns them into
// document transactions. Only undo/redo must bypass Chromium's separate history.
document.execCommand = (command, showUI, value) => {
  if (!view || view.isDestroyed) return originalExec(command, showUI, value)
  if (command.toLowerCase() === 'undo' || command.toLowerCase() === 'redo') {
    // History must see every edit already on screen.
    reconcileDom()
    return command.toLowerCase() === 'undo' ? undo(view.state) : redo(view.state)
  }
  // Only the selection is adopted before the command. Callers prepare the DOM
  // for a command (a correction strips its span's class first); reading that
  // half-finished state as an edit repainted the proofing spans mid-correction.
  syncSelectionFromDom()
  const result = originalExec(command, showUI, value)
  reconcileDom()
  return result
}

// Adopt programmatically selected DOM ranges before an explicit native command
// is invoked from a shell toolbar or a stored annotation/dictation range.
root.addEventListener('beforeinput', () => {
  if (!view || state.isComposing || renderDepth) return
  reconcileDom()
}, true)

root.addEventListener('compositionstart', () => {
  if (!view || compositionPaused) return
  flush()
  // Keep Chromium's composition DOM entirely untouched, including its page
  // wrappers. Reconcile once the final input has landed, not for each pinyin run.
  observer().stop()
  compositionPaused = true
}, true)

root.addEventListener('compositionend', () => {
  const currentGeneration = generation
  setTimeout(() => {
    if (!view || view.isDestroyed || generation !== currentGeneration) return
    const imported = importHtml(originalGetCleanContentHtml())
    compositionPaused = false
    const start = view.state.doc.content.findDiffStart(imported.content)
    if (start !== null) {
      const end = view.state.doc.content.findDiffEnd(imported.content)!
      const overlap = Math.max(0, start - Math.min(end.a, end.b))
      view.dispatch(view.state.tr.replace(start, end.a + overlap, imported.slice(start, end.b + overlap)))
    } else {
      observer().setCurSelection()
      observer().start()
    }
    for (const update of compositionUpdates.splice(0)) Y.applyUpdate(doc!, update, remoteOrigin)
  }, 0)
}, true)

window.addEventListener('pagehide', () => {
  detach?.()
  generation++
  view?.destroy()
  doc?.destroy()
})
mount('<p><br></p>')
Object.assign(window, { novalistPrototypeView: () => view })
