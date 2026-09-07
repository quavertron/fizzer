import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { formatChatTime } from '../chat/time';
import { createChatAgentRegistrationId } from '../chat/shared';
import {
  fallbackAgentModelCatalog,
  isCatalogAgentId,
  loadAgentModels,
  vaultAgentMembershipPayload,
  type AgentModelCatalog,
  type CatalogAgentId,
} from '../chat/agents';
import { normalizeMention } from '../chat/mentions';
import type {
  ChatAgentOption,
  ChatAgentRegistration,
  ChatMessage,
  DesktopRunnerHealth,
  PlanUsage,
  PlanUsageWindow,
  VaultAgent,
} from '../chat/types';
import { ChatAgentToggle } from './ChatAgentToggle';
import { ChatAvatar } from './ChatAvatar';

const CUSTOM_MODEL_VALUE = '__custom__';

function resolveModelPicker(
  agent: ChatAgentOption | undefined,
  model: string,
): { choice: string; custom: string } {
  const trimmed = model.trim();
  if (!agent || agent.models.length === 0) {
    return { choice: CUSTOM_MODEL_VALUE, custom: trimmed };
  }
  if (!trimmed) return { choice: agent.models[0]?.id ?? '', custom: '' };
  if (agent.models.some((preset) => preset.id === trimmed)) {
    return { choice: trimmed, custom: '' };
  }
  return { choice: CUSTOM_MODEL_VALUE, custom: trimmed };
}

function modelFromPicker(choice: string, custom: string) {
  return (choice === CUSTOM_MODEL_VALUE ? custom : choice).trim();
}

export const REASONING_EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
  { id: 'ultra', label: 'Ultra' },
] as const;

export function ReasoningEffortSelect({
  agentId,
  value,
  onChange,
}: {
  agentId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const defaultLabel = agentId === 'claude-code' ? 'Use Claude Code default' : 'Use Codex CLI default';
  const efforts = agentId === 'claude-code'
    ? REASONING_EFFORTS.filter((effort) => effort.id !== 'ultra')
    : REASONING_EFFORTS;
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{defaultLabel}</option>
      {efforts.map((effort) => (
        <option key={effort.id} value={effort.id}>{effort.label}</option>
      ))}
    </select>
  );
}

export function planUsageProviderId(agentId: string) {
  if (agentId === 'akron-grok') return 'grok';
  if (agentId === 'hermes') return 'nous';
  return agentId;
}

function planUsageWindows(usage?: PlanUsage | null): PlanUsageWindow[] {
  if (!usage || usage.status !== 'ok') return [];
  if (usage.windows?.length) return usage.windows;
  if (typeof usage.usedPercent !== 'number') return [];
  return [{
    label: usage.windowMinutes ? `${Math.round(usage.windowMinutes / 60)}h` : 'usage',
    usedPercent: usage.usedPercent,
    ...(usage.windowMinutes ? { windowMinutes: usage.windowMinutes } : {}),
    ...(usage.resetsAt ? { resetsAt: usage.resetsAt } : {}),
    ...(usage.resetsLabel ? { resetsLabel: usage.resetsLabel } : {}),
  }];
}

function formatPlanUsageTitle(usage?: PlanUsage | null) {
  if (!usage) return '';
  if (usage.status !== 'ok') return usage.detail || 'Plan usage unavailable';
  const lines = planUsageWindows(usage).map((window) => {
    let reset = window.resetsLabel || '';
    if (!reset && window.resetsAt) {
      reset = formatChatTime(window.resetsAt);
    }
    return `${window.label}: ${Math.round(window.usedPercent)}% used${reset ? ` · ${reset}` : ''}`;
  });
  if (usage.planType) lines.push(`Plan: ${usage.planType}`);
  if (usage.detail) lines.push(usage.detail);
  return lines.join('\n');
}

