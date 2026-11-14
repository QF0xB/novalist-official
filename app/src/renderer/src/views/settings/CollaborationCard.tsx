import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { rpc } from '../../rpc/client'
import { SharedProjectCard } from './SharedProjectCard'
import { PeerProjectCard } from './PeerProjectCard'
import { useHostedSessionStore } from '../../collaboration/hostedSessionStore'
import { useProjectStore } from '../../stores/projectStore'
import { useCollaborationAccount } from '../../collaboration/useCollaborationAccount'
import { readPreference, writePreference } from '../../collaboration/projectPreferences'

export type CollaborationIntent = 'share' | 'join'

export function CollaborationCard(): React.JSX.Element {
  const { t } = useTranslation()
  const loaded = useProjectStore(state => state.isLoaded)
  const project = useProjectStore(state => state.projectPath)
  const session = useHostedSessionStore(state => state.session)
  const saved = useHostedSessionStore(state => state.saved)
  const sharing = useHostedSessionStore(state => state.busy !== null)
  const [intent, setIntent] = useState<CollaborationIntent>(loaded ? 'share' : 'join')
  const [mode, setMode] = useState<string>(session?.mode ?? saved?.mode ?? remembered(project, false) ?? 'tcp')
  const interacted = useRef(false)
  const [steamAvailable, setSteamAvailable] = useState(false)
  const [name, setName] = useState(() => localStorage.getItem('novalist.collaboration.name') ?? '')
  const [resetConfirm, setResetConfirm] = useState(false)
  const [forfeitAccess, setForfeitAccess] = useState(false)
  const [resetComplete, setResetComplete] = useState(false)
  const persistent = mode === 'persistent'
  const serverMode = mode === 'hosted' || persistent
  const account = useCollaborationAccount(serverMode && !session, project)
  const anonymous = account.configuration?.authenticationRequired === false
  const ready = account.configuration !== null && (persistent ? Boolean(account.account?.deviceRegistered) : anonymous || Boolean(account.account))
  const canConnect = ready && account.busy === null && (!anonymous || Boolean(name.trim()))
  useLayoutEffect(() => { setResetConfirm(false); setForfeitAccess(false); setResetComplete(false) }, [account.server, account.account?.subject, mode])
  useEffect(() => {
    if (session) { interacted.current = true; setMode(session.mode); setIntent('share'); writePreference(project, { mode: session.mode }) }
    // Preserve reconnect controls and any choice or input made during Steam detection.
    else if (!interacted.current) setMode(saved?.mode ?? remembered(project, steamAvailable) ?? (steamAvailable ? 'steam' : 'tcp'))
  }, [session?.sessionId, session?.mode, saved?.projectId, saved?.server, saved?.mode, steamAvailable, project])
  useEffect(() => {
    if (window.novalist.isMobile) return
    let current = true
    void rpc.request<{ available: boolean }>('collaboration/steam/status')
      .then(status => { if (current) setSteamAvailable(status.available) }, () => { if (current) setSteamAvailable(false) })
    return () => { current = false }
  }, [])
  if (session) return <div className="collaboration-settings">
    <p className="settings-hint">{t('collaboration.mode' + (session.mode === 'persistent' ? 'Persistent' : session.mode === 'hosted' ? 'Hosted' : session.mode === 'steam' ? 'Steam' : 'Tcp'))}</p>
    <SharedProjectCard server={session.server} canConnect={false} intent={intent} persistent={persistent} />
  </div>
  return <div className="collaboration-settings" onChangeCapture={() => { interacted.current = true }}
    onClickCapture={() => { interacted.current = true }}>
    <div className="collaboration-intent" role="group" aria-label={t('collaboration.title')}>
      {(['share', 'join'] as const).map(value => <button key={value} className={'dialog-button' + (intent === value ? ' primary' : '')}
        aria-pressed={intent === value} disabled={sharing || account.busy !== null || value === 'share' && !loaded}
        onClick={() => setIntent(value)}>{t('collaboration.' + value + 'Tab')}</button>)}
    </div>
    <label className="inspector-label" htmlFor="set-collaboration-mode">{t('collaboration.mode')}</label>
    <select id="set-collaboration-mode" className="dialog-input" value={mode} disabled={sharing || account.busy !== null}
      onChange={event => { setMode(event.target.value); writePreference(project, { mode: event.target.value }) }}>
      {steamAvailable && <option value="steam">{t('collaboration.modeSteam')}</option>}
      <option value="tcp">{t('collaboration.modeTcp')}</option>
      <option value="hosted">{t('collaboration.modeHosted')}</option>
      {!window.novalist.isMobile && <option value="persistent">{t('collaboration.modePersistent')}</option>}
    </select>
    {!serverMode ? <PeerProjectCard key={mode} steam={mode === 'steam'} intent={intent} /> : <>
      <details><summary>{t('collaboration.serverHelp')}</summary>
      <p className="settings-hint" id="collaboration-server-help">{t(persistent ? 'collaboration.persistentServerHint' : 'collaboration.serverHint')}</p>
      <div className="settings-button-row">
        <button className="dialog-button" onClick={() => void window.novalist.openExternal('https://github.com/QF0xB/novalist-sync-server')}>
          {t('collaboration.serverProject')}</button>
        <button className="dialog-button" onClick={() => void window.novalist.openExternal('https://github.com/QF0xB/novalist-sync-server/blob/main/docs/' + (persistent ? 'self-hosting.md' : 'relay.md'))}>
          {t(persistent ? 'collaboration.persistentSetupGuide' : 'collaboration.serverSetupGuide')}</button>
      </div>
      </details>
      <details open={!ready}><summary>{t('collaboration.server')}{ready ? ': ' + account.server : ''}</summary>
      <label className="inspector-label" htmlFor="set-collaboration-server">{t('collaboration.server')}</label>
      <input id="set-collaboration-server" className="dialog-input" type="url" value={account.server} disabled={account.busy !== null && account.busy !== 'checking' || sharing}
        placeholder="https://" aria-describedby="collaboration-server-help" onChange={event => account.changeServer(event.target.value)} />
      </details>
      {account.busy === 'checking' && <p role="status">{t('collaboration.checkingServer')}</p>}
      {account.busy === 'connecting' && <p role="status">{t('collaboration.accountWorking')}</p>}
      {account.account && <p role="status">{t('collaboration.signedIn', { name: account.account.displayName })}</p>}
      {account.busy === 'signIn' && <p role="status">{t('collaboration.browserPending')}</p>}
      {(account.busy === 'signIn' || account.busy === 'connecting') && <button className="dialog-button" onClick={() => void account.cancel()}>{t(account.busy === 'signIn' ? 'collaboration.cancelSignIn' : 'dialog.cancel')}</button>}
      {account.error && <p role="alert">{account.error}</p>}
      {resetComplete && <p role="status">{t('collaboration.resetComplete')}</p>}
      {persistent && anonymous && <p role="alert">{t('collaboration.persistentRequiresAccount')}</p>}
      {anonymous && !persistent ? <>
        <label className="inspector-label" htmlFor="set-relay-name">{t('collaboration.peerName')}</label>
        <input id="set-relay-name" className="dialog-input" value={name} maxLength={128} disabled={sharing}
          onChange={event => { setName(event.target.value); localStorage.setItem('novalist.collaboration.name', event.target.value) }} />
      </> : account.account ? <>
        <details><summary tabIndex={0}>{t('collaboration.accountDetails')}</summary>
        <p className="settings-hint">{t('collaboration.nameHint')}</p>
        <button className="dialog-button" disabled={account.busy !== null || sharing} onClick={() => void account.signOut()}>{t('collaboration.signOut')}</button>
        </details>
        {persistent && !account.account.deviceRegistered && <section aria-label={t('collaboration.enrollDevice')}>
          <p className="settings-hint">{t('collaboration.enrollHint')}</p>
          {account.account.deviceRegistrationError && <p role="alert">{t('collaboration.registrationFailed', { reason: account.account.deviceRegistrationError })}</p>}
          <button className="dialog-button" disabled={account.busy !== null || sharing} onClick={() => void account.enrollDevice()}>{t('collaboration.enrollDevice')}</button>
          {account.configuration?.accountIdentityReset && <details><summary>{t('collaboration.lostDevices')}</summary>
          <p className="settings-hint">{t('collaboration.resetHint')}</p>
          {resetConfirm ? <div role="group" aria-label={t('collaboration.resetIdentity')}>
            <p role="alert">{t('collaboration.resetWarning')}</p>
            <label className="settings-hint"><input type="checkbox" checked={forfeitAccess} disabled={account.busy !== null || sharing}
              onChange={event => setForfeitAccess(event.target.checked)} /> {t('collaboration.resetForfeit')}</label>
            <div className="settings-button-row">
              <button className="dialog-button" disabled={!forfeitAccess || account.busy !== null || sharing}
                onClick={() => void account.resetIdentity(forfeitAccess).then(ok => {
                  if (ok) { setResetConfirm(false); setForfeitAccess(false); setResetComplete(true) }
                })}>{t('collaboration.resetConfirm')}</button>
              <button className="dialog-button" disabled={account.busy !== null} onClick={() => { setResetConfirm(false); setForfeitAccess(false) }}>{t('dialog.cancel')}</button>
            </div>
          </div> : <button className="dialog-button" disabled={account.busy !== null || sharing}
            onClick={() => { setResetConfirm(true); setForfeitAccess(false) }}>{t('collaboration.resetIdentity')}</button>}
          </details>}
        </section>}
      </> : account.configuration && !anonymous ? <div className="settings-button-row">
        <p className="settings-hint">{t('collaboration.signInHint')}</p>
        <button className="dialog-button primary" disabled={account.busy !== null || sharing || !account.server.trim()}
          onClick={() => void account.signIn()}>{t('collaboration.signIn')}</button>
      </div> : !account.configuration && <button className="dialog-button" disabled={account.busy !== null || !account.server.trim()} onClick={account.retry}>{t('collaboration.checkServer')}</button>}
      {account.error && !anonymous && <button className="dialog-button" disabled={account.busy !== null || sharing} onClick={() => void account.signOut()}>{t('collaboration.forgetSignIn')}</button>}
      {persistent && account.recoveryToken ? <section aria-labelledby="collaboration-recovery-title">
        <h4 id="collaboration-recovery-title">{t('collaboration.saveRecoveryToken')}</h4>
        <p className="settings-hint">{t('collaboration.recoveryTokenHint')}</p>
        <label className="inspector-label" htmlFor="collaboration-recovery-token">{t('collaboration.recoveryToken')}</label>
        <textarea id="collaboration-recovery-token" className="dialog-input" readOnly value={account.recoveryToken}
          autoComplete="off" spellCheck={false} onFocus={event => event.target.select()} />
        <button className="dialog-button primary" onClick={account.dismissRecoveryToken}>{t('collaboration.recoveryTokenSaved')}</button>
      </section> : ready && <SharedProjectCard server={account.server} canConnect={canConnect} intent={intent} name={anonymous ? name.trim() : undefined}
        prepareConnection={account.signIn} persistent={persistent} key={mode} />}
    </>}
  </div>
}

// The connection type picked for this project, or the last one picked anywhere, when this device offers it.
function remembered(project: string | null, steamAvailable: boolean): string | undefined {
  const mode = readPreference(project).mode
  if (mode === 'steam' && !steamAvailable) return undefined
  if (mode === 'persistent' && window.novalist.isMobile) return undefined
  return mode === 'tcp' || mode === 'hosted' || mode === 'persistent' || mode === 'steam' ? mode : undefined
}
