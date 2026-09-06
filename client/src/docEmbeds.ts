import type { NoteSummary } from './api';

export type DocEmbedPart =
  | { type: 'text'; value: string }
  | { type: 'embed'; value: string };

export const NOTE_DND_TYPE = 'application/x-cascade-note';
/** Block embeds: `![[Title]]` (card in chat). */
const DOC_EMBED_REGEX = /!\[\[([^\]\n]+)\]\]/g;
/**
 * Inline citations: `[[Title]]` (not embeds). Negative lookbehind keeps `![[…]]`
 * out of this match so embeds stay handled by DOC_EMBED_REGEX.
 */
const WIKILINK_REGEX = /(?<!!)\[\[([^\]\n]+)\]\]/g;

export function normalizeDocEmbedTarget(raw: string) {
  return raw
    .split('|', 1)[0]
    .split('#', 1)[0]
    .trim();
}

function splitNoteRefs<T extends 'embed' | 'wikilink'>(text: string, pattern: RegExp, type: T): Array<{ type: 'text' | T; value: string }> {
  const parts: Array<{ type: 'text' | T; value: string }> = [];
  let lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type, value: normalizeDocEmbedTarget(match[1]) });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push({ type: 'text', value: text.slice(lastIndex) });
  return parts.length ? parts : [{ type: 'text', value: text }];
}

export function splitDocEmbeds(markdown: string): DocEmbedPart[] {
  return splitNoteRefs(markdown, DOC_EMBED_REGEX, 'embed');
}

/** True when body has `![[…]]` embeds or plain `[[…]]` citations. */
export function bodyHasNoteRefs(body: string): boolean {
  return /\[\[([^\]\n]+)\]\]/.test(body);
}

/** Inline citations exclude `![[…]]` block embeds. */
export function splitWikilinks(text: string) {
  return splitNoteRefs(text, WIKILINK_REGEX, 'wikilink');
}

export function findEmbeddedNote(notes: NoteSummary[], target: string) {
  const normalized = normalizeDocEmbedTarget(target).toLowerCase();
  if (!normalized) return null;
  return notes.find((note) => note.id.toLowerCase() === normalized)
    ?? notes.find((note) => note.title.toLowerCase() === normalized)
    ?? null;
}

export function noteEmbedMarkdown(note: NoteSummary) {
  return `![[${note.title.replace(/\]/g, '')}]]`;
}
