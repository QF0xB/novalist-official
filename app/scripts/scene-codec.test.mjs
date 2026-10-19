import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import * as Y from 'yjs'

import {
    importScene,
    projectScene,
    SCENE_FRAGMENT,
    UnsupportedSceneContentError
} from '../src/yjs/sceneCodec.ts'
import { createSceneSanitizer } from '../src/yjs/sceneSanitizer.ts'

const sanitizer = createSceneSanitizer()

after(() => {
    sanitizer.document.defaultView?.close()
})

const fixtures = [
    '',
    '<p><br></p>',
    '<p>Hello <strong>bold</strong> and <em>italic</em>.</p>',
    '<p>&amp; &lt;text&gt; &nbsp; Grüße 中文 e\u0301</p>',
    '<p class="nv-style-poetry" style="text-align:center">Verse</p>',
    '<ol><li>First</li><li>Second<ul><li>Nested</li></ul></li></ol>',
    '<p><span data-comment-id="comment-1">Annotated</span></p>',
    '<p><a href="novalist://scene/example">Scene link</a></p>',
    '<table><tbody><tr><td>Cell</td></tr></tbody></table>',
    // Native rich-text formatting.
    '<p><b>Bold</b><i>Italic</i><u>Underline</u><strike>Strike</strike><sub>Sub</sub><sup>Super</sup></p>',

    // Highlights.
    '<p><span class="nv-highlight">Highlighted text</span></p>',

    // Comment anchors.
    '<p><span class="nv-comment" data-comment-id="comment-1">Commented <em>text</em></span></p>',

    // Footnote markers.
    '<p>Text<sup class="nv-fn" data-fn-id="fn-1" title="Note text">1</sup></p>',

    // Entity mentions.
    '<p><span class="nv-entity-mention" data-entity-id="entity-1" data-entity-type="character" data-mention-source="alias">Alias</span>&nbsp;</p>',

    // Pending entity creation.
    '<p><span class="nv-mention-pending" data-pending-id="pm-1">Name</span></p>',

    // Suggested insertion and deletion.
    '<p><ins data-nl-change="c1" data-nl-author="Author" data-nl-at="2026-10-19T00:00:00.000Z">Added</ins><del data-nl-change="c2" data-nl-author="Author" data-nl-at="2026-10-19T00:00:00.000Z">Removed</del></p>',

    // Stored image paths.
    '<p class="nv-image"><img src="Images/picture name.png" alt="Description"></p>',

    // Internal anchors and language annotations.
    '<p id="target"><span lang="de-DE">Grüße</span></p><p><a href="#target">Jump</a></p>',

    // Template content, including nested templates.
    '<div><template><p>Preserved content</p></template></div>',
    '<div><template><template><p>Nested content</p></template></template></div>'
]

for (const [index, html] of fixtures.entries()) {
    test(`scene fixture ${index} survives import, projection and binary reload`, () => {
        const original = new Y.Doc()
        const restored = new Y.Doc()

        try {
            importScene(sanitizer, html, original)

            assert.equal(projectScene(sanitizer, original), html)

            Y.applyUpdate(restored, Y.encodeStateAsUpdate(original))

            assert.equal(projectScene(sanitizer, restored), html)
        } finally {
            original.destroy()
            restored.destroy()
        }
    })
}

test('import refuses to overwrite existing scene content', () => {
    const doc = new Y.Doc()

    try {
        const original = '<p>Existing scene</p>'
        importScene(sanitizer, original, doc)

        const before = Y.encodeStateAsUpdate(doc)

        assert.throws(
            () => importScene(sanitizer, '<p>Replacement</p>', doc),
            /importScene only fills an empty/
        )

        assert.equal(projectScene(sanitizer, doc), original)
        assert.deepEqual(Y.encodeStateAsUpdate(doc), before)
    } finally {
        doc.destroy()
    }
})

test('projection explicitly rejects XML hooks', () => {
    const doc = new Y.Doc()

    try {
        doc.getXmlFragment(SCENE_FRAGMENT).insert(0, [
            new Y.XmlHook('unsupported')
        ])

        assert.throws(
            () => projectScene(sanitizer, doc),
            UnsupportedSceneContentError
        )
    } finally {
        doc.destroy()
    }
})

test('projection rejects text marks instead of rendering them as literal markup', () => {
    const doc = new Y.Doc()

    try {
        const text = new Y.XmlText()
        doc.getXmlFragment(SCENE_FRAGMENT).insert(0, [text])
        text.insert(0, 'Hello', { bold: true })

        assert.throws(
            () => projectScene(sanitizer, doc),
            UnsupportedSceneContentError
        )
    } finally {
        doc.destroy()
    }
})

for (const kind of ['element', 'attribute']) {
    test(`projection rejects an invalid ${kind} name after binary reload`, () => {
        const original = new Y.Doc()
        const restored = new Y.Doc()

        try {
            const element = new Y.XmlElement(
                kind === 'element' ? 'invalid name' : 'p'
            )

            if (kind === 'attribute') {
                element.setAttribute('invalid name', 'value')
            }

            original.getXmlFragment(SCENE_FRAGMENT).insert(0, [element])

            // Simulate receiving this structure through a binary Yjs update.
            Y.applyUpdate(restored, Y.encodeStateAsUpdate(original))
            const before = Y.encodeStateAsUpdate(restored)

            assert.throws(
                () => projectScene(sanitizer, restored),
                UnsupportedSceneContentError
            )

            // Failed projection must not mutate the collaborative document.
            assert.deepEqual(Y.encodeStateAsUpdate(restored), before)
        } finally {
            original.destroy()
            restored.destroy()
        }
    })
}

test('projection rejects embedded XML text', () => {
    const doc = new Y.Doc()

    try {
        const text = new Y.XmlText()
        doc.getXmlFragment(SCENE_FRAGMENT).insert(0, [text])
        text.insertEmbed(0, { kind: 'unsupported' })

        assert.throws(
            () => projectScene(sanitizer, doc),
            UnsupportedSceneContentError
        )
    } finally {
        doc.destroy()
    }
})