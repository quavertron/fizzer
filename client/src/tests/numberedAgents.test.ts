import { describe, expect, it } from 'vitest';
import { hasNumberedAgentMention, numberedAgentBase, nextNumberedAgentMentions } from '../chat/mentions';

const codex = { agentId: 'codex', mention: 'codex', taggableByAgents: true };
const original2 = { ...codex, mention: 'codex2' };

describe('numbered agent namespaces', () => {
  it('suggests the next unused instance for each original', () => {
    expect(nextNumberedAgentMentions([codex, original2])).toEqual(['codex3', 'codex22']);
    expect(nextNumberedAgentMentions([codex, { ...original2, instanceOf: 'base' }])).toEqual(['codex3']);
    expect(nextNumberedAgentMentions([codex, { ...codex }])).toEqual(['codex2']);
  });
  it('respects original profiles, reserves suffix 1, and leaves suffix 0 to the shorter base', () => {
    const agents = [codex, original2];
    expect(numberedAgentBase('codex2', agents)).toBeUndefined();
    expect(numberedAgentBase('codex3', agents)).toMatchObject({ base: codex, number: '3', available: true });
    expect(numberedAgentBase('codex20', agents)).toMatchObject({ base: codex, number: '20', available: true });
    expect(numberedAgentBase('codex21', agents)).toMatchObject({ base: original2, number: '1', available: false });
    expect(numberedAgentBase('codex22', agents)).toMatchObject({ base: original2, number: '2', available: true });
    expect(numberedAgentBase('codex29', agents)).toMatchObject({ base: original2, number: '9', available: true });
  });
  it('does not reserve prefixes for generated instances', () => {
    const agents = [codex, { ...original2, instanceOf: 'original-codex' }];
    for (const number of ['21', '22', '29']) {
      expect(numberedAgentBase('codex' + number, agents)).toMatchObject({ base: codex, number, available: true });
    }
  });
  it('keeps first mentions out of ordinary message folding', () => {
    expect(hasNumberedAgentMention('@codex22 start', [codex])).toBe(true);
    expect(hasNumberedAgentMention('@codex21 start', [codex, original2])).toBe(true);
    expect(hasNumberedAgentMention('email@codex22.example', [codex])).toBe(false);
    expect(hasNumberedAgentMention('@unknown2', [codex])).toBe(false);
  });
});
