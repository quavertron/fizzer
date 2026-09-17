import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { canInvokeAgent } from '../chat/agents';
import { ChatMessageText } from '../components/ChatMarkdown';

describe('unavailable mentions', () => {
  it('mutes only unavailable handles, retaining available and human mentions', () => {
    const html = renderToStaticMarkup(<ChatMessageText {...{
      messageId: 'm', body: '@blocked @available @alice @BLOCKED',
      mentionableAliases: ['blocked', 'available', 'alice'], unavailableAliases: ['blocked'],
    }} />);
    expect(html.match(/class="chat-mention is-unavailable"/g)).toHaveLength(2);
    expect(html.match(/class="chat-mention"/g)).toHaveLength(2);
    expect(html).toContain('This agent is unavailable to you');
  });
});

it('uses human invocation permission, independent of agent handoff permission', () => {
  expect(canInvokeAgent({ ownerUserId: 1, pingableByOthers: false }, 1)).toBe(true);
  expect(canInvokeAgent({ ownerUserId: 2, pingableByOthers: false }, 1)).toBe(false);
  expect(canInvokeAgent({ ownerUserId: 2, pingableByOthers: true }, 1)).toBe(true);
  expect(canInvokeAgent({ pingableByOthers: false }, 1)).toBe(false);
  expect(canInvokeAgent({ pingableByOthers: false })).toBe(false);
});

it('re-renders memoized messages when permission changes', () => {
  const props = { messageId: 'm', body: '@blocked', mentionableAliases: ['blocked'], unavailableAliases: ['blocked'] };
  const compare = (ChatMessageText as unknown as { compare: (a: typeof props, b: typeof props) => boolean }).compare;
  expect(compare(props, { ...props, unavailableAliases: [] })).toBe(false);
  expect(compare(props, { ...props, unavailableAliases: ['blocked'] })).toBe(true);
});
