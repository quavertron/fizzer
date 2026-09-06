import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CascadeRunPanel } from '../components/CascadeRunPanel';
import {
  buildHarnessActivity,
  hasRunActivity,
  liveActivityHeadline,
  summarizeActivity,
} from '../chat/harnessActivity';
import { normalizeChatRunBlocks } from '../chat/runBlocks';
import type { ChatMessage } from '../chat/types';

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    channelId: 'c1',
    author: 'Agent',
    body: '',
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('normalizeChatRunBlocks', () => {
  it('keeps tool_use and tool_result blocks', () => {
    const blocks = normalizeChatRunBlocks([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toMatchObject({ type: 'tool_use', id: 't1', name: 'Bash' });
    expect(blocks[2]).toMatchObject({ type: 'tool_result', toolUseId: 't1', content: 'ok' });
  });


});

describe('buildHarnessActivity', () => {
  it.each([false, true])('retains tail usage after a truncated JSON head (structured: %s)', (structured) => {
    const message = msg({
      blocks: structured ? [
        { type: 'thinking', text: 'Checking' },
        { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      ] : [],
      harnessLog: [
        '# cwd /project',
        JSON.stringify({ type: 'assistant', text: 'x'.repeat(structured ? 12_000 : 44_000) }),
        JSON.stringify({ type: 'result', usage: { input_tokens: 1234, output_tokens: 56 } }),
      ].join('\n'),
    });
    expect(buildHarnessActivity(message).stats).toMatchObject({
      cwd: '/project', inputTokens: 1234, outputTokens: 56,
    });
  });

  it('reflects same-length replacements instead of reusing stale activity', () => {
    const first = msg({ status: 'running', blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'old.ts' } }] });
    expect(buildHarnessActivity(first).items[0].text).toBe('old.ts');
    const next = { ...first, blocks: [{ ...first.blocks![0], input: { path: 'new.ts' } }] };
    expect(buildHarnessActivity(next).items[0].text).toBe('new.ts');
    first.blocks![0].input = { path: 'now.ts' };
    expect(buildHarnessActivity(first).items[0].text).toBe('now.ts');
  });

  it('retains fallback tools and usage when only reasoning is structured', () => {
    const activity = buildHarnessActivity(msg({
      status: 'running',
      blocks: [{ type: 'thinking', text: 'Checking' }],
      harnessLog: [
        JSON.stringify({ type: 'item.completed', item: { id: 't1', type: 'command_execution', command: 'npm test', aggregated_output: 'failed assertion', exit_code: 1 } }),
        JSON.stringify({ type: 'result', usage: { input_tokens: 123, output_tokens: 45 } }),
      ].join('\n'),
    }));
    expect(activity.stats).toMatchObject({ toolCount: 1, inputTokens: 123, outputTokens: 45 });
    expect(activity.items.find((item) => item.tool)?.tool).toMatchObject({ status: 'error', result: 'failed assertion' });
  });

  it('retains fallback reasoning when only tools are structured', () => {
    const activity = buildHarnessActivity(msg({
      blocks: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }],
      harnessLog: '# thinking\nchecking fallback reasoning\n# result',
    }));
    expect(activity.thinkingText).toBe('checking fallback reasoning');
  });
  it('builds timeline from structured blocks', () => {
    const activity = buildHarnessActivity(msg({
      blocks: [
        { type: 'thinking', text: 'plan a' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cascade-chat history' } },
        { type: 'tool_result', toolUseId: 't1', content: '[]', isError: false },
      ],
    }));
    expect(activity.stats.hasThinking).toBe(true);
    expect(activity.stats.toolCount).toBe(1);
    expect(activity.items.some((i) => i.kind === 'tool' && i.title === 'Bash')).toBe(true);
    const tool = activity.items.find((i) => i.kind === 'tool')?.tool;
    expect(tool?.status).toBe('done');
    expect(tool?.result).toBe('[]');
  });

  it('keeps Claude reasoning readable in the structured activity view', () => {
    const activity = buildHarnessActivity(msg({
      agentId: 'claude-code',
      blocks: [
        { type: 'thinking', text: 'checking the deploy configuration' },
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } },
      ],
      harnessLog: [
        '\x1b[2m# thinking\x1b[0m',
        '\x1b[2mchecking the deploy configuration\x1b[0m',
        '\x1b[36m▶ Bash\x1b[0m',
        '\x1b[36m{"command":"npm test"}\x1b[0m',
      ].join('\r\n'),
    }));
    expect(activity.thinkingText).toBe('checking the deploy configuration');
    expect(activity.items.find((item) => item.kind === 'thinking')?.text)
      .toBe('checking the deploy configuration');
  });

  it('parses cascade-stats and builds token, context, and cost chips', async () => {
    const { buildHeaderStatChips } = await import('../chat/harnessActivity');
    const activity = buildHarnessActivity(msg({
      harnessLog: [
        '# claude-code claude-sonnet-4 · /home/jt/proj',
        '# cascade-stats {"model":"claude-sonnet-4","maxTurns":30}',
        '# cascade-stats {"inputTokens":1200,"outputTokens":80,"totalCostUsd":0.012,"durationMs":4500,"numTurns":4,"contextWindow":200000,"contextUsed":42000}',
        '# cascade-stats {"rateLimitType":"five_hour","rateLimitUtilization":62,"rateLimitResetsAt":"2026-07-10T20:00:00.000Z","rateLimitStatus":"allowed"}',
        '# exit 0',
      ].join('\n'),
    }));
    expect(activity.stats.model).toBe('claude-sonnet-4');
    expect(activity.stats.cwd).toContain('/home/jt/proj');
    expect(activity.stats.inputTokens).toBe(1200);
    expect(activity.stats.outputTokens).toBe(80);
    expect(activity.stats.totalCostUsd).toBe(0.012);
    expect(activity.stats.durationMs).toBe(4500);
    expect(activity.stats.numTurns).toBe(4);
    expect(activity.stats.maxTurns).toBe(30);
    expect(activity.stats.contextWindow).toBe(200000);
    expect(activity.stats.contextUsed).toBe(42000);
    expect(activity.stats.contextPct).toBeCloseTo(21, 0);
    expect(activity.stats.rateLimitType).toBe('five_hour');
    expect(activity.stats.rateLimitUtilization).toBe(62);
    const chips = buildHeaderStatChips(activity.stats);
    expect(chips.some((c) => c.id === 'tok' && /tok/.test(c.label))).toBe(true);
    expect(chips.some((c) => c.id === 'ctx' && /ctx/.test(c.label))).toBe(true);
    expect(chips.some((c) => c.id === 'cost' && c.label.startsWith('$'))).toBe(true);
  });

  it('shows the live tool argument in the compact header', () => {
    const activity = buildHarnessActivity(msg({
      blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }],
      harnessLog: '# cascade-stats {"model":"claude-opus-4-8","rateLimitType":"five_hour","rateLimitUtilization":1,"rateLimitResetsAt":"2026-08-09T07:50:00.000Z","rateLimitStatus":"allowed_warning","overageInUse":true}\n',
    }));
    expect(liveActivityHeadline(activity)).toEqual({ verb: 'Bash', detail: 'npm test' });
    expect(summarizeActivity(activity, true)).toBe('Bash npm test');
  });

  it('prefers a running tool over an earlier thought', () => {
    const activity = buildHarnessActivity(msg({
      blocks: [
        { type: 'thinking', text: 'I should inspect the collapsed header next.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'client/src/index.css' } },
      ],
    }));
    expect(liveActivityHeadline(activity)).toEqual({
      verb: 'Read',
      detail: 'client/src/index.css',
    });
  });

  it('does not swallow pretty-printed Codex protocol JSON as a { chip', () => {
    const activity = buildHarnessActivity(msg({
      status: 'running',
      harnessLog: [
        '{',
        '  "type": "item.started",',
        '  "item": { "type": "reasoning", "text": "checking the vault rail spacing" }',
        '}',
      ].join('\n'),
    }));
    const live = liveActivityHeadline(activity);
    expect(live.verb).toBe('thinking');
    expect(live.detail).toContain('vault rail');
    expect(live.detail).not.toMatch(/^\{/);
    expect(activity.thinkingText).toContain('vault rail');
  });

  it('advances the original trailing live window as a text block grows', () => {
    const text = 'Earlier context '.repeat(20) + 'MOVING words at the live edge';
    const headline = (text: string) => liveActivityHeadline(buildHarnessActivity(msg({
      status: 'running', blocks: [{ type: 'thinking', text }],
    }))).detail;
    const first = headline(text);
    const next = headline(text + ' next');
    expect(first).toHaveLength(88);
    expect(next).toHaveLength(88);
    expect(next.endsWith(' next')).toBe(true);
    expect(next.indexOf('MOVING')).toBeLessThan(first.indexOf('MOVING'));
  });

  it('hides raw JSON blobs from the live header', () => {
    const activity = buildHarnessActivity(msg({
      status: 'running',
      blocks: [{ type: 'thinking', text: '{"type":"item.started","item":{"type":"reasoning"}}' }],
    }));
    const live = liveActivityHeadline(activity);
    expect(live.verb).toBe('thinking');
    expect(live.detail).not.toMatch(/^\{/);
  });

  it('keeps prompt dumps out of the live thinking header', () => {
    const activity = buildHarnessActivity(msg({
      blocks: [{
        type: 'thinking',
        text: 'You are grok (@grok) in #devspam\n[Context: Shared room delta]\nnevermind',
      }],
    }));
    expect(liveActivityHeadline(activity)).toEqual({ verb: 'thinking', detail: '' });
    expect(summarizeActivity(activity, true)).toBe('thinking');
  });

  it('falls back to codex JSONL tools when blocks are empty', () => {
    const activity = buildHarnessActivity(msg({
      harnessLog: JSON.stringify({
        type: 'item.started',
        item: { id: 'i1', type: 'command_execution', command: 'echo hi' },
      }) + '\n' + JSON.stringify({
        type: 'item.completed',
        item: { id: 'i1', type: 'command_execution', command: 'echo hi', aggregated_output: 'hi', exit_code: 0 },
      }),
    }));
    expect(activity.stats.toolCount).toBe(1);
    expect(activity.items[0]?.title).toBe('Bash');
  });

  it('keeps launch metadata and recent events when harness logs are large', () => {
    const recentEvent = JSON.stringify({
      type: 'item.completed',
      item: { id: 'recent', type: 'command_execution', command: 'echo recent', aggregated_output: 'ok', exit_code: 0 },
    });
    const activity = buildHarnessActivity(msg({
      harnessLog: `$ codex exec --json\n# cwd /home/jt/project\n${'old output\n'.repeat(9_000)}${recentEvent}\n`,
    }));
    expect(activity.stats.command).toBe('codex exec --json');
    expect(activity.stats.cwd).toBe('/home/jt/project');
    expect(activity.items.some((item) => item.tool?.input === 'echo recent')).toBe(true);
  });

  it('keeps activity for empty-body cascade-chat shells', () => {
    const m = msg({
      agentId: 'claude-code',
      runId: 9,
      body: '',
      blocks: [{ type: 'thinking', text: 'still here' }],
    });
    expect(hasRunActivity(m)).toBe(true);
    expect(summarizeActivity(buildHarnessActivity(m), false)).toMatch(/thought/i);
  });
});

describe('CascadeRunPanel raw fallback', () => {
  it('treats a raw CLI launch and heartbeat as live activity', () => {
    const markup = renderToStaticMarkup(createElement(CascadeRunPanel, {
      message: msg({
        status: 'running',
        runId: 1,
        harnessLog: [
          '$ akron --grok -z task --yolo',
          '# cwd /home/jt/Desktop/cascade',
          '# Akron --grok still working · 15s without provider output',
        ].join('\n'),
      }),
      onCancelRun: () => {},
      forceOpen: true,
    }));
    expect(markup).toContain('crp-live-verb');
    expect(markup).toContain('Akron --grok still working');
    expect(markup).toContain('$ akron --grok -z task --yolo');
    expect(markup).toContain('Akron --grok still working');
    expect(markup).not.toContain('waiting for harness stream…');
  });

  it('hides prompt-context thinking from the expanded harness', () => {
    const markup = renderToStaticMarkup(createElement(CascadeRunPanel, {
      message: msg({
        status: 'running',
        runId: 1,
        blocks: [{
          type: 'thinking',
          text: 'You are grok (@grok) in #devspam\n[Context: Shared room delta]\nAgent memory (vault)',
        }],
      }),
      onCancelRun: () => {},
      forceOpen: true,
    }));
    expect(markup).toContain('thinking…');
    expect(markup).not.toContain('Agent memory (vault)');
    expect(markup).not.toContain('Shared room delta');
  });

  it('shows the current command on the collapsed live header', () => {
    const markup = renderToStaticMarkup(createElement(CascadeRunPanel, {
      message: msg({
        status: 'running',
        runId: 1,
        blocks: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test --filter harnessActivity' } }],
      }),
      onCancelRun: () => {},
    }));
    expect(markup).toContain('crp-live-verb');
    expect(markup).toContain('Bash');
    expect(markup).toContain('npm test --filter harnessActivity');
    expect(markup).toContain('Stop');
  });

  it('hides a live unstructured protocol preamble until harness activity arrives', () => {
    const markup = renderToStaticMarkup(createElement(CascadeRunPanel, {
      message: msg({
        status: 'running',
        runId: 1,
        harnessLog: '{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}\n',
      }),
      onCancelRun: () => {},
    }));
    expect(markup).toContain('Starting…');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain('crp-raw-wrap');
  });
});
