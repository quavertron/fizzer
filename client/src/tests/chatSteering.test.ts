import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ChatView,
  ReasoningEffortSelect,
  getRunningMessageState,
  getSteeringPromptLabels,
  isPendingAgentRunShell,
  mergeChatPresence,
  shouldRenderRunPanel,
  shouldDetachStickyForTouch,
  shouldDetachStickyForWheel,
  shouldSnapToRecentOnSend,
} from '../components/ChatView';
import { applyLocalUserProfile } from '../chat/shared';
import type { ChatAgentRegistration, ChatMessage } from '../chat/types';
import { chatMessageStore } from '../chat/messageStore';
import { ChatWorkTrace } from '../components/ChatWorkTrace';
import { ChatMissionCard } from '../components/ChatMissionCard';
import { CascadeRunPanel } from '../components/CascadeRunPanel';

const agent: ChatAgentRegistration = {
  id: 'reg-sol',
  vaultAgentId: 'agent-sol',
  agentId: 'codex',
  displayName: 'Sol',
  avatarUrl: '',
  mention: 'sol',
  model: 'gpt-test',
  reasoningEffort: '',
  priorityServiceTier: false,
  cwd: '',
  contextPrompt: '',
  taggableByAgents: true,
  replyToEveryMessage: false,
  orchestrator: false,
  pingableByOthers: true,
  yolo: false,
  hermesProfile: '',
  hermesSafeMode: false,
  conversationId: 'conversation-1',
};

function message(id: string, partial: Partial<ChatMessage>): ChatMessage {
  return { id, channelId: 'channel', author: 'asdfasdf', body: '', createdAt: id, ...partial };
}

describe('chat sticky bottom intent', () => {
  it('only detaches for upward history scrolling', () => {
    expect(shouldDetachStickyForWheel(-1)).toBe(true);
    expect(shouldDetachStickyForWheel(12)).toBe(false);
    expect(shouldDetachStickyForTouch(100, 112)).toBe(true);
    expect(shouldDetachStickyForTouch(100, 88)).toBe(false);
  });

  it('snaps after send only when the pre-send viewport is within 600px of recent', () => {
    const viewport = (distance: number) => ({
      scrollHeight: 2_000,
      clientHeight: 500,
      scrollTop: 1_500 - distance,
    } as HTMLElement);

    expect(shouldSnapToRecentOnSend(viewport(0))).toBe(true);
    expect(shouldSnapToRecentOnSend(viewport(600))).toBe(true);
    expect(shouldSnapToRecentOnSend(viewport(601))).toBe(false);
  });

  it.each(['running', 'queued', 'sending'] as const)('recognizes a %s shell that completes a send snap', (status) => {
    expect(isPendingAgentRunShell(message('agent', {
      agentId: 'codex',
      status,
      body: 'Thinking...',
    }))).toBe(true);
    expect(isPendingAgentRunShell(message('human', {
      status: 'sending',
      body: 'hello',
    }))).toBe(false);
    expect(isPendingAgentRunShell(message('done', {
      agentId: 'codex',
      status: undefined,
      body: 'Finished.',
    }))).toBe(false);
  });
});

