import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'

test.beforeEach(async ({ page }) => {
  await page.goto('/editor/editor.html')
  await expect(page.locator('#editor')).toHaveAttribute('data-editor-engine', 'prosemirror-yjs')
})

test('every declared editor bridge method remains available', async ({ page }) => {
  const source = readFileSync(resolve('src/renderer/src/views/editor/editorBridge.ts'), 'utf8')
  const declaration = source.split('export interface EditorWindow extends Window {')[1].split('\n}')[0]
  const names = Array.from(declaration.matchAll(/^  (\w+)\(/gm), match => match[1])
  expect(names.length).toBeGreaterThanOrEqual(71)
  expect(await page.evaluate(methods => methods.filter(name =>
    typeof (window as unknown as Record<string, unknown>)[name] !== 'function'), names)).toEqual([])
})

test('existing scene HTML survives the in-app model without narrowing to basic HTML', async ({ page }) => {
  const fixtures = [
    '<p>Plain text</p>', '<p><b>Bold</b> <i>italic</i> <u>underlined</u></p>',
    '<p><span class="nv-highlight">Highlighted</span></p>',
    '<p class="nv-style-poetry" style="text-align:center">Verse</p>',
    '<p><span class="nv-comment" data-comment-id="c1">A <em>comment</em></span></p>',
    '<p>Words<sup class="nv-fn" data-fn-id="fn1" title="Footnote">1</sup></p>',
    '<p><span class="nv-entity-mention" data-entity-id="e1" data-entity-type="character" data-mention-source="alias">Alias</span></p>',
    '<p><span class="nv-mention-pending" data-pending-id="pm1">Pending</span></p>',
    '<p><ins data-nl-change="c1" data-nl-author="Alice">Added</ins><del data-nl-change="c2">Removed</del></p>',
    '<p><a id="target"></a><a href="#target">Link</a></p>',
    '<p class="nv-image"><img src="Images/picture name.png" alt="Description"></p>',
    '<div>One<br>Two</div>', '<div><p>Nested</p>Between<p>Paragraphs</p></div>',
    'Before<p>Paragraph</p>After', '<p><br></p><p></p>',
    '<ul><li>One</li><li><p>Two</p><ul><li>Nested</li></ul></li></ul>',
    '<table><tbody><tr><th>Heading</th><td>A <b>cell</b></td></tr></tbody></table>',
    '<p><span><template><p>Inert content</p></template>Visible</span></p>',
    '<p><strong><em>Nested</em></strong> <em><strong>Reverse</strong></em></p>'
  ]
  for (const html of fixtures) {
    const result = await page.evaluate(value => {
      const editor = window as unknown as EditorWindow
      editor.setContent(value)
      const normalize = (input: string) => {
        const template = document.createElement('template')
        template.innerHTML = input
        return template.innerHTML
      }
      return { actual: normalize(editor.getContent()), expected: normalize(window.sanitizeSceneHtml(value)) }
    }, html)
    expect(result.actual, html).toBe(result.expected)
  }
})

test('normal formatting and undo remain reachable through the existing bridge', async ({ page }) => {
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setContent('<p>Alpha beta</p>')
    document.getElementById('editor')!.focus()
    const text = document.querySelector('#editor p')!.firstChild!
    window.getSelection()!.setBaseAndExtent(text, 0, text, 5)
    editor.toggleBold()
    editor.alignCenter()
    editor.setParagraphStyle('poetry')
  })
  await expect(page.locator('#editor b, #editor strong')).toHaveText('Alpha')
  const html = await page.evaluate(() => (window as unknown as EditorWindow).getContent())
  expect(html).toContain('nv-style-poetry')
  expect(html).toContain('text-align: center')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('#editor')).toHaveText('Alpha beta')
})

test('re-reading the editing DOM never adopts ProseMirror rendering aids as content', async ({ page }) => {
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setAutoReplacements(JSON.stringify([{ kind: 'literal', start: "'", end: "'", startReplace: '“', endReplace: '”' }]))
    editor.setContent('<p><br></p>')
    // Page view routes every observed change through the full DOM re-read.
    editor.setPageView(true)
  })
  await page.locator('#editor').click()
  // Each smart quote is a native command, which is also re-read from the DOM.
  await page.keyboard.type("'don't go,' she said.")
  await page.keyboard.press('Enter')
  await page.keyboard.type('Next.')
  const result = await page.evaluate(() => ({
    html: (window as unknown as EditorWindow).getContent(),
    aids: document.querySelectorAll('#editor .ProseMirror-separator, #editor .ProseMirror-trailingBreak').length
  }))
  expect(result.html).toBe('<p>“don\'t go,” she said.</p><p>Next.</p>')
  expect(result.aids).toBeLessThanOrEqual(2)
})

test('the normal iframe supports shared scene state and ephemeral presence between app panes', async ({ page }) => {
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setSceneContext('parity-scene', 'parity-project')
    editor.setContent('<p>Harbor.</p>')
    const frame = document.createElement('iframe')
    frame.id = 'peer'
    frame.src = './editor.html'
    document.body.append(frame)
  })
  const peer = page.frameLocator('#peer')
  await expect(peer.locator('#editor')).toHaveAttribute('data-editor-engine', 'prosemirror-yjs')
  await peer.locator('body').evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setSceneContext('parity-scene', 'parity-project')
    editor.setContent('<p>Harbor.</p>')
  })
  await expect(page.locator('.prototype-presence li')).toHaveCount(2)
  await expect(peer.locator('.prototype-presence li')).toHaveCount(2)
  await page.locator('#editor').click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('Hello ')
  await expect(peer.locator('#editor')).toContainText('Hello Harbor.')
  await expect(peer.locator('.collaboration-cursor')).toHaveCount(1)
  expect(await peer.locator('body').evaluate(() => (window as unknown as EditorWindow).getPlainText())).toBe('Hello Harbor.')
  expect(await peer.locator('body').evaluate(() => (window as unknown as EditorWindow).getContent())).toBe('<p>Hello Harbor.</p>')
  await page.evaluate(() => document.getElementById('peer')!.remove())
  await expect(page.locator('.prototype-presence li')).toHaveCount(1)
})
