import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHostedSessionStore } from '../../collaboration/hostedSessionStore'
import { useProjectStore } from '../../stores/projectStore'
import { SharedProjectAccess } from './SharedProjectAccess'
import { CollaborationDestination, type CollaborationDestinationValue } from './CollaborationDestination'
import { CollaborationTransferStatus } from './CollaborationTransferStatus'
import { SteamFriendsInvite } from './SteamFriendsInvite'
import type { CollaborationIntent } from './CollaborationCard'
import { readPreference, writePreference } from '../../collaboration/projectPreferences'

export function SharedProjectCard({ server, canConnect, intent, name, prepareConnection, persistent = false }: {
  server: string; canConnect: boolean; intent: CollaborationIntent; name?: string
  prepareConnection?: (server: string) => Promise<boolean>
  persistent?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { session, saved, copied, busy, invitation, error, presenceUnavailable, run } = useHostedSessionStore()
  const loaded = useProjectStore(state => state.isLoaded)
  const project = useProjectStore(state => state.projectPath)
  const [autoReconnect, setAutoReconnect] = useState(() => readPreference(project).autoReconnect ?? true)
  useEffect(() => { setAutoReconnect(readPreference(project).autoReconnect ?? true) }, [project])
  const reconnectOption = project && saved ? <label className="collaboration-checkbox" htmlFor="set-collaboration-auto-reconnect">
    <input id="set-collaboration-auto-reconnect" type="checkbox" checked={autoReconnect}
      onChange={event => { setAutoReconnect(event.target.checked); writePreference(project, { autoReconnect: event.target.checked }) }} />
    {t('collaboration.autoReconnect')}
  </label> : null
  const [link, setLink] = useState('')
  const [destination, setDestination] = useState<CollaborationDestinationValue>({ path: '', valid: false, existing: false })
  const [localError, setLocalError] = useState('')

  const connect = async (operation: 'create' | 'join' | 'resume', params: unknown[], address = server.trim()): Promise<void> => {
    if (prepareConnection && !await prepareConnection(address)) return
    if (persistent) {
      const target = operation === 'create' ? 'persistentCreate' : operation === 'join' ? 'persistentJoin' : 'persistentResume'
      await run(target, operation === 'resume' ? [] : operation === 'create' ? params.slice(0, 1) : params.slice(0, 3))
    } else await run(operation, params)
  }

  const join = async (): Promise<void> => {
    await connect('join', [server.trim(), link.trim(), destination.path, name])
    if (useHostedSessionStore.getState().session) setLink('')
  }
  const recoveryPath = session?.recoveryPath || saved?.recoveryPath
  return <div className="collaboration-project">
    {session ? <>
      <p role="status">{t('collaboration.connection.' + session.connection)}</p>
      {presenceUnavailable && <p className="settings-hint">{t('collaboration.presenceUnavailable')}</p>}
      <div className="settings-button-row">
        {session.isOwner && <button className="dialog-button primary" disabled={busy !== null || session.connection !== 'Connected'} onClick={() => {
          void run('invite', [new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()])
        }}>{t('collaboration.invite')}</button>}
        <button className="dialog-button" disabled={busy !== null} onClick={() => void run('end')}>{t('collaboration.end')}</button>
        {(session.connection === 'KeyRefreshRequired' || session.connection === 'CheckpointRefreshRequired') && <button className="dialog-button primary" disabled={busy !== null} onClick={() => {
          void run('end').then(() => { if (!useHostedSessionStore.getState().session) return run(session.mode === 'persistent' ? 'persistentResume' : 'resume') })
        }}>{t('collaboration.refreshKeys')}</button>}
      </div>
      {(session.mode === 'persistent' || session.mode === 'hosted') && reconnectOption}
      {session.mode === 'steam' && session.isOwner && <SteamFriendsInvite disabled={busy !== null || session.connection !== 'Connected'} />}
      {invitation && <>
        <label className="inspector-label" htmlFor="set-collaboration-invitation">{t('collaboration.invitation')}</label>
        <textarea id="set-collaboration-invitation" className="dialog-input" value={invitation} readOnly onFocus={event => event.target.select()} />
        <p className="settings-hint">{t(session.mode === 'persistent' ? 'collaboration.persistentInvitationHint' : session.mode === 'hosted' ? 'collaboration.invitationHint' : 'collaboration.peerInvitationHint')}</p>
      </>}
      {session.isOwner && <details><summary tabIndex={0}>{t('collaboration.access.title')}</summary>
        <SharedProjectAccess sessionId={session.sessionId} disabled={busy !== null || session.connection === 'AccessEnded'} />
      </details>}
    </> : <>
      {saved && (saved.mode === 'persistent') === persistent && <>
        <p className="settings-hint">{t('collaboration.savedServer', { server: saved.server })}</p>
        <button className="dialog-button primary" disabled={!canConnect || !loaded || busy !== null}
          onClick={() => void connect('resume', [name], saved.server)}>{t('collaboration.resume')}</button>
        <p className="settings-hint">{t(persistent ? 'collaboration.persistentResumeHint' : 'collaboration.resumeHint')}</p>
        {reconnectOption}
      </>}
      <div className="collaboration-options">
      {intent === 'share' ? <section className="collaboration-option" aria-labelledby="collaboration-host-title">
      <h4 id="collaboration-host-title">{t('collaboration.hostTitle')}</h4>
       <p className="settings-hint">{t(persistent ? 'collaboration.persistentHostHint' : 'collaboration.hostHint')}</p>
      <button className="dialog-button primary" disabled={!canConnect || !loaded || busy !== null} onClick={() => void connect('create', [server.trim(), name])}>
        {t('collaboration.create')}
      </button>
      {!loaded && <p className="settings-hint">{t('collaboration.openProjectHint')}</p>}
      </section> : <section className="collaboration-option" aria-labelledby="collaboration-join-title">
      <h4 id="collaboration-join-title">{t('collaboration.joinTitle')}</h4>
      <label className="inspector-label" htmlFor="set-collaboration-join">{t('collaboration.invitation')}</label>
      <textarea id="set-collaboration-join" className="dialog-input" value={link} disabled={busy !== null} autoComplete="off"
        onChange={event => setLink(event.target.value)} />
      {(!persistent || link.trim()) && <>
      <CollaborationDestination id="set-collaboration-destination" busy={busy !== null} onChange={setDestination} allowExisting={!persistent} />
      <div className="settings-button-row">
        <button className="dialog-button primary" disabled={!canConnect || busy !== null || !link.trim() || !destination.valid || persistent && destination.existing} onClick={() => void join()}>
          {t('collaboration.join')}
        </button>
        {!persistent && loaded && !destination.existing && <button className="dialog-button" disabled={busy !== null || !destination.valid}
          onClick={() => void run('copy', [destination.path])}>{t('collaboration.copy')}</button>}
      </div>
      </>}
       <p className="settings-hint">{t(persistent ? 'collaboration.persistentJoinHint' : 'collaboration.joinHint')}</p>
      </section>}
      </div>
    </>}
    {recoveryPath && <button className="dialog-button" onClick={() => {
      void window.novalist.revealPath(recoveryPath).catch(reason => setLocalError(String(reason)))
    }}>{t('collaboration.showRetainedCopy')}</button>}
    {copied && <p role="status">{t('collaboration.copyCreated')}</p>}
    <CollaborationTransferStatus />
    {(error || localError) && <p role="alert">{error || localError}</p>}
  </div>
}
