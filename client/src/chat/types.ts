import type { ChatRelationship } from './relationships';

export interface ChatMediaAttachment {
  media_type: string;
  data: string;
  url: string;
  name?: string;
}

export interface ChatReplyRef {
  messageId: string;
  author: string;
  mention: string;
  preview: string;
  relationship?: ChatRelationship;
}

/** Provenance stamped on a message forwarded in from another channel. */
export interface ChatForwardRef {
  messageId: string;
  channelId: string;
  channelName: string;
  author: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  author: string;
  body: string;
  createdAt: string;
  /** Server persistence order (DB rowid); tiebreaks same-millisecond messages
   * so the client orders them exactly as the server does. Absent until the
   * message is persisted — optimistic messages sort last within a tie. */
  seq?: number;
  status?: 'queued' | 'sending' | 'running' | 'failed' | 'canceled';
  agentId?: string;
  registrationId?: string;
  actorUserId?: number;
  runId?: number;
  blocks?: ChatBlock[];
  /** Full harness terminal transcript (raw process I/O / provider stream). */
  harnessLog?: string;
  /** List API omitted harnessLog but server has one — expand fetches full message. */
  hasHarness?: boolean;
  /** List API stripped heavy data-URL images — hydrate full message to show them. */
  hasImages?: boolean;
  images?: string[];
  attachments?: Array<{ name: string; media_type: string; url: string }>;
  replyTo?: ChatReplyRef;
  forwardedFrom?: ChatForwardRef;
  changeRequest?: {
    files: Array<{ path: string; additions: number; deletions: number }>;
    commit?: string;
    ref?: string;
    approvals: Array<{ userId: number; username: string }>;
    mergedAt?: string;
    mergedBy?: string;
  };
  /** Pre-work Q&A; accept → work-item contract + mission the orchestrator drives. */
  clarification?: {
    title: string;
    questions: Array<{
      id: string;
      prompt: string;
      kind?: 'text' | 'single' | 'multi';
      options?: string[];
      answer?: string;
    }>;
    status: 'pending' | 'accepted' | 'canceled';
    tokenBudget?: number;
    assigneeRegistrationId?: string;
    workItemId?: string;
    missionId?: string;
    acceptedAt?: string;
    acceptedBy?: string;
  };
  mission?: ChatMission;
  missionTaskId?: string;
}

export type ChatMissionTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'canceled';

export interface ChatMissionTask {
  parentTaskId?: string | null;
  joiningChildren?: boolean;
  id: string;
  title: string;
  assignee: string;
  assigneeMention: string;
  assigneeModel: string;
  status: ChatMissionTaskStatus;
  summary: string;
  dependsOn: string[];
  waitingFor: string[];
  priority: number;
  reasoningEffort: string;
  anonymous?: boolean;
  queueReason: 'dependency' | 'dependency-attention' | 'agent-busy' | 'queued' | '';
  attempt: number;
  runId?: number;
  /** Durable work-item twin (workspace / lease / PR). */
  workItemId?: string;
  workItemStatus?: string;
  workspaceMode?: string;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  prState?: string;
  verification?: string;
  reviewState?: 'none' | 'requested' | 'in_review' | 'ready';
  gitState?: { changedFiles: number; dirty: boolean; behind: number; updatedAt: string };
  reviewReady?: boolean;
  reviewBlockers?: string[];
  updatedAt: string;
}

export interface ChatMission {
  id: string;
  rootMessageId: string;
  title: string;
  objective: string;
  status: 'active' | 'reviewing' | 'attention' | 'blocked' | 'completed' | 'canceled';
  coordinator: string;
  coordinatorMention: string;
  tasks: ChatMissionTask[];
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMissionEvent {
  id: number;
  missionId: string;
  taskId?: string;
  kind: string;
  title: string;
  fromStatus: string;
  toStatus: string;
  summary: string;
  runId?: number;
  attempt: number;
  createdAt: string;
}

/** Desktop runner health from GET /api/me/desktop-runner */
export interface PlanUsageWindow {
  label: string;
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string | null;
  resetsLabel?: string | null;
}

export interface PlanUsage {
  status: 'ok' | 'unknown' | 'error';
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string | null;
  resetsLabel?: string | null;
  windows?: PlanUsageWindow[];
  planType?: string | null;
  detail?: string | null;
  fetchedAt?: string;
}

export interface DesktopRunnerHealth {
  online: boolean;
  activeRuns: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSeenAt: string | null;
  planUsage: Record<string, PlanUsage> | null;
}

export interface ChatBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  redacted?: boolean;
  /** tool_use */
  id?: string;
  name?: string;
  input?: unknown;
  /** tool_result */
  toolUseId?: string;
  content?: string;
  isError?: boolean;
}

export interface ChatAgentRegistration {
  id: string;
  /** Persistent vault-level agent id (shared across channels). */
  vaultAgentId?: string;
  /** Server-authoritative owner of this personal assistant. */
  ownerUserId?: number;
  agentId: string;
  displayName: string;
  avatarUrl: string;
  mention: string;
  model: string;
  /** Optional per-channel Codex reasoning effort pin. Empty uses the CLI default. */
  reasoningEffort: string;
  /** Codex-only priority processing override for this channel membership. */
  priorityServiceTier: boolean;
  cwd: string;
  contextPrompt: string;
  taggableByAgents: boolean;
  replyToEveryMessage: boolean;
  /** Join serialized, bounded ambient conversation in this channel. */
  ambientGroupChat?: boolean;
  /** Keep live reasoning, tools, and progress out of chat; publish only the settled reply. */
  finalReplyOnly?: boolean;
  orchestrator: boolean;
  /** Opt-in suggestions by this owner’s coordinator in this channel. */
  nextStepSuggestions?: boolean;
  /** Allow users other than the owner to @mention/trigger this agent in a
   * shared channel. The run still executes on the owner's desktop runner. */
  pingableByOthers: boolean;
  /** Run this agent with permission prompts bypassed ("yolo"). Scoped to this
   * registration, applied on the machine that runs it. */
  yolo: boolean;
  /** Hermes profile selected from the owner's local Hermes installation. */
  hermesProfile: string;
  /** Start Hermes without user config, memory, plugins, or MCP integrations. */
  hermesSafeMode: boolean;
  /** Conversation id linking this member's runs into one resumable session.
   * Empty for a not-yet-persisted member; the server assigns/preserves it. */
  conversationId: string;
}

/** Stable agent principal. Its visible @ alias is copied into each channel binding and may diverge. */
export interface VaultAgent {
  id: string;
  vaultId: string;
  agentId: string;
  displayName: string;
  avatarUrl: string;
  mention: string;
  model: string;
  cwd: string;
  contextPrompt: string;
  hermesProfile: string;
  hermesSafeMode: boolean;
  identityScope: 'network' | 'vault' | 'session';
  expiresAt?: string | null;
  ownerUserId: number;
  ownerUsername: string;
  channelIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ChatAgentOption {
  id: string;
  label: string;
  models: Array<{ id: string; label: string }>;
}

export interface ChatChannelPresence {
  participants: string[];
  online: string[];
  owner?: string;
  profiles?: Record<string, { id: number; username: string; displayName: string; avatarUrl?: string }>;
}

export type SharedChatNote = {
  id: string;
  title: string;
  content: string;
  content_preview: string;
};