export function PlanUsageMeters({
  usage,
  stacked = false,
  decal = false,
}: {
  usage: PlanUsage;
  stacked?: boolean;
  /** Compact right-rail chips — no row growth. */
  decal?: boolean;
}) {
  const title = formatPlanUsageTitle(usage);
  if (usage.status !== 'ok') {
    if (decal) return null;
    return <span className="chat-plan-meters is-unavailable" title={title}>usage unavailable</span>;
  }
  const windows = planUsageWindows(usage).slice(0, 3);
  if (windows.length === 0) return null;
  return (
    <span
      className={`chat-plan-meters${stacked ? ' is-stacked' : ''}${decal ? ' is-decal' : ''}`}
      title={title}
    >
      {windows.map((window, index) => {
        const percent = Math.round(window.usedPercent);
        return (
          <span
            className="chat-plan-meter"
            key={`${window.label}:${index}`}
            role="progressbar"
            aria-label={`${window.label} plan usage ${percent}%`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="chat-plan-meter-label">{decal ? `${percent}%` : window.label}</span>
            <span className="chat-plan-meter-track" aria-hidden="true">
              <span className="chat-plan-meter-fill" style={{ width: `${percent}%` }} />
            </span>
            {!decal && <span className="chat-plan-meter-value">{percent}%</span>}
          </span>
        );
      })}
      {!decal && usage.detail && (() => {
        const topUpMatch = usage.detail.match(/Top-up credits:\s*\$?([\d.]+)/i);
        const totalMatch = usage.detail.match(/Total usable:\s*\$?([\d.]+)/i);
        if (!topUpMatch && !totalMatch) return null;
        const label = topUpMatch ? `top-up $${topUpMatch[1]}` : `usable $${totalMatch![1]}`;
        return <span className="chat-plan-meter-detail">{label}</span>;
      })()}
    </span>
  );
}


export type ChatAgentPanelHandle = {
  openMenu: () => void;
  toggleInvite: () => void;
  openMemberSettings: (registration: ChatAgentRegistration) => void;
  closeChrome: () => void;
};

export type ChatAgentRow = ChatAgentOption & { registration: ChatAgentRegistration };

export type ChatAgentOwnership = 'current-user' | 'other-user' | 'unknown';
export type ChatAgentOwnershipResolver = (
  registration?: ChatAgentRegistration,
  vaultAgent?: VaultAgent,
) => ChatAgentOwnership;
export type ChatMessageOwnershipResolver = (message: ChatMessage) => ChatAgentOwnership;

export function ownershipClass(ownership: ChatAgentOwnership) {
  return `is-owner-${ownership}`;
}


export const ChatAgentPanel = forwardRef<ChatAgentPanelHandle, {
  channelId: string;
  currentUser: string;
  availableAgents: ChatAgentOption[];
  registeredAgents: ChatAgentRegistration[];
  registeredAgentRows: ChatAgentRow[];
  myAgents: VaultAgent[];
  vaultAgents: VaultAgent[];
  resolveAgentOwnership: ChatAgentOwnershipResolver;
  runnerHealth?: DesktopRunnerHealth | null;
  onRegisterAgent: (channelId: string, registration: ChatAgentRegistration) => void;
  onRemoveAgent: (channelId: string, registrationId: string) => void;
  onUpsertVaultAgent?: (agent: Partial<VaultAgent> & { agentId: string }) => Promise<VaultAgent | void> | VaultAgent | void;
  onDeleteVaultAgent?: (vaultAgentId: string) => Promise<void> | void;
  onDeleteAgentProfile?: (vaultAgentId: string) => Promise<void> | void;
  onAddVaultAgentToChannel?: (
    channelId: string,
    vaultAgentId: string,
    membership?: ChatAgentRegistration,
  ) => Promise<void> | void;
  onImportMyAgentToChannel?: (channelId: string, sourceAgentId: string) => Promise<void> | void;
  onInviteUser: (channelId: string, username: string) => Promise<void>;
  canManageRegistration: (registration: ChatAgentRegistration) => boolean;
  onExpandRail: () => void;
  onChromeChange: (chrome: { inviteOpen: boolean; agentMenuOpen: boolean }) => void;
  children?: ReactNode;
}>(function ChatAgentPanel({
  channelId,
  currentUser,
  availableAgents,
  registeredAgents,
  registeredAgentRows,
  vaultAgents,
  resolveAgentOwnership,
  myAgents,
  runnerHealth = null,
  onRegisterAgent,
  onRemoveAgent,
  onUpsertVaultAgent,
  onDeleteVaultAgent,
  onDeleteAgentProfile,
  onAddVaultAgentToChannel,
  onImportMyAgentToChannel,
  onInviteUser,
  canManageRegistration,
  onExpandRail,
  onChromeChange,
  children,
}, ref) {
  const [agentPanelMode, setAgentPanelMode] = useState<'picker' | 'create' | 'edit-member' | 'edit-identity'>('picker');
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteStatus, setInviteStatus] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [editingRegistrationId, setEditingRegistrationId] = useState<string | null>(null);
  const [agentFormError, setAgentFormError] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [identityScope, setIdentityScope] = useState<VaultAgent['identityScope']>('vault');
  const [sessionLeaseMinutes, setSessionLeaseMinutes] = useState(60);
  const createDefaultAgentForm = useCallback((): ChatAgentRegistration => {
    return {
      id: createChatAgentRegistrationId(),
      agentId: '',
      displayName: '',
      avatarUrl: '',
      mention: '',
      model: '',
      reasoningEffort: '',
      priorityServiceTier: false,
      cwd: '',
      contextPrompt: '',
      taggableByAgents: false,
      replyToEveryMessage: false,
      ambientGroupChat: false,
      finalReplyOnly: false,
      orchestrator: false,
      nextStepSuggestions: false,
      pingableByOthers: false,
      yolo: false,
      hermesProfile: '',
      hermesSafeMode: false,
      conversationId: '',
    };
  }, []);
  const [agentForm, setAgentForm] = useState<ChatAgentRegistration>(() => ({
    id: createChatAgentRegistrationId(),
    agentId: '',
    displayName: '',
    avatarUrl: '',
    mention: '',
    model: '',
    reasoningEffort: '',
    priorityServiceTier: false,
    cwd: '',
    contextPrompt: '',
    taggableByAgents: false,
    replyToEveryMessage: false,
    ambientGroupChat: false,
    finalReplyOnly: false,
    orchestrator: false,
    nextStepSuggestions: false,
    pingableByOthers: false,
    yolo: false,
    hermesProfile: '',
    hermesSafeMode: false,
    conversationId: '',
  }));
  const [modelCatalogs, setModelCatalogs] = useState<Record<CatalogAgentId, AgentModelCatalog>>(() => ({
    'claude-code': fallbackAgentModelCatalog('claude-code'),
    codex: fallbackAgentModelCatalog('codex'),
    grok: fallbackAgentModelCatalog('grok'),
    antigravity: fallbackAgentModelCatalog('antigravity'),
  }));
  const effectiveAvailableAgents = useMemo(
    () => availableAgents.map((agent) => {
      if (!isCatalogAgentId(agent.id)) return agent;
      return { ...agent, models: modelCatalogs[agent.id].models };
    }),
    [availableAgents, modelCatalogs],
  );
  const activeFormAgent = effectiveAvailableAgents.find((agent) => agent.id === agentForm.agentId);
  const activeModelCatalog = isCatalogAgentId(agentForm.agentId)
    ? modelCatalogs[agentForm.agentId]
    : undefined;
  const refreshModelCatalog = useCallback(async (agentId: string) => {
    if (!isCatalogAgentId(agentId)) return;
    const catalog = await loadAgentModels(agentId);
    setModelCatalogs((previous) => ({ ...previous, [agentId]: catalog }));
  }, []);
  const channelVaultAgentIds = useMemo(
    () => new Set(registeredAgents.map((r) => r.vaultAgentId).filter(Boolean) as string[]),
    [registeredAgents],
  );
  const vaultAgentById = useMemo(
    () => new Map(vaultAgents.map((agent) => [agent.id, agent])),
    [vaultAgents],
  );

  useEffect(() => {
    onChromeChange({ inviteOpen, agentMenuOpen });
  }, [agentMenuOpen, inviteOpen, onChromeChange]);

  useEffect(() => {
    if (!agentMenuOpen) return;
    const close = () => {
      setAgentMenuOpen(false);
      setEditingRegistrationId(null);
      setAgentFormError('');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [agentMenuOpen]);
  useEffect(() => {
    if (!agentMenuOpen || !isCatalogAgentId(agentForm.agentId)) return;
    void refreshModelCatalog(agentForm.agentId);
  }, [agentForm.agentId, agentMenuOpen, refreshModelCatalog]);

  useEffect(() => {
    if (!agentMenuOpen || !agentForm.agentId || !activeFormAgent || modelChoice === CUSTOM_MODEL_VALUE) return;
    const currentModel = agentForm.model.trim();
    if (currentModel && activeFormAgent.models.some((model) => model.id === currentModel)) return;
    const firstModel = activeFormAgent.models[0]?.id;
    if (!firstModel) {
      setModelChoice(CUSTOM_MODEL_VALUE);
      setCustomModel(currentModel);
      return;
    }
    if (modelChoice === firstModel && agentForm.model === firstModel) return;
    setModelChoice(firstModel);
    setCustomModel('');
    setAgentForm((value) => value.model === firstModel ? value : { ...value, model: firstModel });
  }, [activeFormAgent, agentForm.agentId, agentForm.model, agentMenuOpen, modelChoice]);

  function openAgentEditor(registration?: ChatAgentRegistration) {
    setAgentFormError('');
    if (registration) {
      const agent = effectiveAvailableAgents.find((option) => option.id === registration.agentId);
      const { choice, custom } = resolveModelPicker(agent, registration.model);
      setModelChoice(choice);
      setCustomModel(custom);
      setAgentForm({ ...registration, model: modelFromPicker(choice, custom) });
      setEditingRegistrationId(registration.id);
    } else {
      setIdentityScope('vault');
      setSessionLeaseMinutes(60);
      const form = createDefaultAgentForm();
      const agent = effectiveAvailableAgents.find((option) => option.id === form.agentId);
      const { choice, custom } = resolveModelPicker(agent, form.model);
      setModelChoice(choice);
      setCustomModel(custom);
      setAgentForm(form);
      setEditingRegistrationId(null);
    }
    setAgentMenuOpen(true);
  }

  function openAgentMenu() {
    onExpandRail();
    if (agentMenuOpen) {
      setAgentMenuOpen(false);
      setEditingRegistrationId(null);
      setAgentFormError('');
      setAgentPanelMode('picker');
      return;
    }
    setAgentPanelMode(vaultAgents.length > 0 || onAddVaultAgentToChannel ? 'picker' : 'create');
    openAgentEditor();
  }

  function toggleInvite() {
    onExpandRail();
    setInviteStatus('');
    setInviteOpen((value) => !value);
  }

  function editRegisteredAgent(event: React.MouseEvent, registration: ChatAgentRegistration) {
    event.stopPropagation();
    onExpandRail();
    setAgentPanelMode('edit-member');
    openAgentEditor(registration);
  }

  function openMemberSettings(registration: ChatAgentRegistration) {
    onExpandRail();
    setAgentFormError('');
    const agent = effectiveAvailableAgents.find((option) => option.id === registration.agentId);
    const { choice, custom } = resolveModelPicker(agent, registration.model);
    setModelChoice(choice);
    setCustomModel(custom);
    setAgentForm({ ...registration, model: modelFromPicker(choice, custom) });
    setEditingRegistrationId(registration.id);
    setAgentPanelMode('edit-member');
    setAgentMenuOpen(true);
  }

  function editVaultIdentity(event: React.MouseEvent, registration: ChatAgentRegistration) {
    event.stopPropagation();
    const identity = vaultAgents.find((agent) => agent.id === registration.vaultAgentId);
    setIdentityScope(identity?.identityScope === 'session' ? 'session' : 'vault');
    if (identity?.expiresAt) {
      const remaining = (Date.parse(identity.expiresAt) - Date.now()) / 60_000;
      setSessionLeaseMinutes(remaining > 1440 ? 10080 : remaining > 60 ? 1440 : 60);
    }
    setAgentPanelMode('edit-identity');
    openAgentEditor(registration);
  }

  function openVaultIdentity(event: React.MouseEvent, identity: VaultAgent) {
    event.stopPropagation();
    const member = registeredAgents.find((registration) => registration.vaultAgentId === identity.id);
    const registration: ChatAgentRegistration = {
      ...(member || createDefaultAgentForm()),
      vaultAgentId: identity.id,
      agentId: identity.agentId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      mention: identity.mention,
      model: identity.model,
      cwd: identity.cwd,
      contextPrompt: identity.contextPrompt,
      hermesProfile: identity.hermesProfile || '',
      hermesSafeMode: identity.hermesSafeMode === true,
    };
    setIdentityScope(identity.identityScope === 'session' ? 'session' : 'vault');
    if (identity.expiresAt) {
      const remaining = (Date.parse(identity.expiresAt) - Date.now()) / 60_000;
      setSessionLeaseMinutes(remaining > 1440 ? 10080 : remaining > 60 ? 1440 : 60);
    }
    setAgentPanelMode('edit-identity');
    openAgentEditor(registration);
  }

  function closeChrome() {
    setAgentMenuOpen(false);
    setInviteOpen(false);
    setEditingRegistrationId(null);
    setAgentPanelMode('picker');
    setAgentFormError('');
  }

  useImperativeHandle(ref, () => ({
    openMenu: openAgentMenu,
    toggleInvite,
    openMemberSettings,
    closeChrome,
  }), [agentMenuOpen, effectiveAvailableAgents, createDefaultAgentForm, onAddVaultAgentToChannel, onExpandRail, vaultAgents.length]);

  async function addVaultAgentFromPicker(vaultAgentId: string) {
    setAgentFormError('');
    try {
      if (onAddVaultAgentToChannel) {
        await onAddVaultAgentToChannel(channelId, vaultAgentId);
      } else {
        const va = vaultAgents.find((a) => a.id === vaultAgentId);
        if (!va) return;
        onRegisterAgent(channelId, {
          id: createChatAgentRegistrationId(),
          vaultAgentId: va.id,
          agentId: va.agentId,
          displayName: va.displayName,
          avatarUrl: va.avatarUrl,
          mention: va.mention,
          model: va.model,
          reasoningEffort: '',
          priorityServiceTier: false,
          cwd: va.cwd,
          contextPrompt: va.contextPrompt,
          taggableByAgents: false,
          replyToEveryMessage: false,
          ambientGroupChat: false,
          finalReplyOnly: false,
          orchestrator: false,
          nextStepSuggestions: false,
          pingableByOthers: false,
          yolo: false,
          hermesProfile: va.hermesProfile || '',
          hermesSafeMode: va.hermesSafeMode === true,
          conversationId: '',
        });
      }
      setAgentMenuOpen(false);
      setAgentPanelMode('picker');
    } catch (error) {
      setAgentFormError(error instanceof Error ? error.message : 'Could not add agent');
    }
  }

  async function importMyAgentFromPicker(sourceAgentId: string) {
    if (!onImportMyAgentToChannel) return;
    setAgentFormError('');
    try {
      await onImportMyAgentToChannel(channelId, sourceAgentId);
      setAgentMenuOpen(false);
      setAgentPanelMode('picker');
    } catch (error) {
      setAgentFormError(error instanceof Error ? error.message : 'Could not add agent');
    }
  }

  async function submitAgentRegistration(event: React.FormEvent) {
    event.preventDefault();
    if (!agentForm.agentId) return;
    const mention = normalizeMention(agentForm.mention || '');
    if (!mention) {
      setAgentFormError('Choose a local @ alias.');
      return;
    }
    if (agentPanelMode !== 'edit-member' && mention) {
      const vaultClash = vaultAgents.some((va) =>
        va.id !== agentForm.vaultAgentId
        && normalizeMention(va.mention) === mention,
      );
      if (vaultClash) {
        setAgentFormError(`@${mention} is already used in this vault.`);
        return;
      }
    }
    const model = modelFromPicker(modelChoice, customModel);
    if (!model && agentPanelMode !== 'edit-member') {
      setAgentFormError('Choose a model or enter a custom model ID.');
      return;
    }

    const persistMembership = (overrides: Partial<ChatAgentRegistration> = {}) => {
      onRegisterAgent(channelId, {
        ...agentForm,
        ...overrides,
        id: agentForm.id || createChatAgentRegistrationId(),
        displayName: agentForm.displayName.trim(),
        mention: overrides.mention ?? mention,
        model: overrides.model ?? model,
        cwd: agentForm.cwd.trim(),
        contextPrompt: agentForm.contextPrompt.trim(),
      });
    };

    try {
      if (agentPanelMode === 'edit-identity' && onUpsertVaultAgent && agentForm.vaultAgentId) {
        await onUpsertVaultAgent({
          id: agentForm.vaultAgentId,
          agentId: agentForm.agentId,
          displayName: agentForm.displayName.trim(),
          mention,
          model,
          cwd: agentForm.cwd.trim(),
          contextPrompt: agentForm.contextPrompt.trim(),
          hermesProfile: agentForm.hermesProfile.trim(),
          hermesSafeMode: agentForm.hermesSafeMode,
          identityScope,
          expiresAt: identityScope === 'session'
            ? new Date(Date.now() + sessionLeaseMinutes * 60_000).toISOString()
            : null,
        });
        if (registeredAgents.some((registration) => registration.id === agentForm.id)) {
          persistMembership();
        }
      } else if (agentPanelMode === 'create' && onUpsertVaultAgent) {
        const va = await onUpsertVaultAgent({
          agentId: agentForm.agentId,
          displayName: agentForm.displayName.trim() || agentForm.agentId,
          mention,
          model,
          cwd: agentForm.cwd.trim(),
          contextPrompt: agentForm.contextPrompt.trim(),
          hermesProfile: agentForm.hermesProfile.trim(),
          hermesSafeMode: agentForm.hermesSafeMode,
          identityScope,
          expiresAt: identityScope === 'session'
            ? new Date(Date.now() + sessionLeaseMinutes * 60_000).toISOString()
            : null,
        });
        const vaultAgentId = va?.id || agentForm.vaultAgentId || '';
        if (vaultAgentId && onAddVaultAgentToChannel) {
          await onAddVaultAgentToChannel(
            channelId,
            vaultAgentId,
            vaultAgentMembershipPayload(vaultAgentId, {
              ...agentForm,
              displayName: agentForm.displayName.trim(),
              mention,
              model,
              cwd: agentForm.cwd.trim(),
              contextPrompt: agentForm.contextPrompt.trim(),
            }) as ChatAgentRegistration,
          );
        }
      } else {
        if (agentForm.vaultAgentId && onUpsertVaultAgent) {
          await onUpsertVaultAgent({
            id: agentForm.vaultAgentId,
            agentId: agentForm.agentId,
            displayName: agentForm.displayName.trim(),
            mention: mention || agentForm.mention,
            model,
            cwd: agentForm.cwd.trim(),
            contextPrompt: agentForm.contextPrompt.trim(),
            hermesProfile: agentForm.hermesProfile.trim(),
            hermesSafeMode: agentForm.hermesSafeMode,
            identityScope,
            expiresAt: identityScope === 'session'
              ? new Date(Date.now() + sessionLeaseMinutes * 60_000).toISOString()
              : null,
          });
        }
        persistMembership({
          mention: mention || agentForm.mention,
          model: model || agentForm.model,
        });
      }
      setAgentMenuOpen(false);
      setEditingRegistrationId(null);
      setAgentPanelMode('picker');
      setAgentFormError('');
    } catch (error) {
      setAgentFormError(error instanceof Error ? error.message : 'Could not save agent');
    }
  }

  async function submitInvite(event: React.FormEvent) {
    event.preventDefault();
    const username = inviteUsername.trim().replace(/^@+/, '').toLowerCase();
    if (!username) {
      setInviteStatus('Enter a username.');
      return;
    }
    setInviteBusy(true);
    setInviteStatus('');
    try {
      await onInviteUser(channelId, username);
      setInviteUsername('');
      setInviteStatus(`Added @${username} to the vault.`);
    } catch (error) {
      setInviteStatus(error instanceof Error ? error.message : 'Could not invite user');
    } finally {
      setInviteBusy(false);
    }
  }

  return (
    <>
        {inviteOpen && (
          <form className="chat-invite-menu" onSubmit={submitInvite} onClick={(event) => event.stopPropagation()}>
            <label>
              Username
              <input
                value={inviteUsername}
                placeholder="username"
                autoFocus
                spellCheck={false}
                onChange={(event) => {
                  setInviteStatus('');
                  setInviteUsername(event.target.value.replace(/^@+/, ''));
                }}
              />
            </label>
            {inviteStatus && <div className="chat-invite-status">{inviteStatus}</div>}
            <div className="chat-agent-menu-actions">
              <button type="button" onClick={() => setInviteOpen(false)}>Cancel</button>
              <button type="submit" disabled={inviteBusy}>{inviteBusy ? 'Inviting' : 'Invite'}</button>
            </div>
          </form>
        )}

        {children}

        <div className="chat-agent-section">
          <div className="chat-users-title">Agents in this vault</div>
          {registeredAgentRows.length === 0 && (
            <div className="chat-runs-empty">No agents in this vault yet</div>
          )}
          {registeredAgentRows.map((agent) => {
          const selectedModel = agent.registration.model || agent.models[0]?.id || '';
          const isEditing = editingRegistrationId === agent.registration.id && agentMenuOpen;
          const canManage = canManageRegistration(agent.registration);
          const planUsage = canManage
            ? runnerHealth?.planUsage?.[planUsageProviderId(agent.registration.agentId)] || null
            : null;
          const ownership = resolveAgentOwnership(
            agent.registration,
            agent.registration.vaultAgentId ? vaultAgentById.get(agent.registration.vaultAgentId) : undefined,
          );
          return (
            <div
              className={`chat-user chat-agent-user ${ownershipClass(ownership)}${agent.registration.orchestrator ? ' is-supervisor' : ''}${isEditing ? ' is-editing' : ''}`}
              key={agent.registration.id}
            >
              <button
                type="button"
                className="chat-agent-edit-btn"
                disabled={!canManage}
                onClick={canManage ? (event) => editRegisteredAgent(event, agent.registration) : undefined}
                title={canManage ? 'Channel settings for this agent' : 'Only the agent owner can edit its settings'}
              >
                <ChatAvatar name={agent.registration.displayName || agent.label} kind="agent" avatarUrl={agent.registration.avatarUrl} size="sm" />
                {/* Supervisor reads as a hairline ring on the avatar (see .is-supervisor);
                    the rank still needs a name for screen readers. */}
                {agent.registration.orchestrator && <span className="sr-only">Channel supervisor</span>}
                <div className="chat-user-copy">
                  <div className="chat-user-copy-head">
                    <strong>{agent.registration.displayName || agent.label}</strong>
                    {planUsage && <PlanUsageMeters usage={planUsage} decal />}
                  </div>
                  <span className="chat-user-handle">@{agent.registration.mention || agent.id}</span>
                  <span className="chat-user-role">{selectedModel || 'no model'}</span>
                </div>
              </button>
              {canManage && <button
                type="button"
                className="chat-remove-agent"
                onClick={(event) => {
                  event.stopPropagation();
                  if (agent.registration.vaultAgentId && onDeleteVaultAgent) void onDeleteVaultAgent(agent.registration.vaultAgentId);
                  else onRemoveAgent(channelId, agent.registration.id);
                }}
                title="Remove agent from this vault"
              >
                <X size={12} />
              </button>}
            </div>
          );
          })}

          {agentMenuOpen && agentPanelMode === 'picker' && (
          <div className="chat-agent-menu" onClick={(event) => event.stopPropagation()}>
            <div className="chat-agent-menu-heading">Current vault agents</div>
            {vaultAgents.length === 0 ? (
              <div className="chat-runs-empty">No vault agents yet</div>
            ) : (
              <div className="chat-agent-picker-list">
                {vaultAgents.map((va) => {
                  const inChannel = channelVaultAgentIds.has(va.id);
                  const canManage = va.ownerUsername === currentUser;
                  const ownership = resolveAgentOwnership(undefined, va);
                  return (
                    <div key={va.id} className={`chat-vault-pick-row ${ownershipClass(ownership)}${inChannel ? ' is-in-channel' : ''}`}>
                      <button
                        type="button"
                        className="chat-vault-pick-btn"
                        disabled={inChannel || !canManage}
                        onClick={() => {
                          if (!inChannel) void addVaultAgentFromPicker(va.id);
                        }}
                        title={inChannel ? 'Already in this channel' : canManage ? 'Add to this channel' : 'Only the agent owner can add it'}
                      >
                        <ChatAvatar name={va.displayName || va.mention} kind="agent" avatarUrl={va.avatarUrl} size="sm" />
                        <span className="chat-user-copy">
                          <strong>{va.displayName || va.mention}</strong>
                          <span>
                            @{va.mention} · {va.model || va.agentId} · {va.identityScope === 'session'
                              ? 'temporary agent'
                              : 'vault agent'}
                            {va.identityScope === 'network' && va.ownerUsername
                              ? ` · legacy identity ${va.mention}~${va.ownerUsername}`
                              : ''}
                            {va.ownerUsername ? ` · ${va.ownerUsername}'s agent` : ''}
                            {inChannel ? ' · in this channel' : ''}
                          </span>
                        </span>
                      </button>
                      {canManage && (
                        <button
                          type="button"
                          className="chat-vault-edit-agent"
                          title={`Edit @${va.mention} vault identity`}
                          onClick={(event) => openVaultIdentity(event, va)}
                        >
                          Edit identity
                        </button>
                      )}
                      {onDeleteAgentProfile && canManage && (
                        <button
                          type="button"
                          className="chat-remove-agent"
                          title="Permanently delete agent profile"
                          onClick={(event) => {
                            event.stopPropagation();
                            if (window.confirm(`Permanently delete @${va.mention} from your agent profiles and every vault?`)) {
                              void onDeleteAgentProfile(va.id);
                            }
                          }}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="chat-agent-menu-heading">My Agents</div>
            {myAgents.length === 0 ? (
              <div className="chat-runs-empty">No owned agents from other vaults</div>
            ) : (
              <div className="chat-agent-picker-list">
                {myAgents.map((agent) => {
                  const ownership = resolveAgentOwnership(undefined, agent);
                  return (
                    <div key={agent.id} className={`chat-vault-pick-row ${ownershipClass(ownership)}`}>
                      <button
                        type="button"
                        className="chat-vault-pick-btn"
                        disabled={!onImportMyAgentToChannel}
                        onClick={() => void importMyAgentFromPicker(agent.id)}
                        title="Copy this safe agent identity into the current vault"
                      >
                        <ChatAvatar name={agent.displayName || agent.mention} kind="agent" avatarUrl={agent.avatarUrl} size="sm" />
                        <span className="chat-user-copy">
                          <strong>{agent.displayName || agent.mention}</strong>
                          <span>@{agent.mention} · {agent.model || agent.agentId} · from another vault</span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {agentFormError && <div className="chat-agent-form-error">{agentFormError}</div>}
            <div className="chat-agent-menu-actions">
              <button
                type="button"
                onClick={() => {
                  setAgentMenuOpen(false);
                  setAgentPanelMode('picker');
                  setAgentFormError('');
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setAgentPanelMode('create');
                  openAgentEditor();
                }}
              >
                Create new…
              </button>
            </div>
          </div>
          )}

          {agentMenuOpen && agentPanelMode !== 'picker' && (
          <form
            className="chat-agent-menu chat-agent-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-agent-editor-title"
            onSubmit={(e) => void submitAgentRegistration(e)}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="chat-agent-menu-heading chat-agent-editor-heading">
              <strong id="chat-agent-editor-title">
                {agentPanelMode === 'edit-member' && 'Channel membership'}
                {agentPanelMode === 'edit-identity' && 'Agent identity'}
                {agentPanelMode === 'create' && 'Add agent to this vault'}
              </strong>
              <span>
                {agentPanelMode === 'edit-member' && 'Run behavior for this conversation.'}
                {agentPanelMode === 'edit-identity' && 'Name, @handle, and runtime defaults for this vault.'}
                {agentPanelMode === 'create' && 'Choose an unused @handle and a runnable backend.'}
              </span>
              <button
                type="button"
                className="chat-agent-editor-close"
                aria-label="Close agent editor"
                onClick={() => {
                  setAgentMenuOpen(false);
                  setEditingRegistrationId(null);
                  setAgentPanelMode('picker');
                  setAgentFormError('');
                }}
              >
                <X size={18} />
              </button>
            </div>
            {agentPanelMode !== 'edit-member' && (
              <>
            <label>
              Backend
              <select
                value={agentForm.agentId}
                onChange={(event) => {
                  const agent = effectiveAvailableAgents.find((option) => option.id === event.target.value);
                  setAgentFormError('');
                  const nextPreset = agent?.models[0]?.id ?? '';
                  const { choice, custom } = resolveModelPicker(agent, nextPreset);
                  setModelChoice(choice);
                  setCustomModel(custom);
                  setAgentForm((value) => ({
                    ...value,
                    agentId: event.target.value,
                    displayName: value.displayName || agent?.label || event.target.value,
                    model: modelFromPicker(choice, custom),
                  }));
                }}
              >
                <option value="" disabled>Choose a backend…</option>
                {effectiveAvailableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.label}</option>
                ))}
              </select>
            </label>
            <label>
              Display name
              <input
                value={agentForm.displayName}
                placeholder={activeFormAgent?.label || 'Agent'}
                onChange={(event) => setAgentForm((value) => ({ ...value, displayName: event.target.value }))}
              />
            </label>
            <label>
              @ handle in this vault
              <input
                value={agentForm.mention}
                placeholder="grok"
                spellCheck={false}
                onChange={(event) => setAgentForm((value) => ({ ...value, mention: event.target.value.replace(/^@+/, '') }))}
              />
              <span className="chat-agent-field-hint">Unique in this vault. Mention it in any channel to run this agent.</span>
            </label>
            {agentPanelMode === 'edit-identity' && (
            <label>
              Lifetime
              <select
                value={identityScope}
                onChange={(event) => setIdentityScope(event.target.value as VaultAgent['identityScope'])}
              >
                <option value="vault">Keep in this vault</option>
                <option value="session">Temporary — expires automatically</option>
              </select>
            </label>
            )}
            {identityScope === 'session' && (
              <label>
                Lease
                <select
                  value={sessionLeaseMinutes}
                  onChange={(event) => setSessionLeaseMinutes(Number(event.target.value))}
                >
                  <option value={60}>1 hour</option>
                  <option value={1440}>24 hours</option>
                  <option value={10080}>7 days</option>
                </select>
              </label>
            )}
            <label>
              Cwd
              <input
                value={agentForm.cwd}
                placeholder="Vault root or relative path"
                spellCheck={false}
                onChange={(event) => setAgentForm((value) => ({ ...value, cwd: event.target.value }))}
              />
            </label>
            <label>
              Persona / context
              <textarea
                value={agentForm.contextPrompt}
                placeholder="Standing instructions for this agent"
                rows={3}
                onChange={(event) => setAgentForm((value) => ({ ...value, contextPrompt: event.target.value }))}
              />
            </label>
              </>
            )}
            <div className="chat-agent-group">
              {agentPanelMode === 'edit-member' && <div className="chat-agent-group-title">Runtime</div>}
            <label>
              Model
              {activeModelCatalog?.source === 'fallback' && (
                <span className="chat-agent-field-hint" role="status">Using built-in models</span>
              )}
              {activeFormAgent && activeFormAgent.models.length > 0 ? (
                <>
                  <select
                    value={modelChoice}
                    onChange={(event) => {
                      const choice = event.target.value;
                      setModelChoice(choice);
                      if (choice !== CUSTOM_MODEL_VALUE) setCustomModel('');
                      setAgentForm((value) => ({
                        ...value,
                        model: modelFromPicker(choice, choice === CUSTOM_MODEL_VALUE ? customModel : ''),
                      }));
                    }}
                  >
                    {activeFormAgent.models.map((model) => (
                      <option key={model.id} value={model.id}>{model.label}</option>
                    ))}
                    <option value={CUSTOM_MODEL_VALUE}>Custom model ID…</option>
                  </select>
                  {modelChoice === CUSTOM_MODEL_VALUE && (
                    <input
                      className="chat-model-custom-input"
                      value={customModel}
                      placeholder="e.g. sonnet-4-6"
                      spellCheck={false}
                      onChange={(event) => {
                        const next = event.target.value;
                        setCustomModel(next);
                        setAgentForm((value) => ({ ...value, model: next.trim() }));
                      }}
                    />
                  )}
                </>
              ) : (
                <input
                  value={customModel}
                  placeholder="Model ID"
                  spellCheck={false}
                  onChange={(event) => {
                    const next = event.target.value;
                    setCustomModel(next);
                    setModelChoice(CUSTOM_MODEL_VALUE);
                    setAgentForm((value) => ({ ...value, model: next.trim() }));
                  }}
                />
              )}
            </label>
            {(agentForm.agentId === 'codex' || agentForm.agentId === 'claude-code') && (agentPanelMode === 'edit-member' || agentPanelMode === 'create') && (
              <label>
                Reasoning effort
                <ReasoningEffortSelect
                  agentId={agentForm.agentId}
                  value={agentForm.reasoningEffort || ''}
                  onChange={(reasoningEffort) => setAgentForm((value) => ({ ...value, reasoningEffort }))}
                />
                <span className="chat-agent-field-hint">Default follows the local CLI configuration on the agent owner's desktop.</span>
              </label>
            )}
            {agentForm.agentId === 'codex' && (agentPanelMode === 'edit-member' || agentPanelMode === 'create') && (
              <ChatAgentToggle
                checked={agentForm.priorityServiceTier}
                onChange={(event) => setAgentForm((value) => ({ ...value, priorityServiceTier: event.target.checked }))}
                name="Fast mode"
                hint="Uses Codex priority processing for new runs; may consume usage faster."
              />
            )}
            </div>
            {(agentPanelMode === 'edit-member' || agentPanelMode === 'create') && (
              <>
            <div className="chat-agent-group">
              <div className="chat-agent-group-title">Replies</div>
              <ChatAgentToggle
                checked={agentForm.orchestrator}
                onChange={(event) => setAgentForm((value) => ({
                  ...value,
                  orchestrator: event.target.checked,
                  nextStepSuggestions: event.target.checked && value.nextStepSuggestions,
                  replyToEveryMessage: event.target.checked,
                }))}
                name="Coordinate this channel"
                hint="Reads every human message and can delegate durable work."
              />
              {agentForm.orchestrator && (
                <ChatAgentToggle
                  checked={agentForm.nextStepSuggestions === true}
                  onChange={(event) => setAgentForm((value) => ({ ...value, nextStepSuggestions: event.target.checked }))}
                  name="Suggest what to work on next"
                  hint="Considers a useful next step after work finishes and when you return. Off by default. Work starts only when you accept."
                />
              )}
              <ChatAgentToggle
                stateClass={agentForm.orchestrator ? ' is-locked' : ''}
                checked={agentForm.replyToEveryMessage}
                disabled={agentForm.orchestrator}
                onChange={(event) => setAgentForm((value) => ({ ...value, replyToEveryMessage: event.target.checked }))}
                name="Reply to every human message"
                hint={agentForm.orchestrator
                  ? 'Always on while coordinating.'
                  : 'Otherwise it only answers when @mentioned.'}
              />
              <ChatAgentToggle
                checked={agentForm.ambientGroupChat === true}
                onChange={(event) => setAgentForm((value) => ({ ...value, ambientGroupChat: event.target.checked }))}
                name="Ambient group chat"
                hint="Takes turns naturally with other ambient agents, with a bounded conversation length."
              />
              <ChatAgentToggle
                checked={agentForm.finalReplyOnly === true}
                onChange={(event) => setAgentForm((value) => ({ ...value, finalReplyOnly: event.target.checked }))}
                name="Final replies only"
                hint="Keeps ordinary run status visible, but hides live reasoning, tools, and progress; publishes the settled reply."
              />
            </div>
            <div className="chat-agent-group">
              <div className="chat-agent-group-title">Mentions</div>
              <ChatAgentToggle
                checked={agentForm.taggableByAgents}
                onChange={(event) => setAgentForm((value) => ({ ...value, taggableByAgents: event.target.checked }))}
                name="Other agents"
                hint="Agents in this channel may @mention it."
              />
              <ChatAgentToggle
                checked={agentForm.pingableByOthers}
                onChange={(event) => setAgentForm((value) => ({ ...value, pingableByOthers: event.target.checked }))}
                name="Other people"
                hint="Anyone in the vault, not just you, may @mention it."
              />
            </div>
            <div className="chat-agent-group">
              <div className="chat-agent-group-title">Execution</div>
              {agentForm.agentId === 'hermes' && (
                <>
                  <label>
                    Hermes profile
                    <input
                      value={agentForm.hermesProfile}
                      placeholder="Default local profile"
                      spellCheck={false}
                      onChange={(event) => setAgentForm((value) => ({ ...value, hermesProfile: event.target.value }))}
                    />
                    <span className="chat-agent-field-hint">Uses this named profile from the agent owner's local Hermes installation.</span>
                  </label>
                  <ChatAgentToggle
                    checked={agentForm.hermesSafeMode}
                    onChange={(event) => setAgentForm((value) => ({ ...value, hermesSafeMode: event.target.checked }))}
                    name="Hermes safe mode"
                    hint="Disables user configuration, memory, plugins, AGENTS.md, and MCP integrations."
                  />
                </>
              )}
              <div className="chat-agent-mode-summary">
                <span>Auto</span>
                <span>Recommended</span>
              </div>
              <span className="chat-agent-field-hint">Uses the owner’s desktop CLI and stays inside its workspace. Provider usage follows that local account; private note blocks remain hidden.</span>
              <ChatAgentToggle
                stateClass={agentForm.yolo ? ' is-hot' : ''}
                checked={agentForm.yolo}
                onChange={(event) => setAgentForm((value) => ({ ...value, yolo: event.target.checked }))}
                name="Full host access"
                hint="Bypasses prompts and workspace boundaries."
              />
            </div>
              </>
            )}
            {agentPanelMode === 'edit-member' && agentForm.vaultAgentId && (
              <button
                type="button"
                className="chat-agent-identity-link"
                onClick={(event) => editVaultIdentity(event, agentForm)}
              >
                <span className="chat-agent-toggle-copy">
                  <span className="chat-agent-toggle-name">Edit vault identity</span>
                  <span className="chat-agent-toggle-hint">Name, handle, persona — shared across all channels.</span>
                </span>
                <ChevronRight size={13} />
              </button>
            )}
            {agentFormError && <div className="chat-agent-form-error">{agentFormError}</div>}
            <div className="chat-agent-menu-actions">
              <button
                type="button"
                onClick={() => {
                  setAgentMenuOpen(false);
                  setEditingRegistrationId(null);
                  setAgentPanelMode('picker');
                  setAgentFormError('');
                }}
              >
                Cancel
              </button>
              <button type="submit">
                {agentPanelMode === 'create' ? 'Create & add' : 'Save'}
              </button>
            </div>
          </form>
          )}
        </div>

    </>
  );
});
