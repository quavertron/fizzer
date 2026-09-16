import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { agentOwnerStyle, agentOwnership, eligibleAgentProfiles } from '../chat/agents';
import type { ChatAgentRegistration, VaultAgent } from '../chat/types';
import { ChatAvatar } from '../components/ChatAvatar';
import { ChatAgentPanel } from '../components/ChatAgentPanel';

const profile = (id: string, overrides: Partial<VaultAgent> = {}): VaultAgent => ({
  id, vaultId: 'origin-vault', agentId: 'codex', displayName: id, mention: id,
  avatarUrl: '', model: '', cwd: '', contextPrompt: '', hermesProfile: '',
  hermesSafeMode: false, identityScope: 'vault', ownerUserId: 1, ownerUsername: 'alice',
  ...overrides,
});
const registration = (identity: VaultAgent): ChatAgentRegistration => ({
  ...identity, id: `reg-${identity.id}`, vaultAgentId: identity.id,
  reasoningEffort: '', priorityServiceTier: false, taggableByAgents: false,
  replyToEveryMessage: false, orchestrator: false, pingableByOthers: true,
  yolo: false, conversationId: '',
});

describe('My Agents eligibility', () => {
  it('omits existing vault identities, including those seated only in another channel', () => {
    const added = profile('added');
    const profiles = [added, profile('another-channel', { channelIds: ['vault-chat-2'] }),
      profile('elsewhere', { channelIds: ['other-vault-chat'] }), profile('unused'),
      profile('other-owner', { ownerUserId: 2, ownerUsername: 'bob' }),
      profile('unknown', { ownerUserId: 0, ownerUsername: '' })];
    expect(eligibleAgentProfiles(profiles, [registration(added)], 'alice', 1, ['vault-chat-1', 'vault-chat-2'])
      .map(({ id }) => id)).toEqual(['elsewhere', 'unused']);
  });

  it('allows readding a removed profile, without mistaking its original vault for membership', () => {
    const removed = profile('removed', { vaultId: 'current-vault', channelIds: [] });
    expect(eligibleAgentProfiles([removed], [], 'alice', 1, ['current-chat'])).toEqual([removed]);
  });
});

