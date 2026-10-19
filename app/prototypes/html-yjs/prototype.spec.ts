import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const runtimeErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  runtimeErrors.set(page, errors)
  page.on('pageerror', error => errors.push(error.message))
})
test.afterEach(({ page }) => {
  expect(runtimeErrors.get(page)).toEqual([])
})

async function importScene(page: Page, html: string) {
  await page.getByLabel('Source HTML fragment').fill(html)
  await page.getByRole('button', { name: 'Import into fresh demo' }).click()
  await expect(page.getByRole('textbox', { name: 'Bob scene', exact: true })).toBeVisible()
}

async function selectWithKeyboard(page: Page, key: string, expected: string) {
  // Chromium updates its DOM selection before dispatching selectionchange.
  // Wait for that event so ProseMirror has adopted the selection before the
  // next command; checking getSelection() alone can race the editor state.
  await page.evaluate(text => {
    document.documentElement.dataset.testSelection = 'pending'
    const onSelection = () => {
      if (window.getSelection()?.toString() !== text) return
      document.documentElement.dataset.testSelection = 'settled'
      document.removeEventListener('selectionchange', onSelection)
    }
    document.addEventListener('selectionchange', onSelection)
  }, expected)
  await page.keyboard.press(key)
  await expect(page.locator('html')).toHaveAttribute('data-test-selection', 'settled')
}

test('sample preserves HTML annotations and initializes both peers only once', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('#fidelity')).toContainText('parsed HTML preserved')
  const source = await page.locator('#source').inputValue()
  for (const peer of ['alice', 'bob']) {
    await expect(page.locator(`#${peer}-html`)).toHaveValue(source)
    const editor = page.getByRole('textbox', { name: `${peer === 'alice' ? 'Alice' : 'Bob'} scene`, exact: true })
    await expect(editor.locator('[data-entity-id="entity-1"]')).toHaveText('Mara')
    await expect(editor.locator('[data-comment-id="comment-1"]')).toHaveText('a letter')
    await expect(editor.locator('[data-fn-id="fn-1"]')).toHaveText('1')
    await expect(editor.locator('ins[data-nl-change="change-1"]')).toHaveText('A new beginning.')
    // ProseMirror also renders non-content separator images around inline atoms.
    await expect(editor.locator('img[alt="Sample image"]')).toHaveCount(1)
  }
})

test('offline concurrent inserts converge and undo keeps remote edits', async ({ page }) => {
  await page.goto('/')
  await importScene(page, '<p>Harbor.</p>')
  await page.getByRole('button', { name: 'Disconnect peers', exact: true }).click()
  const alice = page.getByRole('textbox', { name: 'Alice scene', exact: true })
  const bob = page.getByRole('textbox', { name: 'Bob scene', exact: true })
  await alice.click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('Alice ')
  await bob.click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('Bob ')
  await expect(alice).not.toContainText('Bob ')
  await expect(bob).not.toContainText('Alice ')
  await expect(page.locator('#convergence')).toHaveText('Documents differ')
  await page.getByRole('button', { name: 'Reconnect peers', exact: true }).click()
  await expect(alice).toContainText('Bob ')
  await expect(bob).toContainText('Alice ')
  await expect(page.locator('#convergence')).toHaveText('Documents match')
  await page.locator('#alice').getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(alice).not.toContainText('Alice ')
  await expect(alice).toContainText('Bob ')
  await expect(page.locator('#convergence')).toHaveText('Documents match')
  await page.locator('#alice').getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(bob).toContainText('Alice ')
  await expect(page.locator('#convergence')).toHaveText('Documents match')
})

test('presence shares named cursors and selections, clears on disconnect, and returns on reconnect', async ({ page }) => {
  await page.goto('/')
  await importScene(page, '<p>Harbor.</p>')
  const alice = page.getByRole('textbox', { name: 'Alice scene', exact: true })
  const bob = page.getByRole('textbox', { name: 'Bob scene', exact: true })
  const aliceParticipants = page.getByRole('list', { name: 'Alice participants' })
  const bobParticipants = page.getByRole('list', { name: 'Bob participants' })
  await expect(aliceParticipants.getByRole('listitem')).toHaveCount(2)
  await expect(bobParticipants).toContainText('Alice')
  await alice.click()
  await page.keyboard.press('Control+Home')
  await selectWithKeyboard(page, 'Control+Shift+End', 'Harbor.')
  await expect(bob.locator('.collaboration-cursor[data-user="Alice"]')).toHaveCount(1)
  await expect(bob.locator('.collaboration-selection[data-user="Alice"]')).toHaveText('Harbor.')
  await expect(bobParticipants).toContainText('Alice — editing')
  // Presence decorations must never leak into the HTML projection.
  await expect(page.locator('#bob-html')).toHaveValue('<p>Harbor.</p>')
  await page.getByRole('button', { name: 'Disconnect peers', exact: true }).click()
  await expect(aliceParticipants.getByRole('listitem')).toHaveCount(1)
  await expect(bobParticipants.getByRole('listitem')).toHaveCount(1)
  await expect(bob.locator('.collaboration-cursor, .collaboration-selection')).toHaveCount(0)
  await page.getByRole('button', { name: 'Reconnect peers', exact: true }).click()
  await expect(aliceParticipants.getByRole('listitem')).toHaveCount(2)
  await expect(bobParticipants.getByRole('listitem')).toHaveCount(2)
  await alice.click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('Hello ')
  await expect(bob.locator('.collaboration-cursor[data-user="Alice"]')).toHaveCount(1)
  await expect(page.locator('#bob-html')).toHaveValue('<p>Hello Harbor.</p>')
})

