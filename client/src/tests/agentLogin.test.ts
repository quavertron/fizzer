import { describe, expect, it } from 'vitest';
import { messageNeedsLogin, providerLoginTarget, agentLoginLabel } from '../chat/agentLogin';
import type { ChatMessage } from '../chat/types';

function failed(body: string): ChatMessage {
  return { id: '1', channelId: 'c', author: 'a', body, createdAt: '', status: 'failed' };
}

describe('agent login detection', () => {
  it('flags sign-in failures', () => {
    expect(messageNeedsLogin(failed('Not logged in · Please run /login'))).toBe(true);
    expect(messageNeedsLogin(failed(
      'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.',
    ))).toBe(true);
  });

  it('does not flag quota or non-login failures', () => {
    expect(messageNeedsLogin(failed("You've hit your usage limit. Visit settings to purchase more credits."))).toBe(false);
    expect(messageNeedsLogin(failed('The agent crashed while editing the file.'))).toBe(false);
  });

  it('only flags failed messages', () => {
    expect(messageNeedsLogin({ ...failed('Not logged in'), status: 'running' })).toBe(false);
    expect(messageNeedsLogin({ ...failed('Not logged in'), status: undefined })).toBe(false);
  });

  it('maps only supported CLI providers to a login target', () => {
    expect(providerLoginTarget('claude-code')).toBe('claude');
    expect(providerLoginTarget('codex')).toBe('codex');
    expect(providerLoginTarget('grok')).toBeNull();
    expect(providerLoginTarget(undefined)).toBeNull();
  });

  it('labels providers for the button', () => {
    expect(agentLoginLabel('claude')).toBe('Claude');
    expect(agentLoginLabel('codex')).toBe('Codex');
  });
});
