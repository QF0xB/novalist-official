import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

const page_ = pathToFileURL(resolve('src/renderer/public/editor/scene-editor.html')).href

test.beforeEach(async ({ page }) => {
  await page.goto(page_)
  await expect(page.locator('#editor')).toHaveAttribute('data-editor-engine', 'prosemirror-scene')
})

async function load(page: Page, body: string): Promise<void> {
  await page.evaluate(value => (window as unknown as EditorWindow).setContent(value), body)
}
async function content(page: Page): Promise<{ format: string; version: number; doc: { content: unknown[] } }> {
  return JSON.parse(await page.evaluate(() => (window as unknown as EditorWindow).getContent()))
}
async function html(page: Page): Promise<string> {
  return page.locator('#editor').evaluate(element => element.innerHTML)
}
async function caretAt(page: Page, text: string, offset: number): Promise<void> {
  await page.evaluate(({ text, offset }) => {
    const walker = document.createTreeWalker(document.getElementById('editor')!, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent!.includes(text)) {
        document.getElementById('editor')!.focus()
        window.getSelection()!.setPosition(node, node.textContent!.indexOf(text) + offset)
        return
      }
    }
    throw new Error(`no text ${text}`)
  }, { text, offset })
}

test('every bridge function the host may call exists', async ({ page }) => {
  const source = readFileSync(resolve('src/renderer/src/views/editor/editorBridge.ts'), 'utf8')
  const declaration = source.split('export interface EditorWindow extends Window {')[1].split('\n}')[0]
  const names = Array.from(declaration.matchAll(/^  (\w+)\(/gm), match => match[1])
  expect(names.length).toBeGreaterThanOrEqual(71)
  expect(await page.evaluate(methods => methods.filter(name =>
    typeof (window as unknown as Record<string, unknown>)[name] !== 'function'), names)).toEqual([])
})

test('legacy HTML scenes load and are saved as scene documents', async ({ page }) => {
  await load(page, '<p class="nv-style-heading">Title</p><p>Some <b>bold</b> text.</p>')
  await expect(page.locator('#editor p')).toHaveCount(2)
  const saved = await content(page)
  expect(saved.format).toBe('novalist-scene')
  expect(saved.version).toBe(1)
  expect(saved.doc.content).toEqual([
    { type: 'paragraph', attrs: { style: 'heading' }, content: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', content: [
      { type: 'text', text: 'Some ' },
      { type: 'text', marks: [{ type: 'bold', attrs: { tag: 'b' } }], text: 'bold' },
      { type: 'text', text: ' text.' }
    ] }
  ])
  // A saved document loads back unchanged.
  const body = await page.evaluate(() => (window as unknown as EditorWindow).getContent())
  await load(page, '<p>Other</p>')
  await load(page, body)
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getContent())).toBe(body)
})

test('typing, Enter and Shift+Enter land at the caret', async ({ page }) => {
  await load(page, '<p>Alpha beta</p>')
  await page.locator('#editor p').click()
  await caretAt(page, 'beta', 0)
  await page.keyboard.type('new ')
  await page.keyboard.press('Enter')
  await page.keyboard.type('next')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('soft')
  await expect(page.locator('#editor')).toHaveText('Alpha new nextsoftbeta')
  expect(await html(page)).toContain('<p>Alpha new </p><p>next<br>softbeta</p>')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getPlainText())).toBe('Alpha new \nnext\nsoftbeta')
})

test('an empty line made with Enter is kept as an empty line', async ({ page }) => {
  await load(page, '<p>One</p>')
  await caretAt(page, 'One', 3)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Two')
  const saved = await content(page)
  expect(saved.doc.content[1]).toEqual({ type: 'paragraph', attrs: { placeholder: true } })
})

