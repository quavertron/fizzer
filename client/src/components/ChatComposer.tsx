import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { ImagePlus, Paperclip, Send, Smile, X } from 'lucide-react';
import { api, type NoteSummary } from '../api';
import { NOTE_DND_TYPE, noteEmbedMarkdown } from '../docEmbeds';
import { normalizeMention } from '../chat/mentions';
import { stripChatControlMarkers } from '../chat/shared';
import type { ChatAgentRegistration, ChatMediaAttachment, ChatReplyRef } from '../chat/types';

export const CHAT_MEDIA_LIMIT = 8;
export const CHAT_MEDIA_MAX_BYTES = 64 * 1024 * 1024;

const CHAT_EMOJIS = ['😀', '😂', '😍', '🥳', '😎', '🤔', '👍', '👎', '❤️', '🔥', '🎉', '✅', '👀', '🙏', '💎', '🚀'];

type ElectronClipboardAPI = {
  readClipboardImage?: () => Promise<ChatMediaAttachment | null>;
};

function isImageMediaType(mediaType: string) {
  return mediaType.startsWith('image/');
}

export function isVideoMediaType(mediaType: string) {
  return mediaType.startsWith('video/');
}

export function isMp4Attachment(attachment: { name?: string; media_type?: string; url?: string }) {
  const type = String(attachment.media_type || '').toLowerCase();
  if (isVideoMediaType(type) || type === 'video/mp4') return true;
  const name = String(attachment.name || '').toLowerCase();
  const url = String(attachment.url || '').toLowerCase();
  return name.endsWith('.mp4') || url.includes('video/mp4') || /\.mp4(\?|$)/.test(url);
}

