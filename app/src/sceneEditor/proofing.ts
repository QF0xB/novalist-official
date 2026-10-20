import type { Node as ModelNode } from 'prosemirror-model'
import { Plugin, PluginKey } from 'prosemirror-state'
import type { EditorState, Transaction } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import type { EditorView } from 'prosemirror-view'
import type { ProofingStatus } from '../renderer/src/views/editor/editorBridge'
import { sceneSchema } from '../sceneModel/schema.ts'

/** A grammar, spelling or style finding, as the host's checker returns it. */
interface Finding {
  message: string
  offset: number
  length: number
  type: 'spelling' | 'grammar' | 'style'
  replacements: string[]
}

/** A finding placed in the document. Positions follow edits; `text` is what was flagged. */
interface Issue extends Omit<Finding, 'offset' | 'length'> {
  from: number
  to: number
  text: string
}

interface ProofingState {
  issues: Issue[]
  decorations: DecorationSet
}

const key = new PluginKey<ProofingState>('proofing')
const DELAY_MS = 1500

/**
 * The plain text the checker sees, with the document position of every
 * character. Blocks are separated by a newline and a hard break is one, so
 * offsets in the checker's answer map straight back onto the document.
 */
export function proofingText(doc: ModelNode): { text: string; positions: number[] } {
  const parts: string[] = []
  const positions: number[] = []
  const push = (text: string, pos: number, step: number) => {
    for (let index = 0; index < text.length; index++) positions.push(pos + index * step)
    parts.push(text)
  }
  let first = true
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (!first) push('\n', pos, 0)
    first = false
    node.forEach((child, offset) => {
      const at = pos + 1 + offset
      if (child.isText) push(child.text!, at, 1)
      else if (child.type === sceneSchema.nodes.hard_break) push('\n', at, 0)
      else if (child.type === sceneSchema.nodes.footnote) push(child.attrs.label, at, 0)
    })
    return false
  })
  return { text: parts.join(''), positions }
}

function decorate(doc: ModelNode, issues: Issue[]): DecorationSet {
  return DecorationSet.create(doc, issues.map((issue, index) => Decoration.inline(issue.from, issue.to, {
    class: 'grammar-issue', 'data-issue-type': issue.type, 'data-issue-index': String(index)
  }, { issue })))
}

/** Places checker findings for `text`; findings that do not fit the document are dropped. */
function place(doc: ModelNode, findings: Finding[]): Issue[] {
  const { positions } = proofingText(doc)
  return findings.flatMap(finding => {
    if (finding.length <= 0 || finding.offset < 0 || finding.offset + finding.length > positions.length) return []
    const from = positions[finding.offset]
    const to = positions[finding.offset + finding.length - 1] + 1
    if (to <= from) return []
    const { offset: _offset, length: _length, ...rest } = finding
    return [{ ...rest, from, to, text: doc.textBetween(from, to, '\n', '\n') }]
  })
}

export interface ProofingHost {
  sendMessage(message: Record<string, unknown>): void
  labels(): { removeText?: string; addToDictionary?: string; dismiss?: string }
}

/**
 * Grammar and spelling underlines as decorations: the prose DOM is never
 * rewritten for them, and they follow edits like the text they mark. An edit
 * inside a flagged passage drops its underline; the next check, a moment
 * after typing stops, brings back whatever still applies.
 */