test('paragraph styles stay put while typing and splitting', async ({ page }) => {
  await load(page, '<p>Title</p><p>Body text.</p>')
  await caretAt(page, 'Title', 5)
  await page.evaluate(() => (window as unknown as EditorWindow).setParagraphStyle('heading'))
  await page.keyboard.type(' here')
  await expect(page.locator('#editor p').first()).toHaveClass('nv-style-heading')
  await page.waitForTimeout(300)
  await expect(page.locator('#editor p').first()).toHaveClass('nv-style-heading')
  await expect(page.locator('#editor p').first()).toHaveText('Title here')
  // Enter at the end of a heading continues with body text.
  await page.keyboard.press('Enter')
  await page.keyboard.type('Body')
  await expect(page.locator('#editor p').nth(1)).not.toHaveClass(/nv-style/)
  await page.evaluate(() => (window as unknown as EditorWindow).setParagraphStyle(''))
  await expect(page.locator('#editor p').nth(1)).not.toHaveAttribute('class')
})

test('formatting, alignment and lists apply to the selection and undo', async ({ page }) => {
  await load(page, '<p>Alpha beta</p><p>Gamma</p>')
  await page.evaluate(() => {
    const text = document.querySelector('#editor p')!.firstChild!
    document.getElementById('editor')!.focus()
    window.getSelection()!.setBaseAndExtent(text, 0, text, 5)
  })
  await page.evaluate(() => {
    const e = window as unknown as EditorWindow
    e.toggleBold()
    e.toggleItalic()
    e.alignCenter()
  })
  await expect(page.locator('#editor strong em, #editor em strong')).toHaveText('Alpha')
  await expect(page.locator('#editor p').first()).toHaveAttribute('style', /text-align: center/)
  await page.evaluate(() => (window as unknown as EditorWindow).toggleBulletList())
  await expect(page.locator('#editor ul li')).toHaveCount(1)
  await page.evaluate(() => (window as unknown as EditorWindow).toggleNumberList())
  await expect(page.locator('#editor ol li')).toHaveCount(1)
  await page.evaluate(() => (window as unknown as EditorWindow).toggleNumberList())
  await expect(page.locator('#editor ol, #editor ul')).toHaveCount(0)
  for (let i = 0; i < 6; i++) await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('#editor strong, #editor em')).toHaveCount(0)
  await expect(page.locator('#editor p').first()).not.toHaveAttribute('style')
})

test('clicks and double-clicks place the caret and select a word', async ({ page }) => {
  await load(page, '<p>Intro words here.</p><p>heitrnhseirtnsheai and more</p><p>Last line.</p>')
  const box = (await page.locator('#editor p').nth(1).boundingBox())!
  await page.mouse.click(box.x + 40, box.y + box.height / 2)
  await page.keyboard.type('X')
  await expect(page.locator('#editor p').nth(1)).toContainText('X')
  await expect(page.locator('#editor p').nth(2)).toHaveText('Last line.')
  // Far enough from the click above not to count as a triple click.
  await page.waitForTimeout(800)
  await page.mouse.dblclick(box.x + 40, box.y + box.height / 2)
  expect(await page.evaluate(() => window.getSelection()!.toString())).toMatch(/^he\w*X\w*$/)
})

test('pasting HTML keeps formatting through the scene model, plain text becomes paragraphs', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await load(page, '<p>Start end</p>')
  await caretAt(page, 'end', 0)
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/html', '<b>bold</b> <script>alert(1)</script><span onclick="x()">safe</span> ')
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('#editor b')).toHaveText('bold')
  expect(await html(page)).not.toMatch(/script|onclick/)
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text/plain', 'line one\nline two')
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(page.locator('#editor p')).toHaveCount(2)
  await expect(page.locator('#editor p').nth(1)).toHaveText('line twoend')
})

test('a scene this editor cannot read safely is read-only and never overwritten', async ({ page }) => {
  // A newer format version, written by a later Novalist.
  const legacy = '{"format":"novalist-scene","version":2,"doc":{"type":"doc","content":[]}}'
  await load(page, legacy)
  await expect(page.locator('#scene-notice')).toBeVisible()
  await expect(page.locator('#editor')).toHaveAttribute('contenteditable', 'false')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getContent())).toBe(legacy)
  await load(page, '<p>Fine</p>')
  await expect(page.locator('#scene-notice')).toBeHidden()
  await expect(page.locator('#editor')).toHaveAttribute('contenteditable', 'true')
})