describe('agent steering presentation', () => {
  it('marks the newest active response and its triggering follow-up', () => {
    const messages = [
      message('1', { author: 'Sol', agentId: 'codex', registrationId: agent.id, status: 'running', body: 'Thinking…' }),
      message('2', { body: '@sol also check mobile' }),
      message('3', { author: 'Sol', agentId: 'codex', registrationId: agent.id, status: 'running', body: 'Thinking…' }),
    ];
    const state = getRunningMessageState(messages);
    expect(state.get(agent.id)).toEqual({ latestId: '3', count: 2 });
    expect(getSteeringPromptLabels(messages, [agent], state).get('2')).toBe('sol');
  });

  it('does not call the first prompt steering', () => {
    const messages = [
      message('1', { body: '@sol start' }),
      message('2', { author: 'Sol', agentId: 'codex', registrationId: agent.id, status: 'running' }),
    ];
    expect(getSteeringPromptLabels(messages, [agent]).size).toBe(0);
  });

  it('keeps the steering decal after the interrupted response settles', () => {
    const messages = [
      message('1', {
        author: 'Sol', agentId: 'codex', registrationId: agent.id,
        status: 'canceled', body: 'Steered into the continuation below.',
      }),
      message('2', { body: 'also answer the subscription question' }),
      message('3', {
        author: 'Sol', agentId: 'codex', registrationId: agent.id,
        body: 'It is low risk for personal CLI use.',
      }),
    ];
    expect(getSteeringPromptLabels(messages, [agent]).get('2')).toBe('sol');
  });

  it('keeps running-step details folded even when the activity list is open', () => {
    const live = message('live-fold', {
      author: 'Sol', agentId: 'codex', registrationId: agent.id,
      status: 'running', body: 'Checking the implementation.',
      harnessLog: 'Private diagnostic detail', hasHarness: true,
    });
    const markup = renderToStaticMarkup(createElement(ChatWorkTrace, {
      trace: [live], selectedMessageId: null, forceOpen: true,
      onCancelRun: () => {}, onContextMenu: () => {}, onReply: () => {},
      runningMessageState: new Map([[agent.id, { latestId: live.id, count: 1 }]]),
    }));
    expect(markup).toContain('chat-work-trace-body');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('chat-work-line-body');
    expect(markup).not.toContain('crp-term-stream');
  });

  it('shows delegated task names and waiting state in a collapsed active mission', () => {
    const markup = renderToStaticMarkup(createElement(ChatMissionCard, {
      mission: {
        id: 'mission', rootMessageId: 'root', title: 'Fix progress', objective: '',
        status: 'active', coordinator: 'Astra', coordinatorMention: 'astra', summary: '',
        createdAt: '', updatedAt: '', tasks: [{
          id: 'validation', title: 'Validate the implementation', assignee: 'Astra',
          assigneeMention: 'astra', assigneeModel: '', status: 'pending', summary: '',
          dependsOn: ['implementation'], waitingFor: ['implementation'], priority: 0,
          reasoningEffort: '', anonymous: true, queueReason: 'dependency', attempt: 0, updatedAt: '',
        }],
      },
      traceContent: createElement('span', null, 'Checking current progress'),
    }));
    expect(markup).toContain('Validate the implementation');
    expect(markup).toContain('pending');
    expect(markup).toContain('waiting for dependencies');
    expect(markup).toContain('subagent');
    expect(markup).toContain('Checking current progress');
    expect(markup).not.toContain('chat-mission-card is-active is-live is-open');
  });

  it('labels completed activity and folds its diagnostic history', () => {
    const markup = renderToStaticMarkup(createElement(ChatWorkTrace, {
      trace: [message('done', { author: 'Astra', body: 'Validation passed.' })],
      selectedMessageId: null, onCancelRun: () => {}, onContextMenu: () => {},
      onReply: () => {}, runningMessageState: new Map(),
    }));
    expect(markup).toContain('Completed activity');
    expect(markup).not.toContain('chat-work-trace-body');
  });

  it('exposes coordinator progress, both delegated runs and failure without expanding history', () => {
    const trace = [
      message('update', { author: 'Astra', body: 'The implementation is ready; validation is running.' }),
      message('worker', { author: 'Astra', missionTaskId: 'implementation', status: 'running', body: 'Checking the patch.', harnessLog: '# codex app-server · /private/parent' }),
      message('child', { author: 'Astra', missionTaskId: 'validation', status: 'running', body: 'Running regression tests.', harnessLog: '# codex app-server · /private/child' }),
      message('failed', { author: 'Astra', missionTaskId: 'other', status: 'failed', body: 'Validation failed.' }),
    ];
    const markup = renderToStaticMarkup(createElement(ChatWorkTrace, {
      trace, selectedMessageId: null, onCancelRun: () => {}, onContextMenu: () => {},
      onReply: () => {}, runningMessageState: new Map(),
    }));
    for (const item of trace) expect(markup).toContain(`data-message-id="${item.id}"`);
    expect(markup).toContain('Delegated · Astra');
    expect(markup).toContain('Checking the patch.');
    expect(markup).toContain('Running regression tests.');
    expect(markup).not.toContain('/private/');
    expect(markup).not.toContain('4 updates');
    expect(markup).not.toContain('chat-work-line-body');
  });

  it.each([false, true])('shows current activity without opening the live transcript (embedded: %s)', (embedded) => {
    const live = message('3', {
      author: 'Sol', agentId: 'codex', registrationId: agent.id,
      status: 'running', body: 'Applying the steering advice now.',
    });
    const markup = renderToStaticMarkup(createElement(ChatWorkTrace, {
      trace: [live],
      selectedMessageId: null,
      onCancelRun: () => {},
      onContextMenu: () => {},
      onReply: () => {},
      runningMessageState: new Map([[agent.id, { latestId: live.id, count: 1 }]]),
      embedded,
    }));
    expect(markup).toContain('is-live');
    expect(markup.includes('is-embedded')).toBe(embedded);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('chat-work-trace-body');
    expect(markup).toContain(live.body);
    expect(markup).not.toContain('chat-work-decals');
  });
});

describe('reasoning effort settings', () => {
  it('offers every supported Codex override including max and ultra', () => {
    const markup = renderToStaticMarkup(createElement(ReasoningEffortSelect, {
      agentId: 'codex',
      value: '',
      onChange: () => {},
    }));
    expect(markup).toContain('Use Codex CLI default');
    expect(markup).toContain('Low');
    expect(markup).toContain('Medium');
    expect(markup).toContain('High');
    expect(markup).toContain('Extra high');
    expect(markup).toContain('Max');
    expect(markup).toContain('Ultra');
  });

  it('offers Claude Code efforts through max without unsupported ultra', () => {
    const markup = renderToStaticMarkup(createElement(ReasoningEffortSelect, {
      agentId: 'claude-code',
      value: '',
      onChange: () => {},
    }));
    expect(markup).toContain('Use Claude Code default');
    expect(markup).toContain('Extra high');
    expect(markup).toContain('Max');
    expect(markup).not.toContain('Ultra');
  });
});

