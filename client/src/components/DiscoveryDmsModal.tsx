import { LoadingIndicator } from './LoadingIndicator';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Ban, BookOpen, ChevronDown, Clock3, Flag, Search, ShieldCheck, UserPlus, X } from 'lucide-react';
import { FizzerMark } from './FizzerMark';
import { api, formatRelativeDate, type CommunityUpdates, type User } from '../api';
import { ReportDialog } from './ReportDialog';
import { ModalShell } from './ModalShell';
import { DirectMessageThread, type DirectMessageConversation } from './DirectMessageThread';

export type DiscoveryTab = 'public' | 'dms';

type PublicVault = {
  id: string;
  name: string;
  ownerUsername: string;
  ownerDisplayName: string;
  ownerAvatarUrl: string;
  memberCount: number;
  summary: string;
  topics: string[];
  joinPolicy: 'open' | 'request' | 'invite';
  lastActivity: string;
  role: 'owner' | 'editor' | 'viewer' | null;
  requestStatus: 'pending' | 'approved' | 'rejected' | null;
};

type PublicVaultDetail = PublicVault & {
  guidelines: string;
  homeNote: { title: string; preview: string; updatedAt: string } | null;
};

type BlockedUser = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  createdAt: string;
};

type DiscoveryDmsModalProps = {
  initialTab: DiscoveryTab;
  onClose: () => void;
  onOpenLocation: (vaultId: string, channelId?: string, title?: string) => void | Promise<void>;
  onVaultsChanged: () => void | Promise<void>;
  currentUsername: string;
  currentUser?: User | null;
  onMarkRead: (channelId: string) => void | Promise<void>;
  updateCounts: CommunityUpdates['counts'];
};

function personInitial(displayName: string, username: string) {
  return (displayName || username).trim().charAt(0).toUpperCase() || '?';
}

function statusMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function DiscoveryDmsModal({
  initialTab,
  onClose,
  onOpenLocation,
  onVaultsChanged,
  currentUsername,
  currentUser,
  onMarkRead,
  updateCounts,
}: DiscoveryDmsModalProps) {
  const [publicVaults, setPublicVaults] = useState<PublicVault[]>([]);
  const [publicVaultDetail, setPublicVaultDetail] = useState<PublicVaultDetail | null>(null);
  const [reportVault, setReportVault] = useState<PublicVaultDetail | null>(null);
  const [dms, setDms] = useState<DirectMessageConversation[]>([]);
  const [selectedDm, setSelectedDm] = useState<DirectMessageConversation | null>(null);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [allowStrangerDms, setAllowStrangerDms] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [dmUsername, setDmUsername] = useState('');
  const [blockUsername, setBlockUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [status, setStatus] = useState('');

  const runAction = async (action: string, fallback: string, work: () => Promise<void>, onError?: () => void) => {
    setBusyAction(action);
    setStatus('');
    try {
      await work();
    } catch (error) {
      onError?.();
      setStatus(statusMessage(error, fallback));
    } finally {
      setBusyAction('');
    }
  };

  const loadPublicVaults = useCallback(async (query = '') => {
    setLoading(true);
    setStatus('');
    try {
      const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      const data = await api<{ vaults: PublicVault[] }>(`/api/public-vaults${suffix}`);
      setPublicVaults(data.vaults);
    } catch (error) {
      setStatus(statusMessage(error, 'Could not load public vaults'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDms = useCallback(async () => {
    setLoading(true);
    setStatus('');
    try {
      const [dmData, privacyData, blocksData] = await Promise.all([
        api<{ conversations: DirectMessageConversation[] }>('/api/me/direct-messages'),
        api<{ allowDirectMessages: boolean }>('/api/me/dm-settings'),
        api<{ blocks: BlockedUser[] }>('/api/me/blocks'),
      ]);
      const conversations = dmData.conversations || [];
      setDms(conversations);
      setSelectedDm((current) => (
        (current && conversations.some((conversation) => conversation.channelId === current.channelId) ? current : null)
        || conversations[0]
        || null
      ));
      setAllowStrangerDms(privacyData.allowDirectMessages);
      setBlockedUsers(blocksData.blocks);
    } catch (error) {
      setStatus(statusMessage(error, 'Could not load direct messages'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialTab !== 'public') {
      void loadDms();
      return;
    }
    const timer = window.setTimeout(() => void loadPublicVaults(searchQuery), 180);
    return () => window.clearTimeout(timer);
  }, [initialTab, loadDms, loadPublicVaults, searchQuery]);

  const openPublicVaultDetail = async (vault: PublicVault) => {
    await runAction(`detail:${vault.id}`, `Could not open ${vault.name}`, async () => {
      const data = await api<{ vault: PublicVaultDetail }>(`/api/public-vaults/${encodeURIComponent(vault.id)}`);
      setPublicVaultDetail(data.vault);
    });
  };

  const joinVault = async (vault: PublicVault) => {
    if (vault.role) {
      await onOpenLocation(vault.id);
      onClose();
      return;
    }
    await runAction(`join:${vault.id}`, `Could not join ${vault.name}`, async () => {
      const joined = await api<{ vaultId: string; name: string; role: string | null; requestStatus: 'pending' | null }>(
        `/api/public-vaults/${encodeURIComponent(vault.id)}/join`,
        { method: 'POST' },
      );
      if (joined.requestStatus === 'pending') {
        setPublicVaults((current) => current.map((item) => item.id === vault.id ? { ...item, requestStatus: 'pending' } : item));
        setPublicVaultDetail((current) => current?.id === vault.id ? { ...current, requestStatus: 'pending' } : current);
        setStatus(`Request sent to @${vault.ownerUsername}.`);
        return;
      }
      await onVaultsChanged();
      await onOpenLocation(joined.vaultId);
      onClose();
    });
  };

  const publicActionLabel = (vault: PublicVault) => {
    if (vault.role) return 'Open';
    if (vault.joinPolicy === 'invite') return 'Invite only';
    if (vault.requestStatus === 'pending') return 'Requested';
    return vault.joinPolicy === 'request' ? 'Request access' : 'Join as viewer';
  };

  const publicActionDisabled = (vault: PublicVault) => (
    busyAction === `join:${vault.id}`
    || (!vault.role && (vault.joinPolicy === 'invite' || vault.requestStatus === 'pending'))
  );

  const createDm = async (event: FormEvent) => {
    event.preventDefault();
    const username = dmUsername.trim().replace(/^@/, '');
    if (!username) return;
    await runAction('create-dm', `Could not message @${username}`, async () => {
      const created = await api<DirectMessageConversation>('/api/direct-messages', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      setDms((current) => [created, ...current.filter((dm) => dm.channelId !== created.channelId)]);
      setSelectedDm(created);
      setDmUsername('');
    });
  };

  const updatePrivacy = async () => {
    const next = !allowStrangerDms;
    setAllowStrangerDms(next);
    await runAction('privacy', 'Could not update DM privacy', async () => {
      const data = await api<{ allowDirectMessages: boolean }>('/api/me/dm-settings', {
        method: 'PUT',
        body: JSON.stringify({ allowDirectMessages: next }),
      });
      setAllowStrangerDms(data.allowDirectMessages);
      setStatus(data.allowDirectMessages ? 'Anyone may start a DM with you.' : 'New direct messages are turned off.');
    }, () => setAllowStrangerDms(!next));
  };

  const blockUser = async (usernameValue: string) => {
    const username = usernameValue.trim().replace(/^@/, '');
    if (!username) return;
    await runAction(`block:${username}`, `Could not block @${username}`, async () => {
      const data = await api<{ block: BlockedUser }>('/api/me/blocks', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      setBlockedUsers((current) => [data.block, ...current.filter((user) => user.username !== data.block.username)]);
      setBlockUsername('');
      setStatus(`Blocked @${data.block.username}.`);
    });
  };

  const unblockUser = async (username: string) => {
    await runAction(`unblock:${username}`, `Could not unblock @${username}`, async () => {
      await api(`/api/me/blocks/${encodeURIComponent(username)}`, {
        method: 'DELETE',
      });
      setBlockedUsers((current) => current.filter((user) => user.username !== username));
      setStatus(`Unblocked @${username}.`);
    });
  };

  return (
    <ModalShell
      backdropClassName={`overlay-backdrop discovery-dms-backdrop ${initialTab === 'dms' ? 'is-messages' : ''}`}
      dialogClassName={`discovery-dms-modal ${initialTab === 'dms' ? 'is-messages' : ''}`}
      ariaLabelledby="discovery-dms-title"
      onClose={onClose}
      closeOnEscape={!reportVault}
      afterDialog={reportVault && (
        <ReportDialog
          vaultId={reportVault.id}
          targetType="vault"
          targetId={reportVault.id}
          title={reportVault.name}
          onClose={() => setReportVault(null)}
        />
      )}
    >
        <header className="discovery-dms-header">
          <div>
            <span className="surface-kicker">{initialTab === 'public' ? 'Community' : 'Private'}</span>
            <h2 id="discovery-dms-title">{initialTab === 'public' ? 'Explore vaults' : 'Messages'}</h2>
            <p>{initialTab === 'public' ? 'Find a workspace built around an idea.' : 'Your conversations, in one inbox.'}</p>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label={`Close ${initialTab === 'public' ? 'explore vaults' : 'messages'}`}><X size={17} /></button>
        </header>

        <div className="discovery-dms-body">
          {initialTab === 'public' ? (
            <div className="discovery-panel" role="tabpanel">
              {publicVaultDetail ? (
                <div className="public-vault-detail">
                  <button type="button" className="public-vault-back" onClick={() => setPublicVaultDetail(null)}><ArrowLeft size={14} /> Back to public vaults</button>
                  <div className="public-vault-detail-heading">
                    <span className="discovery-avatar discovery-vault-avatar" aria-hidden="true"><FizzerMark size={18} /></span>
                    <div><h3>{publicVaultDetail.name}</h3><span>by @{publicVaultDetail.ownerUsername}</span></div>
                  </div>
                  <p className="public-vault-purpose">{publicVaultDetail.summary || 'The owner has not added a public summary yet.'}</p>
                  {!!publicVaultDetail.topics.length && <div className="public-vault-topics">{publicVaultDetail.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>}
                  <div className="public-vault-activity"><Clock3 size={13} /> Active {formatRelativeDate(publicVaultDetail.lastActivity)}</div>
                  <section><h4>Community guidelines</h4><p>{publicVaultDetail.guidelines || 'No additional guidelines have been posted.'}</p></section>
                  {publicVaultDetail.homeNote && (
                    <section className="public-vault-home-preview">
                      <h4><BookOpen size={13} /> {publicVaultDetail.homeNote.title}</h4>
                      <p>{publicVaultDetail.homeNote.preview || 'This note does not have a preview yet.'}</p>
                    </section>
                  )}
                  <div className="public-vault-detail-actions">
                    {publicVaultDetail.role !== 'owner' && (
                      <button type="button" className="public-vault-report-action" onClick={() => setReportVault(publicVaultDetail)}>
                        <Flag size={13} /> Report vault
                      </button>
                    )}
                    <button type="button" className="public-vault-primary-action" disabled={publicActionDisabled(publicVaultDetail)} onClick={() => void joinVault(publicVaultDetail)}>
                      {busyAction === `join:${publicVaultDetail.id}` ? 'Working…' : publicActionLabel(publicVaultDetail)}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <label className="discovery-search">
                    <Search size={14} aria-hidden="true" />
                    <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search name, owner, purpose, or topic" aria-label="Search public vaults" />
                  </label>
                  <div className="discovery-list public-vault-list" aria-label="Public vaults">
                    {loading && <div className="discovery-empty"><LoadingIndicator label="Loading public vaults" /></div>}
                    {!loading && publicVaults.map((vault) => (
                      <article className="discovery-row public-vault-card" key={vault.id}>
                        <span className="discovery-avatar discovery-vault-avatar" aria-hidden="true"><FizzerMark size={17} /></span>
                        <button type="button" className="public-vault-card-copy" disabled={busyAction === `detail:${vault.id}`} onClick={() => void openPublicVaultDetail(vault)} aria-label={`View ${vault.name} details`}>
                          <strong>{vault.name}</strong>
                          <span className="public-vault-owner">by @{vault.ownerUsername}</span>
                          <span className="public-vault-purpose">{vault.summary || 'No public summary yet.'}</span>
                          {!!vault.topics.length && <span className="public-vault-topics">{vault.topics.map((topic) => <em key={topic}>{topic}</em>)}</span>}
                          <span className="public-vault-activity"><Clock3 size={12} /> Active {formatRelativeDate(vault.lastActivity)}</span>
                        </button>
                        <button type="button" disabled={publicActionDisabled(vault)} onClick={() => void joinVault(vault)}>
                          {busyAction === `join:${vault.id}` ? 'Working…' : publicActionLabel(vault)}
                        </button>
                      </article>
                    ))}
                    {!loading && !publicVaults.length && <div className="discovery-empty">No public vaults match that search.</div>}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className={`dm-inbox ${selectedDm ? 'has-selection' : ''}`}>
              <aside className="dm-inbox-sidebar" aria-label="Direct message conversations">
                <form className="dm-compose" onSubmit={createDm}>
                  <label htmlFor="dm-username">New message</label>
                  <div>
                    <span aria-hidden="true">@</span>
                    <input id="dm-username" autoFocus value={dmUsername} onChange={(event) => setDmUsername(event.target.value)} placeholder="Username" autoComplete="off" />
                    <button type="submit" disabled={!dmUsername.trim() || busyAction === 'create-dm'} aria-label="Start direct message">
                      <UserPlus size={15} />
                    </button>
                  </div>
                </form>

                <section className="dm-section dm-conversations" aria-labelledby="dm-conversations-title">
                  <h3 id="dm-conversations-title">Conversations</h3>
                  <div className="discovery-list">
                    {loading && <div className="discovery-empty"><LoadingIndicator label="Loading messages" /></div>}
                    {!loading && dms.map((dm) => {
                      const unreadCount = updateCounts.byTarget[dm.channelId] || 0;
                      const selected = selectedDm?.channelId === dm.channelId;
                      return (
                        <article className={`discovery-row dm-conversation-row ${selected ? 'is-selected' : ''} ${unreadCount > 0 ? 'is-unread' : ''}`} key={dm.channelId}>
                          <span className="discovery-avatar" aria-hidden="true">{dm.user.avatarUrl ? <img src={dm.user.avatarUrl} alt="" /> : personInitial(dm.user.displayName, dm.user.username)}</span>
                          <button type="button" className="discovery-row-copy dm-open" aria-pressed={selected} onClick={() => setSelectedDm(dm)}>
                            <strong>{dm.user.displayName || dm.user.username}</strong><span>@{dm.user.username}</span>
                          </button>
                          {unreadCount > 0 && (
                            <span className="dm-conversation-unread" aria-label={`${unreadCount} unread message${unreadCount === 1 ? '' : 's'}`}>
                              {unreadCount >= 99 ? '99+' : unreadCount}
                            </span>
                          )}
                          <button type="button" className="dm-block-button" disabled={busyAction === `block:${dm.user.username}`} onClick={() => void blockUser(dm.user.username)} aria-label={`Block @${dm.user.username}`} title={`Block @${dm.user.username}`}><Ban size={14} /></button>
                        </article>
                      );
                    })}
                    {!loading && !dms.length && <div className="discovery-empty">Start a conversation above.</div>}
                  </div>
                </section>

                <details className="dm-settings-details">
                  <summary>
                    <ShieldCheck size={15} aria-hidden="true" />
                    <span>Privacy &amp; blocking</span>
                    <small>{allowStrangerDms ? 'On' : 'Off'}</small>
                    <ChevronDown size={14} aria-hidden="true" />
                  </summary>
                  <div className="dm-settings-body">
                    <div className="dm-privacy-row">
                      <div><strong>New messages</strong><span>Allow people to start a conversation.</span></div>
                      <button type="button" role="switch" aria-checked={allowStrangerDms} aria-label="Allow messages from strangers" className={`dm-toggle ${allowStrangerDms ? 'is-on' : ''}`} disabled={busyAction === 'privacy'} onClick={() => void updatePrivacy()}><span /></button>
                    </div>
                    <section className="dm-section" aria-labelledby="blocked-users-title">
                      <h3 id="blocked-users-title">Blocked users</h3>
                      <form className="dm-block-form" onSubmit={(event) => { event.preventDefault(); void blockUser(blockUsername); }}>
                        <input value={blockUsername} onChange={(event) => setBlockUsername(event.target.value)} placeholder="Username to block" aria-label="Username to block" autoComplete="off" />
                        <button type="submit" disabled={!blockUsername.trim() || busyAction.startsWith('block:')}>Block</button>
                      </form>
                      <div className="discovery-list dm-block-list">
                        {blockedUsers.map((blocked) => (
                          <article className="discovery-row" key={blocked.username}>
                            <div className="discovery-row-copy"><strong>{blocked.displayName || blocked.username}</strong><span>@{blocked.username}</span></div>
                            <button type="button" disabled={busyAction === `unblock:${blocked.username}`} onClick={() => void unblockUser(blocked.username)}>Unblock</button>
                          </article>
                        ))}
                        {!blockedUsers.length && <div className="discovery-empty compact">Nobody is blocked.</div>}
                      </div>
                    </section>
                  </div>
                </details>
              </aside>

              <main className="dm-inbox-thread">
                {selectedDm ? (
                  <DirectMessageThread
                    conversation={selectedDm}
                    currentUsername={currentUsername}
                    currentUser={currentUser}
                    onBack={() => setSelectedDm(null)}
                    onRead={onMarkRead}
                  />
                ) : (
                  <div className="dm-thread-empty">
                    <strong>Your messages</strong>
                    <span>Choose a conversation or start a new one.</span>
                  </div>
                )}
              </main>
            </div>
          )}
        </div>
        {status && <div className="discovery-dms-status" role="status">{status}</div>}
    </ModalShell>
  );
}
