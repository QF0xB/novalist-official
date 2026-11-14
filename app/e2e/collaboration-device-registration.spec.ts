import { expect, test } from '@playwright/test'
import { dismissTour, launchApp } from './harness'

declare global {
  interface Window { registrationTest: { registered: boolean; calls: string[] } }
}

// Signing in to a persistent server registers the device in the same browser visit. The register button
// only appears when that did not happen, and disappears once the fallback registration succeeds.
test('persistent sign-in offers device registration only when sign-in did not register the device', async () => {
  const h = await launchApp('nl-collaboration-device-registration-')
  try {
    await dismissTour(h.page)
    await h.page.evaluate(() => {
      window.registrationTest = { registered: true, calls: [] }
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'collaboration/account/configuration') return { authenticationRequired: true } as T
        if (method === 'collaboration/account/status') return null as T
        if (method === 'collaboration/account/signIn')
          return { subject: 'writer', displayName: 'Test Writer', deviceRegistered: window.registrationTest.registered,
            recoveryToken: window.registrationTest.registered ? 'first-recovery-token' : null } as T
        if (method === 'collaboration/account/enrollDevice' || method === 'collaboration/account/signOut') {
          window.registrationTest.calls.push(method)
          return (method.endsWith('enrollDevice')
            ? { subject: 'writer', displayName: 'Test Writer', deviceRegistered: true, recoveryToken: 'retry-recovery-token' } : null) as T
        }
        return original<T>(method, params)
      }
    })
    await h.page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-collaboration-trigger][aria-expanded="false"]')?.click())
    await h.page.locator('#set-collaboration-mode').selectOption('persistent')
    await h.page.getByLabel('Server address', { exact: true }).fill('https://sync.example/')
    await expect(h.page.getByLabel('Invitation link', { exact: true })).toHaveCount(0)
    await h.page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(h.page.getByRole('status').filter({ hasText: 'Signed in as Test Writer' })).toBeVisible()
    await expect(h.page.getByLabel('Recovery token', { exact: true })).toHaveValue('first-recovery-token')
    await expect(h.page.getByRole('button', { name: 'Register this device', exact: true })).toHaveCount(0)
    await expect(h.page.getByLabel('Invitation link', { exact: true })).toHaveCount(0)
    await h.page.getByRole('button', { name: 'I have saved the token — continue', exact: true }).click()
    await expect(h.page.getByLabel('Recovery token', { exact: true })).toHaveCount(0)
    await expect(h.page.getByLabel('Invitation link', { exact: true })).toBeVisible()
    await expect(h.page.getByLabel('Local project folder name', { exact: true })).toHaveCount(0)
    await h.page.getByLabel('Invitation link', { exact: true }).fill('novalist://invitation')
    await expect(h.page.getByLabel('Local project folder name', { exact: true })).toBeVisible()
    await expect(h.page.getByRole('checkbox', { name: 'Use an existing local project', exact: true })).toHaveCount(0)

    await h.page.getByText('Account', { exact: true }).click()
    await h.page.getByRole('button', { name: 'Sign out', exact: true }).click()
    await h.page.evaluate(() => { window.registrationTest.registered = false })
    await h.page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const register = h.page.getByRole('button', { name: 'Register this device', exact: true })
    await expect(register).toBeVisible()
    await register.click()
    await expect(h.page.getByLabel('Recovery token', { exact: true })).toHaveValue('retry-recovery-token')
    await expect(register).toHaveCount(0)
    expect(await h.page.evaluate(() => window.registrationTest.calls))
      .toEqual(['collaboration/account/signOut', 'collaboration/account/enrollDevice'])
  } finally { await h.close() }
})
