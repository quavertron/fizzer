import type { ChatMessage } from './types';

export type AgentLoginProvider = 'claude' | 'codex';

/**
 * A failed run whose transcript reports a sign-in problem — expired/rotated
 * OAuth token or "Not logged in". Deliberately narrow so quota/usage-limit
 * failures ("you've hit your usage limit") do NOT offer a login button.
 */
const LOGIN_FAILURE = /not logged in|please run \/login|log ?in again|log out and sign in|token could not be refreshed|refresh token was already used|please (?:re-?)?authenticate|run\s+`?codex login`?|not authenticated/i;

/** Only CLI agents whose provider login we can drive get a button. */
export function providerLoginTarget(agentId: string | undefined | null): AgentLoginProvider | null {
  if (agentId === 'claude-code') return 'claude';
  if (agentId === 'codex') return 'codex';
  return null;
}

export function messageNeedsLogin(message: ChatMessage): boolean {
  return message.status === 'failed'
    && typeof message.body === 'string'
    && LOGIN_FAILURE.test(message.body);
}

export function agentLoginLabel(provider: AgentLoginProvider): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}
