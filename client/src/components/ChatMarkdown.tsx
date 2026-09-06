import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import { Capacitor } from '@capacitor/core';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import DOMPurify from 'dompurify';
import { api, type Note, type NoteSummary } from '../api';
import type { SharedChatNote } from '../chat/types';
import { highlightJSON } from './jsonHighlighter';
import {
  bodyHasNoteRefs,
  findEmbeddedNote,
  NOTE_DND_TYPE,
  noteEmbedMarkdown,
  splitDocEmbeds,
  splitWikilinks,
} from '../docEmbeds';
import { stripChatControlMarkers } from '../chat/shared';
import { escapeRegExp, normalizeMention } from '../chat/mentions';
import {
  chatMediaLink,
  twitterEmbedResizeHeight,
  youtubeVideoId,
  YOUTUBE_EMBED_CONTROL_EVENT,
  YOUTUBE_EMBED_STATE_EVENT,
  type YouTubeEmbedControlDetail,
  type YouTubeEmbedStateDetail,
} from '../mediaLinks';

export const CHAT_MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];
const CHAT_EXTERNAL_TARGET = Capacitor.isNativePlatform() ? undefined : '_blank';

export function SafeMarkdownImage({ src = '', alt = '' }: { src?: string; alt?: string }) {
  let local = src.startsWith('/') || src.startsWith('data:') || src.startsWith('blob:');
  if (!local && typeof window !== 'undefined') {
    try { local = new URL(src, window.location.href).origin === window.location.origin; } catch { local = false; }
  }
  return local
    ? <img src={src} alt={alt} />
    : <a href={src} target={CHAT_EXTERNAL_TARGET} rel="noopener noreferrer">External image{alt ? `: ${alt}` : ''}</a>;
}

function formatChatMentions(text: string, aliases: string[]): ReactNode[] {
  const mentionable = [...new Set(
    aliases.map((alias) => normalizeMention(alias)).filter(Boolean),
  )];
  if (mentionable.length === 0) return [text];
  const aliasPattern = mentionable
    .map((alias) => alias.split(/\s+/).map(escapeRegExp).join('[\\s-]*'))
    .join('|');
  const regex = new RegExp(`@\\s*(?:${aliasPattern})(?=$|[\\s.,:;!?\\])}])`, 'gi');
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(<span key={key++} className="chat-mention">{match[0]}</span>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : [text];
}

/** Inline `[[Title]]` cites → clickable note chips (embeds `![[…]]` stay cards). */
function formatChatWikilinks(
  text: string,
  notes: NoteSummary[],
  messageId: string,
  onOpenNote?: (id: string) => void,
  onOpenSharedNote?: (messageId: string, title: string) => void,
): ReactNode[] {
  const parts = splitWikilinks(text);
  if (parts.length === 1 && parts[0].type === 'text') return [text];
  let key = 0;
  const nodes: ReactNode[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.value) nodes.push(part.value);
      continue;
    }
    const target = part.value;
    if (!target) continue;
    const embedded = findEmbeddedNote(notes, target);
    const canOpen = Boolean(embedded ? onOpenNote : onOpenSharedNote);
    nodes.push(
      <button
        key={`wiki-${key++}`}
        type="button"
        className={`chat-wikilink${embedded ? '' : ' is-missing'}`}
        onClick={() => {
          if (embedded) onOpenNote?.(embedded.id);
          else onOpenSharedNote?.(messageId, target);
        }}
        disabled={!canOpen}
        title={embedded ? `Preview ${embedded.title}` : `Note: ${target}`}
      >
        {embedded?.title ?? target}
      </button>,
    );
  }
  return nodes.length > 0 ? nodes : [text];
}

function LinkedNotePreview({ messageId, target, loadSharedNote, onOpenNote, onClose }: {
  messageId: string;
  target: { id?: string; title: string };
  loadSharedNote?: (messageId: string, title: string) => Promise<SharedChatNote | null>;
  onOpenNote?: (id: string) => void;
  onClose: () => void;
}) {
  const [note, setNote] = useState<{ title: string; content: string } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let canceled = false;
    setNote(null);
    setError('');
    const load = async () => {
      try {
        const result = target.id
          ? (await api<{ note: Note }>(`/api/notes/${encodeURIComponent(target.id)}`)).note
          : await loadSharedNote?.(messageId, target.title);
        if (canceled) return;
        if (result) setNote(result);
        else setError('This note is unavailable.');
      } catch {
        if (!canceled) setError('Could not load this note. Close and reopen to retry.');
      }
    };
    void load();
    return () => { canceled = true; };
  }, [messageId, target, loadSharedNote]);
  return (
    <section className="chat-note-preview" aria-label={`Note preview: ${target.title}`}>
      <header>
        <strong>{note?.title ?? target.title}</strong>
        {target.id && onOpenNote && <button type="button" onClick={() => onOpenNote(target.id!)}>Open note</button>}
        <button type="button" onClick={onClose} aria-label="Close note preview">Close</button>
      </header>
      <div className="chat-note-preview-body" tabIndex={0}>
        {note ? <ReactMarkdown remarkPlugins={CHAT_MARKDOWN_PLUGINS} components={{
          img: SafeMarkdownImage,
          a: ({ href, children }) => <a href={href} target={CHAT_EXTERNAL_TARGET} rel="noopener noreferrer">{children}</a>,
        }}>{note.content || '*This note is empty.*'}</ReactMarkdown>
          : <p role="status">{error || 'Loading note…'}</p>}
      </div>
    </section>
  );
}

function aliasesEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// While an agent message streams, its body grows by a token at a time and
// react-markdown re-parses the *entire* body on every keystroke-sized update —
// the dominant main-thread cost during a live run. Paint a throttled snapshot
// (matching ThinkingBlock's 90ms) so the full markdown parse runs a few times a
// second instead of per token; the final settle always flushes the exact body.
const STREAM_BODY_PAINT_MS = 120;

export function ChatMediaEmbed({ href, label }: { href: string; label: ReactNode }) {
  const media = chatMediaLink(href);
  const [embedLoaded, setEmbedLoaded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const youtubeInfoRef = useRef({ currentTime: 0, title: 'YouTube video' });
  const [twitterHeight, setTwitterHeight] = useState<number | null>(null);
  useEffect(() => {
    if (media?.provider !== 'youtube') return;
    const frameWindow = frameRef.current?.contentWindow;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://www.youtube.com' || event.source !== frameWindow) return;
      let payload: { event?: string; info?: number | { currentTime?: number; videoData?: { title?: string } } } = {};
      try { payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
      if (payload.event === 'infoDelivery' && typeof payload.info === 'object') {
        if (Number.isFinite(payload.info.currentTime)) youtubeInfoRef.current.currentTime = payload.info.currentTime || 0;
        const title = payload.info.videoData?.title?.trim();
        if (title) youtubeInfoRef.current.title = title;
      }
      if (payload.event === 'onStateChange' && typeof payload.info === 'number') {
        const videoId = youtubeVideoId(href);
        if (!videoId) return;
        window.dispatchEvent(new CustomEvent<YouTubeEmbedStateDetail>(YOUTUBE_EMBED_STATE_EVENT, {
          detail: {
            videoId,
            url: href,
            title: youtubeInfoRef.current.title,
            currentTime: youtubeInfoRef.current.currentTime,
            state: payload.info,
          },
        }));
      }
    };
    const onControl = (event: Event) => {
      const detail = (event as CustomEvent<YouTubeEmbedControlDetail>).detail;
      const videoId = youtubeVideoId(href);
      if (!videoId || detail?.videoId !== videoId) return;
      frameWindow?.postMessage(JSON.stringify({ event: 'command', func: detail.func, args: [] }), '*');
    };
    window.addEventListener('message', onMessage);
    window.addEventListener(YOUTUBE_EMBED_CONTROL_EVENT, onControl);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener(YOUTUBE_EMBED_CONTROL_EVENT, onControl);
    };
  }, [href, media?.provider]);
  useEffect(() => {
    if (media?.provider !== 'twitter') return;
    setTwitterHeight(null);
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://platform.twitter.com' || event.source !== frameRef.current?.contentWindow) return;
      const height = twitterEmbedResizeHeight(event.data);
      if (height !== null) setTwitterHeight((current) => current === height ? current : height);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [href, media?.provider]);
  if (!media) return <a href={href} target={CHAT_EXTERNAL_TARGET} rel="noopener noreferrer">{label}</a>;
  if (!embedLoaded) {
    return (
      <span className={`chat-media-embed is-${media.aspect} is-${media.provider}`}>
        <a href={href} target={CHAT_EXTERNAL_TARGET} rel="noopener noreferrer">{label}</a>
        <button type="button" onClick={() => setEmbedLoaded(true)}>Load external embed</button>
      </span>
    );
  }
  return (
    <span className={`chat-media-embed is-${media.aspect} is-${media.provider}`}>
      <a href={href} target={CHAT_EXTERNAL_TARGET} rel="noopener noreferrer">{label}</a>
      <iframe
        ref={frameRef}
        src={media.embedUrl}
        title={media.title}
        loading="lazy"
        style={media.provider === 'twitter' && twitterHeight ? { height: `${twitterHeight}px` } : undefined}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        onLoad={() => {
          if (media.provider !== 'youtube') return;
          const player = frameRef.current?.contentWindow;
          player?.postMessage(JSON.stringify({ event: 'listening' }), '*');
          player?.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), '*');
        }}
      />
    </span>
  );
}