test('concurrent deletion and formatting merge without losing the other edit', async ({ page }) => {
  await page.goto('/')
  await importScene(page, '<p>Harbor.</p>')
  await page.getByRole('button', { name: 'Disconnect peers', exact: true }).click()
  const alice = page.getByRole('textbox', { name: 'Alice scene', exact: true })
  const bob = page.getByRole('textbox', { name: 'Bob scene', exact: true })
  await alice.click()
  await page.keyboard.press('Control+End')
  await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorOffset)).toBe(7)
  await selectWithKeyboard(page, 'Shift+ArrowLeft', '.')
  await page.keyboard.press('Backspace')
  await expect(alice).toHaveText('Harbor')
  await bob.click()
  await page.keyboard.press('Control+Home')
  await selectWithKeyboard(page, 'Control+Shift+End', 'Harbor.')
  await page.locator('#bob').getByRole('button', { name: 'Bold', exact: true }).click()
  await expect(bob.locator('strong')).toHaveText('Harbor.')
  await page.getByRole('button', { name: 'Reconnect peers', exact: true }).click()
  await expect(alice).toHaveText('Harbor')
  await expect(alice.locator('strong')).toHaveText('Harbor')
  await expect(bob.locator('strong')).toHaveText('Harbor')
  await expect(page.locator('#convergence')).toHaveText('Documents match')
})

test('fidelity report distinguishes schema loss from sanitizer changes', async ({ page }) => {
  await page.goto('/')
  await importScene(page, '<table><tbody><tr><td>Keep these words</td></tr></tbody></table>')
  await page.getByText('Initial import fidelity report', { exact: true }).click()
  let report = JSON.parse(await page.locator('#report').innerText())
  expect(report.sanitizerChanged).toBe(false)
  expect(report.schemaChanged).toBe(true)
  expect(report.parsedHtmlMatch).toBe(false)
  await expect(page.getByRole('textbox', { name: 'Alice scene', exact: true })).toContainText('Keep these words')
  await importScene(page, '<p onclick="alert(1)">Safe text<script>alert(1)</script></p>')
  report = JSON.parse(await page.locator('#report').innerText())
  expect(report.sanitizerChanged).toBe(true)
  expect(report.schemaChanged).toBe(false)
  await expect(page.locator('#alice-html')).toHaveValue('<p>Safe text</p>')
  await importScene(page, '<script>alert(1)</script><p>Safe text</p>')
  report = JSON.parse(await page.locator('#report').innerText())
  expect(report.sanitizerChanged).toBe(true)
  expect(report.parsedHtmlMatch).toBe(false)
})

test('imported scene IDs cannot replace demo controls', async ({ page }) => {
  await page.goto('/')
  await importScene(page, '<p id="bob">A duplicated element ID.</p>')
  await expect(page.getByRole('textbox', { name: 'Bob scene', exact: true })).toHaveText('A duplicated element ID.')
  await expect(page.locator('#convergence')).toHaveText('Documents match')
  await page.getByRole('button', { name: 'Disconnect peers', exact: true }).click()
  await expect(page.locator('#connection-status')).toContainText('Disconnected')
})

test('downloads HTML and imports local copies without writing the original', async ({ page }) => {
  await page.goto('/')
  const html = '<p class="nv-style-poetry">A local copy.</p>'
  await page.locator('#file').setInputFiles({ name: 'copy.html', mimeType: 'text/html', buffer: Buffer.from(html) })
  await expect(page.locator('#source')).toHaveValue(html)
  await page.getByRole('button', { name: 'Import into fresh demo' }).click()
  const downloaded = page.waitForEvent('download')
  await page.locator('#alice').getByRole('button', { name: 'Download HTML' }).click()
  const download = await downloaded
  expect(download.suggestedFilename()).toBe('scene-prototype.html')
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk))
  expect(Buffer.concat(chunks).toString()).toBe(html)
})
