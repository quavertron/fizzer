import { missionAccent, missionMessageIdentities } from '../chat/missionIdentity';
import { ChatMissionCard } from '../components/ChatMissionCard';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatWorkTrace } from '../components/ChatWorkTrace';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat/types';
import {
  isForcedWorkTraceLine,
  isSteeringContinuationMessage,
  isWorkTraceMessage,
  partitionWorkRun,
  segmentTranscript,
  humanizeActivityLine,
  workTraceHarnessPreview,
  workTracePreview,
  workTraceDecals,
  workTracePhase,
  workTracePeek,
  workTraceStatusLabel,
  workTraceSummary,
} from '../chat/workTrace';

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'author' | 'body'>): ChatMessage {
  return {
    channelId: 'ch',
    createdAt: '2026-08-03T00:00:00.000Z',
    ...partial,
  };
}

describe('workTrace', () => {
  it('keeps completed process details behind the trace toggle', () => {
    const markup = renderToStaticMarkup(createElement(ChatWorkTrace, {
      trace: [msg({ id: 'done', author: 'Sol', missionTaskId: 'task', body: 'Child verified and joined.\n\nTask: internal-task-id' })],
      selectedMessageId: null,
      onCancelRun: () => {}, onContextMenu: () => {}, onReply: () => {},
      runningMessageState: new Map(),
    }));
    expect(markup).not.toContain('Child verified and joined.');
    expect(markup).toContain('Work details');
    expect(markup).not.toContain('>Activity<');
    expect(markup).not.toContain('1 update');
    expect(markup).not.toContain('internal-task-id');
    expect(markup).toContain('aria-expanded="false"');
  });

  it('recognizes the durable steering sentinel without exposing it as prose', () => {
    expect(isSteeringContinuationMessage(msg({
      id: 'steered', author: 'Sol', body: 'Steered into the continuation below.', status: 'canceled',
    }))).toBe(true);
    expect(isSteeringContinuationMessage(msg({
      id: 'cancel', author: 'Sol', body: 'Run canceled by user.', status: 'canceled',
    }))).toBe(false);
  });

  it('labels steering cancels as steer, not blocked', () => {
    const steered = msg({
      id: 'steered', author: 'Sol', body: 'Steered into the continuation below.', status: 'canceled', agentId: 'codex',
    });
    expect(workTracePhase(steered)).toBe('steering');
    expect(workTraceStatusLabel(steered)).toBe('steered');
    expect(workTracePhase(msg({
      id: 'hard-cancel', author: 'Sol', body: 'Run canceled by user.', status: 'canceled', agentId: 'codex',
    }))).toBe('blocked');
  });
  it('classifies agents, mission wakes, and humans', () => {
    expect(isWorkTraceMessage(msg({ id: '1', author: 'jt', body: 'hi' }))).toBe(false);
    expect(isWorkTraceMessage(msg({ id: '2', author: 'Sol', body: 'ok', agentId: 'codex' }))).toBe(true);
    expect(isWorkTraceMessage(msg({ id: 'sys-mission-abc-wake', author: 'Cascade', body: 'review' }))).toBe(true);
    expect(isWorkTraceMessage(msg({ id: '3', author: 'Sol', body: 'x' }), new Set(['Sol']))).toBe(true);
    expect(isForcedWorkTraceLine(msg({ id: 't', author: 'Sol', body: 'x', missionTaskId: 'task-1' }))).toBe(true);
  });

  it('keeps a single ordinary agent reply as a full bubble', () => {
    const reply = msg({ id: 'a1', author: 'Sol', body: 'Done.', agentId: 'codex' });
    expect(partitionWorkRun([reply])).toEqual({ trace: [], full: [reply] });
  });

  it('does not fold a later same-author turn into an earlier conversation burst', () => {
    const first = msg({ id: 'h1', author: 'diego', body: 'It is duplicated.' });
    const later = msg({
      id: 'h2', author: 'diego', body: 'On the frontend.',
      createdAt: '2026-08-03T00:02:00.000Z',
    });
    const segments = segmentTranscript([first, later]);
    expect(segments).toHaveLength(2);
  });

  it('hides a lone long delegated response behind the work dot', () => {
    const workerEssay = msg({
      id: 'worker-essay',
      author: 'Sonnet',
      body: '# Audit\n\n' + 'Detailed evidence for the coordinator. '.repeat(80),
      agentId: 'claude',
      missionTaskId: 'task-essay',
    });
    expect(partitionWorkRun([workerEssay])).toEqual({ trace: [workerEssay], full: [] });
  });

  it('collapses intermediates and keeps the final non-worker answer full', () => {
    const mid = msg({ id: 'a1', author: 'Sol', body: 'Checking…', agentId: 'codex' });
    const final = msg({ id: 'a2', author: 'Sol', body: 'Fixed root cause.', agentId: 'codex' });
    const { trace, full } = partitionWorkRun([mid, final]);
    expect(trace).toEqual([mid]);
    expect(full).toEqual([final]);
  });

  it('keeps worker and system messages in the compact stream', () => {
    const wake = msg({ id: 'sys-mission-1-wake', author: 'Cascade', body: '@sol review' });
    const worker = msg({
      id: 'a1',
      author: 'Terra',
      body: 'Deploy green.',
      agentId: 'codex',
      missionTaskId: 'task-1',
    });
    const final = msg({ id: 'a2', author: 'Sol', body: 'All clear.', agentId: 'codex' });
    const { trace, full } = partitionWorkRun([wake, worker, final]);
    expect(trace.map((m) => m.id)).toEqual(['sys-mission-1-wake', 'a1']);
    expect(full.map((m) => m.id)).toEqual(['a2']);
  });

  it('keeps live running shells inside the compact trace', () => {
    const mid = msg({ id: 'a1', author: 'Sol', body: 'Thinking…', agentId: 'codex' });
    const live = msg({ id: 'a2', author: 'Terra', body: 'Thinking…', agentId: 'codex', status: 'running' });
    const { trace, full } = partitionWorkRun([mid, live]);
    expect(trace).toEqual([mid, live]);
    expect(full).toEqual([]);
  });

  it('never hides media inside the compact trace', () => {
    const progress = msg({ id: 'a1', author: 'Sol', body: 'Checking…', agentId: 'codex' });
    const artifact = msg({
      id: 'a2', author: 'Terra', body: 'Screenshot evidence.', agentId: 'codex',
      attachments: [{ name: 'proof.png', media_type: 'image/png', url: '/proof.png' }],
    });
    const { trace, full } = partitionWorkRun([progress, artifact]);
    expect(trace).toEqual([progress]);
    expect(full).toEqual([artifact]);
  });

  it('segments human turns around work runs', () => {
    const human = msg({ id: 'h1', author: 'jt', body: 'fix this' });
    const mid = msg({ id: 'a1', author: 'Sol', body: 'Looking…', agentId: 'codex' });
    const final = msg({ id: 'a2', author: 'Sol', body: 'Done.', agentId: 'codex' });
    const segments = segmentTranscript([human, mid, final]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: 'group' });
    expect(segments[1]).toMatchObject({
      kind: 'work',
      id: 'a1',
      trace: [mid],
    });
    if (segments[1].kind === 'work') expect(segments[1].fullGroups).toHaveLength(0);
    if (segments[1].kind === 'work') expect(segments[1].updateGroups).toEqual([{ messages: [final] }]);
  });

  it('keeps an answered question and its progress in place when another run appears', () => {
    const question = msg({ id: 'question', author: 'jt', body: 'Why did that take ten minutes?' });
    const answer = msg({ id: 'answer', author: 'Astra', agentId: 'codex', runId: 3419,
      body: 'Most of the wait was deployment.', harnessLog: 'Checked the finished job.' });
    const later = msg({ id: 'later', author: 'Astra', agentId: 'codex', runId: 3420,
      body: 'Thinking...', status: 'running' });
    const before = segmentTranscript([question, answer]);
    const during = segmentTranscript([question, answer, later]);
    expect(during.slice(0, 2)).toEqual(before);
    expect(during[2]).toMatchObject({ kind: 'group', group: { messages: [later] } });
    expect(segmentTranscript([question, answer, { ...later, status: undefined, body: 'Delivered.' }])
      .slice(0, 2)).toEqual(before);
  });

  it('nests a system wake in its persisted empty agent carrier', () => {
    const carrier = msg({
      id: 'agent-trace-mission-1-wake', author: 'Terra', body: '', agentId: 'codex', registrationId: 'terra-reg',
    });
    const wake = msg({ id: 'sys-mission-mission-1-wake', author: 'Cascade', body: '@terra review' });
    const segments = segmentTranscript([carrier, wake]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ kind: 'work', carrier, trace: [wake] });
  });

  it('keeps different agents and artifacts in chronological rows', () => {
    const before = msg({ id: 'a1', author: 'Sol', body: 'Before', agentId: 'codex' });
    const artifact = msg({
      id: 'a2', author: 'Terra', body: 'Evidence', agentId: 'codex',
      attachments: [{ name: 'proof.png', media_type: 'image/png', url: '/proof.png' }],
    });
    const after = msg({
      id: 'a3', author: 'Terra', body: 'After', agentId: 'codex', missionTaskId: 'task-1',
    });
    const final = msg({ id: 'a4', author: 'Sol', body: 'Done', agentId: 'codex' });
    const segments = segmentTranscript([before, artifact, after, final]);
    expect(segments.map((segment) => segment.kind)).toEqual(['group', 'group', 'work', 'group']);
    expect(segments.map((segment) => segment.kind === 'group'
      ? segment.group.messages.map((message) => message.id)
      : [...segment.trace, ...segment.updateGroups.flatMap((group) => group.messages)].map((message) => message.id)))
      .toEqual([['a1'], ['a2'], ['a3'], ['a4']]);
  });

  it('keeps mission artifacts separate from agent responses', () => {
    const acknowledgement = msg({ id: 'a1', author: 'Sol', body: 'I am fixing it.', agentId: 'codex', registrationId: 'sol' });
    const mission = msg({
      id: 'm1', author: 'Cascade', body: 'Fix it durably.',
      mission: {
        id: 'mission-1', rootMessageId: 'm1', title: 'Fix it', objective: 'Fix it durably.',
        status: 'active', coordinator: 'sol', coordinatorMention: 'sol', tasks: [],
        summary: '', createdAt: '', updatedAt: '',
      },
    });
    const worker = msg({ id: 'w1', author: 'Sol', body: 'Tests pass.', agentId: 'codex', registrationId: 'sol', missionTaskId: 'task-1' });
    const shipped = msg({ id: 'a2', author: 'Sol', body: 'Shipped.', agentId: 'codex', registrationId: 'sol' });
    const segments = segmentTranscript([acknowledgement, mission, worker, shipped]);
    expect(segments.map((segment) => segment.kind)).toEqual(['group', 'group', 'work']);
    expect(segments[0]).toMatchObject({ kind: 'group', group: { messages: [acknowledgement] } });
    expect(segments[1]).toMatchObject({ kind: 'group', group: { messages: [mission] } });
    if (segments[2].kind === 'work') {
      expect(segments[2].trace).toEqual([worker]);
      expect(segments[2].updateGroups).toEqual([{ messages: [shipped] }]);
    }
  });

  it('nests a coordinator mission root in the live run that created it', () => {
    const acknowledgement = msg({
      id: 'a1', author: 'Sol', body: 'I am fixing it.', status: 'running',
      agentId: 'codex', registrationId: 'sol-reg',
    });
    const mission = msg({
      id: 'sys-mission-root-1', author: 'Sol', body: 'Fix it durably.',
      agentId: 'codex', registrationId: 'sol-reg',
      mission: {
        id: 'mission-1', rootMessageId: 'sys-mission-root-1', title: 'Fix it', objective: 'Fix it durably.',
        status: 'active', coordinator: 'sol', coordinatorMention: 'sol', tasks: [],
        summary: '', createdAt: '', updatedAt: '',
      },
    });
    const segments = segmentTranscript([acknowledgement, mission]);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      kind: 'work',
      trace: [acknowledgement],
      fullGroups: [{ messages: [mission] }],
    });
  });

  it('never flattens a coordinator response under a later worker', () => {
    const coordinator = msg({
      id: 'a1', author: 'Sol', body: 'Here is the answer.', agentId: 'codex', registrationId: 'sol-reg',
    });
    const laterWorker = msg({
      id: 'a2', author: 'Terra', body: 'Still checking.', agentId: 'codex', missionTaskId: 'task-1',
    });
    const segments = segmentTranscript([coordinator, laterWorker]);
    expect(segments.map((segment) => segment.kind)).toEqual(['group', 'work']);
    expect(segments[0]).toMatchObject({ kind: 'group', group: { messages: [coordinator] } });
    if (segments[1].kind === 'work') expect(segments[1].trace).toEqual([laterWorker]);
  });

  it('derives a compact ordered workflow decal trail', () => {
    const trace = [
      msg({ id: '1', author: 'Sol', body: 'Queued for Terra', status: 'sending', missionTaskId: 't1' }),
      msg({ id: '2', author: 'Terra', body: 'Running regression tests', status: 'running', missionTaskId: 't1' }),
      msg({ id: '3', author: 'Sol', body: 'Reconciling evidence for review', status: 'running' }),
      msg({ id: '4', author: 'Sol', body: 'Deploying production', status: 'running' }),
      msg({ id: '5', author: 'Sol', body: 'Done' }),
    ];
    expect(trace.map(workTracePhase)).toEqual(['routing', 'testing', 'reviewing', 'deploying', 'complete']);
    expect(workTraceDecals(trace).map((decal) => decal.label)).toEqual(['route', 'test', 'review', 'deploy', 'complete']);
  });

  it('previews and summarizes compactly', () => {
    // Newest useful line wins (live harness tails grow downward).
    expect(workTracePreview('line one\nline two')).toBe('line two');
    expect(workTracePreview('x'.repeat(200)).endsWith('…')).toBe(true);
    const trace = [
      msg({ id: '1', author: 'Sol', body: 'a', agentId: 'codex' }),
      msg({ id: '2', author: 'Terra', body: 'b', agentId: 'codex' }),
    ];
    expect(workTraceSummary(trace)).toContain('2 steps');
    expect(workTraceSummary(trace)).toContain('Sol');
  });

  it('suppresses prompt dumps and incomplete protocol in compact previews', () => {
    expect(workTraceHarnessPreview('# thinking\nYou are grok (@grok) in #dev\n[Context: secret]')).toBe('thinking…');
    expect(workTraceHarnessPreview('{"type":"item.started","item":')).toBe('');
    expect(workTracePreview('{"type":"item.started","item":')).toBe('');
  });

  it('humanizes protocol JSONL instead of dumping raw objects', () => {
    expect(humanizeActivityLine('{"type":"thread.started","thread_id":"abc"}')).toBe('session started');
    expect(humanizeActivityLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'rg "mission" client/src' },
    }))).toBe('Bash rg "mission" client/src');
    expect(humanizeActivityLine(JSON.stringify({
      type: 'item.started',
      item: { type: 'reasoning', text: '' },
    }))).toBe('thinking…');
    expect(humanizeActivityLine(JSON.stringify({
      type: 'item.completed',
      item: { type: 'file_change', path: '/home/jt/Desktop/cascade/client/src/App.tsx' },
    }))).toBe('edited src/App.tsx');
    // Never surface the full JSON blob.
    expect(workTracePreview('{"type":"thread.started","thread_id":"abc"}\n{"type":"item.started","item":{"type":"reasoning"}}'))
      .toBe('thinking…');
  });

  it('normalizes Claude reasoning, ANSI bytes, and streamed tool JSON in mission peeks', () => {
    const harness = [
      '\x1b[2m# thinking\x1b[0m',
      '\x1b[2mchecking the deploy configuration\x1b[0m',
      '\x1b[36m▶ Bash\x1b[0m',
      '\x1b[36m{"command":"python -c verify"}\x1b[0m',
    ].join('\r\n');
    expect(workTraceHarnessPreview(harness)).toBe('Bash python -c verify');
    expect(workTraceHarnessPreview(`${harness}\r\n\x1b[32m✓ tool_result\x1b[0m\r\nraw output`))
      .toBe('Bash done');
    expect(workTraceHarnessPreview('\x1b[2m# thinking\x1b[0m\r\n\x1b[2mchecking the deployment path\x1b[0m'))
      .toBe('checking the deployment path');
    expect(humanizeActivityLine('\x1b[36m{"type":"item.started","item":{"type":"reasoning","text":"checking"}}\x1b[0m'))
      .toBe('checking');
    expect(workTraceHarnessPreview('\x1b[36m▶ Bash\x1b[0m\r\n\x1b[36m{"command":"unterminated'))
      .toBe('Bash');
  });

  it('derives live chrome from the bounded recent harness tail', () => {
    const stalePrefix = 'deploying historical release output\n'.repeat(20_000);
    const current = JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'npm test' },
    });
    const neutralTail = 'ordinary command output\n'.repeat(1_000);
    const harness = `${stalePrefix}${neutralTail}${current}`;

    expect(workTraceHarnessPreview(harness)).toBe('Bash npm test');
    expect(workTracePhase(msg({
      id: 'long-live',
      author: 'Sol',
      body: 'Thinking…',
      status: 'running',
      harnessLog: harness,
    }))).toBe('testing');
  });

  it('builds a collapsed mission peek from the live step', () => {
    const peek = workTracePeek([
      msg({ id: '1', author: 'Sol', body: 'Queued', status: 'sending', missionTaskId: 't1' }),
      msg({
        id: '2',
        author: 'Terra',
        body: 'Thinking…',
        status: 'running',
        harnessLog: '{"type":"thread.started","thread_id":"x"}\nBash rg "mission" client/src',
      }),
    ]);
    expect(peek).toMatchObject({
      live: true,
      author: 'Terra',
      label: 'Working…',
      phase: 'working',
    });
    expect(peek?.summary).toContain('live');
    expect(peek?.decals.at(-1)?.label).toBe('work');
  });

});


