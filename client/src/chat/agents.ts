/**
 * Client-side agent catalog and registration settings.
 * Keep in sync with server AgentId / CLI agent lists where applicable.
 */

import type { ChatAgentRegistration } from './types';

export type AgentId = 'claude-code' | 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes' | 'akron-grok' | 'omp' | 'pi';
export type AgentModel = { id: string; label: string };

/** Providers whose local desktop login can expose a runtime model catalog. */
export type CatalogAgentId = 'claude-code' | 'codex' | 'grok' | 'antigravity';

export type AgentModelCatalog = {
  models: AgentModel[];
  source: 'live' | 'fallback';
  /** Deliberately generic; raw desktop/CLI errors never reach the renderer UI. */
  error?: string;
};

const CATALOG_AGENT_IDS: readonly CatalogAgentId[] = [
  'claude-code',
  'codex',
  'grok',
  'antigravity',
];

const MODEL_CATALOG_FALLBACK_MESSAGE = 'Using built-in models';
const MODEL_CATALOG_TIMEOUT_MS = 8_000;

export function isCatalogAgentId(agentId: string): agentId is CatalogAgentId {
  return CATALOG_AGENT_IDS.includes(agentId as CatalogAgentId);
}

export const CHAT_AGENTS: Array<{ id: AgentId; label: string }> = [
  { id: 'claude-code', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'hermes', label: 'Hermes' },
  { id: 'akron-grok', label: 'Akron --grok' },
  { id: 'omp', label: 'OMP' },
  { id: 'pi', label: 'Pi' },
];

/** Preserve authoritative in-memory members across a transient hydration error. */
export function agentsAfterLoadFailure<T>(cached?: T[]): T[] {
  return cached ?? [];
}

/** Preserve channel-only launch settings when seating a new persistent identity. */
export function vaultAgentMembershipPayload(
  vaultAgentId: string,
  registration: Partial<ChatAgentRegistration> = {},
) {
  return { ...registration, vaultAgentId };
}

/**
 * Curated model presets shown in the agent picker.
 * Prefer ids known to work with the local CLI; dead ids (e.g. retired grok-build)
 * are intentionally omitted. The picker also accepts a custom model ID.
 */
