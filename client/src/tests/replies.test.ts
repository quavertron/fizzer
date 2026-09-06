import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildReplyPreview, buildReplyRef } from '../chat/replies';
import type { ChatMessage } from '../chat/types';
import { ChatQuoteRefs } from '../components/ChatQuoteRefs';

const marker = '<!-- fizzer-next:msg-1788698344022-hol6pj -->';
const message: ChatMessage = {
  id: 'agent-dispatch-0d7b7e23-1ae3-4b66-a603-690b8bfb4520',
  channelId: 'channel', author: 'Astra', createdAt: '',
  body: `${marker}\n\nCorrect—it remained unresolved.`,
};

describe('reply preview control metadata', () => {
  it('filters the reported marker before truncation without mutating content or links', () => {
    const source = { ...message, body: `${marker}\n\n${'Visible '.repeat(30)}` };
    const reply = buildReplyRef(source, []);
    expect(reply).toEqual({ messageId: source.id, author: 'Astra', mention: 'astra',
      preview: `${'Visible '.repeat(30).slice(0, 119)}…` });
    expect(source.body).toContain(marker);
  });

  it.each([marker, '<!-- fizzer-next-feedback:source -->', '<!-- fizzer-next-none:source -->',
    '<!-- fizzer-next:msg-1788698344022-hol6pj', '<!-- fizzer-next-feedback:source --'])
  ('hides complete and truncated saved markers in both quote variants: %s', (control) => {
    for (const canJumpToReply of [true, false]) {
      const replyTo = { messageId: message.id, author: 'Astra', mention: 'astra',
        preview: `Correct—it remained unresolved. ${control}` };
      const html = renderToStaticMarkup(createElement(ChatQuoteRefs, {
        message: { ...message, replyTo }, canJumpToReply, onJumpToMessage() {},
      }));
      expect(html).toContain('Correct—it remained unresolved.');
      expect(html).not.toContain('fizzer-next');
      expect(html.includes('<button')).toBe(canJumpToReply);
      expect(replyTo.preview).toContain(control);
    }
    expect(buildReplyPreview({ ...message, body: `Visible ${control}` })).toBe('Visible');
  });

  it('preserves ordinary HTML, comments and code and retains empty-body fallback', () => {
    const body = '<div>hello</div> <!-- ordinary comment --> `a < b`';
    expect(buildReplyPreview({ ...message, body })).toBe(body);
    expect(buildReplyPreview({ ...message, body: marker })).toBe('(message)');
  });
});