it.each(['completed', 'canceled'] as const)('stops mission activity on %s even with a stale live trace', (status) => {
  const markup = renderToStaticMarkup(createElement(ChatMissionCard, {
    mission: {
      id: 'settled', rootMessageId: 'root', title: 'Fix it', objective: 'Fix it',
      status, coordinator: 'sol', coordinatorMention: 'sol', tasks: [],
      summary: 'Useful outcome', createdAt: '', updatedAt: '',
    },
    tracePeek: { live: true, author: 'Sol', label: 'Working…', summary: '', decals: [], phase: 'working' },
  }));
  expect(markup).not.toContain('thinking-spinner');
  expect(markup).not.toContain('Working…');
  expect(markup).toContain('Useful outcome');
});


it.each(['pending', 'running', 'blocked', 'failed', 'completed'] as const)('renders delegated %s state accurately', (status) => {
  const markup = renderToStaticMarkup(createElement(ChatMissionCard, {
    mission: {
      id: 'm', rootMessageId: 'root', title: 'Fix it', objective: 'Fix it',
      status: 'active', coordinator: 'astra', coordinatorMention: 'astra',
      summary: '', createdAt: '', updatedAt: '',
      tasks: [{ id: 'task', title: 'Verify it', assignee: 'astra', assigneeMention: 'astra',
        assigneeModel: '', status, summary: 'Choose which account to use', dependsOn: [], waitingFor: [],
        priority: 0, reasoningEffort: '', queueReason: '', attempt: 1, updatedAt: '' }],
    },
  }));
  expect(markup.includes('thinking-spinner')).toBe(status === 'running');
  if (status === 'pending') expect(markup).toContain('queued');
  if (status === 'blocked' || status === 'failed') {
    expect(markup).toContain('needs attention');
    expect(markup).toContain('Choose which account to use');
  }
});