export const CHAT_AGENT_MODEL_PRESETS: Record<AgentId, { id: string; label: string }[]> = {
  'claude-code': [
    // Most capable first. These pinned IDs are from the official current catalog.
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  ],
  grok: [
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'grok-4.5', label: 'Grok 4.5' },
  ],
  // agentapi --model= only accepts flash_lite|flash|pro; named models below are
  // normalized onto one of those execution tiers.
  antigravity: [
    { id: 'flash_lite', label: 'Gemini Flash Lite (tier)' },
    { id: 'flash', label: 'Gemini Flash (tier)' },
    { id: 'pro', label: 'Gemini Pro (tier)' },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
    { id: 'gemini-3.5-flash-extra-low', label: 'Gemini 3.5 Flash (Low)' },
    { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Medium)' },
    { id: 'gemini-3-flash-agent', label: 'Gemini 3.5 Flash (High)' },
    { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image' },
    { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ],
  copilot: [
    { id: 'auto', label: 'Auto' },
    { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
  ],
  // Nous-hosted ids from Hermes' model catalog. An explicit selection is passed
  // through as `-m`; otherwise Hermes may inherit its selected local profile.
  hermes: [
    { id: 'z-ai/glm-5.2', label: 'GLM 5.2 (Hermes default)' },
    { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731' },
    { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8' },
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
    { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'x-ai/grok-4.5', label: 'Grok 4.5' },
    { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
    { id: 'qwen/qwen3.8-max', label: 'Qwen 3.8 Max' },
  ],
  'akron-grok': [],
  omp: [
    { id: 'openai-codex/gpt-5.6-sol', label: 'Codex · GPT-5.6 Sol' },
    { id: 'openai-codex/gpt-5.6-terra', label: 'Codex · GPT-5.6 Terra' },
    { id: 'openai-codex/gpt-5.6-luna', label: 'Codex · GPT-5.6 Luna' },
    { id: 'openai-codex/gpt-5.5', label: 'Codex · GPT-5.5' },
    { id: 'openai-codex/gpt-5.4', label: 'Codex · GPT-5.4' },
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Code · Sonnet 5' },
    { id: 'anthropic/claude-opus-4-8', label: 'Claude Code · Opus 4.8' },
    { id: 'anthropic/claude-fable-5', label: 'Claude Code · Fable 5' },
    { id: 'anthropic/claude-haiku-4-5', label: 'Claude Code · Haiku 4.5' },
    { id: 'google-antigravity/gemini-3.5-flash', label: 'Antigravity · Gemini 3.5 Flash' },
    { id: 'google-antigravity/gemini-3.1-pro', label: 'Antigravity · Gemini 3.1 Pro' },
    { id: 'google-antigravity/gemini-3-flash', label: 'Antigravity · Gemini 3 Flash' },
    { id: 'google-antigravity/claude-sonnet-4-6', label: 'Antigravity · Claude Sonnet 4.6' },
    { id: 'google-antigravity/claude-opus-4-6', label: 'Antigravity · Claude Opus 4.6' },
    { id: 'xai-oauth/grok-build', label: 'Grok · Build' },
    { id: 'xai-oauth/grok-build-0.1', label: 'Grok · Build 0.1' },
    { id: 'xai-oauth/grok-4.3', label: 'Grok · 4.3' },
    { id: 'xai-oauth/grok-4.5', label: 'Grok · 4.5' },
    { id: 'xai-oauth/grok-4.20-multi-agent-0309', label: 'Grok · 4.20 Multi-Agent' },
    { id: 'xai-oauth/grok-4.20-0309-reasoning', label: 'Grok · 4.20 Reasoning' },
    { id: 'xai-oauth/grok-4.20-0309-non-reasoning', label: 'Grok · 4.20 Non-Reasoning' },
    { id: 'xai-oauth/grok-composer-2.5-fast', label: 'Grok · Composer 2.5 Fast' },
  ],
  pi: [],
};
/**
 * Built-in choices remain the safe browser/unsupported-provider path.
 * Return a fresh array so a picker cannot mutate the shared preset table.
 */
export function fallbackAgentModelCatalog(agentId: CatalogAgentId): AgentModelCatalog {
  return {
    models: CHAT_AGENT_MODEL_PRESETS[agentId].map((model) => ({ ...model })),
    source: 'fallback',
    error: MODEL_CATALOG_FALLBACK_MESSAGE,
  };
}

/**
 * Read the optional Electron catalog bridge and accept only a non-empty,
 * well-formed live list. Browser mode and older shells deliberately resolve to
 * the same built-in fallback instead of surfacing bridge/CLI details.
 */
export async function loadAgentModels(agentId: CatalogAgentId): Promise<AgentModelCatalog> {
  const fallback = fallbackAgentModelCatalog(agentId);
  const cascadeBridge = typeof window === 'undefined' ? undefined : Reflect.get(window, 'cascade');
  const getAgentModels = cascadeBridge && typeof cascadeBridge === 'object'
    ? Reflect.get(cascadeBridge, 'getAgentModels')
    : undefined;
  if (typeof getAgentModels !== 'function') return fallback;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('catalog timeout')), MODEL_CATALOG_TIMEOUT_MS);
    });
    const response = await Promise.race([getAgentModels(agentId), timeout]);
    if (!response || typeof response !== 'object') return fallback;
    const source = Reflect.get(response, 'source');
    const rawModels = Reflect.get(response, 'models');
    if (source !== 'live' || !Array.isArray(rawModels)) return fallback;

    const seen = new Set<string>();
    const models: AgentModel[] = [];
    for (const entry of rawModels) {
      if (!entry || typeof entry !== 'object') continue;
      const id = Reflect.get(entry, 'id');
      const label = Reflect.get(entry, 'label');
      if (typeof id !== 'string' || id.trim().length === 0) continue;
      if (typeof label !== 'string' || label.trim().length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label });
    }
    if (models.length === 0) return fallback;
    return { models, source: 'live' };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeoutId);
  }
}
export function agentLabel(agentId: string) {
  return CHAT_AGENTS.find((agent) => agent.id === agentId)?.label ?? agentId;
}

/** Empty / vault-root aliases → '' so the server treats it as the vault root. */
export function normalizeChatCwd(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^(vault\s*root|root|\.\/?)$/i.test(trimmed)) return '';
  return trimmed;
}
