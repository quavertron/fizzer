import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  bodyHasNoteRefs,
  findEmbeddedNote,
  splitDocEmbeds,
  splitWikilinks,
} from '../docEmbeds';
import type { ChatMessage } from '../chat/types';
import { ChatView } from '../components/ChatView';
import { chatMessageStore } from '../chat/messageStore';

describe('splitDocEmbeds / splitWikilinks', () => {
  it('splits block embeds', () => {
    const parts = splitDocEmbeds('See ![[One Room]] please');
    expect(parts).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'embed', value: 'One Room' },
      { type: 'text', value: ' please' },
    ]);
  });

  it('splits inline wikilinks with colons in titles', () => {
    const body = 'Made [[One Room: social presence without audience capture]]. Done.';
    expect(bodyHasNoteRefs(body)).toBe(true);
    expect(splitWikilinks(body)).toEqual([
      { type: 'text', value: 'Made ' },
      { type: 'wikilink', value: 'One Room: social presence without audience capture' },
      { type: 'text', value: '. Done.' },
    ]);
  });

  it('does not treat embeds as wikilinks', () => {
    // After embed split, residual text has no wikilink; raw still has ![[.
    const raw = 'x ![[Embedded Note]] y';
    const textOnly = splitDocEmbeds(raw)
      .filter((p) => p.type === 'text')
      .map((p) => p.value)
      .join('');
    expect(splitWikilinks(textOnly)).toEqual([{ type: 'text', value: 'x  y' }]);
  });

  it('preserves prose and raw embeds while splitting adjacent citations repeatedly', () => {
    const text = 'Before ![[Card]] [[One]][[Two|alias]] after';
    for (let i = 0; i < 3; i++) {
      expect(bodyHasNoteRefs(text)).toBe(true);
      expect(splitWikilinks(text)).toEqual([
        { type: 'text', value: 'Before ![[Card]] ' },
        { type: 'wikilink', value: 'One' },
        { type: 'wikilink', value: 'Two' },
        { type: 'text', value: ' after' },
      ]);
      expect(splitDocEmbeds('![[Card]]![[Other#section]]')).toEqual([
        { type: 'embed', value: 'Card' }, { type: 'embed', value: 'Other' },
      ]);
    }
  });

  it('leaves empty, incomplete, and multiline references as prose', () => {
    for (const text of ['', '[[]]', '[[unfinished', '[[line\nbreak]]']) {
      expect(bodyHasNoteRefs(text)).toBe(false);
      expect(splitWikilinks(text)).toEqual([{ type: 'text', value: text }]);
      expect(splitDocEmbeds(text)).toEqual([{ type: 'text', value: text }]);
    }
  });

  it('resolves notes by title case-insensitively', () => {
    const notes = [
      { id: '1', title: 'One Room: social presence without audience capture', content_preview: '' },
    ] as any;
    expect(findEmbeddedNote(notes, 'one room: social presence without audience capture')?.id).toBe('1');
  });

  it('normalizes aliases and section targets identically for cards and citations', () => {
    const target = 'Team plan';
    expect(splitDocEmbeds('![[Team plan|the plan]] ![[Team plan#launch]]'))
      .toEqual([
        { type: 'embed', value: target },
        { type: 'text', value: ' ' },
        { type: 'embed', value: target },
      ]);
    expect(splitWikilinks('[[Team plan#launch]]')).toEqual([{ type: 'wikilink', value: target }]);
  });

  it('renders an actual in-chat embed card with a note preview', () => {
    const channelId = 'embed-channel';
    const message: ChatMessage = {
      id: 'embed-message', channelId, author: 'asdfasdf', body: 'Read ![[Team plan|the plan]].', createdAt: 'now',
    };
    chatMessageStore.set(channelId, [message]);
    const markup = renderToStaticMarkup(createElement(ChatView, {
      channelId,
      channelName: 'cascade-dev',
      currentUser: 'asdfasdf',
      presence: { participants: [], online: [] },
      availableAgents: [],
      registeredAgents: [],
      onRegisterAgent: () => {}, onRemoveAgent: () => {},
      onInviteUser: async () => {},
      onSendMessage: () => {}, onCancelRun: () => {},
      notes: [{
        id: 'plan', vault_id: 'vault', folder_id: null, title: 'Team plan', content_preview: 'Launch checklist',
        is_pinned: 0, is_archived: 0, is_listed: 1, position: 0, word_count: 2,
        created_at: 'now', updated_at: 'now', tags: [],
      }],
      onOpenNote: () => {},
    }));
    expect(markup).toContain('chat-doc-embed');
    expect(markup).toContain('Team plan');
    expect(markup).toContain('Launch checklist');
  });
});