function inferredMediaType(file: File) {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.md')) return 'text/markdown';
  if (name.endsWith('.txt')) return 'text/plain';
  if (name.endsWith('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function readMediaFile(file: File): Promise<ChatMediaAttachment | null> {
  return new Promise((resolve) => {
    if (file.size > CHAT_MEDIA_MAX_BYTES) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const data = url.split(',')[1] || '';
      resolve({
        media_type: inferredMediaType(file),
        data,
        url,
        name: file.name,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function getElectronClipboardAPI(): ElectronClipboardAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronClipboardAPI }).electronAPI;
}

/** Keep the reply quote while suppressing its implicit agent mention. */
export function prepareReplyForSend(reply: ChatReplyRef, notifyAgent: boolean): ChatReplyRef {
  return notifyAgent ? reply : { ...reply, mention: '' };
}

export type ChatComposerHandle = {
  startReply: (reply: ChatReplyRef) => void;
};

export const ChatComposer = forwardRef<ChatComposerHandle, {
  channelId: string;
  channelName: string;
  directMessage?: boolean;
  notes: NoteSummary[];
  mentionableAliases: string[];
  registeredAgents: ChatAgentRegistration[];
  onSendMessage: (channelId: string, body: string, media?: ChatMediaAttachment[], replyTo?: ChatReplyRef) => void;
}>(function ChatComposer({
  channelId,
  channelName,
  directMessage = false,
  notes,
  mentionableAliases,
  registeredAgents,
  onSendMessage,
}, ref) {
  const [draft, setDraft] = useState('');
  const [replyTarget, setReplyTarget] = useState<ChatReplyRef | null>(null);
  const [replyNotifiesAgent, setReplyNotifiesAgent] = useState(true);
  const [pendingMedia, setPendingMedia] = useState<ChatMediaAttachment[]>([]);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionCycleRef = useRef<{ matches: string[]; index: number; start: number } | null>(null);

  useImperativeHandle(ref, () => ({
    startReply(reply: ChatReplyRef) {
      setReplyTarget(reply);
      setReplyNotifiesAgent(true);
      requestAnimationFrame(() => draftRef.current?.focus());
    },
  }), []);

  useEffect(() => {
    setReplyTarget(null);
    setReplyNotifiesAgent(true);
  }, [channelId]);

  // A restored chat can paint before its transcript/listing hydration settles.
  // Focus the visible composer once it has survived that first paint; otherwise
  // Electron can leave focus on the replaced document body until a tab switch.
  // Never steal focus from a control the user already reached during startup.
  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const textarea = draftRef.current;
        const active = document.activeElement;
        if (textarea?.offsetParent && (!active || active === document.body)) {
          textarea.focus({ preventScroll: true });
        }
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [channelId]);

  const addMediaFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const next: ChatMediaAttachment[] = [];
    for (const file of files) {
      const item = await readMediaFile(file);
      if (!item) {
        setMediaError(`"${file.name}" is too large (max ${CHAT_MEDIA_MAX_BYTES / (1024 * 1024)}MB).`);
        continue;
      }
      try {
        const uploaded = await api<{ url: string }>(`/api/notes/${channelId}/assets`, {
          method: 'POST',
          body: JSON.stringify({ media_type: item.media_type, data: item.data, filename: item.name }),
        });
        next.push({ ...item, url: uploaded.url });
      } catch (error) {
        setMediaError(error instanceof Error ? error.message : `Could not upload "${file.name}".`);
      }
    }
    if (next.length === 0) return;
    setMediaError('');
    setPendingMedia((prev) => [...prev, ...next].slice(0, CHAT_MEDIA_LIMIT));
  }, [channelId]);

  const addDesktopClipboardImage = useCallback(async () => {
    const image = await getElectronClipboardAPI()?.readClipboardImage?.();
    if (!image?.data || !isImageMediaType(image.media_type)) return false;
    setMediaError('');
    setPendingMedia((prev) => [...prev, image].slice(0, CHAT_MEDIA_LIMIT));
    return true;
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) {
      const types = Array.from(event.clipboardData?.types || []);
      if (types.some((type) => type === 'text/plain' || type === 'text/html' || type === 'text/uri-list')) return;
      void addDesktopClipboardImage();
      return;
    }
    event.preventDefault();
    void addMediaFiles(files);
  }, [addDesktopClipboardImage, addMediaFiles]);

  const handleUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    void addMediaFiles(files);
  }, [addMediaFiles]);

  useEffect(() => {
    if (!emojiPickerOpen) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setEmojiPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [emojiPickerOpen]);

  const insertEmoji = useCallback((emoji: string) => {
    const textarea = draftRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? draft.length;
    const end = textarea.selectionEnd ?? start;
    setDraft(`${draft.slice(0, start)}${emoji}${draft.slice(end)}`);
    setEmojiPickerOpen(false);
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + emoji.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }, [draft]);

  const insertEmbedInDraft = useCallback((noteId: string, textarea: HTMLTextAreaElement) => {
    const embedded = notes.find((note) => note.id === noteId);
    if (!embedded) return false;
    const insert = noteEmbedMarkdown(embedded);
    const start = textarea.selectionStart ?? draft.length;
    const end = textarea.selectionEnd ?? start;
    const needsPrefix = start > 0 && !/\s/.test(draft.slice(start - 1, start)) ? ' ' : '';
    const needsSuffix = end < draft.length && !/\s/.test(draft.slice(end, end + 1)) ? ' ' : '';
    const text = `${needsPrefix}${insert}${needsSuffix}`;
    setDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + text.length;
      textarea.setSelectionRange(cursor, cursor);
    });
    return true;
  }, [draft, notes]);

  function submit() {
    const body = draft.trim();
    if (!body && pendingMedia.length === 0) return;
    const reply = replyTarget
      ? prepareReplyForSend(replyTarget, replyNotifiesAgent)
      : undefined;
    onSendMessage(channelId, body, pendingMedia, reply);
    setDraft('');
    resetHistory();
    setPendingMedia([]);
    setMediaError('');
    setReplyTarget(null);
  }

  // Tab-complete an "@handle" from the mentionable list. Repeated Tab cycles
  // through the matches for the same partial. Returns true when it handled the key.
  function completeMention(textarea: HTMLTextAreaElement): boolean {
    const value = textarea.value;
    const cursor = textarea.selectionStart ?? value.length;
    const cycle = mentionCycleRef.current;
    const cycleToken = cycle ? `@${cycle.matches[cycle.index]} ` : '';
    const canCycle = Boolean(cycle
      && cursor === cycle.start + cycleToken.length
      && value.slice(cycle.start, cursor) === cycleToken);
    let next: { matches: string[]; index: number; start: number };
    if (canCycle && cycle) {
      next = { matches: cycle.matches, index: (cycle.index + 1) % cycle.matches.length, start: cycle.start };
    } else {
      const match = /@([\w-]*)$/.exec(value.slice(0, cursor));
      if (!match) return false;
      const start = cursor - match[0].length;
      const partial = match[1].toLowerCase();
      const matches = mentionableAliases.filter((alias) => alias.toLowerCase().startsWith(partial));
      if (matches.length === 0) return false;
      next = { matches, index: 0, start };
    }
    mentionCycleRef.current = next;
    // Append a trailing space so the caret lands ready for the message text.
    const chosen = `@${next.matches[next.index]} `;
    const caret = next.start + chosen.length;
    setDraft(`${value.slice(0, next.start)}${chosen}${value.slice(cursor)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
    return true;
  }

  function isCompletingMention(textarea: HTMLTextAreaElement): boolean {
    const cursor = textarea.selectionStart ?? textarea.value.length;
    const value = textarea.value;
    if (/@[\w-]*$/.test(value.slice(0, cursor))) return true;
    // Keep Tab-cycling alive right after we inserted "@handle " (with its space).
    const cycle = mentionCycleRef.current;
    if (!cycle) return false;
    const cycleToken = `@${cycle.matches[cycle.index]} `;
    return cursor === cycle.start + cycleToken.length
      && value.slice(cycle.start, cursor) === cycleToken;
  }
  const canSend = draft.trim().length > 0 || pendingMedia.length > 0;

  // Undo/redo history for the composer. A controlled textarea loses the browser's
  // native undo stack, so we keep our own snapshots and coalesce rapid typing into
  // a single step (commit fires 350ms after the last keystroke).
  const historyRef = useRef<{ stack: { v: string; s: number; e: number }[]; index: number }>({
    stack: [{ v: '', s: 0, e: 0 }],
    index: 0,
  });
  const historyTimerRef = useRef<number | null>(null);
  const historySelRef = useRef<{ s: number; e: number } | null>(null);

  const commitHistory = useCallback(() => {
    const textarea = draftRef.current;
    if (!textarea) return;
    const history = historyRef.current;
    const top = history.stack[history.index];
    if (top && top.v === textarea.value) {
      top.s = textarea.selectionStart;
      top.e = textarea.selectionEnd;
      return;
    }
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push({ v: textarea.value, s: textarea.selectionStart, e: textarea.selectionEnd });
    history.index = history.stack.length - 1;
  }, []);

  const scheduleHistoryCommit = useCallback(() => {
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    historyTimerRef.current = window.setTimeout(() => {
      historyTimerRef.current = null;
      commitHistory();
    }, 350);
  }, [commitHistory]);

  const resetHistory = useCallback(() => {
    if (historyTimerRef.current) { window.clearTimeout(historyTimerRef.current); historyTimerRef.current = null; }
    historyRef.current = { stack: [{ v: '', s: 0, e: 0 }], index: 0 };
  }, []);

  const stepHistory = useCallback((dir: -1 | 1) => {
    if (historyTimerRef.current) { window.clearTimeout(historyTimerRef.current); historyTimerRef.current = null; }
    commitHistory();
    const history = historyRef.current;
    const target = history.index + dir;
    if (target < 0 || target >= history.stack.length) return;
    history.index = target;
    const entry = history.stack[target];
    historySelRef.current = { s: entry.s, e: entry.e };
    setDraft(entry.v);
  }, [commitHistory]);

  // Restore the caret after an undo/redo swap re-renders the textarea.
  useLayoutEffect(() => {
    const sel = historySelRef.current;
    if (!sel) return;
    historySelRef.current = null;
    const textarea = draftRef.current;
    if (textarea) { textarea.focus(); textarea.setSelectionRange(sel.s, sel.e); }
  }, [draft]);

  useLayoutEffect(() => {
    const textarea = draftRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, 180);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden';
  }, [draft]);

  return (
    <footer
      className="chat-composer"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(NOTE_DND_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
        const textarea = draftRef.current;
        if (!noteId || !textarea) return;
        e.preventDefault();
        insertEmbedInDraft(noteId, textarea);
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="chat-media-input"
        accept="image/*,video/*,audio/*,.pdf,.txt,.md"
        multiple
        onChange={handleUpload}
      />
      <div className="chat-emoji-picker-wrap" ref={emojiPickerRef}>
        <button
          type="button"
          className="btn-icon chat-emoji-btn"
          aria-label="Choose emoji"
          aria-expanded={emojiPickerOpen}
          title="Choose emoji"
          onClick={() => setEmojiPickerOpen((open) => !open)}
        >
          <Smile size={17} />
        </button>
        {emojiPickerOpen && (
          <div className="chat-emoji-picker" role="dialog" aria-label="Emoji picker">
            {CHAT_EMOJIS.map((emoji) => (
              <button key={emoji} type="button" className="chat-emoji-option" onClick={() => insertEmoji(emoji)}>
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="btn-icon chat-upload-btn"
        onClick={() => fileInputRef.current?.click()}
        title="Upload media"
      >
        <ImagePlus size={17} />
      </button>
      <div className="chat-composer-main">
        {replyTarget && (
          <div className="chat-reply-bar">
            <div className="chat-reply-bar-copy">
              <span className="chat-reply-bar-label">
                Replying to <strong>@{replyTarget.mention}</strong>
              </span>
              <span className="chat-reply-bar-preview">{stripChatControlMarkers(replyTarget.preview)}</span>
            </div>
            {registeredAgents.some((agent) => normalizeMention(agent.mention) === normalizeMention(replyTarget.mention)) && (
              <button
                type="button"
                className={`chat-reply-mention-toggle${replyNotifiesAgent ? ' active' : ''}`}
                aria-pressed={replyNotifiesAgent}
                title={replyNotifiesAgent ? `Turn off notification for @${replyTarget.mention}` : `Notify @${replyTarget.mention}`}
                onClick={() => setReplyNotifiesAgent((value) => !value)}
              >
                @{replyNotifiesAgent ? 'ON' : 'OFF'}
              </button>
            )}
            <button
              type="button"
              className="chat-reply-bar-close"
              title="Cancel reply"
              onClick={() => {
                setReplyTarget(null);
                setReplyNotifiesAgent(true);
              }}
            >
              <X size={12} />
            </button>
          </div>
        )}
        {pendingMedia.length > 0 && (
          <div className="chat-paste-previews">
            {pendingMedia.map((item, index) => (
              <div key={`${item.name || 'media'}-${index}`} className="chat-paste-thumb">
                {isImageMediaType(item.media_type) ? (
                  <img src={item.url} alt="" />
                ) : isVideoMediaType(item.media_type) || isMp4Attachment(item) ? (
                  <video className="chat-paste-video" src={item.url} muted playsInline preload="metadata" />
                ) : (
                  <div className="chat-paste-file">
                    <Paperclip size={14} />
                    <span>{item.name || 'file'}</span>
                  </div>
                )}
                <button
                  type="button"
                  className="chat-paste-remove"
                  title="Remove"
                  onClick={() => setPendingMedia((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={draftRef}
          value={draft}
          placeholder={replyTarget ? `Reply to @${replyTarget.mention}` : directMessage ? `Message ${channelName}` : `Message #${channelName}`}
          spellCheck
          rows={1}
          onChange={(e) => {
            setDraft(e.target.value);
            mentionCycleRef.current = null;
            scheduleHistoryCommit();
          }}
          onPaste={handlePaste}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(NOTE_DND_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
            if (!noteId) return;
            e.preventDefault();
            e.stopPropagation();
            insertEmbedInDraft(noteId, e.currentTarget);
          }}
          onKeyDown={(e) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && (e.key === 'z' || e.key === 'Z')) {
              e.preventDefault();
              stepHistory(e.shiftKey ? 1 : -1);
              return;
            }
            if (mod && !e.shiftKey && (e.key === 'y' || e.key === 'Y')) {
              e.preventDefault();
              stepHistory(1);
              return;
            }
            if (e.key === 'Tab' && !e.shiftKey && isCompletingMention(e.currentTarget)) {
              e.preventDefault();
              completeMention(e.currentTarget);
              return;
            }
            if (e.key === 'Escape' && replyTarget) {
              e.preventDefault();
              setReplyTarget(null);
              setReplyNotifiesAgent(true);
              return;
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
      <button className="btn-icon chat-send-btn" onClick={submit} title="Send message" disabled={!canSend}>
        <Send size={17} />
      </button>
      {mediaError && <span className="chat-media-error">{mediaError}</span>}
    </footer>
  );
});
