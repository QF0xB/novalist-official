import assert from 'node:assert/strict'
import { after, test } from 'node:test'

import { convertScene, signature } from '../src/sceneModel/convert.ts'
import { isSceneDocument, parseScene, serializeScene, SceneFormatError } from '../src/sceneModel/format.ts'
import { sceneFromHtml, sceneToHtml } from '../src/sceneModel/html.ts'
import { createSceneSanitizer } from '../src/yjs/sceneSanitizer.ts'

const environment = createSceneSanitizer()
after(() => environment.document.defaultView?.close())

// Scene HTML as the editor, imports and pastes produce it.
const scenes = [
  '',
  '<p><br></p>',
  '<p></p>',
  '<p>Plain text</p>',
  '<p>Hello <strong>bold</strong> and <em>italic</em>.</p>',
  '<p><b>Bold</b> <i>italic</i> <u>underlined</u> <s>struck</s> <strike>old strike</strike></p>',
  '<p><b>Bold</b><i>Italic</i><u>Underline</u><strike>Strike</strike><sub>Sub</sub><sup>Super</sup></p>',
  '<p><strong><em>Nested</em></strong> <em><strong>Reverse</strong></em></p>',
  '<p>&amp; &lt;text&gt; &nbsp; Grüße 中文 é</p>',
  '<p class="nv-style-poetry" style="text-align:center">Verse</p>',
  '<p class="nv-style-heading">Chapter title</p><p class="nv-style-subheading">Sub</p>',
  '<p style="text-align: justify; margin-left: 2em">Justified</p>',
  '<p class="nv-image"><img src="Images/picture name.png" alt="Description"></p>',
  '<p><span class="nv-highlight">Highlighted</span></p>',
  '<p><span class="nv-comment" data-comment-id="c1">A <em>comment</em></span></p>',
  '<p><span class="nv-comment nv-comment-active" data-comment-id="c1">Active comment</span></p>',
  '<p>Words<sup class="nv-fn" data-fn-id="fn1" title="Footnote">1</sup></p>',
  '<p><span class="nv-entity-mention" data-entity-id="e1" data-entity-type="character" data-mention-source="alias">Alias</span></p>',
  '<p><span class="nv-mention-pending" data-pending-id="pm1">Pending</span></p>',
  '<p><ins data-nl-change="c1" data-nl-author="Alice">Added</ins><del data-nl-change="c2">Removed</del></p>',
  '<p><a id="target"></a><a href="#target">Link</a> and <a href="novalist://scene/example">scene link</a></p>',
  '<p><span style="font-family: Georgia">Styled</span> <code>code</code> <small>small</small></p>',
  '<div>One<br>Two</div>',
  '<div><p>Nested</p>Between<p>Paragraphs</p></div>',
  'Before<p>Paragraph</p>After',
  '<ul><li>One</li><li><p>Two</p><ul><li>Nested</li></ul></li></ul>',
  '<ol start="3"><li>First</li><li>Second</li></ol>',
  '<blockquote><p>Quoted</p></blockquote>',
  '<h1>Heading</h1><h3 style="text-align:right">Right</h3>',
  '<hr><p>After a rule</p>',
  '<table><tbody><tr><th>Heading</th><td>A <b>cell</b></td></tr></tbody></table>',
  '<pre>  preformatted\n  text</pre>',
  '<p><span><template><p>Inert content</p></template>Visible</span></p>',
  '<p>Line one</p>\n<p>Line two</p>\n',
  '<p>Soft<br>break and trailing<br></p>'
]

for (const html of scenes) {
  test(`converts without loss: ${JSON.stringify(html).slice(0, 70)}`, () => {
    const result = convertScene(environment, html)
    assert.ok(result.ok, result.ok ? '' : result.reason)
    // The stored body parses back to the same document.
    assert.ok(isSceneDocument(result.body))
    assert.ok(parseScene(result.body).eq(result.doc))
    // And renders back to HTML with the same meaning as the original.
    assert.equal(
      signature(environment.document, sceneToHtml(environment.document, parseScene(result.body))),
      signature(environment.document, environment.sanitize(html)))
  })
}

test('Novalist formatting has dedicated types, not generic HTML', () => {
  const doc = sceneFromHtml(environment,
    '<p class="nv-style-heading" style="text-align:center"><b>A</b><span class="nv-comment" data-comment-id="c1">B</span>'
    + '<sup class="nv-fn" data-fn-id="f1">1</sup><span class="nv-entity-mention" data-entity-id="e1">C</span></p>')
  const paragraph = doc.firstChild
  assert.equal(paragraph.type.name, 'paragraph')
  assert.equal(paragraph.attrs.style, 'heading')
  assert.equal(paragraph.attrs.align, 'center')
  assert.equal(paragraph.attrs.extra, null)
  const kinds = []
  paragraph.forEach(child => kinds.push(child.isText ? child.marks.map(mark => mark.type.name).join('+') : child.type.name))
  assert.deepEqual(kinds, ['bold', 'comment', 'footnote', 'mention'])
})

test('editor display state is not content', () => {
  const doc = sceneFromHtml(environment,
    '<p class="nv-focus-block"><span class="nv-comment nv-comment-active" data-comment-id="c1">Text</span></p>')
  assert.equal(sceneToHtml(environment.document, doc), '<p><span class="nv-comment" data-comment-id="c1">Text</span></p>')
})

test('stored scenes are one block per line', () => {
  const result = convertScene(environment, '<p>One</p><p>Two</p>')
  assert.ok(result.ok)
  const lines = result.body.trimEnd().split('\n')
  assert.equal(lines.length, 4)
  assert.equal(lines[1], '{"type":"paragraph","content":[{"type":"text","text":"One"}]},')
  assert.equal(lines[2], '{"type":"paragraph","content":[{"type":"text","text":"Two"}]}')
})

test('legacy HTML bodies are not scene documents', () => {
  assert.equal(isSceneDocument('<p>{"format": "not this"}</p>'), false)
  assert.equal(isSceneDocument('  {"format":"novalist-scene"}'), true)
})

test('unknown formats, versions and schema violations are rejected, not misread', () => {
  assert.throws(() => parseScene('{"format":"other","version":1,"doc":{}}'), SceneFormatError)
  assert.throws(() => parseScene('{"format":"novalist-scene","version":2,"doc":{"type":"doc"}}'), /version 2/)
  assert.throws(() => parseScene('{"format":"novalist-scene","version":1,"doc":{"type":"doc","content":[{"type":"text","text":"x"}]}}'), SceneFormatError)
  assert.throws(() => parseScene('not json'), SceneFormatError)
})

test('scripts and event handlers never reach the document', () => {
  const result = convertScene(environment, '<p onclick="alert(1)">Hi<script>alert(2)</script><img src="x" onerror="alert(3)"></p>')
  assert.ok(result.ok)
  assert.doesNotMatch(result.body, /alert|onclick|onerror|script/)
})
