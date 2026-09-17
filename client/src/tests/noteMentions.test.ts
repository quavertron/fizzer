import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { CompletionContext } from '@codemirror/autocomplete';
import { noteMentionCompletion, noteMentionRanges, noteMentions, refreshNoteMentions } from '../noteMentions';

const members = [{ username: 'diego', displayName: 'Diego Example' }, { username: 'asdfasdf', displayName: 'Workspace Owner' }];
const state = (doc: string, readOnly = false) => EditorState.create({ doc, extensions: [markdown(), EditorState.readOnly.of(readOnly)] });
const complete = (doc: string, readOnly = false) => noteMentionCompletion(() => members)(new CompletionContext(state(doc, readOnly), doc.length, false));

describe('human mentions in notes', () => {
  it('recognizes exact members case-insensitively and keeps plain Markdown', () => {
    const doc = 'CWD? @asdfasdf @Diego tap in. @stranger @diego-other';
    const matches = noteMentionRanges(state(doc), members);
    expect(matches.map(match => doc.slice(match.from, match.to))).toEqual(['@asdfasdf', '@Diego']);
    expect(state(doc).doc.toString()).toBe(doc);
  });

  it('ignores code, escaped text, emails, URLs, links, images, and wiki links', () => {
    const doc = ['`@diego`', '```md\n@diego\n```', '    @diego', '\\@diego test@diego @@diego', 'https://example.test/@diego', '[label @diego](https://example.test/@diego)', '![@diego](image.png)', '[[@diego]]', '<span title="@diego">', '@diego'].join('\n\n');
    expect(noteMentionRanges(state(doc), members).map(match => match.from)).toEqual([doc.lastIndexOf('@diego')]);
  });

  it('offers vault members after @ and searches username or display name', () => {
    expect(complete('Hello @')?.options.map(option => option.label)).toEqual(['@asdfasdf', '@diego']);
    expect(complete('Hello @exam')?.options.map(option => option.label)).toEqual(['@diego']);
    expect(complete('Hello @DIE')?.options[0].apply).toBe('@diego ');
    expect(complete('Hello @DIE')?.from).toBe(6);
    expect(complete('@unknown')).toBeNull();
    expect(complete('plain text')).toBeNull();
  });

  it('does not offer completion in read-only notes or excluded contexts', () => {
    expect(complete('@di', true)).toBeNull();
    for (const doc of ['`@di', '```\n@di', 'email@di', '\\@di', 'https://site/@di', '[link](https://site/@di']) expect(complete(doc), doc).toBeNull();
  });

  it('refreshes decoration membership without changing content or selection', () => {
    let current = members;
    const editor = EditorState.create({ doc: '@diego', selection: { anchor: 3 }, extensions: [markdown(), noteMentions(() => current, true)] });
    current = [];
    const updated = editor.update({ effects: refreshNoteMentions.of() }).state;
    expect(noteMentionRanges(updated, current)).toEqual([]);
    expect(updated.doc.toString()).toBe('@diego');
    expect(updated.selection.main.head).toBe(3);
  });
});
