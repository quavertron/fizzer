import { describe, expect, it } from 'vitest';
import {
  DOCUMENTATION_CONVERSATIONS_STORAGE_KEY,
  buildDocumentationIssuePrompt,
  buildDocumentationPrompt,
  createDocumentationConversation,
  documentationConversationTitle,
  isDocumentationIssueRequest,
  loadDocumentationConversations,
  parseDocumentationIssueDraft,
  reduceDocumentationEvent,
  saveDocumentationConversations,
  type DocumentationAssistantTurn,
  type DocumentationConversation,
} from '../documentationAssistant';

function memoryStorage(seed?: string) {
  const values = new Map<string, string>();
  if (seed !== undefined) values.set(DOCUMENTATION_CONVERSATIONS_STORAGE_KEY, seed);
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe('documentation assistant local conversations', () => {
  it('creates an empty conversation and derives a compact first-question title', () => {
    const conversation = createDocumentationConversation(1_700_000_000_000);

    expect(conversation.title).toBe('New conversation');
    expect(conversation.turns).toEqual([]);
    expect(conversation.createdAt).toBe('2023-11-14T22:13:20.000Z');
    expect(documentationConversationTitle('  A useful question  ')).toBe('A useful question');
    expect(documentationConversationTitle('x'.repeat(80))).toBe(`${'x'.repeat(51)}…`);
  });

  it('round-trips valid history, recovers interrupted streams, and bounds saved data', () => {
    const storage = memoryStorage();
    const conversations: DocumentationConversation[] = Array.from({ length: 52 }, (_, conversationIndex) => ({
      id: `conversation-${conversationIndex}`,
      title: `Conversation ${conversationIndex}`,
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z',
      turns: Array.from({ length: 102 }, (_, turnIndex) => ({
        id: `turn-${conversationIndex}-${turnIndex}`,
        role: turnIndex % 2 === 0 ? 'user' as const : 'assistant' as const,
        body: turnIndex === 101 ? 'x'.repeat(20_100) : `turn ${turnIndex}`,
        status: turnIndex === 101 ? 'streaming' as const : 'completed' as const,
      })),
    }));

    saveDocumentationConversations(conversations, storage);
    const raw = JSON.parse(storage.getItem(DOCUMENTATION_CONVERSATIONS_STORAGE_KEY) || '[]') as DocumentationConversation[];
    const loaded = loadDocumentationConversations(storage);

    expect(raw).toHaveLength(50);
    expect(raw[0].turns).toHaveLength(100);
    expect(raw[0].turns[raw[0].turns.length - 1]?.body).toHaveLength(20_000);
    expect(loaded).toHaveLength(50);
    expect(loaded[0].turns[loaded[0].turns.length - 1]?.status).toBe('failed');
  });

  it('falls back to a usable empty conversation when storage is malformed', () => {
    const storage = memoryStorage('{not-json');

    const loaded = loadDocumentationConversations(storage);

    expect(loaded).toHaveLength(1);
    expect(loaded[0].title).toBe('New conversation');
    expect(loaded[0].turns).toEqual([]);
  });
});

describe('documentation assistant issue intent', () => {
  it('recognizes natural creation commands without hijacking help questions', () => {
    expect(isDocumentationIssueRequest('Please file a GitHub issue for this sync crash')).toBe(true);
    expect(isDocumentationIssueRequest('Could you turn this into a feature request?')).toBe(true);
    expect(isDocumentationIssueRequest('Bug report: the history button loses my messages')).toBe(true);
    expect(isDocumentationIssueRequest('How do I create a GitHub issue?')).toBe(false);
    expect(isDocumentationIssueRequest('Why does the guide mention issue labels?')).toBe(false);
  });

  it('builds a draft prompt from only the supplied active conversation', () => {
    const activeHistory: DocumentationAssistantTurn[] = [
      { id: 'current-user', role: 'user', body: 'The current conversation marker', status: 'completed' },
      { id: 'current-guide', role: 'assistant', body: 'Current Guide answer', status: 'completed' },
    ];
    const otherConversation: DocumentationAssistantTurn[] = [
      { id: 'private-other', role: 'user', body: 'OTHER CONVERSATION SECRET', status: 'completed' },
    ];

    const prompt = buildDocumentationIssuePrompt('# Public guide', 'Please file an issue', activeHistory);

    expect(prompt).toContain('The current conversation marker');
    expect(prompt).toContain('Please file an issue');
    expect(prompt).not.toContain(otherConversation[0].body);
    expect(prompt).toContain('Use only the current Fizzer Guide conversation');
    expect(prompt).toContain('Return exactly one JSON object');
  });
});

describe('documentation assistant issue drafts', () => {
  const history: DocumentationAssistantTurn[] = [
    { id: 'u1', role: 'user', body: 'Search crashes when I type a colon', status: 'completed' },
    { id: 'a1', role: 'assistant', body: 'Search should keep filtering.', status: 'completed' },
  ];
  const request = 'Please create a bug report for this';

  it('accepts only a strict complete JSON object', () => {
    const draft = parseDocumentationIssueDraft(
      JSON.stringify({ title: 'Search crashes on colon', body: '## Observed\nSearch closes.', label: 'bug' }),
      history,
      request,
    );

    expect(draft).toEqual({
      title: 'Search crashes on colon',
      body: '## Observed\nSearch closes.',
      label: 'bug',
    });
  });

  it('uses the same deterministic editable fallback for fenced, partial, or malformed output', () => {
    const fenced = parseDocumentationIssueDraft(
      '```json\n{"title":"Unsafe partial","body":"Body","label":"bug"}\n```',
      history,
      request,
    );
    const partial = parseDocumentationIssueDraft('{"title":"Only a title"}', history, request);
    const malformed = parseDocumentationIssueDraft('not json', history, request);

    expect(fenced).toEqual(partial);
    expect(partial).toEqual(malformed);
    expect(malformed.title).toBe('Search crashes when I type a colon');
    expect(malformed.label).toBe('bug');
    expect(malformed.body).toContain('## Guide conversation');
    expect(malformed.body).toContain('Search crashes when I type a colon');
  });
});

describe('documentation assistant prompt context', () => {
  it('includes the guide, current question, and bounded recent history', () => {
    const history: DocumentationAssistantTurn[] = [
      { id: 'u1', role: 'user', body: 'old question', status: 'completed' },
      { id: 'a1', role: 'assistant', body: 'old answer', status: 'completed' },
    ];
    const prompt = buildDocumentationPrompt('# Guide\nUse notes.', 'How do notes work?', history);

    expect(prompt).toContain('<fizzer-guide>\n# Guide\nUse notes.\n</fizzer-guide>');
    expect(prompt).toContain('How do notes work?');
    expect(prompt).toContain('old question');
    expect(prompt).toContain('Do not inspect or modify files');
  });

  it('limits history by turn count and character budget', () => {
    const history = Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      body: `${index}:${'x'.repeat(2_000)}`,
      status: 'completed' as const,
    }));
    const prompt = buildDocumentationPrompt('guide', 'question', history);

    expect(prompt).not.toContain('0:');
    expect(prompt).toContain('9:');
    expect(prompt.length).toBeLessThan(7_000);
  });
});

