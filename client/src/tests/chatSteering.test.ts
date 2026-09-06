import { applyRemoteChatMessage, captureChatMessageSnapshotBaseline, reconcileChatMessageSnapshot } from '../chat/runBlocks';
import { ChatGroupRow } from "../components/ChatGroupRow";
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
import { ChatMessageText } from '../components/ChatMarkdown';

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

  it('recognizes the delayed runner shell that completes a send snap', () => {
    expect(isPendingAgentRunShell(message('agent', {
      agentId: 'codex',
      status: 'running',
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

  it.each([false, true])('shows current activity with the transcript collapsed (embedded: %s)', (embedded) => {
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
    expect(markup.includes('is-open')).toBe(false);
    expect(markup).not.toContain(live.body);
    expect(markup).toContain('Working…');
    expect(markup).not.toContain('chat-work-lines');
    expect(markup).toContain('aria-expanded="false"');
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

  it('keeps live diagnostics selectable and failures visible', () => {
    expect(shouldRenderRunPanel(message('1', { status: 'running' }), false, true)).toBe(true);
    expect(shouldRenderRunPanel(message('2', { status: 'running' }), false, false)).toBe(true);
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

it('renders a next-step question without exposing its durable evidence marker', () => {
  const html = renderToStaticMarkup(createElement(ChatMessageText, {
    messageId: 'proposal', mentionableAliases: [],
    body: '<!-- fizzer-next:source-123 -->\n\nThis keeps interrupting you. Should fixing it be next?',
  }));
  expect(html).toContain('Should fixing it be next?');
  expect(html).not.toContain('fizzer-next');
  expect(html).not.toContain('source-123');
});

describe('quiet conversation activity', () => {
  const renderRow = (row: ChatMessage, avatarKind: 'agent' | 'human' = 'agent') => renderToStaticMarkup(createElement(ChatGroupRow, {
    group: { messages: [row] }, avatarKind,
    selectedMessageId: null, jumpHighlightMessageId: null,
    latestRunningMessageId: row.id, runningSiblingCount: 1,
    steeringPromptLabels: new Map(), mentionableAliases: [], notes: [],
    loadedMessageIds: new Set([row.id]), scrollRootRef: { current: null },
    onCancelRun() {}, onToggleSelect() {}, onContextMenu() {}, onReply() {},
    onJumpToMessage() {}, onLightbox() {}, onImageLoad() {},
  }));

  it('keeps startup visible and publishes one outcome through mission replacement, cleanup and reconnect', () => {
    const shell = message('shell', { agentId: 'codex', status: 'queued', body: '', seq: 1 });
    expect(renderRow(shell)).toContain('Queued');
    let rows = applyRemoteChatMessage([], shell);
    const mission = { id: 'mission', rootMessageId: 'root', title: 'Fix legibility', objective: '',
      status: 'active' as const, coordinator: 'astra', coordinatorMention: 'astra',
      tasks: [], summary: '', createdAt: '', updatedAt: '' };
    rows = applyRemoteChatMessage(rows, { ...shell, status: undefined, mission });
    expect(rows).toHaveLength(1);
    expect(renderRow(rows[0])).toContain('Fix legibility');
    const baseline = captureChatMessageSnapshotBaseline(rows);
    const outcome = message('outcome', { agentId: 'codex', seq: 2, body: 'Fixed legibility. Lifecycle checks passed.' });
    rows = applyRemoteChatMessage(rows, outcome);
    rows = applyRemoteChatMessage(rows, outcome); // duplicate realtime delivery
    rows = applyRemoteChatMessage(rows, message('transient', { agentId: 'codex', status: 'running', body: '' }));
    rows = applyRemoteChatMessage(rows, message('transient', { agentId: 'codex', body: '' }));
    rows = reconcileChatMessageSnapshot(rows, [{ ...shell, status: undefined, mission }], baseline);
    rows = reconcileChatMessageSnapshot(rows, rows, captureChatMessageSnapshotBaseline(rows));
    const html = rows.map((row) => renderRow(row)).join('');
    expect(html.split(outcome.body)).toHaveLength(2);
    expect(html).not.toContain('thinking-spinner');
    expect(rows.map((row) => row.id)).toEqual(['shell', 'outcome']);
  });

  it('preserves the verification outcome while clearing transient text and misplaced checkpoint metadata', () => {
    const marker = '<!-- fizzer-next-none:sys-mission-c43e70cb-review -->';
    let rows = [message('verification', { agentId: 'codex', status: 'running',
      body: '', blocks: [{ type: 'text', text: `Checking the desktop. ${marker.slice(0, -3)}` }] })];
    const running = renderRow(rows[0]);
    expect(running).toContain('Checking the desktop.');
    expect(running).not.toContain('fizzer-next');
    const final = 'Desktop check blocked: no streaming response was visible.';
    rows = applyRemoteChatMessage(rows, { ...rows[0], status: undefined,
      body: `${final}\n\n${marker}`, blocks: [] });
    rows = reconcileChatMessageSnapshot(rows, rows, captureChatMessageSnapshotBaseline(rows));
    const settled = renderRow(rows[0]);
    expect(settled).toContain(final);
    expect(settled).not.toContain('fizzer-next');
    expect(settled).not.toContain('thinking-spinner');
    expect(settled).not.toContain('chat-working-output');
  });

  it('streams public text inside the message activity panel without a separate decal', () => {
    let rows = [message('stream', { agentId: 'codex', status: 'running', body: 'Thinking...',
      blocks: [{ type: 'thinking', text: 'Private reasoning' },
        { type: 'tool_result', text: 'Raw tool output' },
        { type: 'text', text: 'Checking the first file' }],
    })];
    const first = renderRow(rows[0]);
    expect(first).not.toContain('chat-working-decal');
    expect(first).toContain('cascade-run-panel');
    expect(first).toMatch(/crp-live-detail[^>]*>Checking the first file<\/span>/);
    expect(first.match(/thinking-spinner /g)).toHaveLength(1);
    expect(first).not.toContain('Private reasoning');
    expect(first).not.toContain('Raw tool output');
    rows = applyRemoteChatMessage(rows, { ...rows[0], blocks: [{ type: 'text', text: 'Now checking the second file' }] });
    const next = renderRow(rows[0]);
    expect(next).toContain('Now checking the second file');
    expect(next).not.toContain('Checking the first file');
    for (const status of [undefined, 'failed', 'canceled'] as const) {
      const settled = applyRemoteChatMessage(rows, { ...rows[0], status, body: 'Substantive final outcome.' });
      const html = renderRow(settled[0]);
      expect(html).not.toContain('chat-working-output');
      expect(html).not.toContain('thinking-spinner');
      expect(html).toContain('Substantive final outcome.');
    }
  });

  it('replaces queued/running process output and removes activity on every terminal state', () => {
    const base = message('activity', {
      author: 'Sol', agentId: 'codex', runId: 42,
      body: 'I will inspect the runtime instructions.',
      harnessLog: '# thinking\nInternal runtime instructions',
    });
    for (const status of ['queued', 'sending', 'running'] as const) {
      const html = renderRow({ ...base, status });
      expect(html).toContain('thinking-spinner');
      expect(html).not.toContain('chat-working-decal');
      expect(html).toContain('cascade-run-panel');
      expect(html).toContain(status === 'running' ? 'Working' : 'Queued');
      expect(html).not.toContain(base.body);
      expect(html).not.toContain('Internal runtime instructions');
    }
    for (const status of [undefined, 'failed', 'canceled'] as const) {
      const html = renderRow({ ...base, status, body: 'Useful result or failure explanation.' });
      expect(html).not.toContain('thinking-spinner');
      expect(html).toContain('Useful result or failure explanation.');
    }
    expect(renderRow({ ...base, agentId: undefined, status: 'sending' }, 'human')).toContain(base.body);
  });
});
