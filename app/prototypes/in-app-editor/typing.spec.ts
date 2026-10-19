import { expect, test } from '@playwright/test'
import type { EditorWindow } from '../../src/renderer/src/views/editor/editorBridge'

const sample = '<p>Alpha <b>beta</b> gamma delta.</p><p>Second.</p>'
const cases = {
  empty: { html: '<p><br></p>', keys: [] as string[], expected: '<p>Hello world</p>' },
  inword: { html: sample, keys: ['ArrowRight', 'ArrowRight'], expected: '<p>AlHello worldpha <b>beta</b> gamma delta.</p><p>Second.</p>' },
  middle: { html: sample, keys: Array(6).fill('ArrowRight'), expected: '<p>Alpha Hello world<b>beta</b> gamma delta.</p><p>Second.</p>' },
  end: { html: sample, keys: ['End'], expected: '<p>Alpha <b>beta</b> gamma delta.Hello world</p><p>Second.</p>' }
}

// Page view and proofing spans both wrap ProseMirror's nodes in DOM it does not
// own. A click, arrow keys and typing must still land at the caret: these
// combinations once reversed typed text, typed at the old caret, or lost words.
for (const mode of ['plain', 'pages', 'proofing', 'both'] as const) {
  for (const [name, { html, keys, expected }] of Object.entries(cases)) {
    test(`typing lands at the caret: ${mode}, ${name}`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto('/editor/editor.html')
      await expect(page.locator('#editor')).toHaveAttribute('data-editor-engine', 'prosemirror-yjs')
      await page.evaluate(({ mode, html }) => {
        const editor = window as unknown as EditorWindow
        editor.setContent(html)
        if (mode === 'pages' || mode === 'both') editor.setPageView(true)
        if (mode === 'proofing' || mode === 'both') {
          editor.setGrammarCheckEnabled(true)
          editor.setGrammarIssues(JSON.stringify([
            { offset: 0, length: 5, type: 'spelling', message: 'Spelling', replacements: ['Alps'] },
            { offset: 17, length: 5, type: 'grammar', message: 'Grammar', replacements: ['delta'] }
          ]))
        }
      }, { mode, html })
      const box = (await page.locator('#editor p').first().boundingBox())!
      await page.mouse.click(box.x + 2, box.y + box.height / 2)
      for (const key of keys) await page.keyboard.press(key)
      await page.keyboard.type('Hello world', { delay: 20 })
      await expect.poll(() => page.evaluate(() => (window as unknown as EditorWindow).getContent())).toBe(expected)
      expect(await page.locator('#editor').evaluate(editor => editor.textContent)).toBe(
        expected.replace(/<[^>]+>/g, ''))
      expect(errors).toEqual([])
    })
  }
}