it('keeps running work ahead of queued work and exposes settled failures', () => {
  const base = { channelId: 'room', author: 'Astra', body: '', createdAt: '', agentId: 'codex' };
  const running = { ...base, id: 'running', status: 'running' as const, missionTaskId: 'task' };
  const queued = { ...base, id: 'queued', status: 'queued' as const };
  expect(workTracePeek([running, queued])).toMatchObject({ label: 'Working…', phase: 'working' });
  expect(workTracePeek([queued])).toMatchObject({ label: 'Queued…', phase: 'routing' });
  expect(workTracePeek([{ ...base, id: 'failed', status: 'failed' }, { ...base, id: 'done' }]))
    .toMatchObject({ label: 'Failed', live: false, phase: 'blocked' });
});

it('shows a readable current paragraph only from public text blocks', () => {
  const running = msg({ id: 'stream', author: 'Sol', status: 'running', body: 'Thinking...', blocks: [
    { type: 'thinking', text: 'Private reasoning' },
    { type: 'text', text: 'Checking the public output' },
    { type: 'text', text: 'Redacted output', redacted: true },
  ] });
  expect(workTracePeek([running])?.label).toBe('Checking the public output');
  expect(workTracePeek([{ ...running, blocks: [{ type: 'text', text: 'x'.repeat(200) + 'newest output' }] }])?.label)
    .toBe('x'.repeat(200) + 'newest output');
  expect(workTracePeek([{ ...running, status: undefined }])?.label).toBe('Work details');
});