describe('chat run panel lifecycle', () => {
  it('exposes Stop on server-owned queued shells without harness chrome', () => {
    const queued = message('agent-dispatch-pending', { agentId: 'codex', status: 'queued', body: 'Queued...' });
    expect(shouldRenderRunPanel(queued, false, false)).toBe(true);
    const markup = renderToStaticMarkup(createElement(CascadeRunPanel, {
      message: queued, vaultId: 'vault', onHydrateMessage: () => {}, onCancelRun: () => {},
    }));
    expect(markup).toContain('aria-label="Stop run"');
    expect(markup).not.toContain('Harness');
  });

  it('hides a successful completed harness without discarding its trace', () => {
    const completed = message('1', {
      author: 'Sol',
      agentId: 'codex',
      runId: 42,
      body: 'A complete final answer.',
      blocks: [{ type: 'text', text: 'A complete final answer.' }],
      harnessLog: '# complete run trace\n',
      hasHarness: true,
    });

    expect(shouldRenderRunPanel(completed, false, true)).toBe(false);
    expect(shouldRenderRunPanel(completed, true, true)).toBe(true);
    expect(completed.harnessLog).toBe('# complete run trace\n');
    expect(completed.blocks).toEqual([{ type: 'text', text: 'A complete final answer.' }]);
  });

  it('keeps live and failed run diagnostics visible', () => {
    expect(shouldRenderRunPanel(message('1', { status: 'running' }), false, true)).toBe(true);
    expect(shouldRenderRunPanel(message('2', { status: 'running' }), false, false)).toBe(false);
    expect(shouldRenderRunPanel(message('3', { status: 'failed' }), false, true)).toBe(true);
    expect(shouldRenderRunPanel(message('4', { status: 'canceled' }), false, true)).toBe(true);
    expect(shouldRenderRunPanel(message('5', { status: 'sending', body: 'Queued...' }), false, true)).toBe(false);
  });

  it('renders a successful final reply without an automatic Harness view', () => {
    // Messages now live in the external store; seed the channel ChatView reads.
    chatMessageStore.set('channel', [message('1', {
      author: 'Sol',
      agentId: 'codex',
      runId: 42,
      body: 'A complete final answer with nuance.',
      harnessLog: '# complete run trace\n',
      hasHarness: true,
    })]);
    const markup = renderToStaticMarkup(createElement(ChatView, {
      channelId: 'channel',
      channelName: 'cascade-dev',
      currentUser: 'asdfasdf',
      presence: { participants: [], online: [] },
      availableAgents: [],
      registeredAgents: [],
      onRegisterAgent: () => {},
      onRemoveAgent: () => {},
      onInviteUser: async () => {},
      onSendMessage: () => {},
      onCancelRun: () => {},
    }));

    expect(markup).toContain('A complete final answer with nuance.');
    expect(markup).not.toContain('cascade-run-panel');
    expect(markup).not.toContain('Harness');
  });
});

describe('mergeChatPresence', () => {
  const alice = { id: 1, username: 'alice', displayName: 'Alice', avatarUrl: 'https://a/alice.png' };

  it.each([{}, { profiles: {} }])('keeps cached profiles with incoming fields %j', (incoming) => {
    const prior = { participants: ['alice'], online: ['alice'], owner: 'alice', profiles: { alice } };
    const merged = mergeChatPresence(prior, { participants: ['alice'], online: [], ...incoming });
    expect(merged.profiles).toEqual({ alice });
  });

  it('merges in newly reported profiles alongside cached ones', () => {
    const bob = { id: 2, username: 'bob', displayName: 'Bob', avatarUrl: '' };
    const prior = { participants: ['alice'], online: ['alice'], owner: 'alice', profiles: { alice } };
    const merged = mergeChatPresence(prior, { participants: ['alice', 'bob'], online: ['bob'], profiles: { bob } });
    expect(merged.profiles).toEqual({ alice, bob });
  });

  it('starts from the incoming payload when there is no cache yet', () => {
    const merged = mergeChatPresence(undefined, { participants: ['alice'], online: ['alice'], owner: 'alice', profiles: { alice } });
    expect(merged).toEqual({ participants: ['alice'], online: ['alice'], owner: 'alice', profiles: { alice } });
  });

  it('paints the signed-in user photo that presence deliberately omits', () => {
    const presence = mergeChatPresence(undefined, {
      participants: ['alice'],
      online: ['alice'],
      owner: 'alice',
      profiles: { alice: { id: 1, username: 'alice', displayName: 'Alice' } },
    });
    const painted = applyLocalUserProfile(presence, {
      id: 1,
      username: 'alice',
      displayName: 'Alice',
      avatarUrl: 'data:image/jpeg;base64,abc',
    });
    expect(painted.profiles?.alice.avatarUrl).toBe('data:image/jpeg;base64,abc');
    expect(presence.profiles?.alice.avatarUrl).toBeUndefined();
  });
});
