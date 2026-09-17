import { StateEffect, StateField, Prec, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, keymap, type DecorationSet } from '@codemirror/view';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { acceptCompletion, autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import type { VaultMember } from './api';

type Member = Pick<VaultMember, 'username' | 'displayName'>;
export const refreshNoteMentions = StateEffect.define<void>();

function excludedRanges(state: EditorState) {
  const ranges: { from: number; to: number }[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 30) ?? syntaxTree(state);
  tree.iterate({ enter(node) {
    if (/^(FencedCode|CodeBlock|InlineCode|Link|Autolink|URL|Image|HTMLBlock|HTMLTag|Escape)$/.test(node.name)) {
      ranges.push({ from: node.from, to: node.to });
      return false;
    }
  } });
  for (const match of state.doc.toString().matchAll(/\[\[[^\]\n]*\]\]|https?:\/\/[^\s<>]+/g)) {
    ranges.push({ from: match.index, to: match.index + match[0].length });
  }
  return ranges;
}

export function noteMentionRanges(state: EditorState, members: readonly Member[]) {
  const known = new Map(members.map(member => [member.username.toLowerCase(), member]));
  const excluded = excludedRanges(state);
  const mentions: { from: number; to: number; member: Member }[] = [];
  for (const match of state.doc.toString().matchAll(/(^|[^\p{L}\p{N}_\\@/:.+?=&%#-])@([A-Za-z0-9_][A-Za-z0-9_-]*)/gu)) {
    const from = match.index + match[1].length;
    const to = from + match[2].length + 1;
    const member = known.get(match[2].toLowerCase());
    if (member && !excluded.some(range => from < range.to && to > range.from)) mentions.push({ from, to, member });
  }
  return mentions;
}

export function noteMentionCompletion(getMembers: () => readonly Member[]) {
  return (context: CompletionContext) => {
    if (context.state.readOnly) return null;
    const match = context.matchBefore(/(^|[^\p{L}\p{N}_\\@/:.+?=&%#-])@[A-Za-z0-9_-]*/u);
    if (!match) return null;
    const from = match.from + match.text.indexOf('@');
    if (excludedRanges(context.state).some(range => from >= range.from && from < range.to)) return null;
    const before = context.state.sliceDoc(context.state.doc.lineAt(from).from, from);
    if (/(?:^|[^\\])`+[^`]*$/.test(before) || /\[\[[^\]]*$/.test(before)) return null;
    const query = context.state.sliceDoc(from + 1, context.pos).toLowerCase();
    const options = getMembers()
      .filter(member => member.username.toLowerCase().includes(query) || member.displayName.toLowerCase().includes(query))
      .sort((a, b) => a.username.localeCompare(b.username))
      .map(member => ({ label: `@${member.username}`, detail: member.displayName, type: 'variable', apply: `@${member.username} ` }));
    return options.length ? { from, options, filter: false } : null;
  };
}

export function noteMentions(getMembers: () => readonly Member[], readOnly: boolean): Extension {
  const decorate = (state: EditorState) => Decoration.set(noteMentionRanges(state, getMembers()).map(({ from, to, member }) =>
    Decoration.mark({ class: 'cm-note-mention', attributes: { title: `${member.displayName} (@${member.username})` } }).range(from, to)), true);
  return [
    StateField.define<DecorationSet>({
      create: decorate,
      update(value, transaction) {
        return transaction.docChanged || transaction.effects.some(effect => effect.is(refreshNoteMentions))
          ? decorate(transaction.state) : value;
      },
      provide: field => EditorView.decorations.from(field),
    }),
    EditorView.baseTheme({
      '.cm-note-mention': { color: 'var(--accent)', backgroundColor: 'var(--accent-subtle)', borderRadius: '4px', padding: '1px 2px' },
      '.cm-tooltip-autocomplete': { backgroundColor: 'var(--bg-raised)', color: 'var(--text-primary)', border: '1px solid var(--border)' },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--bg-deep)' },
      '.cm-completionDetail': { opacity: '0.7', marginLeft: '12px' },
    }),
    ...(readOnly ? [] : [
      autocompletion({ override: [noteMentionCompletion(getMembers)], maxRenderedOptions: 8, icons: false }),
      Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
    ]),
  ];
}