it('does not revive a blocked verification from a stale working trace', () => {
  const markup = renderToStaticMarkup(createElement(ChatMissionCard, {
    mission: {
      id: 'c43e70cb', rootMessageId: 'root', title: 'Verify restored working animation', objective: '',
      status: 'attention', coordinator: 'astra', coordinatorMention: 'astra',
      summary: '', createdAt: '', updatedAt: '',
      tasks: [{ id: 'e37c677b', title: 'Verify streaming decal', assignee: 'astra', assigneeMention: 'astra',
        assigneeModel: '', status: 'blocked', summary: 'No streaming response was visible.', dependsOn: [], waitingFor: [],
        priority: 0, reasoningEffort: '', queueReason: '', attempt: 0, updatedAt: '' }],
    },
    tracePeek: { live: true, author: 'Astra', label: 'Working…', summary: '', decals: [], phase: 'working' },
  }));
  expect(markup).toContain('needs attention');
  expect(markup).toContain('No streaming response was visible.');
  expect(markup).not.toContain('thinking-spinner');
  expect(markup).not.toContain('Working…');
  expect(markup).not.toContain('mission-status-completed');
});

it('shows the resumed task instead of the canceled prior attempt in the mission preview', () => {
  const markup = renderToStaticMarkup(createElement(ChatMissionCard, {
    mission: {
      id: 'resumed', rootMessageId: 'root', title: 'Resolve verification failure', objective: '',
      status: 'active', coordinator: 'astra', coordinatorMention: 'astra',
      summary: '', createdAt: '', updatedAt: '',
      tasks: [{ id: 'task', title: 'Repair and verify the UI', assignee: 'astra', assigneeMention: 'astra',
        assigneeModel: '', status: 'running', summary: '', dependsOn: [], waitingFor: [],
        priority: 0, reasoningEffort: '', queueReason: '', attempt: 1, updatedAt: '' }],
    },
    tracePeek: { live: false, author: 'Astra', label: 'Canceled', summary: '', decals: [], phase: 'canceled' },
  }));
  expect(markup).toContain('working');
  expect(markup).toContain('Repair and verify the UI');
  expect(markup).not.toContain('Canceled');
});


