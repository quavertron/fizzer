import { describe, expect, it } from 'vitest';
import { hasRegistrationForMention, isCompactCommand, replyQuoteTargetsAgent, resolveAgentMessageRegistration } from '../chat/mentions';
import { prepareReplyForSend } from '../components/ChatComposer';

const registrations = [
  { id: 'terra-reg', agentId: 'codex', displayName: 'Terra', mention: 'terra', taggableByAgents: true },
  { id: 'sol-reg', agentId: 'codex', displayName: 'Sol', mention: 'sol', taggableByAgents: true },
];

describe('compact command', () => {
  it('recognizes bare and explicitly targeted compact commands', () => {
    expect(isCompactCommand('/compact', registrations)).toBe(true);
    expect(isCompactCommand('/compact @terra @sol', registrations)).toBe(true);
    expect(isCompactCommand('@terra /COMPACT', registrations)).toBe(true);
  });

  it('does not swallow ordinary messages that merely mention compacting', () => {
    expect(isCompactCommand('/compact now', registrations)).toBe(false);
    expect(isCompactCommand('please /compact @terra', registrations)).toBe(false);
  });
});

describe('reply agent notification', () => {
  const reply = { messageId: 'msg-agent', author: 'Sol', mention: 'sol', preview: 'Original answer' };

  it('keeps the implicit mention on by default', () => {
    expect(prepareReplyForSend(reply, true)).toEqual(reply);
  });

  it('removes routing mention without removing reply context', () => {
    expect(prepareReplyForSend(reply, false)).toEqual({ ...reply, mention: '' });
  });

  it('detects when an author-derived reply mention needs roster hydration', () => {
    expect(hasRegistrationForMention('ocsol', [])).toBe(false);
    expect(hasRegistrationForMention('@sol', registrations)).toBe(true);
  });
});

describe('replyQuoteTargetsAgent', () => {
  const quotedMessages = [
    { id: 'msg-human', agentId: undefined, registrationId: undefined },
    { id: 'msg-agent', agentId: 'codex', registrationId: 'sol-reg' },
    { id: 'msg-legacy-agent', agentId: 'codex' },
  ];

  it('does not treat a reply to a person as a failed agent call', () => {
    expect(replyQuoteTargetsAgent(
      { messageId: 'msg-human', mention: 'asdfasdf' },
      quotedMessages,
    )).toBe(false);
  });

  it('still reports agent-authored quotes, including legacy helper messages', () => {
    expect(replyQuoteTargetsAgent({ messageId: 'msg-agent', mention: 'sol' }, quotedMessages)).toBe(true);
    expect(replyQuoteTargetsAgent({ messageId: 'msg-legacy-agent', mention: 'sol' }, quotedMessages)).toBe(true);
  });

  it('defers to the server when the quote is outside the loaded page', () => {
    expect(replyQuoteTargetsAgent({ messageId: 'msg-gone', mention: 'sol' }, quotedMessages)).toBe(false);
    expect(replyQuoteTargetsAgent({ messageId: 'msg-gone', mention: '' }, quotedMessages)).toBe(false);
    expect(replyQuoteTargetsAgent(undefined, quotedMessages)).toBe(false);
  });
});

describe('resolveAgentMessageRegistration', () => {
  it('uses the authoritative registration id when present', () => {
    expect(resolveAgentMessageRegistration({ registrationId: 'terra-reg' }, registrations)?.id).toBe('terra-reg');
  });

  it('accepts legacy helper messages with an unambiguous agent identity', () => {
    expect(resolveAgentMessageRegistration({ agentId: 'codex', author: 'Terra' }, registrations)?.id).toBe('terra-reg');
  });

  it('does not infer a source from ambiguous or human messages', () => {
    expect(resolveAgentMessageRegistration({ author: 'Terra' }, registrations)).toBeUndefined();
    expect(resolveAgentMessageRegistration({ agentId: 'codex', author: 'Unknown' }, registrations)).toBeUndefined();
  });
});
