import { useEffect, useRef, useState } from 'react';
import { Ban, Bot, Camera, Flag, Globe2, KeyRound, Link as LinkIcon, LogOut, SlidersHorizontal, Trash2, Users, X } from 'lucide-react';
import { api, type User, type VaultMember, type VaultRole } from '../api';
import {
  getAndroidLocalCodexStatus,
  isAndroidLocalCodexAvailable,
  setAndroidLocalCodexEnabled,
  startAndroidLocalCodexLogin,
  type LocalCodexStatus,
} from '../androidLocalCodex';
import { ensureDesktopRunnerHost, stopDesktopRunnerHost } from '../desktopRunnerHost';
import { ModalShell } from './ModalShell';

type AssignableRole = Exclude<VaultRole, 'owner'>;
export type AccountSettingsSection = 'profile' | 'preferences' | 'security' | 'local-agent' | 'vault';
type PublicJoinPolicy = 'open' | 'request' | 'invite';
type PublicVaultSettings = {
  visibility: 'private' | 'public';
  summary: string;
  topics: string[];
  guidelines: string;
  homeNoteId: string | null;
  joinPolicy: PublicJoinPolicy;
};
type PublicHomeNoteChoice = { id: string; title: string };
type PublicJoinRequest = {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  status: 'pending';
  createdAt: string;
};
type VaultBan = {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  reason: string;
  createdAt: string;
};
type VaultReport = {
  id: number;
  targetType: 'vault' | 'note' | 'message' | 'member';
  targetId: string;
  targetUsername: string | null;
  reason: 'spam' | 'harassment' | 'hate' | 'illegal' | 'other';
  detail: string;
  createdAt: string;
};

const ROLE_HELP: Record<VaultRole, string> = {
  owner: 'Owns the vault. Cannot be removed or demoted here.',
  editor: 'Can read and write notes, folders, and chats.',
  viewer: 'Read-only access.',
};

