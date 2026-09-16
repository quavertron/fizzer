import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, type NoteSummary } from '../api';
import { cancelLocalAgentRun } from '../localAgentRunner';
import { useChatDispatch } from '../chat/dispatch';
import { chatMessageStore } from '../chat/messageStore';
import { emptyChatState } from '../chat/session';
import type { ChatAgentRegistration, ChatMessage } from '../chat/types';

vi.mock('../api', async (original) => ({ ...await original<typeof import('../api')>(), api: vi.fn() }));
vi.mock('../localAgentRunner', () => ({ isLocalRunId: (id: number) => id < 0, cancelLocalAgentRun: vi.fn() }));
const registration = { id: 'sol', agentId: 'codex', displayName: 'Sol', mention: 'sol', cwd: '', conversationId: 'conversation' } as ChatAgentRegistration;
const trigger: ChatMessage = { id: 'human', channelId: 'channel', author: 'Alice', body: '@sol fix it', createdAt: '2026-09-01T00:00:00Z' };
const ref = <T,>(current: T) => ({ current });

function setup() {
  chatMessageStore.set('channel', []);
  let dispatch!: ReturnType<typeof useChatDispatch>;
  const setChatState = vi.fn();
  const setNotice = vi.fn();
  function Harness() {
    dispatch = useChatDispatch({
      activeVaultIdRef: ref<string | null>('vault'), notesRef: ref([{ id: 'channel' } as NoteSummary]),
      chatStateRef: ref({ ...emptyChatState(), registeredAgentsByChannel: { channel: [registration] } }),
      user: { username: 'Alice' }, setChatState, setNotice,
    });
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return { dispatch, setChatState, setNotice };
}

afterEach(() => vi.resetAllMocks());

describe('chat mutations without browser scheduling', () => {
  it('persists the human prompt and leaves queued projections to the server', async () => {
    const { dispatch } = setup();
    vi.mocked(api).mockImplementation(async (_path, options) => ({
      message: { ...JSON.parse(options!.body as string), seq: 1 }, agents: [registration],
      dispatches: [{ id: 'dispatch', runId: null, registration }],
    }));
    dispatch.handleSendChatMessage('channel', trigger.body);
    await vi.waitFor(() => expect(chatMessageStore.getChannel('channel')[0].seq).toBe(1));
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/vaults/vault/channels/channel/messages', expect.objectContaining({ method: 'POST' }));
    expect(chatMessageStore.getChannel('channel')).toHaveLength(1);
    expect(chatMessageStore.getChannel('channel')[0].agentId).toBeUndefined();
  });

  it.each(['/clear', ' /RESET @sol ', '/compact'])('posts %s as its own durable action and refreshes returned agents', async (command) => {
    const { dispatch, setChatState } = setup();
    const previous = { ...trigger, body: 'hello', createdAt: new Date().toISOString() };
    chatMessageStore.set('channel', [previous]);
    const agents = [{ ...registration, conversationId: 'server-generation' }];
    vi.mocked(api).mockImplementation(async (_path, options) => ({
      message: JSON.parse(options!.body as string), agents, dispatches: [],
    }));
    dispatch.handleSendChatMessage('channel', command);
    await vi.waitFor(() => expect(setChatState).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/vaults/vault/channels/channel/messages', expect.objectContaining({
      method: 'POST', body: expect.stringContaining(command.trim()),
    }));
    expect(chatMessageStore.getChannel('channel').map((message) => message.body)).toEqual(['hello', command.trim()]);
    expect(setChatState.mock.calls[0][0](emptyChatState()).registeredAgentsByChannel.channel).toEqual(agents);
    expect(registration.conversationId).toBe('conversation');
  });

  it('posts clear then an unmentioned ping without merging while clear is pending', async () => {
    const { dispatch } = setup();
    let finishClear!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(() => new Promise((resolve) => { finishClear = resolve; }));
    vi.mocked(api).mockImplementation(async (_path, options) => ({ message: JSON.parse(options!.body as string) }));
    dispatch.handleSendChatMessage('channel', '/clear');
    dispatch.handleSendChatMessage('channel', 'ping');
    expect(api).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api).mock.calls.map(([, options]) => [options?.method, JSON.parse(options!.body as string).body]))
      .toEqual([['POST', '/clear'], ['POST', 'ping']]);
    finishClear({ message: chatMessageStore.getChannel('channel')[0], dispatches: [] });
    await vi.waitFor(() => expect(chatMessageStore.getChannel('channel')).toHaveLength(2));
  });

  it.each([true, false])('updates legacy local runs only after successful IPC cancel (%s)', async (success) => {
    const { dispatch } = setup();
    chatMessageStore.set('channel', [{ ...trigger, runId: -7, status: 'running', body: 'Thinking...' }]);
    vi.mocked(cancelLocalAgentRun).mockResolvedValueOnce(success);
    expect(await dispatch.handleCancelChatRun(-7)).toBe(success);
    expect(chatMessageStore.getChannel('channel')[0].status).toBe(success ? 'canceled' : 'running');
    expect(api).not.toHaveBeenCalled();
  });

  it.each([true, false])('leaves remote projection changes to the server after cancel (%s)', async (success) => {
    const { dispatch } = setup();
    const rows: ChatMessage[] = [{ ...trigger, runId: 7, status: 'running', agentId: 'codex' }];
    chatMessageStore.set('channel', rows);
    vi.mocked(api).mockResolvedValueOnce({ success });
    expect(await dispatch.handleCancelChatRun(7)).toBe(success);
    expect(api).toHaveBeenCalledExactlyOnceWith('/api/runs/7/cancel', { method: 'POST' });
    expect(chatMessageStore.getChannel('channel')).toBe(rows);
  });
});