export function createProofing(host: ProofingHost) {
  let enabled = false
  let checking = false
  let requestId = 0
  let pending: { id: number; text: string } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let view: EditorView | null = null

  const popup = document.getElementById('grammar-popup')!
  const message = popup.querySelector<HTMLElement>('.gp-message')!
  const suggestions = popup.querySelector<HTMLElement>('.gp-suggestions')!
  const dismiss = popup.querySelector<HTMLElement>('.gp-dismiss')!
  dismiss.addEventListener('mousedown', event => { event.preventDefault(); hidePopup() })

  const plugin = new Plugin<ProofingState>({
    key,
    state: {
      init: () => ({ issues: [], decorations: DecorationSet.empty }),
      apply(transaction, value, _before, after) {
        const replaced = transaction.getMeta(key) as Issue[] | undefined
        if (replaced) return { issues: replaced, decorations: decorate(after.doc, replaced) }
        if (!transaction.docChanged) return value
        // Keep every finding whose own text survived the edit.
        const issues = value.issues.flatMap(issue => {
          const from = transaction.mapping.map(issue.from, 1)
          const to = transaction.mapping.map(issue.to, -1)
          return to > from && after.doc.textBetween(from, to, '\n', '\n') === issue.text ? [{ ...issue, from, to }] : []
        })
        return { issues, decorations: decorate(after.doc, issues) }
      }
    },
    props: {
      decorations: state => key.getState(state)!.decorations,
      handleClick(clicked, pos) {
        const issue = key.getState(clicked.state)!.issues.find(candidate => candidate.from <= pos && pos <= candidate.to)
        if (issue) showPopup(issue)
        else hidePopup()
        return false
      }
    },
    view(editor) {
      view = editor
      return {
        update(updated, before) {
          if (updated.state.doc !== before.doc) {
            hidePopup()
            schedule()
          }
        },
        destroy() { view = null }
      }
    }
  })

  function status(): ProofingStatus {
    const issues = view ? key.getState(view.state)!.issues : []
    return {
      enabled,
      checking,
      grammarCount: issues.filter(issue => issue.type === 'grammar').length,
      spellingCount: issues.filter(issue => issue.type !== 'grammar').length
    }
  }

  // The shell reads the live status when this notification arrives.
  const notify = () => host.sendMessage({ type: 'grammarStatusChanged' })

  function setIssues(issues: Issue[]) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(key, issues).setMeta('addToHistory', false))
    notify()
  }

  function schedule() {
    requestId++
    pending = null
    if (timer) clearTimeout(timer)
    timer = null
    if (!enabled) return
    if (checking) {
      checking = false
      notify()
    }
    timer = setTimeout(() => {
      timer = null
      if (!view) return
      const { text } = proofingText(view.state.doc)
      pending = { id: requestId, text }
      checking = true
      notify()
      host.sendMessage({ type: 'grammarCheckRequest', requestId, plainText: text })
    }, DELAY_MS)
  }

  function showPopup(issue: Issue) {
    if (!view) return
    const labels = host.labels()
    message.textContent = issue.message || 'Issue detected'
    const choices = issue.replacements.map(replacement => {
      const choice = document.createElement('span')
      choice.className = 'gp-suggestion'
      choice.textContent = replacement || labels.removeText || 'Delete'
      choice.addEventListener('mousedown', event => {
        event.preventDefault()
        correct(issue, replacement)
      })
      return choice
    })
    if (issue.type === 'spelling' && issue.text.trim()) {
      const learn = document.createElement('span')
      learn.className = 'gp-suggestion'
      learn.style.opacity = '0.7'
      learn.textContent = labels.addToDictionary || 'Add to Dictionary'
      learn.addEventListener('mousedown', event => {
        event.preventDefault()
        host.sendMessage({ type: 'addToDictionary', word: issue.text.trim() })
        // The word is now known everywhere in the scene.
        setIssues(key.getState(view!.state)!.issues.filter(other => !(other.type === 'spelling' && other.text === issue.text)))
        hidePopup()
      })
      choices.push(learn)
    }
    suggestions.replaceChildren(...choices)
    dismiss.textContent = labels.dismiss || 'Dismiss'
    const coords = view.coordsAtPos(issue.from)
    popup.style.left = `${Math.max(4, Math.min(coords.left, window.innerWidth - 340))}px`
    popup.style.top = `${coords.bottom + 6}px`
    popup.classList.add('visible')
    if (coords.bottom + 6 + popup.offsetHeight > window.innerHeight) {
      popup.style.top = `${Math.max(4, coords.top - popup.offsetHeight - 6)}px`
    }
  }

  function hidePopup() {
    popup.classList.remove('visible')
  }

  /** One undoable edit; the corrected finding goes, the others stay where they are. */
  function correct(issue: Issue, replacement: string) {
    if (!view) return
    const current = key.getState(view.state)!.issues.find(candidate => candidate.from === issue.from && candidate.text === issue.text)
    if (!current) return hidePopup()
    const transaction: Transaction = replacement
      ? view.state.tr.insertText(replacement, current.from, current.to)
      : view.state.tr.delete(current.from, current.to)
    view.dispatch(transaction.scrollIntoView())
    hidePopup()
    view.focus()
  }

  return {
    plugin,
    status,
    hidePopup,
    setEnabled(on: boolean) {
      enabled = on
      if (!on) {
        requestId++
        pending = null
        checking = false
        if (timer) clearTimeout(timer)
        timer = null
        setIssues([])
        hidePopup()
      } else {
        schedule()
      }
      notify()
    },
    /** A checker answer; one for older text or an earlier scene is ignored. */
    setFindings(json: string, id?: number) {
      if (!view) return
      if (id !== undefined) {
        if (!enabled || !pending || id !== pending.id) return
        const asked = pending.text
        pending = null
        checking = false
        if (proofingText(view.state.doc).text !== asked) {
          schedule()
          return
        }
      }
      let findings: Finding[] = []
      try { findings = JSON.parse(json) } catch { findings = [] }
      setIssues(place(view.state.doc, Array.isArray(findings) ? findings : []))
    },
    scrollToNext(type: 'grammar' | 'punctuation') {
      if (!view) return
      const wanted = (issue: Issue) => type === 'grammar' ? issue.type === 'grammar' : issue.type !== 'grammar'
      const issues = key.getState(view.state)!.issues.filter(wanted)
      const head = view.state.selection.head
      const next = issues.find(issue => issue.from > head) ?? issues[0]
      if (!next) return
      const target = view.domAtPos(next.from)
      const element = target.node instanceof Element ? target.node : target.node.parentElement
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => showPopup(next), 150)
    },
    /** A newly loaded scene: nothing checked yet. */
    reset() {
      hidePopup()
      schedule()
      notify()
    }
  }
}

export const proofingIssues = (state: EditorState) => key.getState(state)?.issues ?? []
