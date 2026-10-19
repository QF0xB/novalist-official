import { EditorState } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { baseKeymap, toggleMark } from 'prosemirror-commands'
import { keymap } from 'prosemirror-keymap'
import { redo, undo, yCursorPlugin, ySyncPlugin, yUndoPlugin, prosemirrorToYXmlFragment } from 'y-prosemirror'
import { exportHtml, fidelityReport, parseHtml } from './html'
import { sceneSchema } from './schema'
import { DemoTransport } from './transport'

const SAMPLE = '<p class="nv-style-poetry" style="text-align: center;">The <strong>harbor</strong> at <em>dawn</em>.</p><p><span class="nv-entity-mention" data-entity-id="entity-1" data-entity-type="character" data-mention-source="name">Mara</span> found <span class="nv-comment" data-comment-id="comment-1">a letter</span><sup class="nv-fn" data-fn-id="fn-1" title="Sample footnote">1</sup>.</p><p><ins data-nl-change="change-1" data-nl-author="Alice" data-nl-at="2026-10-19T00:00:00.000Z">A new beginning.</ins> <del data-nl-change="change-2" data-nl-author="Bob">An old ending.</del></p><ul><li><p>A clue</p></li><li><p>A question</p></li></ul><p class="nv-image"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" alt="Sample image" width="24" height="24"></p>'

// Capture the demo's own controls before imported scene IDs can duplicate them.
const controls = new Map(Array.from(document.querySelectorAll<HTMLElement>('[id]'))
  .map(node => [node.id, node]))

function element<T extends HTMLElement>(id: string): T {
  const found = controls.get(id)
  if (!found) throw new Error(`Missing prototype element: ${id}`)
  return found as T
}

const source = element<HTMLTextAreaElement>('source')
const connection = element<HTMLButtonElement>('connection')
let transport: DemoTransport | undefined
let peers: Array<{ view: EditorView; output: HTMLTextAreaElement; participants: HTMLUListElement }> = []

function refresh(): void {
  if (!transport || peers.length !== 2) return
  peers.forEach(peer => { peer.output.value = exportHtml(peer.view.state.doc) })
  peers.forEach((peer, index) => {
    const awareness = transport!.awareness[index]
    const entries = Array.from(awareness.getStates()).sort(([a], [b]) =>
      Number(b === awareness.clientID) - Number(a === awareness.clientID))
    peer.participants.replaceChildren(...entries.flatMap(([clientId, state]) => {
      if (!state.user || typeof state.user.name !== 'string') return []
      const item = document.createElement('li')
      item.textContent = `${state.user.name}${clientId === awareness.clientID ? ' (you)' : ''} — ${state.cursor ? 'editing' : 'present'}`
      return [item]
    }))
  })
  element('connection-status').textContent = transport.connected ? 'Connected locally' : 'Disconnected: edits remain in each pane'
  element('convergence').textContent = peers[0].view.state.doc.eq(peers[1].view.state.doc)
    ? 'Documents match' : 'Documents differ'
  connection.textContent = transport.connected ? 'Disconnect peers' : 'Reconnect peers'
  connection.setAttribute('aria-pressed', String(!transport.connected))
}

function presenceCursor(user: { name: string; color: string }): HTMLElement {
  const cursor = document.createElement('span')
  cursor.className = 'collaboration-cursor'
  cursor.dataset.user = user.name
  cursor.contentEditable = 'false'
  cursor.setAttribute('aria-hidden', 'true')
  cursor.style.setProperty('--presence-color', user.color)
  const label = document.createElement('span')
  label.textContent = user.name
  cursor.append(label)
  return cursor
}

function button(label: string, action: () => void): HTMLButtonElement {
  const result = document.createElement('button')
  result.type = 'button'
  result.textContent = label
  result.addEventListener('mousedown', event => event.preventDefault())
  result.addEventListener('click', action)
  return result
}