it('gives a mission and its bound worker one activity surface, preserving later answers and unrelated work', () => {
  const mission = msg({ id: 'root', author: 'Astra', agentId: 'codex', registrationId: 'astra', body: '', mission: {
    id: 'bf3a6199-8132-4e75-8e58-ec37c097e5a2', rootMessageId: 'root', title: 'Simplify worker guidance', objective: '',
    coordinator: 'Astra', coordinatorMention: 'astra', status: 'active', summary: '', createdAt: '', updatedAt: '',
    tasks: [{ id: 'worker-task', title: 'Consolidate worker context', assignee: 'Astra', assigneeMention: 'astra', assigneeModel: '', status: 'running', runId: 3477,
      summary: '', dependsOn: [], waitingFor: [], priority: 0, reasoningEffort: '', queueReason: '', attempt: 0, updatedAt: '' }],
  } });
  const assignment = msg({ id: 'mission-task-worker-task', author: 'Astra', agentId: 'codex', body: 'Instructions', missionTaskId: 'worker-task' });
  const worker = msg({ id: 'worker', author: 'Astra', agentId: 'codex', registrationId: 'astra', body: 'Packaging is still running.',
    status: 'running', missionTaskId: 'worker-task', runId: 3477, blocks: [{ type: 'text', text: 'Desktop packaging is still running for the helper prompt changes; I’m watching it through completion.' }] });
  const unrelated = msg({ id: 'other', author: 'Astra', agentId: 'codex', body: 'A separate answer', runId: 3480 });
  const identities = missionMessageIdentities([mission, assignment, worker, unrelated]);
  expect(identities.get(worker.id)).toMatchObject({ title: 'Simplify worker guidance', role: 'Worker' });
  expect(identities.has(unrelated.id)).toBe(false);
  const segments = segmentTranscript([mission, assignment, worker, unrelated]);
  expect(segments).toHaveLength(2);
  expect(segments[0]).toMatchObject({ kind: 'work', carrier: { id: 'root' }, trace: [assignment, worker] });
  expect(segments[1]).toMatchObject({ kind: 'group', group: { messages: [unrelated] } });
  const card = renderToStaticMarkup(createElement(ChatMissionCard, { mission: mission.mission!, tracePeek: workTracePeek([worker]) }));
  expect(card).toContain(missionAccent(mission.mission!.id));
  expect(card.match(/class="[^"]*thinking-spinner/g)).toHaveLength(1);
  expect(card).toContain('Consolidate worker context');
  expect(card).toContain('Desktop packaging is still running');
  expect(card).not.toContain('chat-working-output');
  const answer = { ...worker, status: undefined, body: 'Delivered the helper changes.' };
  const settled = segmentTranscript([mission, assignment, answer, unrelated]);
  expect(settled.some((segment) => segment.kind === 'group' && segment.group.messages.includes(answer))).toBe(true);

});