describe('agent ownership presentation', () => {
  it('gives owners consistent distinct tints independent of viewing permissions', () => {
    expect(agentOwnerStyle('alice', ['alice', 'bob', 'carol'])).toEqual(agentOwnerStyle('alice', ['alice', 'bob', 'carol']));
    expect(agentOwnerStyle('alice', ['alice', 'bob', 'carol'])).not.toEqual(agentOwnerStyle('bob', ['alice', 'bob', 'carol']));
    expect(agentOwnerStyle('bob', ['alice', 'bob', 'carol'])).not.toEqual(agentOwnerStyle('carol', ['alice', 'bob', 'carol']));
    expect(agentOwnerStyle('')).toBeUndefined();
    const avatar = (ownership: 'owned' | 'other') => renderToStaticMarkup(<ChatAvatar name="Agent" kind="agent" ownerLabel="alice" ownership={ownership} />).match(/style="([^"]+)"/)?.[1];
    expect(avatar('owned')).toBeTruthy();
    expect(avatar('owned')).toBe(avatar('other'));
  });

  it('separates the actual colliding owners and ignores roster order and repeated agents', () => {
    const owners = ['asdfasdf', 'lightyear', 'yourmomisgay'];
    const hue = (owner: string) => Number(String((agentOwnerStyle(owner, owners) as Record<string, string>)['--agent-tint']).match(/hsl\(([^ ]+)/)![1]);
    for (const a of owners) {
      expect(agentOwnerStyle(a, owners)).toEqual(agentOwnerStyle(a, [...owners].reverse().concat(a)));
      for (const b of owners.filter((name) => name !== a)) {
        const delta = Math.abs(hue(a) - hue(b));
        expect(Math.min(delta, 360 - delta)).toBeGreaterThanOrEqual(120);
      }
    }
  });

  it('prefers owner ids, falls back to usernames, and leaves missing metadata unknown', () => {
    expect(agentOwnership({ ownerUserId: 1, ownerUsername: 'old-name' }, 'alice', 1)).toBe('owned');
    expect(agentOwnership({ ownerUserId: 2, ownerUsername: 'alice' }, 'alice', 1)).toBe('other');
    expect(agentOwnership({ ownerUsername: 'alice' }, 'alice')).toBe('owned');
    expect(agentOwnership({ ownerUsername: 'bob' }, 'alice')).toBe('other');
    expect(agentOwnership(undefined, 'alice', 1)).toBe('unknown');
    expect(agentOwnership({ ownerUsername: '' }, '')).toBe('unknown');
  });

  it.each(['owned', 'other'] as const)('marks %s avatars, including image avatars, with accessible ownership', (ownership) => {
    const html = renderToStaticMarkup(<ChatAvatar name="Agent" kind="agent" ownership={ownership} ownerLabel="alice" avatarUrl="/avatar.png" onClick={() => {}} title="Open agent settings" />);
    expect(html).toContain(`data-agent-ownership="${ownership}"`);
    expect(html).toContain('src="/avatar.png"');
    expect(html).toContain('aria-label="Open agent settings · alice’s agent"');
  });

  it('keeps human avatars unchanged and labels unknown agent ownership without guessing', () => {
    const human = renderToStaticMarkup(<ChatAvatar name="Alice" kind="human" ownership="owned" ownerLabel="alice" avatarUrl="/human.png" />);
    expect(human).not.toContain('data-agent-ownership');
    expect(human).not.toContain('agent</');
    expect(human).toContain('src="/human.png"');
    expect(human).toContain('aria-hidden="true"');
    const unknown = renderToStaticMarkup(<ChatAvatar name="Agent" kind="agent" />);
    expect(unknown).toContain('data-agent-ownership="unknown"');
    expect(unknown).toContain('aria-label="Agent · Owner unknown"');
    const clickable = renderToStaticMarkup(<ChatAvatar name="Agent" kind="agent" onClick={() => {}} />);
    expect(clickable).toContain('aria-label="Open settings for Agent · Owner unknown"');
  });

  it('colors agent rows by owner independently of management and invocation permissions', () => {
    const profiles = [profile('theirs', { ownerUserId: 2, ownerUsername: 'bob' }), profile('mine'), profile('mine-too')];
    const members = profiles.map(registration);
    const html = renderToStaticMarkup(createElement(ChatAgentPanel, {
      channelId: 'chat', currentUser: 'alice', currentUserId: 1, vaultAgents: profiles,
      availableAgents: [], registeredAgents: members,
      registeredAgentRows: members.map((member) => ({ id: 'codex', label: member.displayName, models: [], registration: member })),
      canManageRegistration: () => false,
      onRegisterAgent() {}, onRemoveAgent() {}, async onInviteUser() {}, onExpandRail() {}, onChromeChange() {},
    }));
    expect(html).toContain('data-agent-ownership="owned"');
    expect(html).toContain('data-agent-ownership="other"');
    expect(html).toContain('alice’s agent');
    expect(html).toContain('bob’s agent');
    expect(html.match(/class="chat-agent-edit-btn" disabled=""/g)).toHaveLength(3);
    expect(html.indexOf('>mine</strong>')).toBeLessThan(html.indexOf('>mine-too</strong>'));
    expect(html.indexOf('>mine-too</strong>')).toBeLessThan(html.indexOf('>theirs</strong>'));
    expect(members.map((member) => member.displayName)).toEqual(['theirs', 'mine', 'mine-too']);
    expect(html.match(/--agent-tint:hsl/g)).toHaveLength(6);
    expect(members.every((member) => member.pingableByOthers)).toBe(true);
  });
});