function downloadHtml(html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'scene-prototype.html'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function importDemo(): void {
  // Prepare the new document before disposing either live editor.
  const imported = parseHtml(source.value)
  const projected = exportHtml(imported)
  const report = fidelityReport(source.value, projected)
  element('report').textContent = JSON.stringify(report, null, 2)
  element('fidelity').textContent = report.parsedHtmlMatch
    ? `Initial import: parsed HTML preserved. Exact source match: ${report.exactSourceMatch ? 'yes' : 'no'}.`
    : `Initial import changed HTML. Sanitizer changed content: ${report.sanitizerChanged ? 'yes' : 'no'}; schema changed content: ${report.schemaChanged ? 'yes' : 'no'}. Inspect the report before evaluating compatibility.`

  peers.forEach(peer => peer.view.destroy())
  peers = []
  transport?.destroy()
  // Refresh after a transaction completes, not while the binding is dispatching.
  transport = new DemoTransport(() => queueMicrotask(refresh))
  const colors = getComputedStyle(document.documentElement)
  transport.awareness.forEach((awareness, index) => awareness.setLocalStateField('user', {
    name: index === 0 ? 'Alice' : 'Bob',
    color: colors.getPropertyValue(index === 0 ? '--nl-accent' : '--nl-book-cover-cream').trim()
  }))
  // Initialize once, then clone binary state via the transport. Importing the
  // same HTML independently into both Y.Docs would duplicate initial content.
  prosemirrorToYXmlFragment(imported, transport.docs[0].getXmlFragment('scene'))

  for (const [index, id] of ['alice', 'bob'].entries()) {
    const name = index === 0 ? 'Alice' : 'Bob'
    const host = element(id)
    host.replaceChildren()
    const heading = document.createElement('h3')
    heading.textContent = name
    const participants = document.createElement('ul')
    participants.className = 'participants'
    participants.setAttribute('aria-label', `${name} participants`)
    const toolbar = document.createElement('div')
    toolbar.className = 'controls'
    toolbar.setAttribute('role', 'toolbar')
    toolbar.setAttribute('aria-label', `${name} formatting`)
    const surface = document.createElement('div')
    const fragment = transport.docs[index].getXmlFragment('scene')
    const view = new EditorView(surface, {
      state: EditorState.create({
        schema: sceneSchema,
        plugins: [
          ySyncPlugin(fragment),
          yCursorPlugin(transport.awareness[index], {
            cursorBuilder: presenceCursor,
            selectionBuilder: user => ({
              class: 'collaboration-selection',
              style: `--presence-color: ${user.color}`,
              'data-user': user.name
            })
          }),
          yUndoPlugin(),
          keymap({
            'Mod-z': undo, 'Mod-y': redo, 'Mod-Shift-z': redo,
            'Mod-b': toggleMark(sceneSchema.marks.strong),
            'Mod-i': toggleMark(sceneSchema.marks.em)
          }),
          keymap(baseKeymap)
        ]
      }),
      attributes: { role: 'textbox', 'aria-label': `${name} scene`, 'aria-multiline': 'true' },
      transformPastedHTML: html => window.sanitizeSceneHtml(html),
      dispatchTransaction(this: EditorView, transaction) {
        // The cursor binding batches awareness transactions. An import can
        // destroy the old view before an already-scheduled batch is delivered.
        if (this.isDestroyed) return
        this.updateState(this.state.apply(transaction))
        queueMicrotask(refresh)
      }
    })
    for (const [label, command] of [
      ['Bold', toggleMark(sceneSchema.marks.strong)],
      ['Italic', toggleMark(sceneSchema.marks.em)],
      ['Underline', toggleMark(sceneSchema.marks.underline)],
      ['Undo', undo], ['Redo', redo]
    ] as const) {
      toolbar.append(button(label, () => { command(view.state, view.dispatch, view); view.focus() }))
    }
    toolbar.append(button('Download HTML', () => downloadHtml(exportHtml(view.state.doc))))
    const label = document.createElement('label')
    label.htmlFor = `${id}-html`
    label.textContent = `${name} current HTML`
    const output = document.createElement('textarea')
    output.id = `${id}-html`
    output.readOnly = true
    output.spellcheck = false
    host.append(heading, participants, toolbar, surface, label, output)
    peers.push({ view, output, participants })
  }
  refresh()
}

source.value = SAMPLE
element('import').addEventListener('click', importDemo)
element('sample').addEventListener('click', () => { source.value = SAMPLE; importDemo() })
connection.addEventListener('click', () => {
  transport?.setConnected(!transport.connected)
  refresh()
})
element<HTMLInputElement>('file').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  // Loading a file only populates the source field; the import button resets.
  source.value = await file.text()
  input.value = ''
})
window.addEventListener('pagehide', () => {
  peers.forEach(peer => peer.view.destroy())
  transport?.destroy()
})
importDemo()