it('keeps coordinator explanations linked to the same identity without borrowing nearby mission work', () => {
  const id = 'bf3a6199-8132-4e75-8e58-ec37c097e5a2';
  const root = msg({ id: 'root', author: 'Astra', body: '', mission: {
    id, rootMessageId: 'root', title: 'Coordinator ownership', objective: '', coordinator: 'Astra', coordinatorMention: 'astra', status: 'completed',
    summary: '', createdAt: '', updatedAt: '', tasks: [],
  } });
  const wake = msg({ id: `sys-mission-${id}-interpret-1`, author: 'Astra', agentId: 'codex', body: 'Interpret results' });
  const response = msg({ id: 'reply', author: 'Astra', agentId: 'codex', body: 'Comparing the delivered result', status: 'running',
    replyTo: { messageId: wake.id, author: 'Astra', mention: 'astra', preview: '' } });
  const explanation = msg({ id: `mission-explanation-${id}-1`, author: 'Astra', agentId: 'codex', body: 'Delivered; here is what changed.' });
  const identities = missionMessageIdentities([root, wake, response, explanation]);
  expect(identities.get(response.id)).toMatchObject({ id, role: 'Coordinator' });
  expect(identities.get(explanation.id)).toMatchObject({ id, role: 'Coordinator' });
  expect(missionAccent(id)).toBe(missionAccent(id));
});
