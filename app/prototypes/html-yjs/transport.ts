import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'

interface PresenceChange { added: number[]; updated: number[]; removed: number[] }

/** A local test transport, not a server/provider or a durability implementation. */
export class DemoTransport {
  readonly docs = [new Y.Doc(), new Y.Doc()]
  // Presence is ephemeral and travels separately from document updates.
  readonly awareness = this.docs.map(doc => new Awareness(doc))
  connected = true
  private readonly remoteOrigin = Symbol('demo remote update')
  private readonly listeners: Array<(update: Uint8Array, origin: unknown) => void>
  private readonly presenceListeners: Array<(change: PresenceChange, origin: unknown) => void>

  constructor(onChange: () => void) {
    this.listeners = this.docs.map((_, index) => (update, origin) => {
      if (this.connected && origin !== this.remoteOrigin) {
        Y.applyUpdate(this.docs[1 - index], update, this.remoteOrigin)
      }
      onChange()
    })
    this.docs.forEach((doc, index) => doc.on('update', this.listeners[index]))
    this.presenceListeners = this.awareness.map((awareness, index) => (change, origin) => {
      if (this.connected && origin !== this.remoteOrigin) {
        const clients = [...change.added, ...change.updated, ...change.removed]
        applyAwarenessUpdate(this.awareness[1 - index], encodeAwarenessUpdate(awareness, clients), this.remoteOrigin)
      }
      onChange()
    })
    this.awareness.forEach((awareness, index) => awareness.on('update', this.presenceListeners[index]))
  }

  setConnected(connected: boolean): void {
    this.connected = connected
    if (!connected) {
      this.awareness.forEach((awareness, index) => {
        removeAwarenessStates(awareness, [this.docs[1 - index].clientID], this.remoteOrigin)
      })
      return
    }
    const [alice, bob] = this.docs
    // Capture both missing-update sets before delivery. This exercises merging
    // independently produced offline edits rather than replacing either doc.
    const forAlice = Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice))
    const forBob = Y.encodeStateAsUpdate(alice, Y.encodeStateVector(bob))
    Y.applyUpdate(alice, forAlice, this.remoteOrigin)
    Y.applyUpdate(bob, forBob, this.remoteOrigin)
    // Republish with newer awareness clocks after clearing remote presence on
    // disconnect. Equal-clock updates would not resurrect a removed state.
    this.awareness.forEach(awareness => awareness.setLocalState(awareness.getLocalState()))
  }

  destroy(): void {
    this.docs.forEach((doc, index) => {
      doc.off('update', this.listeners[index])
      this.awareness[index].off('update', this.presenceListeners[index])
      // Awareness observes doc destruction and clears its heartbeat timer.
      doc.destroy()
    })
  }
}