function useThrottledStreamBody(body: string, streaming: boolean): string {
  const [paintBody, setPaintBody] = useState(body);
  const lastPaintRef = useRef(0);
  useEffect(() => {
    if (!streaming) {
      // Settled (or never streaming): show the exact body immediately.
      setPaintBody(body);
      return;
    }
    const now = Date.now();
    const since = now - lastPaintRef.current;
    if (since >= STREAM_BODY_PAINT_MS) {
      lastPaintRef.current = now;
      setPaintBody(body);
      return;
    }
    // Trailing edge — guarantees the latest chunk lands even if tokens keep
    // arriving faster than the interval (a debounce would starve steady streams).
    const timer = window.setTimeout(() => {
      lastPaintRef.current = Date.now();
      setPaintBody(body);
    }, STREAM_BODY_PAINT_MS - since);
    return () => window.clearTimeout(timer);
  }, [body, streaming]);
  return paintBody;
}

// The actual markdown parse lives in its own memoized child so a throttled-away
// body update (parent re-render with an unchanged `formattedBody`) bails out
// here instead of re-parsing the whole message.
const ChatMarkdownBody = memo(function ChatMarkdownBody({
  messageId,
  formattedBody,
  components,
  notes,
  onOpenNote,
  onOpenSharedNote,
}: {
  messageId: string;
  formattedBody: string;
  components: Record<string, unknown>;
  notes: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (messageId: string, title: string) => void;
}) {
  return (
    <>
      {splitDocEmbeds(formattedBody).map((part, index) => {
        if (part.type === 'text') {
          if (!part.value) return null;
          return (
            <ReactMarkdown key={index} remarkPlugins={CHAT_MARKDOWN_PLUGINS} components={components as any}>
              {part.value}
            </ReactMarkdown>
          );
        }
        const embedded = findEmbeddedNote(notes, part.value);
        return (
          <button
            key={index}
            type="button"
            className={`chat-doc-embed${embedded || onOpenSharedNote ? '' : ' is-missing'}`}
            onClick={() => embedded ? onOpenNote?.(embedded.id) : onOpenSharedNote?.(messageId, part.value)}
            disabled={!embedded && !onOpenSharedNote}
            title={embedded ? `Preview ${embedded.title}` : 'Preview shared note'}
            draggable={!!embedded}
            onDragStart={(event) => {
              if (!embedded) return;
              event.dataTransfer.setData(NOTE_DND_TYPE, embedded.id);
              event.dataTransfer.setData('text/plain', noteEmbedMarkdown(embedded));
              event.dataTransfer.effectAllowed = 'copyMove';
            }}
          >
            <span className="chat-doc-embed-title">
              {embedded?.title ?? (onOpenSharedNote ? part.value : `Missing note: ${part.value}`)}
            </span>
            {embedded?.content_preview?.trim() && (
              <span className="chat-doc-embed-preview">
                {embedded.content_preview.trim().length > 180
                  ? `${embedded.content_preview.trim().slice(0, 179)}…`
                  : embedded.content_preview.trim()}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
});

// ChatMessageText stays module-local; work-trace uses its own lightweight markdown.
export const ChatMessageText = memo(function ChatMessageText({
  messageId,
  body,
  streaming = false,
  isAgent = false,
  mentionableAliases,
  notes = [],
  onOpenNote,
  onOpenSharedNote,
}: {
  messageId: string;
  body: string;
  streaming?: boolean;
  isAgent?: boolean;
  mentionableAliases: string[];
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (messageId: string, title: string) => Promise<SharedChatNote | null>;
}) {
  const [preview, setPreview] = useState<{ id?: string; title: string } | null>(null);
  const previewLocalNote = useCallback((id: string) => {
    setPreview({ id, title: notes.find((note) => note.id === id)?.title || 'Note' });
  }, [notes]);
  const previewSharedNote = useCallback((_messageId: string, title: string) => {
    setPreview({ title });
  }, []);
  // Suggestion evidence stays in the durable transcript, outside the chat prose.
  const paintBody = useThrottledStreamBody(stripChatControlMarkers(body), streaming);

  const withInlineMarkup = useCallback((children: ReactNode): ReactNode => {
    const decorate = (value: string): ReactNode[] => {
      // Wikilinks first so mention highlighting runs on surrounding prose only.
      const wikiNodes = formatChatWikilinks(
        value,
        notes,
        messageId,
        previewLocalNote,
        onOpenSharedNote ? previewSharedNote : undefined,
      );
      return wikiNodes.flatMap((node) => (
        typeof node === 'string'
          ? formatChatMentions(node, mentionableAliases)
          : [node]
      ));
    };
    if (Array.isArray(children)) {
      return children.flatMap((child) =>
        typeof child === 'string' ? decorate(child) : [child]
      );
    }
    if (typeof children === 'string') return decorate(children);
    return children;
  }, [mentionableAliases, messageId, notes, previewLocalNote, previewSharedNote, onOpenSharedNote]);

  const formattedBody = useMemo(() => {
    // Raw <svg>…</svg> is escaped by react-markdown, so (agents only) lift it
    // into a ```svg fence — the code renderer sanitizes and draws it inline.
    // User messages never render SVG; they show the markup as plain text.
    const ticks = paintBody.replace(/\\+`/g, '`');
    const processed = isAgent
      ? ticks.replace(/```svg\s*[\r\n]+([\s\S]*?)```|(<svg[\s\S]*?<\/svg>)/gi, (whole, _fenced, raw) =>
          raw ? `\n\`\`\`svg\n${raw}\n\`\`\`\n` : whole,
        )
      : ticks;
    const trimmed = processed.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
        }
      } catch {
        // ignore
      }
    }
    return processed;
  }, [paintBody, isAgent]);

  const components = useMemo(() => ({
    a: ({ href = '', children }: { href?: string; children?: ReactNode }) => (
      <ChatMediaEmbed href={href} label={children} />
    ),
    p: ({ children }: { children?: ReactNode }) => <p>{withInlineMarkup(children)}</p>,
    strong: ({ children }: { children?: ReactNode }) => <strong>{withInlineMarkup(children)}</strong>,
    em: ({ children }: { children?: ReactNode }) => <em>{withInlineMarkup(children)}</em>,
    del: ({ children }: { children?: ReactNode }) => <del>{withInlineMarkup(children)}</del>,
    li: ({ children }: { children?: ReactNode }) => <li>{withInlineMarkup(children)}</li>,
    td: ({ children }: { children?: ReactNode }) => <td>{withInlineMarkup(children)}</td>,
    th: ({ children }: { children?: ReactNode }) => <th>{withInlineMarkup(children)}</th>,
    code({ node, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const isInline = !className;
      const value = String(children).replace(/\n$/, '');

      // ```svg blocks render as inline graphics. Sanitize first — message
      // bodies are untrusted, and raw SVG can smuggle <script>/onload/etc.
      if (!isInline && match && match[1] === 'svg' && isAgent) {
        const clean = DOMPurify
          .sanitize(value, { USE_PROFILES: { svg: true, svgFilters: true } })
          .replace(/\s(?:href|xlink:href|src)=["']https?:\/\/[^"']*["']/gi, '');
        return <span className="chat-svg" dangerouslySetInnerHTML={{ __html: clean }} />;
      }

      if (!isInline && (!match || match[1] === 'json')) {
        const trimmed = value.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            JSON.parse(trimmed);
            return (
              <code className={className || 'language-json'} {...props}>
                {highlightJSON(value)}
              </code>
            );
          } catch {
            // ignore
          }
        }
      }

      if (!isInline && match && match[1] === 'json') {
        return (
          <code className={className} {...props}>
            {highlightJSON(value)}
          </code>
        );
      }
      return <code className={className} {...props}>{children}</code>;
    },
    img: SafeMarkdownImage,
  }), [withInlineMarkup, isAgent]);

  return (
    <>
      <ChatMarkdownBody
      messageId={messageId}
      formattedBody={formattedBody}
      components={components}
      notes={notes}
      onOpenNote={previewLocalNote}
      onOpenSharedNote={onOpenSharedNote ? previewSharedNote : undefined}
    />
    {preview && <LinkedNotePreview key={`${messageId}:${preview.id || preview.title}`}
      messageId={messageId} target={preview} loadSharedNote={onOpenSharedNote}
      onOpenNote={onOpenNote} onClose={() => setPreview(null)} />}
    </>
  );
}, (prev, next) =>
  prev.messageId === next.messageId
  && prev.streaming === next.streaming
  && prev.onOpenSharedNote === next.onOpenSharedNote
  &&
  prev.body === next.body
  && aliasesEqual(prev.mentionableAliases, next.mentionableAliases)
  // Notes list only matters for bodies with `![[…]]` embeds or `[[…]]` cites.
  && (prev.notes === next.notes || !bodyHasNoteRefs(next.body))
  && prev.onOpenNote === next.onOpenNote
);