describe('documentation assistant run events', () => {
  it('accumulates visible text and ignores reasoning-only events', () => {
    const initial = { answer: '', status: 'queued' as const, seenSeqs: new Set<number>() };
    const hidden = reduceDocumentationEvent(initial, {
      seq: 1,
      type: 'text',
      payload_json: JSON.stringify({ chatVisible: false, message: { content: 'hidden' } }),
    });
    const visible = reduceDocumentationEvent(hidden, {
      seq: 2,
      type: 'text',
      payload_json: JSON.stringify({ chatVisible: true, message: { content: [{ type: 'text', text: 'Answer' }] } }),
    });

    expect(hidden.answer).toBe('');
    expect(visible.answer).toBe('Answer');
    expect(visible.status).toBe('running');
  });

  it('deduplicates replayed events and settles terminal status', () => {
    const initial = { answer: '', status: 'running' as const, seenSeqs: new Set<number>() };
    const first = reduceDocumentationEvent(initial, {
      seq: 4,
      type: 'text',
      payload_json: JSON.stringify({ chatVisible: true, message: { content: [{ type: 'text', text: 'Done' }] } }),
    });
    const duplicate = reduceDocumentationEvent(first, {
      seq: 4,
      type: 'text',
      payload_json: JSON.stringify({ chatVisible: true, message: { content: [{ type: 'text', text: 'Done' }] } }),
    });
    const completed = reduceDocumentationEvent(duplicate, {
      seq: 5,
      type: 'status',
      payload_json: JSON.stringify({ status: 'completed', summary: 'Finished' }),
    });

    expect(duplicate.answer).toBe('Done');
    expect(completed.status).toBe('completed');
    expect(completed.terminal).toBe('Finished');
  });
});
