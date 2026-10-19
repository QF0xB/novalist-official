import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EditorWindow } from '../src/renderer/src/views/editor/editorBridge'

test.beforeEach(async ({ page }) => {
  await page.goto(pathToFileURL(resolve('src/renderer/public/editor/editor.html')).href)
  await page.evaluate(() => {
    const editor = window as unknown as EditorWindow
    editor.setContent('<p id="paragraph">One two three</p>')
    document.getElementById('editor')!.focus()
    window.getSelection()!.setPosition(document.getElementById('editor')!.querySelector('p')!.firstChild!, 4)
  })
})

test('Ctrl+Delete removes the next word instead of being forwarded as a hotkey', async ({ page }) => {
  await page.keyboard.press('Control+Delete')
  await expect(page.locator('#editor')).toHaveText('One three')
  // Whether the following space goes too is the platform's word rule.
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getContent())).toMatch(/^<p id="paragraph">One {1,2}three<\/p>$/)
})

test('Ctrl+Backspace removes the previous word instead of being forwarded as a hotkey', async ({ page }) => {
  await page.keyboard.press('Control+Backspace')
  await expect(page.locator('#editor')).toHaveText('two three')
  expect(await page.evaluate(() => (window as unknown as EditorWindow).getContent())).toBe('<p id="paragraph">two three</p>')
})
