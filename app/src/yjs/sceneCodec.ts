import * as Y from 'yjs'

import type {SceneSanitizer} from "./sceneSanitizer";

/**
 * Scene representation shared by import, projection and the future editor binding:
 * - HTML elements become Y.XmlElement nodes, preserving their attributes.
 * - Character data becomes plain Y.XmlText.
 * - Formatting is represented by elements, not Y.XmlText formatting attributes.
 *
 * Input and output use the editor's sanitizer. This preserves supported content,
 * but does not guarantee byte-for-byte equality for arbitrary HTML: sanitization
 * and HTML parsing can remove or normalize markup.
 */
export const SCENE_FRAGMENT = 'scene'

const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** Content the generic mirror cannot represent. Never dropped silently. */
export class UnsupportedSceneContentError extends Error {}

/**
 * Initializes an empty scene fragment from sanitized HTML.
 * This is not an update/diff operation: existing collaborative state must be
 * restored from Yjs updates and edited in place, never rebuilt from HTML.
 */
export function importScene(sanitizer: SceneSanitizer, html: string, doc: Y.Doc): void {
    const fragment = doc.getXmlFragment(SCENE_FRAGMENT)
    if (fragment.length > 0) {
        throw new Error('importScene only fills an empty document.')
    }

    const container = sanitizer.document.createElement('div')
    container.innerHTML = sanitizer.sanitize(html)

    // Finish conversion before inserting anything. Yjs transactions batch changes;
    // they do not roll back mutations when an exception is thrown.
    const children = Array.from(container.childNodes, toYjs)

    doc.transact(() => {
        fragment.insert(0, children)
    })
}

export function projectScene(sanitizer: SceneSanitizer, doc: Y.Doc): string {
    const container = sanitizer.document.createElement('div')
    for (const child of doc.getXmlFragment(SCENE_FRAGMENT).toArray()) {
        container.appendChild(toDom(sanitizer.document, child))
    }

    // Yjs state may arrive from another client, so projection must enforce the
    // editor's HTML safety policy even when this importer did not create the nodes.
    return sanitizer.sanitize(container.innerHTML)
}

function toYjs(node: Node): Y.XmlElement | Y.XmlText {
    if (node.nodeType === TEXT_NODE) {
        const text = new Y.XmlText()
        text.insert(0, node.textContent ?? '')
        return text
    }

    if (node.nodeType === ELEMENT_NODE) {
        const element = node as Element
        const yElement = new Y.XmlElement(element.localName)

        for (const attribute of Array.from(element.attributes)) {
            yElement.setAttribute(attribute.name, attribute.value)
        }

        // Templates keep their children in a separate DocumentFragment.
        const children = element.localName === 'template'
            ? (element as HTMLTemplateElement).content.childNodes
            : element.childNodes


        yElement.insert(0, Array.from(children, toYjs))
        return yElement
    }

    throw new UnsupportedSceneContentError(`Unsupported node type ${node.nodeType}.`)
}

function toDom(document: Document, node: Y.XmlElement | Y.XmlText | Y.XmlHook): Node {
    if (node instanceof Y.XmlText) {
        const parts = node.toDelta()
        let text = ''

        for (const part of parts) {
            if (
                typeof part.insert !== 'string' ||
                    Object.keys(part.attributes ?? {}).length > 0
            ) {
                throw new UnsupportedSceneContentError(
                    'Formatted or embedded Yjs text is unsupported.'
                )
            }

            text += part.insert
        }

        return document.createTextNode(text)
    }

    if (!(node instanceof Y.XmlElement)) {
        throw new UnsupportedSceneContentError('Unsupported Yjs XML node.')
    }

    const element = document.createElement(node.nodeName)

    for (const [name, value] of Object.entries(node.getAttributes())) {
        element.setAttribute(name, String(value))
    }

    // Appending to a template element itself would not populate its content.
    const target = element.localName === 'template'
        ? (element as HTMLTemplateElement).content
        : element

    for (const child of node.toArray()) {
        target.appendChild(toDom(document, child))
    }

    return element
}