export function AccountSettings({ user, vaultId, vaultName, initialSection = 'profile', showAgentMemory, onShowAgentMemoryChange, onClose, onUserChanged, onSessionChanged, onMembershipChanged, onRenameVault, onDeleteVault }: {
  user: User;
  vaultId?: string | null;
  vaultName?: string;
  initialSection?: AccountSettingsSection;
  onRenameVault?: (id: string, name: string) => Promise<boolean>;
  onDeleteVault?: (id: string) => Promise<boolean>;
  /** Whether agent memory folders are shown in the sidebar and updates feed. */
  showAgentMemory: boolean;
  onShowAgentMemoryChange: (show: boolean) => void;
  onClose: () => void;
  onUserChanged: (user: User) => void;
  onSessionChanged: () => void;
  /** Lets the app refresh the vault list so the sidebar's vault details stay accurate. */
  onMembershipChanged?: () => void;
}) {
  const [activeSection, setActiveSection] = useState<AccountSettingsSection>(initialSection);
  const [displayName, setDisplayName] = useState(user.displayName || user.username);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [profileState, setProfileState] = useState('');
  const [passwordState, setPasswordState] = useState('');
  const [busy, setBusy] = useState(false);
  const localCodexAvailable = isAndroidLocalCodexAvailable();
  const [localCodexStatus, setLocalCodexStatus] = useState<LocalCodexStatus | null>(null);
  const [localCodexOutput, setLocalCodexOutput] = useState('');
  const [localCodexBusy, setLocalCodexBusy] = useState(false);
  const localCodexLoginUrl = localCodexOutput.match(/https?:\/\/[^\s]+/)?.[0];
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!localCodexAvailable) return;
    void getAndroidLocalCodexStatus().then(setLocalCodexStatus).catch((error) => {
      setLocalCodexStatus({ supported: false, authenticated: false, error: String(error) });
    });
  }, [localCodexAvailable]);

  const authenticateLocalCodex = async () => {
    setLocalCodexBusy(true);
    setLocalCodexOutput('Starting secure device login…');
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = await startAndroidLocalCodexLogin((event) => {
        if (event.line) setLocalCodexOutput((existing) => `${existing}\n${event.line}`.trim());
        if (event.kind === 'login-completed' || event.kind === 'login-failed') {
          setLocalCodexBusy(false);
          void getAndroidLocalCodexStatus().then(setLocalCodexStatus);
          unsubscribe?.();
        }
      });
    } catch (error) {
      setLocalCodexBusy(false);
      setLocalCodexOutput(error instanceof Error ? error.message : 'Could not start Codex login.');
      unsubscribe?.();
    }
  };

  const toggleLocalCodex = async () => {
    if (!localCodexStatus) return;
    setLocalCodexBusy(true);
    try {
      const next = await setAndroidLocalCodexEnabled(!localCodexStatus.enabled);
      setLocalCodexStatus(next);
      if (next.enabled) ensureDesktopRunnerHost();
      else stopDesktopRunnerHost();
    } finally {
      setLocalCodexBusy(false);
    }
  };

  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState('');
  const [renameName, setRenameName] = useState(vaultName || '');
  const [vaultAction, setVaultAction] = useState<'rename' | 'delete' | null>(null);
  const vaultActionBusy = vaultAction !== null;
  const [vaultActionStatus, setVaultActionStatus] = useState<{ action: 'rename' | 'delete'; message: string } | null>(null);
  const [members, setMembers] = useState<VaultMember[]>([]);
  const [myRole, setMyRole] = useState<VaultRole | null>(null);
  const [memberUsername, setMemberUsername] = useState('');
  const [memberRole, setMemberRole] = useState<AssignableRole>('editor');
  const [memberState, setMemberState] = useState('');
  const [memberBusy, setMemberBusy] = useState(false);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [vaultVisibility, setVaultVisibility] = useState<'private' | 'public'>('private');
  const [publicSummary, setPublicSummary] = useState('');
  const [publicTopics, setPublicTopics] = useState('');
  const [publicGuidelines, setPublicGuidelines] = useState('');
  const [publicHomeNoteId, setPublicHomeNoteId] = useState('');
  const [publicJoinPolicy, setPublicJoinPolicy] = useState<PublicJoinPolicy>('open');
  const [publicHomeNotes, setPublicHomeNotes] = useState<PublicHomeNoteChoice[]>([]);
  const [publicJoinRequests, setPublicJoinRequests] = useState<PublicJoinRequest[]>([]);
  const [vaultBans, setVaultBans] = useState<VaultBan[]>([]);
  const [vaultReports, setVaultReports] = useState<VaultReport[]>([]);

  // Wrap a member-management mutation: flip memberBusy, clear status, and
  // surface errors uniformly. Callers keep their own pre-checks/prompts.
  const runMember = async (errMsg: string, fn: () => Promise<void>) => {
    setMemberBusy(true);
    setMemberState('');
    try {
      await fn();
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : errMsg);
    } finally {
      setMemberBusy(false);
    }
  };

  const loadMembers = async () => {
    if (!vaultId) {
      setMembers([]);
      setMyRole(null);
      setPublicHomeNotes([]);
      setPublicJoinRequests([]);
      setVaultBans([]);
      setVaultReports([]);
      return;
    }
    setMembersLoading(true);
    setMembersError('');
    try {
      const [result, visibility] = await Promise.all([
        api<{ members: VaultMember[]; role: VaultRole | null }>(`/api/vaults/${vaultId}/members`),
        api<PublicVaultSettings>(`/api/vaults/${vaultId}/visibility`),
      ]);
      setMembers(result.members || []);
      setMyRole(result.role || null);
      setVaultVisibility(visibility.visibility);
      setPublicSummary(visibility.summary || '');
      setPublicTopics((visibility.topics || []).join(', '));
      setPublicGuidelines(visibility.guidelines || '');
      setPublicHomeNoteId(visibility.homeNoteId || '');
      setPublicJoinPolicy(visibility.joinPolicy || 'open');
      if (result.role === 'owner') {
        const [homeNotes, joinRequests, bans, reports] = await Promise.all([
          api<{ notes: PublicHomeNoteChoice[] }>(`/api/vaults/${vaultId}/public-home-notes`),
          api<{ requests: PublicJoinRequest[] }>(`/api/vaults/${vaultId}/join-requests`),
          api<{ bans: VaultBan[] }>(`/api/vaults/${vaultId}/bans`),
          api<{ reports: VaultReport[] }>(`/api/vaults/${vaultId}/reports`),
        ]);
        setPublicHomeNotes(homeNotes.notes || []);
        setPublicJoinRequests(joinRequests.requests || []);
        setVaultBans(bans.bans || []);
        setVaultReports(reports.reports || []);
      } else {
        setPublicHomeNotes([]);
        setPublicJoinRequests([]);
        setVaultBans([]);
        setVaultReports([]);
      }
    } catch (error) {
      setMembersError(error instanceof Error ? error.message : 'Could not load vault settings');
    } finally {
      setMembersLoading(false);
    }
  };

  useEffect(() => {
    void loadMembers();
  }, [vaultId]);

  const canManageMembers = !membersLoading && !membersError && myRole === 'owner';
  const canManage = (member: VaultMember) => canManageMembers
    && member.role !== 'owner'
    && member.userId !== user.id;
  const assignableRoles: AssignableRole[] = ['editor', 'viewer'];
  const canLeave = !membersLoading && !membersError && Boolean(myRole) && myRole !== 'owner';

  const saveProfile = async () => {
    setBusy(true);
    setProfileState('');
    try {
      const result = await api<{ user: User }>('/api/me/profile', {
        method: 'PUT',
        body: JSON.stringify({ displayName, avatarUrl }),
      });
      onUserChanged(result.user);
      setProfileState('Profile saved');
    } catch (error) {
      setProfileState(error instanceof Error ? error.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    setPasswordState('');
    if (newPassword !== confirmPassword) {
      setPasswordState('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      localStorage.removeItem('docs_token');
      onSessionChanged();
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordState('Password changed');
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      setPasswordState(error instanceof Error ? error.message : 'Could not change password');
    } finally {
      setBusy(false);
    }
  };

  const chooseAvatar = (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      setProfileState('Choose a PNG, JPEG, WebP, or GIF image');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setProfileState('Profile picture must be smaller than 2 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatarUrl(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const inviteMember = async () => {
    if (!vaultId) return;
    const username = memberUsername.trim().replace(/^@+/, '').toLowerCase();
    if (!username) {
      setMemberState('Enter a username');
      return;
    }
    await runMember('Could not add member', async () => {
      await api(`/api/vaults/${vaultId}/members`, {
        method: 'POST',
        body: JSON.stringify({ username, role: memberRole }),
      });
      setMemberUsername('');
      setMemberState(`Added @${username} as ${memberRole}`);
      await loadMembers();
      onMembershipChanged?.();
    });
  };

  /**
   * Share link for someone whose username you don't know, or who has no
   * account yet — inviting by username needs both.
   */
  const copyInviteLink = async () => {
    if (!vaultId) return;
    await runMember('Could not create invite link', async () => {
      const { url } = await api<{ url: string }>(`/api/vaults/${vaultId}/invite-link`, {
        method: 'POST',
        body: JSON.stringify({ role: memberRole }),
      });
      try {
        await navigator.clipboard.writeText(url);
        setInviteLinkCopied(true);
        window.setTimeout(() => setInviteLinkCopied(false), 2500);
        setMemberState(`${memberRole} invite link copied — valid for 7 days`);
      } catch {
        // Clipboard is blocked in some webviews; the link is useless unseen.
        setMemberState(url);
      }
    });
  };

  const saveDiscoverySettings = async (overrides: Partial<PublicVaultSettings> = {}) => {
    if (!vaultId || !canManageMembers) return;
    const visibility = overrides.visibility ?? vaultVisibility;
    const summary = overrides.summary ?? publicSummary;
    const topics = overrides.topics ?? publicTopics.split(',').map((topic) => topic.trim()).filter(Boolean);
    const guidelines = overrides.guidelines ?? publicGuidelines;
    const homeNoteId = overrides.homeNoteId !== undefined ? overrides.homeNoteId : (publicHomeNoteId || null);
    const joinPolicy = overrides.joinPolicy ?? publicJoinPolicy;
    await runMember('Could not update vault visibility', async () => {
      const body = overrides.visibility === 'private'
        ? { visibility: 'private' as const }
        : { visibility, summary, topics, guidelines, homeNoteId, joinPolicy };
      const result = await api<PublicVaultSettings>(`/api/vaults/${vaultId}/visibility`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setVaultVisibility(result.visibility);
      setPublicSummary(result.summary);
      setPublicTopics(result.topics.join(', '));
      setPublicGuidelines(result.guidelines);
      setPublicHomeNoteId(result.homeNoteId || '');
      setPublicJoinPolicy(result.joinPolicy);
      setMemberState(result.visibility === 'public' ? 'Public discovery profile saved.' : 'Discovery profile saved; vault is private.');
      if (result.joinPolicy !== 'request') setPublicJoinRequests([]);
    });
  };

  const reviewJoinRequest = async (request: PublicJoinRequest, action: 'approve' | 'reject') => {
    if (!vaultId || !canManageMembers) return;
    await runMember('Could not review join request', async () => {
      await api(`/api/vaults/${vaultId}/join-requests/${request.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
      setPublicJoinRequests((current) => current.filter((item) => item.id !== request.id));
      setMemberState(action === 'approve' ? `Added @${request.username} as viewer` : `Declined @${request.username}'s request`);
      if (action === 'approve') {
        await loadMembers();
        onMembershipChanged?.();
      }
    });
  };

  const changeMemberRole = async (target: VaultMember, role: AssignableRole) => {
    if (!vaultId || target.role === 'owner') return;
    await runMember('Could not update role', async () => {
      await api(`/api/vaults/${vaultId}/members/${target.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      setMemberState(`@${target.username} is now ${role}`);
      await loadMembers();
      onMembershipChanged?.();
    });
  };

  const removeMember = async (target: VaultMember) => {
    if (!vaultId || target.role === 'owner') return;
    if (!window.confirm(`Remove @${target.username} from ${vaultName || 'this vault'}? They lose access to its notes and chats.`)) return;
    await runMember('Could not remove member', async () => {
      await api(`/api/vaults/${vaultId}/members/${target.userId}`, { method: 'DELETE' });
      setMemberState(`Removed @${target.username}`);
      await loadMembers();
      onMembershipChanged?.();
    });
  };

  const banMember = async (target: VaultMember) => {
    if (!vaultId || target.role === 'owner') return;
    const reason = window.prompt(
      `Remove and ban @${target.username} from ${vaultName || 'this vault'}? They will be unable to rejoin. Optional reason:`,
      '',
    );
    if (reason === null) return;
    await runMember('Could not ban member', async () => {
      await api(`/api/vaults/${vaultId}/bans`, {
        method: 'POST',
        body: JSON.stringify({ userId: target.userId, reason }),
      });
      setMemberState(`Removed and banned @${target.username}`);
      await loadMembers();
      onMembershipChanged?.();
    });
  };

  const unbanMember = async (target: VaultBan) => {
    if (!vaultId) return;
    await runMember('Could not unban member', async () => {
      await api(`/api/vaults/${vaultId}/bans/${target.userId}`, { method: 'DELETE' });
      setVaultBans((current) => current.filter((ban) => ban.userId !== target.userId));
      setMemberState(`Unbanned @${target.username}; they may rejoin normally.`);
    });
  };

  const reviewReport = async (report: VaultReport, action: 'dismiss' | 'resolve') => {
    if (!vaultId) return;
    await runMember('Could not review report', async () => {
      await api(`/api/vaults/${vaultId}/reports/${report.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
      setVaultReports((current) => current.filter((item) => item.id !== report.id));
      setMemberState(action === 'dismiss' ? 'Report dismissed.' : 'Report resolved.');
    });
  };

  const reportTargetLabel = (report: VaultReport) => (
    report.targetType === 'member' && report.targetUsername
      ? `member @${report.targetUsername}`
      : `${report.targetType} ${report.targetId}`
  );

  // Any non-owner member may remove themselves; the vault disappears from their sidebar.
  const leaveVault = async () => {
    if (!vaultId || !canLeave) return;
    if (!window.confirm(`Leave ${vaultName || 'this vault'}? You lose access until someone invites you back.`)) return;
    setMemberBusy(true);
    setMemberState('');
    try {
      await api(`/api/vaults/${vaultId}/members/${user.id}`, { method: 'DELETE' });
      onMembershipChanged?.();
      onClose();
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not leave vault');
      setMemberBusy(false);
    }
  };

  return (
    <ModalShell
      backdropClassName="overlay-backdrop account-settings-backdrop"
      dialogClassName="account-settings"
      ariaLabelledby="account-settings-title"
      onClose={onClose}
    >
        <header>
          <div>
            <span className="surface-kicker">Personal workspace</span>
            <h2 id="account-settings-title">Settings</h2>
            <p>Manage your identity, preferences, security, and vault settings.</p>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close account settings"><X size={17} /></button>
        </header>

        <nav className="account-settings-nav" aria-label="Settings sections" role="tablist">
          <button type="button" role="tab" aria-selected={activeSection === 'profile'} aria-controls="account-profile" onClick={() => setActiveSection('profile')}>
            <Camera size={15} /><span><strong>Profile</strong><small>Name and picture</small></span>
          </button>
          <button type="button" role="tab" aria-selected={activeSection === 'preferences'} aria-controls="account-preferences" onClick={() => setActiveSection('preferences')}>
            <SlidersHorizontal size={15} /><span><strong>Preferences</strong><small>Workspace behavior</small></span>
          </button>
          <button type="button" role="tab" aria-selected={activeSection === 'security'} aria-controls="account-security" onClick={() => setActiveSection('security')}>
            <KeyRound size={15} /><span><strong>Security</strong><small>Password</small></span>
          </button>
          {localCodexAvailable && <button type="button" role="tab" aria-selected={activeSection === 'local-agent'} aria-controls="account-local-agent" onClick={() => setActiveSection('local-agent')}>
            <Bot size={15} /><span><strong>Local Codex</strong><small>Run on this phone</small></span>
          </button>}
          {vaultId && <button type="button" role="tab" aria-selected={activeSection === 'vault'} aria-controls="account-vault" onClick={() => setActiveSection('vault')}>
            <Users size={15} /><span><strong>Manage vault</strong><small>{vaultName || 'Sharing'}</small></span>
          </button>}
        </nav>

        <div className="account-settings-section account-profile-section" id="account-profile" role="tabpanel" hidden={activeSection !== 'profile'}>
          <div className="account-section-heading">
            <span className="surface-kicker">Your identity</span>
            <h3>Profile</h3>
            <p>Shown to people anywhere you collaborate.</p>
          </div>
          <div className="account-avatar-preview">
            {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{(displayName || user.username).charAt(0).toUpperCase()}</span>}
          </div>
          <div className="account-avatar-actions">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => chooseAvatar(event.target.files?.[0])} />
            <button type="button" onClick={() => fileRef.current?.click()}><Camera size={14} /> Choose picture</button>
            {avatarUrl && <button type="button" onClick={() => setAvatarUrl('')}><Trash2 size={14} /> Remove</button>}
            <small>PNG, JPEG, WebP, or GIF. Maximum 2 MB.</small>
          </div>
          <label>
            Display name
            <input value={displayName} maxLength={48} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
          </label>
          <label>
            Login handle
            <input value={user.username} disabled />
            <small>Handles stay stable so mentions, invites, ownership, and history remain reliable.</small>
          </label>
          {profileState && <div className="account-settings-status" role="status">{profileState}</div>}
          <div className="account-settings-actions"><button type="button" disabled={busy || !displayName.trim()} onClick={() => void saveProfile()}>Save profile</button></div>
        </div>

        <div className="account-settings-section" id="account-preferences" role="tabpanel" hidden={activeSection !== 'preferences'}>
          <div className="account-section-title"><SlidersHorizontal size={15} /><strong>Preferences</strong></div>
          <label className="account-settings-check">
            <input
              type="checkbox"
              checked={showAgentMemory}
              onChange={(event) => onShowAgentMemoryChange(event.target.checked)}
            />
            <span>Show agent memory</span>
          </label>
          <small className="account-settings-hint">
            Reveals the folders agents keep their memory and scratchpad notes in, and includes them in the updates feed.
          </small>
        </div>

        <div className="account-settings-section" id="account-security" role="tabpanel" hidden={activeSection !== 'security'}>
          <div className="account-section-title"><KeyRound size={15} /><strong>Change password</strong></div>
          <label>Current password<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label>
          <label>New password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} /></label>
          <label>Confirm new password<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} /></label>
          {passwordState && <div className="account-settings-status" role="status">{passwordState}</div>}
          <div className="account-settings-actions"><button type="button" disabled={busy || !currentPassword || newPassword.length < 8 || !confirmPassword} onClick={() => void changePassword()}>Change password</button></div>
        </div>

        {localCodexAvailable && (
          <div className="account-settings-section" id="account-local-agent" role="tabpanel" hidden={activeSection !== 'local-agent'}>
            <div className="account-section-title"><Bot size={15} /><strong>Local Codex preview</strong></div>
            <p className="account-settings-lede">
              Codex runs inside Fizzer's private Android workspace while the app is open. The screen stays awake during a run.
            </p>
            <div className="account-settings-status" role="status">
              {!localCodexStatus
                ? 'Checking bundled runtime…'
                : localCodexStatus.error
                  ? localCodexStatus.error
                  : `${localCodexStatus.version || 'Bundled Codex'} · ${localCodexStatus.authenticated ? 'ready' : 'login required'}`}
            </div>
            {!localCodexStatus?.authenticated && (
              <div className="account-settings-actions">
                <button type="button" disabled={localCodexBusy || localCodexStatus?.supported === false} onClick={() => void authenticateLocalCodex()}>
                  {localCodexBusy ? 'Waiting for login…' : 'Connect Codex account'}
                </button>
              </div>
            )}
            {localCodexStatus?.authenticated && (
              <>
                <div className="account-settings-actions">
                  <button type="button" disabled={localCodexBusy} onClick={() => void toggleLocalCodex()}>
                  {localCodexStatus.enabled ? 'Stop using this phone' : 'Switch runner to this phone'}
                  </button>
                </div>
                <small className="account-settings-hint">
                  {localCodexStatus.enabled
                    ? 'Online. Codex agent mentions execute locally while Fizzer is open.'
                    : 'Ready but offline. Enabling replaces your desktop runner until it reconnects.'}
                </small>
              </>
            )}
            {localCodexLoginUrl && <a className="account-local-codex-login" href={localCodexLoginUrl} target="_blank" rel="noreferrer">Open secure login</a>}
            {localCodexOutput && <pre className="account-local-codex-output">{localCodexOutput}</pre>}
          </div>
        )}

        {vaultId && (
          <div className="account-settings-section" id="account-vault" role="tabpanel" hidden={activeSection !== 'vault'}>
            <div className="account-section-title"><Users size={15} /><strong>Manage vault</strong></div>
            <p className="account-settings-lede"><strong>{vaultName || 'This vault'}</strong></p>
            {membersLoading ? <p role="status">Loading vault settings…</p> : membersError ? <p role="alert">{membersError} <button type="button" onClick={() => void loadMembers()}>Retry</button></p> : (
              <p>{vaultVisibility === 'public' ? 'Public' : 'Private'} · {members.length} {members.length === 1 ? 'member' : 'members'} · {myRole || 'Role unknown'}</p>
            )}
            {canManageMembers && onRenameVault && <form onSubmit={async (event) => {
              event.preventDefault();
              if (vaultActionBusy || !renameName.trim()) return;
              setVaultActionStatus(null);
              setVaultAction('rename');
              try {
                const saved = await onRenameVault(vaultId, renameName);
                setVaultActionStatus({ action: 'rename', message: saved ? 'Vault renamed.' : 'Could not rename vault. Try again.' });
              } finally { setVaultAction(null); }
            }}>
              <label>Vault name<input value={renameName} maxLength={80} disabled={vaultActionBusy} onChange={(event) => setRenameName(event.target.value)} /></label>
              <div className="account-settings-actions"><button type="submit" disabled={vaultActionBusy || !renameName.trim()}>{vaultAction === 'rename' ? 'Saving…' : 'Rename vault'}</button></div>
              {vaultActionStatus?.action === 'rename' && <p role="status">{vaultActionStatus.message}</p>}
            </form>}
            {canManageMembers && (
              <div className="account-public-discovery">
                <div className="account-vault-visibility">
                  <Globe2 size={15} aria-hidden="true" />
                  <label>
                    <input
                      type="checkbox"
                      checked={vaultVisibility === 'public'}
                      disabled={memberBusy}
                      onChange={(event) => void saveDiscoverySettings({ visibility: event.target.checked ? 'public' : 'private' })}
                    />
                    List this vault publicly
                  </label>
                </div>
                <label>
                  Public summary
                  <textarea value={publicSummary} maxLength={240} rows={2} onChange={(event) => setPublicSummary(event.target.value)} placeholder="What is this vault for?" />
                  <small>{publicSummary.length}/240</small>
                </label>
                <label>
                  Topics
                  <input value={publicTopics} onChange={(event) => setPublicTopics(event.target.value)} placeholder="research, design systems" />
                  <small>1–5 comma-separated topics. Topics are normalized when saved.</small>
                </label>
                <label>
                  Community guidelines
                  <textarea value={publicGuidelines} maxLength={2000} rows={4} onChange={(event) => setPublicGuidelines(event.target.value)} placeholder="Set expectations before someone joins." />
                  <small>{publicGuidelines.length}/2000</small>
                </label>
                <label>
                  Curated home note preview
                  <select value={publicHomeNoteId} onChange={(event) => setPublicHomeNoteId(event.target.value)}>
                    <option value="">No home note preview</option>
                    {publicHomeNotes.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
                  </select>
                  <small>Only a sanitized preview of this listed non-chat note appears before membership.</small>
                </label>
                <label>
                  Join policy
                  <select value={publicJoinPolicy} onChange={(event) => setPublicJoinPolicy(event.target.value as PublicJoinPolicy)}>
                    <option value="open">Open — anyone can join as viewer</option>
                    <option value="request">Request — owner approval required</option>
                    <option value="invite">Invite only — no self-join</option>
                  </select>
                  <small>Public discovery never grants editor access. Promote viewers deliberately below.</small>
                </label>
                <div className="account-settings-actions">
                  <button type="button" disabled={memberBusy} onClick={() => void saveDiscoverySettings()}>Save discovery profile</button>
                </div>
              </div>
            )}
            {canManageMembers && (publicJoinPolicy === 'request' || publicJoinRequests.length > 0) && (
              <div className="account-join-requests">
                <strong>Join requests</strong>
                {publicJoinRequests.map((request) => (
                  <div key={request.id}>
                    <span>{request.displayName || request.username} <small>@{request.username}</small></span>
                    <button type="button" disabled={memberBusy} onClick={() => void reviewJoinRequest(request, 'reject')}>Decline</button>
                    <button type="button" disabled={memberBusy} onClick={() => void reviewJoinRequest(request, 'approve')}>Approve as viewer</button>
                  </div>
                ))}
                {!publicJoinRequests.length && <small className="account-settings-hint">No pending requests.</small>}
              </div>
            )}
            {canManageMembers && (
              <div className="account-moderation-queue">
                <div className="account-moderation-title"><Flag size={13} /><strong>Reports</strong><span>{vaultReports.length}</span></div>
                {vaultReports.map((report) => (
                  <article key={report.id}>
                    <div><strong>{report.reason}</strong><span>{reportTargetLabel(report)}</span></div>
                    {report.detail && <p>{report.detail}</p>}
                    <small>Reporter identity is hidden from vault owners.</small>
                    <div>
                      <button type="button" disabled={memberBusy} onClick={() => void reviewReport(report, 'dismiss')}>Dismiss</button>
                      <button type="button" disabled={memberBusy} onClick={() => void reviewReport(report, 'resolve')}>Resolve</button>
                    </div>
                  </article>
                ))}
                {!vaultReports.length && <small className="account-settings-hint">No open reports.</small>}
              </div>
            )}
            <ul className="account-vault-members">
              {members.map((member) => (
                <li key={member.userId}>
                  <div>
                    <strong>
                      {member.displayName || member.username}
                      {member.userId === user.id && <em className="account-vault-you"> (you)</em>}
                    </strong>
                    <span>@{member.username}</span>
                  </div>
                  {canManage(member) ? (
                    <div className="account-vault-member-actions">
                      <select
                        aria-label={`Role for @${member.username}`}
                        value={member.role}
                        disabled={memberBusy}
                        onChange={(event) => void changeMemberRole(member, event.target.value as AssignableRole)}
                      >
                        {assignableRoles.map((role) => (
                          <option key={role} value={role}>{role}</option>
                        ))}
                      </select>
                      <button type="button" aria-label={`Remove @${member.username}`} disabled={memberBusy} onClick={() => void removeMember(member)}>Remove</button>
                      <button type="button" aria-label={`Remove and ban @${member.username}`} className="is-danger" disabled={memberBusy} onClick={() => void banMember(member)}>
                        <Ban size={12} /> Remove &amp; ban
                      </button>
                    </div>
                  ) : (
                    <span className="account-vault-role" title={ROLE_HELP[member.role]}>{member.role}</span>
                  )}
                </li>
              ))}
            </ul>
            {canManageMembers && (
              <div className="account-banned-users">
                <strong>Banned users</strong>
                {vaultBans.map((ban) => (
                  <div key={ban.userId}>
                    <span>{ban.displayName || ban.username} <small>@{ban.username}</small>{ban.reason ? <em> · {ban.reason}</em> : null}</span>
                    <button type="button" disabled={memberBusy} onClick={() => void unbanMember(ban)}>Unban</button>
                  </div>
                ))}
                {!vaultBans.length && <small className="account-settings-hint">Nobody is banned.</small>}
              </div>
            )}
            {canManageMembers ? (
              <div className="account-vault-invite">
                <input
                  value={memberUsername}
                  aria-label="Invite by username"
                  placeholder="username"
                  onChange={(event) => setMemberUsername(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void inviteMember(); }}
                  autoComplete="off"
                />
                <select aria-label="Invite role" value={memberRole} onChange={(event) => setMemberRole(event.target.value as AssignableRole)}>
                  {assignableRoles.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
                <button type="button" disabled={memberBusy || !memberUsername.trim()} onClick={() => void inviteMember()}>
                  {memberBusy ? 'Working' : 'Invite'}
                </button>
              </div>
            ) : (
              <small className="account-settings-hint">Only the owner can invite, change, or remove members.</small>
            )}
            {canManageMembers && <small className="account-settings-hint">{ROLE_HELP[memberRole]}</small>}
            {canManageMembers && (
              <div className="account-settings-actions">
                <button type="button" disabled={memberBusy} onClick={() => void copyInviteLink()}>
                  <LinkIcon size={13} /> {inviteLinkCopied ? 'Link copied' : `Copy ${memberRole} invite link`}
                </button>
              </div>
            )}
            {canManageMembers && onDeleteVault && <div className="account-settings-actions">
              <button type="button" disabled={vaultActionBusy || memberBusy} onClick={async () => {
                if (vaultActionBusy || !window.confirm(`Permanently delete “${vaultName}” and all its notes and chats? This cannot be undone. If this is your last vault, you can create or join another.`)) return;
                setVaultActionStatus(null);
                setVaultAction('delete');
                try {
                  if (await onDeleteVault(vaultId)) onClose();
                  else setVaultActionStatus({ action: 'delete', message: 'Could not delete vault. Try again.' });
                } finally { setVaultAction(null); }
              }}>{vaultAction === 'delete' ? 'Working…' : 'Delete vault permanently'}</button>
              {vaultActionStatus?.action === 'delete' && <p role="alert">{vaultActionStatus.message}</p>}
            </div>}
            {canLeave && (
              <div className="account-settings-actions">
                <button type="button" className="account-vault-leave" disabled={memberBusy} onClick={() => void leaveVault()}>
                  <LogOut size={13} /> Leave vault
                </button>
              </div>
            )}
            {memberState && <div className="account-settings-status" role="status">{memberState}</div>}
          </div>
        )}
    </ModalShell>
  );
}
