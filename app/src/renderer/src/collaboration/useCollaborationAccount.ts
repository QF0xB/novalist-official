import { useEffect, useRef, useState } from 'react'
import { rpc } from '../rpc/client'
import { useHostedSessionStore } from './hostedSessionStore'
import { readPreference, writePreference } from './projectPreferences'

interface Account { subject: string; displayName: string; deviceRegistered: boolean; deviceRegistrationError?: string | null; recoveryToken?: string | null }
interface Configuration { authenticationRequired: boolean; accountIdentityReset?: boolean }
export function useCollaborationAccount(enabled: boolean, project: string | null = null) {
  const [server, setServer] = useState(() => readPreference(project).server ?? '')
  const [account, setAccount] = useState<Account | null>(null)
  const [configuration, setConfiguration] = useState<Configuration | null>(null)
  const [busy, setBusy] = useState<'checking' | 'connecting' | 'signIn' | 'signOut' | null>(null)
  const [error, setError] = useState('')
  const [recoveryToken, setRecoveryToken] = useState('')
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const active = useRef(false)
  const savedServer = useHostedSessionStore(state => state.saved?.server)
  useEffect(() => { setServer(readPreference(project).server ?? ''); setRecoveryToken('') }, [project])
  // A project's saved session names the server it reconnects to.
  useEffect(() => { if (savedServer) setServer(savedServer) }, [savedServer])
  useEffect(() => {
    if (!enabled || !server.trim()) return
    const current = ++generation.current
    const timer = setTimeout(() => {
      if (generation.current !== current || active.current) return
      setBusy('checking')
      void (async () => {
        try {
          const value = await rpc.request<Configuration>('collaboration/account/configuration', [server.trim()])
          if (generation.current !== current) return
          setConfiguration(value)
          const restored = value.authenticationRequired
            ? await rpc.request<Account | null>('collaboration/account/status', [server.trim()]) : null
          if (generation.current === current) { setAccount(restored); setError('') }
        } catch (reason) { if (generation.current === current) setError(String(reason)) }
        finally { if (generation.current === current) setBusy(null) }
      })()
    }, 350)
    return () => { clearTimeout(timer); generation.current++ }
  }, [server, enabled, retry])
  const signIn = async (address = server.trim()): Promise<boolean> => {
    if (active.current) return false
    active.current = true
    generation.current++
    setError(''); setBusy('connecting')
    try {
      const policy = await rpc.request<Configuration>('collaboration/account/configuration', [address])
      setConfiguration(policy)
      let value: Account | null = null
      if (policy.authenticationRequired) {
        value = await rpc.request<Account | null>('collaboration/account/status', [address])
        if (!value) {
          setAccount(null)
          setBusy('signIn')
          value = await rpc.request<Account>('collaboration/account/signIn', [address])
        }
      }
      writePreference(project, { server: address })
      setServer(address); setAccount(value)
      setRecoveryToken(value?.recoveryToken ?? '')
      return true
    } catch (reason) { setError(String(reason)); return false }
    finally { active.current = false; setBusy(null) }
  }
  const signOut = async (): Promise<void> => {
    generation.current++
    setError(''); setBusy('signOut')
    try {
      await rpc.request('collaboration/account/signOut', [server.trim()])
      setAccount(null)
      setRecoveryToken('')
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(null) }
  }
  const changeServer = (value: string): void => {
    generation.current++
    setServer(value); setAccount(null); setConfiguration(null); setError(''); setBusy(null); setRecoveryToken('')
  }
  const enrollDevice = async (): Promise<void> => {
    if (active.current) return
    active.current = true
    generation.current++
    setError(''); setBusy('connecting')
    try {
      const value = await rpc.request<Account>('collaboration/account/enrollDevice', [server.trim()])
      setAccount(value); setRecoveryToken(value.recoveryToken ?? '')
    }
    catch (reason) { setError(String(reason)) }
    finally { active.current = false; setBusy(null) }
  }
  const cancel = async (): Promise<void> => {
    try { await rpc.request('collaboration/account/cancel') }
    catch (reason) { setError(String(reason)) }
  }
  const resetIdentity = async (forfeitProjectAccess: boolean): Promise<boolean> => {
    if (active.current || !forfeitProjectAccess) return false
    active.current = true
    generation.current++
    setError(''); setBusy('connecting'); setRecoveryToken('')
    try {
      const value = await rpc.request<Account>('collaboration/account/resetIdentity', [server.trim(), true])
      setAccount(value)
      setRecoveryToken(value.recoveryToken ?? '')
      return true
    } catch (reason) {
      setError(String(reason))
      // Reset may have completed before automatic enrollment was cancelled. Reflect the new identity.
      try { setAccount(await rpc.request<Account | null>('collaboration/account/status', [server.trim()])) }
      catch (refreshReason) { setError(String(reason) + '\n' + String(refreshReason)) }
      return false
    }
    finally { active.current = false; setBusy(null) }
  }
  return { server, account, configuration, busy, error, recoveryToken, dismissRecoveryToken: () => setRecoveryToken(''),
    enrollDevice, resetIdentity, signIn, signOut, changeServer, cancel, retry: () => setRetry(value => value + 1) }
}
