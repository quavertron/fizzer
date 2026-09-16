import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  agentsAfterLoadFailure,
  CHAT_AGENT_MODEL_PRESETS,
  vaultAgentMembershipPayload,
} from '../chat/agents';

describe('agent member hydration', () => {
  it('preserves loaded registrations when a reconnect fetch fails', () => {
    const cached = [{ id: 'ocsol', mention: 'ocsol' }];
    expect(agentsAfterLoadFailure(cached)).toBe(cached);
  });

  it('does not resurrect removed registrations from legacy local state', () => {
    expect(agentsAfterLoadFailure(undefined)).toEqual([]);
  });
});

describe('persistent agent launch', () => {
  it('carries ambient and final-only membership settings into the seating request', () => {
    const payload = vaultAgentMembershipPayload('adags-builder', {
      ambientGroupChat: true,
      finalReplyOnly: true,
      taggableByAgents: true,
      conversationId: 'builder-conversation',
    });

    expect(payload).toMatchObject({
      vaultAgentId: 'adags-builder',
      ambientGroupChat: true,
      finalReplyOnly: true,
      taggableByAgents: true,
      conversationId: 'builder-conversation',
    });
  });
});

describe('agent editor layout', () => {
  it('keeps save actions in document flow instead of overlaying scrolled fields', () => {
    const styles = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    const actions = styles.match(/\.chat-agent-editor \.chat-agent-menu-actions \{([^}]+)\}/)?.[1] || '';
    expect(actions).not.toMatch(/position:\s*sticky/);
    expect(actions).not.toMatch(/backdrop-filter/);
  });
});

describe('OMP model presets', () => {
  it('uses provider-qualified ids for the major authenticated catalogs', () => {
    const ids = CHAT_AGENT_MODEL_PRESETS.omp.map(({ id }) => id);
    expect(ids).toContain('openai-codex/gpt-5.6-sol');
    expect(ids).toContain('anthropic/claude-sonnet-5');
    expect(ids).toContain('google-antigravity/gemini-3.5-flash');
    expect(ids).toEqual(expect.arrayContaining([
      'xai-oauth/grok-build',
      'xai-oauth/grok-build-0.1',
      'xai-oauth/grok-4.3',
      'xai-oauth/grok-4.5',
      'xai-oauth/grok-4.20-multi-agent-0309',
      'xai-oauth/grok-4.20-0309-reasoning',
      'xai-oauth/grok-4.20-0309-non-reasoning',
      'xai-oauth/grok-composer-2.5-fast',
    ]));
    expect(ids.every((id) => id.includes('/'))).toBe(true);
  });
});
