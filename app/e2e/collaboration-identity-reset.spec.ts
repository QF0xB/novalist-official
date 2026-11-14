import { expect, test } from '@playwright/test'
import { dismissTour, launchApp } from './harness'

test('lost-device reset requires explicit forfeiture confirmation before the MFA RPC', async () => {
  const h = await launchApp('nl-collaboration-identity-reset-')
  try {
    await dismissTour(h.page)
    await h.page.evaluate(() => {
      const account = { subject: 'writer', displayName: 'Test Writer', deviceRegistered: false,
        deviceRegistrationError: 'Link this device from an authorized device or recovery key.' }
      const original = window.novalistRpc.request.bind(window.novalistRpc)
      const calls: { method: string; params?: unknown }[] = []
      Object.assign(window, { identityResetCalls: calls })
      window.novalistRpc.request = async <T,>(method: string, params?: unknown): Promise<T> => {
        if (method === 'collaboration/account/configuration') return { authenticationRequired: true, accountIdentityReset: true } as T
        if (method === 'collaboration/account/status') return account as T
        if (method === 'collaboration/account/resetIdentity') {
          calls.push({ method, params })
          return { ...account, deviceRegistered: true, deviceRegistrationError: null, recoveryToken: 'new-recovery-token' } as T
        }
        if (method === 'collaboration/account/enrollDevice') {
          calls.push({ method, params })
          return null as T
        }
        return original<T>(method, params)
      }
    })
    await h.page.evaluate(() => document.querySelector<HTMLButtonElement>('[data-collaboration-trigger][aria-expanded="false"]')?.click())
    await h.page.locator('#set-collaboration-mode').selectOption('persistent')
    await h.page.getByLabel('Server address', { exact: true }).fill('https://sync.example/')
    await expect(h.page.getByRole('alert').filter({ hasText: 'Link this device' })).toBeVisible()
    await expect(h.page.getByLabel('Invitation link', { exact: true })).toHaveCount(0)
    await h.page.getByText('Lost access to all your devices?', { exact: true }).click()
    await h.page.getByRole('button', { name: 'Reset lost-device identity', exact: true }).click()
    const confirm = h.page.getByRole('button', { name: 'Reset identity with fresh MFA', exact: true })
    await expect(confirm).toBeDisabled()
    await expect(h.page.getByRole('alert').filter({ hasText: 'including projects you owned' })).toBeVisible()
    await h.page.getByRole('checkbox', { name: 'I understand that I am giving up all previous project access and ownership.' }).check()
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(h.page.getByLabel('Recovery token', { exact: true })).toHaveValue('new-recovery-token')
    expect(await h.page.evaluate(() => (window as unknown as { identityResetCalls: unknown[] }).identityResetCalls))
      .toEqual([{ method: 'collaboration/account/resetIdentity', params: ['https://sync.example/', true] }])
    await expect(h.page.getByRole('button', { name: 'Register this device', exact: true })).toHaveCount(0)
    await h.page.getByRole('button', { name: 'I have saved the token — continue', exact: true }).click()
    await expect(h.page.getByRole('button', { name: 'Reset lost-device identity', exact: true })).toHaveCount(0)
    await expect(h.page.getByLabel('Invitation link', { exact: true })).toBeVisible()
  } finally { await h.close() }
})