test('host shortcuts are forwarded and word deletion stays in the editor', async ({ page }) => {
  await page.evaluate(() => {
    const frame = document.createElement('iframe')
    frame.id = 'child'
    frame.src = './scene-editor.html'
    document.body.append(frame)
    ;(window as unknown as { received: unknown[] }).received = []
    window.addEventListener('message', event => {
      const raw = (event.data as { novalistEditor?: string }).novalistEditor
      if (raw) (window as unknown as { received: unknown[] }).received.push(JSON.parse(raw))
    })
  })
  const child = page.frameLocator('#child')
  await expect(child.locator('#editor')).toHaveAttribute('data-editor-engine', 'prosemirror-scene')
  await child.locator('body').evaluate(() => (window as unknown as EditorWindow).setContent('<p>One two three</p>'))
  await child.locator('#editor p').click()
  await child.locator('body').evaluate(() => window.getSelection()!.setPosition(document.querySelector('#editor p')!.firstChild!, 4))
  // Let the editor read the scripted selection, as it would a real click.
  await page.waitForTimeout(100)
  await page.keyboard.press('Control+Backspace')
  await page.keyboard.press('Control+k')
  await page.keyboard.type('!')
  await expect(child.locator('#editor')).toHaveText('!two three')
  const received = () => page.evaluate(() => (window as unknown as { received: Array<Record<string, unknown>> }).received)
  await expect.poll(async () => (await received()).filter(message => message.type === 'hotkey' && message.key !== 'Control').map(message => message.key)).toEqual(['k'])
  await expect.poll(async () => (await received()).some(message => message.type === 'contentChanged'
    && JSON.parse(String(message.html)).format === 'novalist-scene' && message.plainText === '!two three')).toBe(true)
})

test('selecting text shows the formatting bubble, which formats without losing the selection', async ({ page }) => {
  await page.evaluate(() => {
    const e = window as unknown as EditorWindow
    e.setTheme('#1e1e24', '#d8d4cc', '#c9a227', '#3a3a46', '#1e1e24', '#d8d4cc')
    e.setContent('<p class="nv-style-heading">Arcturus Black</p><p><br></p><p>In the dim solitude of the old study, Duke Arcturus Black sat ensconced in his chair.</p><p>Second paragraph.</p>')
  })
  const bubble = page.locator('.nv-bubble')
  await expect(bubble).toBeHidden()
  const text = page.locator('#editor p').nth(2)
  const box = (await text.boundingBox())!
  // Drag across the first words, as a writer selects.
  await page.mouse.move(box.x + 2, box.y + 10)
  await page.mouse.down()
  await page.mouse.move(box.x + 120, box.y + 10, { steps: 5 })
  await expect(bubble).toBeHidden()
  await page.mouse.up()
  await expect(bubble).toBeVisible()
  await expect(page.locator('.nv-bubble-count')).toHaveText(/^\d+ words?$/)
  // Left-aligned with the selection, just above it.
  const position = (await bubble.boundingBox())!
  expect(Math.abs(position.x - box.x)).toBeLessThan(12)
  expect(position.y + position.height).toBeLessThanOrEqual(box.y + 2)
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/scene-editor-bubble.png', clip: { x: 0, y: 0, width: 800, height: 220 } })

  const selected = await page.evaluate(() => window.getSelection()!.toString())
  await page.locator('.nv-bubble [data-command="bold"]').click()
  await expect(text.locator('strong')).toHaveText(selected)
  await expect(page.locator('.nv-bubble [data-command="bold"]')).toHaveClass(/active/)
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected)

  await page.locator('.nv-bubble [data-command="heading"]').click()
  await page.locator('.nv-bubble-popup button', { hasText: 'Subheading' }).click()
  await expect(text).toHaveClass('nv-style-subheading')
  await page.locator('.nv-bubble [data-command="undo"]').click()
  await expect(text).not.toHaveClass(/nv-style/)

  // Collapsing the selection puts the bubble away.
  await page.keyboard.press('ArrowRight')
  await expect(bubble).toBeHidden()
})
