import { useEffect, useRef, useMemo, useCallback, useState, memo } from 'react';
import type { Note, NoteSummary } from '../api';
import { api, formatRelativeDate, type NotePublishInfo } from '../api';
import { findEmbeddedNote, normalizeDocEmbedTarget, NOTE_DND_TYPE, noteEmbedMarkdown } from '../docEmbeds';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder, Decoration, type DecorationSet, WidgetType, drawSelection } from '@codemirror/view';
import { EditorState, type Extension, RangeSetBuilder, Prec, StateField, StateEffect } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, defaultHighlightStyle } from '@codemirror/language';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { closeBrackets } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { FileText, Link2, Columns3, Globe, ExternalLink, LockKeyhole, Save, Search, X } from 'lucide-react';
import { hasObsidianKanbanMarker, KanbanView } from './KanbanView';
import {
  acquireInteractionLock,
  bindDragGesture,
  releaseInteractionLock,
} from '../ui/interactionLocks';

/* ═══════════════════════════════════════════════════════════
   NoteEditor — CodeMirror 6 Live Preview Markdown Editor
   ═══════════════════════════════════════════════════════════ */

interface NoteEditorProps {
  note: Note | null;
  content: string;
  onContentChange: (content: string) => void;
  onSave: () => void | Promise<unknown>;
  onRename?: (title: string) => Promise<void>;
  onExecuteDirective?: (prompt: string) => void;
  onOpenWikilink?: (title: string) => void;
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
}

/* ─── Custom Dark Theme ──────────────────────────────────── */
const cascadeTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '0.9375rem',
    fontFamily: 'var(--font-sans)',
  },
  /* CodeMirror's default focused outline rings the entire note — kill it.
     Keyboard focus is already clear from the caret / active line. */
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-content': {
    padding: '16px 26px 80px',
    fontFamily: 'var(--font-sans)',
    lineHeight: '1.8',
    caretColor: 'var(--accent)',
    outline: 'none',
  },
  '.cm-content:focus, .cm-content:focus-visible': {
    outline: 'none',
    boxShadow: 'none',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    background: 'hsla(38, 92%, 55%, 0.22) !important',
  },
  /* Default search match highlight is neon green; tone it down. */
  '.cm-selectionMatch': {
    backgroundColor: 'hsla(38, 70%, 50%, 0.18)',
  },
  '.cm-selectionMatch-main': {
    backgroundColor: 'hsla(38, 80%, 50%, 0.28)',
  },
  '.cm-activeLine': {
    background: 'hsla(226, 14%, 16%, 0.5)',
  },
  '.cm-activeLineGutter': {
    background: 'hsla(226, 14%, 16%, 0.5)',
  },
  '.cm-gutters': {
    background: 'var(--bg-base)',
    color: 'hsl(224, 8%, 30%)',
    borderRight: '1px solid var(--border-subtle)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.75rem',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 12px 0 8px',
    minWidth: '3em',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  /* Markdown-specific styles */
  '.cm-line': {
    padding: '0 2px',
  },
  /* WYSIWYG heading styles — badge type, obliqued, like a model designation */
  '.cm-heading-1': {
    fontFamily: 'var(--font-display)',
    fontSize: '1.75em',
    fontWeight: '700',
    fontStyle: 'italic',
    lineHeight: '1.25',
    letterSpacing: '0.01em',
    color: 'hsl(222, 16%, 96%)',
  },
  '.cm-heading-2': {
    fontFamily: 'var(--font-display)',
    fontSize: '1.35em',
    fontWeight: '700',
    fontStyle: 'italic',
    lineHeight: '1.3',
    letterSpacing: '0.02em',
    color: 'hsl(222, 14%, 93%)',
  },
  '.cm-heading-3': {
    fontFamily: 'var(--font-display)',
    fontSize: '1.15em',
    fontWeight: '600',
    fontStyle: 'italic',
    lineHeight: '1.4',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'hsl(222, 12%, 88%)',
  },
  '.cm-heading-4': {
    fontFamily: 'var(--font-display)',
    fontSize: '1em',
    fontWeight: '600',
    fontStyle: 'italic',
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: 'hsl(222, 10%, 84%)',
  },
  /* Bold / Italic */
  '.cm-md-bold': {
    fontWeight: '700',
    color: 'hsl(222, 16%, 96%)',
  },
  '.cm-md-italic': {
    fontStyle: 'italic',
    color: 'hsl(222, 12%, 86%)',
  },
  /* Inline code — amber backlight on black */
  '.cm-md-inline-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    background: 'var(--bg-deep)',
    padding: '1px 5px',
    borderRadius: '2px',
    color: 'hsl(38, 88%, 66%)',
  },
  /* Hidden markers */
  '.cm-md-hidden': {
    fontSize: '0',
    width: '0',
    display: 'inline',
    overflow: 'hidden',
    color: 'transparent',
  },
  /* Wiki-link chip — amber, the in-world reference */
  '.cm-wikilink': {
    color: 'hsl(38, 88%, 68%)',
    background: 'hsla(38, 92%, 55%, 0.13)',
    padding: '1px 6px',
    borderRadius: '2px',
    cursor: 'pointer',
    fontWeight: '500',
  },
  '.cm-wikilink:hover': {
    background: 'hsla(38, 92%, 55%, 0.22)',
  },
  /* External Link — ice, the third decal band */
  '.cm-external-link': {
    color: 'hsl(192, 78%, 66%)',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  '.cm-external-link:hover': {
    color: 'hsl(192, 88%, 76%)',
  },
  /* AI directive chip — magenta, the second decal band */
  '.cm-directive': {
    color: 'hsl(338, 82%, 70%)',
    background: 'hsla(338, 78%, 55%, 0.13)',
    padding: '2px 8px',
    borderRadius: '2px',
    border: '1px solid hsla(338, 78%, 55%, 0.32)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
  },
  '.cm-checkbox': {
    cursor: 'pointer',
    accentColor: 'hsl(38, 92%, 55%)',
  },
  '.cm-hr-widget': {
    display: 'block',
    height: '1px',
    background: 'var(--border)',
    margin: '14px 0',
    border: 'none',
  },
  '.cm-private-block': {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    boxSizing: 'border-box',
    margin: '8px 0',
    padding: '11px 12px',
    border: '1px solid hsla(38, 88%, 60%, 0.34)',
    borderRadius: '4px',
    background: 'hsla(38, 72%, 45%, 0.08)',
    color: 'hsl(38, 74%, 72%)',
    cursor: 'pointer',
  },
  '.cm-private-block strong': {
    display: 'block',
    fontSize: '0.8rem',
    letterSpacing: '0.04em',
  },
  '.cm-private-block small': {
    display: 'block',
    marginTop: '1px',
    color: 'var(--text-tertiary)',
    fontSize: '0.7rem',
  },
  /* Code blocks read as a data plate: dead black, amber rule down the edge */
  '.cm-code-block-line': {
    background: 'var(--bg-deep)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    borderLeft: '2px solid hsla(38, 92%, 55%, 0.4)',
    paddingLeft: '12px',
  },
  /* GFM tables (rendered live-preview widget) */
  '.cm-md-table-wrap': {
    margin: '10px 0',
    overflowX: 'auto',
  },
  '.cm-md-table': {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: '0.9em',
    lineHeight: '1.5',
  },
  '.cm-md-table th, .cm-md-table td': {
    border: '1px solid var(--border)',
    padding: '5px 11px',
    textAlign: 'left',
    verticalAlign: 'top',
  },
  /* Table headers are spec-sheet column labels */
  '.cm-md-table th': {
    background: 'var(--bg-raised)',
    color: 'hsl(222, 14%, 92%)',
    fontFamily: 'var(--font-display)',
    fontWeight: '600',
    fontStyle: 'italic',
    fontSize: '0.85em',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  '.cm-md-table td': {
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-md-table tbody tr:nth-child(even) td, .cm-md-table tbody tr:nth-child(even) td': {
    background: 'hsla(226, 14%, 16%, 0.45)',
  },
  '.cm-md-table code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
    background: 'var(--bg-deep)',
    padding: '1px 5px',
    borderRadius: '2px',
    color: 'hsl(38, 88%, 66%)',
  },
  '.cm-doc-embed': {
    display: 'block',
    margin: '10px 0',
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: '2px',
    background: 'var(--bg-surface)',
    color: 'hsl(222, 12%, 86%)',
    cursor: 'pointer',
  },
  '.cm-doc-embed:hover': {
    borderColor: 'hsla(38, 92%, 55%, 0.45)',
    background: 'var(--bg-raised)',
  },
  '.cm-doc-embed.is-missing': {
    cursor: 'default',
    color: 'hsl(224, 8%, 55%)',
    borderStyle: 'dashed',
  },
  '.cm-doc-embed-title': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    color: 'hsl(222, 14%, 92%)',
    fontFamily: 'var(--font-display)',
    fontWeight: '700',
    fontStyle: 'italic',
    fontSize: '0.92rem',
    lineHeight: '1.3',
  },
  '.cm-doc-embed-preview': {
    marginTop: '6px',
    color: 'hsl(222, 9%, 62%)',
    fontSize: '0.85rem',
    lineHeight: '1.45',
  },
  '.cm-md-image-wrap': {
    position: 'relative',
    display: 'inline-block',
    margin: '12px 0',
    maxWidth: '100%',
    verticalAlign: 'top',
    lineHeight: '0',
  },
  '.cm-md-image-wrap.is-resizing': {
    userSelect: 'none',
  },
  '.cm-md-image': {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '2px',
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    cursor: 'default',
  },
  '.cm-md-image.is-loading': {
    minHeight: '120px',
  },
  '.cm-md-image.is-error': {
    minHeight: '48px',
    padding: '12px',
    color: 'hsl(222, 9%, 55%)',
    fontSize: '0.85rem',
  },
  '.cm-md-image-resize': {
    position: 'absolute',
    right: '4px',
    bottom: '4px',
    width: '14px',
    height: '14px',
    borderRadius: '2px',
    border: '1px solid hsla(38, 92%, 55%, 0.85)',
    background: 'linear-gradient(135deg, transparent 45%, hsla(38, 92%, 55%, 0.95) 45%, hsla(38, 92%, 55%, 0.95) 55%, transparent 55%), linear-gradient(135deg, transparent 65%, hsla(38, 92%, 55%, 0.75) 65%, hsla(38, 92%, 55%, 0.75) 75%, transparent 75%)',
    backgroundColor: 'hsla(226, 14%, 12%, 0.85)',
    cursor: 'nwse-resize',
    opacity: '0',
    transition: 'opacity 0.12s ease',
    boxShadow: '0 0 0 1px hsla(0, 0%, 0%, 0.35)',
    zIndex: '2',
  },
  '.cm-md-image-wrap:hover .cm-md-image-resize, .cm-md-image-wrap.is-resizing .cm-md-image-resize, .cm-md-image-wrap:focus-within .cm-md-image-resize': {
    opacity: '1',
  },
  '.cm-md-image-size': {
    position: 'absolute',
    left: '6px',
    bottom: '6px',
    padding: '1px 6px',
    borderRadius: '3px',
    background: 'hsla(226, 14%, 10%, 0.82)',
    color: 'hsl(38, 88%, 72%)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem',
    lineHeight: '1.4',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 0.12s ease',
    zIndex: '2',
  },
  '.cm-md-image-wrap.is-resizing .cm-md-image-size': {
    opacity: '1',
  },
}, { dark: true });

/* ─── Syntax Highlighting ────────────────────────────────── */
const cascadeHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'hsl(222, 16%, 96%)', fontFamily: 'var(--font-display)', fontWeight: '700', fontStyle: 'italic', fontSize: '1.75em' },
  { tag: tags.heading2, color: 'hsl(222, 14%, 93%)', fontFamily: 'var(--font-display)', fontWeight: '700', fontStyle: 'italic', fontSize: '1.35em' },
  { tag: tags.heading3, color: 'hsl(222, 12%, 88%)', fontFamily: 'var(--font-display)', fontWeight: '600', fontStyle: 'italic', fontSize: '1.15em' },
  { tag: tags.heading4, color: 'hsl(222, 10%, 84%)', fontFamily: 'var(--font-display)', fontWeight: '600', fontStyle: 'italic' },
  { tag: tags.heading5, color: 'hsl(222, 10%, 80%)', fontFamily: 'var(--font-display)', fontWeight: '600', fontStyle: 'italic' },
  { tag: tags.heading6, color: 'hsl(222, 9%, 76%)', fontFamily: 'var(--font-display)', fontWeight: '600', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700', color: 'hsl(222, 16%, 96%)' },
  { tag: tags.emphasis, fontStyle: 'italic', color: 'hsl(222, 12%, 86%)' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'hsl(224, 8%, 46%)' },
  { tag: tags.link, color: 'hsl(38, 88%, 68%)', textDecoration: 'underline' },
  { tag: tags.url, color: 'hsl(38, 70%, 56%)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', color: 'hsl(38, 88%, 66%)', fontSize: '0.875em' },
  { tag: tags.processingInstruction, color: 'hsl(38, 88%, 60%)' },
  { tag: tags.quote, color: 'hsl(222, 9%, 58%)', fontStyle: 'italic' },
  /* Code palette borrowed from the decal set so nothing reads as a stray hue */
  { tag: tags.keyword, color: 'hsl(338, 78%, 68%)' },
  { tag: tags.string, color: 'hsl(152, 62%, 60%)' },
  { tag: tags.number, color: 'hsl(38, 92%, 66%)' },
  { tag: tags.comment, color: 'hsl(224, 8%, 40%)' },
  { tag: tags.meta, color: 'hsl(192, 40%, 52%)' },
  { tag: tags.punctuation, color: 'hsl(224, 8%, 44%)' },
  { tag: tags.contentSeparator, color: 'hsl(226, 11%, 26%)' },
]);

/* ─── Checkbox Widget ────────────────────────────────────── */
class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean) {
    super();
  }
  toDOM() {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.checked;
    cb.className = 'cm-checkbox';
    cb.setAttribute('aria-label', this.checked ? 'Checked' : 'Unchecked');
    return cb;
  }
  eq(other: CheckboxWidget) {
    return this.checked === other.checked;
  }
}

/* ─── HR Widget ──────────────────────────────────────────── */
class HRWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('hr');
    hr.className = 'cm-hr-widget';
    return hr;
  }
}

class PrivateBlockWidget extends WidgetType {
  constructor(private from: number) {
    super();
  }
  toDOM() {
    const root = document.createElement('div');
    root.className = 'cm-private-block';
    root.dataset.privateFrom = String(this.from);
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', 'Private block. Hidden from agents. Click to edit.');
    root.innerHTML = '<span aria-hidden="true">🔒</span><span><strong>Private block</strong><small>Hidden from agents · click to edit</small></span>';
    return root;
  }
  eq(other: PrivateBlockWidget) {
    return this.from === other.from;
  }
  ignoreEvent() {
    return false;
  }
}

const NOTE_IMAGE_MAX_BYTES = 64 * 1024 * 1024;
const NOTE_AUDIO_MAX_BYTES = 64 * 1024 * 1024;

function imageFileFromDataTransfer(dataTransfer: DataTransfer | null): File | null {
  if (!dataTransfer) return null;
  const fromFiles = Array.from(dataTransfer.files || []).find((file) => file.type.startsWith('image/'));
  if (fromFiles) return fromFiles;
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
}

function resolveAssetUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const apiBase = import.meta.env.VITE_API_URL || '';
  return `${apiBase}${url.startsWith('/') ? url : `/${url}`}`;
}

/** Obsidian-style image size in alt: `![caption|320]` or `![caption|320x240]`. */
const IMAGE_ALT_SIZE_RE = /^(.*?)\|(\d{1,5})(?:x(\d{1,5}))?\s*$/;
const IMAGE_LINE_RE = /^(\s*)!\[([^\]]*)\]\(([^)]+)\)\s*$/;
const IMAGE_MIN_WIDTH_PX = 80;

export function parseImageAlt(raw: string): { alt: string; width: number | null } {
  const m = raw.match(IMAGE_ALT_SIZE_RE);
  if (!m) return { alt: raw, width: null };
  const width = Math.max(1, parseInt(m[2], 10));
  return { alt: m[1], width };
}

export function formatImageMarkdown(indent: string, alt: string, url: string, width: number | null): string {
  const cleanAlt = alt.replace(/\|/g, ' ').trim();
  const altPart = width != null && width > 0 ? `${cleanAlt}|${Math.round(width)}` : cleanAlt;
  return `${indent}![${altPart}](${url})`;
}

function clampImageWidth(px: number, maxWidth: number): number {
  const max = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : 2400;
  return Math.min(max, Math.max(IMAGE_MIN_WIDTH_PX, Math.round(px)));
}

function applyImageWidth(img: HTMLImageElement, width: number | null) {
  if (width != null && width > 0) {
    img.style.width = `${width}px`;
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
  } else {
    img.style.width = '';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
  }
}

function rewriteImageLineWidth(view: EditorView, wrap: HTMLElement, width: number | null): boolean {
  let pos: number;
  try {
    pos = view.posAtDOM(wrap);
  } catch {
    return false;
  }
  const line = view.state.doc.lineAt(pos);
  const match = line.text.match(IMAGE_LINE_RE);
  if (!match) return false;
  const [, indent, rawAlt, url] = match;
  const { alt } = parseImageAlt(rawAlt);
  const next = formatImageMarkdown(indent, alt, url, width);
  if (next === line.text) return true;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: next },
  });
  return true;
}

/* ─── Image Widget ───────────────────────────────────────── */
function isVideoMarkdownTarget(alt: string, url: string): boolean {
  const lowerAlt = alt.toLowerCase();
  const lowerUrl = url.toLowerCase();
  return lowerAlt.endsWith('.mp4')
    || lowerUrl.includes('video/mp4')
    || /\.mp4(\?|$)/.test(lowerUrl)
    || lowerUrl.endsWith('.mp4');
}

class VideoWidget extends WidgetType {
  constructor(
    private alt: string,
    private url: string,
  ) {
    super();
  }

  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-video-wrap';
    const video = document.createElement('video');
    video.className = 'cm-md-video is-loading';
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    const label = document.createElement('div');
    label.className = 'cm-md-video-label';
    label.textContent = this.alt || 'video.mp4';

    const resolved = resolveAssetUrl(this.url);
    const finish = (src: string) => {
      video.src = src;
      video.onloadeddata = () => video.classList.remove('is-loading');
      video.onerror = () => {
        video.classList.remove('is-loading');
        video.classList.add('is-error');
      };
    };

    if (/^https?:\/\//i.test(resolved) && !resolved.includes('/api/notes/')) {
      const link = document.createElement('a');
      link.href = resolved;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `External video: ${this.alt || 'video'}`;
      wrap.appendChild(link);
      return wrap;
    } else {
      fetch(resolved, {
        credentials: 'include',
      })
        .then((res) => {
          if (!res.ok) throw new Error('load failed');
          return res.blob();
        })
        .then((blob) => finish(URL.createObjectURL(blob)))
        .catch(() => {
          video.classList.remove('is-loading');
          video.classList.add('is-error');
        });
    }

    wrap.appendChild(video);
    wrap.appendChild(label);
    return wrap;
  }

  eq(other: VideoWidget) {
    return this.alt === other.alt && this.url === other.url;
  }

  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(
    private alt: string,
    private url: string,
    private width: number | null = null,
  ) {
    super();
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image-wrap';
    wrap.setAttribute('data-image-url', this.url);

    const img = document.createElement('img');
    img.className = 'cm-md-image is-loading';
    img.alt = this.alt || 'image';
    img.draggable = false;
    applyImageWidth(img, this.width);

    const handle = document.createElement('span');
    handle.className = 'cm-md-image-resize';
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', 'Drag to resize image');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.tabIndex = -1;

    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'cm-md-image-size';
    sizeLabel.setAttribute('aria-hidden', 'true');
    if (this.width != null) sizeLabel.textContent = `${this.width}px`;

    const maxWidthFor = () => {
      const scroller = view.scrollDOM;
      const contentPad = 52; // .cm-content horizontal padding
      const available = (scroller?.clientWidth ?? 800) - contentPad;
      return Math.max(IMAGE_MIN_WIDTH_PX, available);
    };

    handle.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startW = img.getBoundingClientRect().width || this.width || IMAGE_MIN_WIDTH_PX;
      const maxW = maxWidthFor();
      wrap.classList.add('is-resizing');
      acquireInteractionLock({ cursor: 'nwse-resize' });
      let lastX = startX;

      bindDragGesture({
        onMove: (ev) => {
          lastX = ev.clientX;
          const next = clampImageWidth(startW + (ev.clientX - startX), maxW);
          applyImageWidth(img, next);
          sizeLabel.textContent = `${next}px`;
        },
        onEnd: () => {
          wrap.classList.remove('is-resizing');
          releaseInteractionLock();
          const next = clampImageWidth(startW + (lastX - startX), maxW);
          applyImageWidth(img, next);
          sizeLabel.textContent = `${next}px`;
          rewriteImageLineWidth(view, wrap, next);
        },
      });
    });

    // Double-click handle resets to natural size.
    handle.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyImageWidth(img, null);
      sizeLabel.textContent = '';
      rewriteImageLineWidth(view, wrap, null);
    });

    const resolved = resolveAssetUrl(this.url);
    if (/^https?:\/\//i.test(resolved) && !resolved.includes('/api/notes/')) {
      const link = document.createElement('a');
      link.href = resolved;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `External image: ${this.alt || 'image'}`;
      wrap.appendChild(link);
      return wrap;
    }

    fetch(resolved, {
      credentials: 'include',
    })
      .then((res) => {
        if (!res.ok) throw new Error('load failed');
        return res.blob();
      })
      .then((blob) => {
        img.src = URL.createObjectURL(blob);
        img.onload = () => img.classList.remove('is-loading');
      })
      .catch(() => {
        img.classList.remove('is-loading');
        img.classList.add('is-error');
        img.alt = 'Failed to load image';
      });

    wrap.appendChild(img);
    wrap.appendChild(handle);
    wrap.appendChild(sizeLabel);
    return wrap;
  }

  eq(other: ImageWidget) {
    return this.alt === other.alt && this.url === other.url && this.width === other.width;
  }

  ignoreEvent(event: Event) {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('.cm-md-image-resize')) return true;
    // Allow editor selection on the image body (click-through to edit source line).
    return false;
  }
}

/* ─── GFM Table support ──────────────────────────────────── */
type CellAlign = 'left' | 'center' | 'right' | null;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal inline markdown → HTML for table cells (escape first, then format). */
function renderCellInline(raw: string): string {
  let s = escapeHtml(raw.trim());
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<span class="cm-external-link" data-url="$2">$1</span>');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '<span class="cm-wikilink">$1</span>');
  return s;
}

/** Split a `| a | b |` row into trimmed cells, dropping the outer pipes. */
function splitTableRow(text: string): string[] {
  let t = text.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** True if the line is a GFM delimiter row, e.g. `|---|:--:|` (must have a pipe,
 * so a bare `---` horizontal rule isn't mistaken for a 1-column table). */
function isTableDelimiter(text: string): boolean {
  if (!text.includes('|')) return false;
  const cells = splitTableRow(text);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function cellAlign(delimCell: string): CellAlign {
  const c = delimCell.trim();
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return null;
}

class TableWidget extends WidgetType {
  constructor(
    private header: string[],
    private align: CellAlign[],
    private rows: string[][],
    private key: string,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return this.key === other.key;
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'cm-md-table';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    this.header.forEach((cell, i) => {
      const th = document.createElement('th');
      th.innerHTML = renderCellInline(cell);
      const a = this.align[i];
      if (a) th.style.textAlign = a;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of this.rows) {
      const tr = document.createElement('tr');
      for (let i = 0; i < this.header.length; i++) {
        const td = document.createElement('td');
        td.innerHTML = renderCellInline(row[i] ?? '');
        const a = this.align[i];
        if (a) td.style.textAlign = a;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
}

class DocEmbedWidget extends WidgetType {
  constructor(
    private target: string,
    private note: NoteSummary | null,
  ) {
    super();
  }
  eq(other: DocEmbedWidget) {
    return this.target === other.target && this.note?.id === other.note?.id && this.note?.content_preview === other.note?.content_preview;
  }
  toDOM() {
    const root = document.createElement('div');
    root.className = `cm-doc-embed${this.note ? '' : ' is-missing'}`;
    root.setAttribute('data-note-id', this.note?.id ?? '');

    const title = document.createElement('div');
    title.className = 'cm-doc-embed-title';
    title.textContent = this.note?.title ?? `Missing note: ${this.target}`;
    root.appendChild(title);

    const previewText = this.note?.content_preview?.trim();
    if (previewText) {
      const preview = document.createElement('div');
      preview.className = 'cm-doc-embed-preview';
      preview.textContent = previewText.length > 220 ? `${previewText.slice(0, 219)}…` : previewText;
      root.appendChild(preview);
    }
    return root;
  }
}

/* ─── WYSIWYG Decorations Plugin ─────────────────────────── */
export function buildDecorations(
  state: EditorState,
  notes: NoteSummary[] = [],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  const cursorLine = state.selection.main.head;
  const activeLine = doc.lineAt(cursorLine).number;

  const hidden = Decoration.mark({ class: 'cm-md-hidden' });
  const boldDeco = Decoration.mark({ class: 'cm-md-bold' });
  const italicDeco = Decoration.mark({ class: 'cm-md-italic' });
  const codeDeco = Decoration.mark({ class: 'cm-md-inline-code' });
  const wikilinkDeco = Decoration.mark({ class: 'cm-wikilink' });
  const directiveDeco = Decoration.mark({ class: 'cm-directive' });

  // Flat list to collect all decoration ranges
  const decos: { from: number; to: number; deco: Decoration }[] = [];

  // Helper to collect a decoration range safely
  const collectDeco = (from: number, to: number, deco: Decoration) => {
    if (from < to) {
      decos.push({ from, to, deco });
    }
  };

  const privateBlocks: { from: number; to: number }[] = [];
  let privateStart: number | null = null;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const marker = line.text.trim().toLowerCase();
    if (privateStart === null && marker === ':::private') {
      privateStart = line.from;
    } else if (privateStart !== null && marker === ':::') {
      privateBlocks.push({ from: privateStart, to: line.to });
      privateStart = null;
    }
  }
  if (privateStart !== null) privateBlocks.push({ from: privateStart, to: doc.length });
  const inPrivateBlock = (from: number, to: number) =>
    privateBlocks.some((block) => from >= block.from && to <= block.to);
  for (const block of privateBlocks) {
    if (activeLine < doc.lineAt(block.from).number || activeLine > doc.lineAt(block.to).number) {
      decos.push({
        from: block.from,
        to: block.to,
        deco: Decoration.replace({
          block: true,
          widget: new PrivateBlockWidget(block.from),
        }),
      });
    }
  }

  // GFM tables: a header row, a delimiter row, then 0+ body rows. Rendered as a
  // block widget when the cursor is outside (raw source stays editable inside).
  const tableBlocks: { from: number; to: number }[] = [];
  for (let i = 1; i + 1 <= doc.lines; i++) {
    const headerLine = doc.line(i);
    const delimLine = doc.line(i + 1);
    if (inPrivateBlock(headerLine.from, headerLine.to)) continue;
    if (!headerLine.text.includes('|')) continue;
    if (!isTableDelimiter(delimLine.text)) continue;

    const header = splitTableRow(headerLine.text);
    const align = splitTableRow(delimLine.text).map(cellAlign);
    if (header.length !== align.length) continue; // not a real table
    const rows: string[][] = [];
    let lastLine = i + 1;
    for (let j = i + 2; j <= doc.lines; j++) {
      const bl = doc.line(j);
      if (!bl.text.trim() || !bl.text.includes('|')) break;
      rows.push(splitTableRow(bl.text));
      lastLine = j;
    }

    const from = headerLine.from;
    const to = doc.line(lastLine).to;
    tableBlocks.push({ from, to });
    if (cursorLine < doc.lineAt(from).number || cursorLine > doc.lineAt(to).number) {
      decos.push({
        from,
        to,
        deco: Decoration.replace({
          block: true,
          widget: new TableWidget(header, align, rows, doc.sliceString(from, to)),
        }),
      });
    }
    i = lastLine; // skip past the consumed table
  }
  const inTableBlock = (from: number, to: number) =>
    tableBlocks.some((b) => from >= b.from && to <= b.to);

  let inCodeBlock = false;
  let codeBlockFenceChar = '';
  let codeBlockFenceLength = 0;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const isActive = i === activeLine;
    if (inPrivateBlock(line.from, line.to)) continue;
    if (inTableBlock(line.from, line.to)) continue;

    if (inCodeBlock) {
      const endFenceMatch = text.match(/^(\s*)(`{3,}|~{3,})\s*$/);
      if (endFenceMatch && endFenceMatch[2][0] === codeBlockFenceChar && endFenceMatch[2].length >= codeBlockFenceLength) {
        inCodeBlock = false;
        if (!isActive) {
          collectDeco(line.from, line.to, hidden);
        } else {
          decos.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-code-block-line' }) });
        }
        continue;
      }

      decos.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-code-block-line' }) });
      continue;
    }

    const startFenceMatch = text.match(/^(\s*)(`{3,}|~{3,})([^\s`~]*)\s*$/);
    if (startFenceMatch) {
      inCodeBlock = true;
      codeBlockFenceChar = startFenceMatch[2][0];
      codeBlockFenceLength = startFenceMatch[2].length;
      if (!isActive) {
        collectDeco(line.from, line.to, hidden);
      } else {
        decos.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-code-block-line' }) });
      }
      continue;
    }

    // Headings: Apply class and optionally hide markers
    const headingMatch = text.match(/^(#{1,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const cls = `cm-heading-${Math.min(level, 4)}`;
      collectDeco(line.from, line.to, Decoration.mark({ class: cls }));
      if (!isActive) {
        // Hide the # markers
        collectDeco(line.from, line.from + headingMatch[0].length, hidden);
      }
    }

    // Horizontal rule
    if (/^---+$/.test(text.trim()) && !isActive) {
      if (line.from < line.to) {
        decos.push({
          from: line.from,
          to: line.to,
          deco: Decoration.replace({ widget: new HRWidget() }),
        });
      }
      continue;
    }

    // Checkboxes
    const checkMatch = text.match(/^(\s*[-*+]\s)\[([xX ])\]/);
    if (checkMatch) {
      const checked = checkMatch[2].toLowerCase() === 'x';
      const cbStart = line.from + checkMatch[1].length;
      const cbEnd = cbStart + 3; // [x] or [ ]
      if (cbStart < cbEnd) {
        decos.push({
          from: cbStart,
          to: cbEnd,
          deco: Decoration.replace({ widget: new CheckboxWidget(checked) }),
        });
      }
    }

    if (isActive) continue; // Don't hide/decorate formatting markers on the active line

    const imageMatch = text.match(IMAGE_LINE_RE);
    if (imageMatch) {
      const { alt, width } = parseImageAlt(imageMatch[2]);
      const url = imageMatch[3];
      if (isVideoMarkdownTarget(alt, url)) {
        decos.push({
          from: line.from,
          to: line.to,
          deco: Decoration.replace({
            block: true,
            widget: new VideoWidget(alt, url),
          }),
        });
      } else {
        decos.push({
          from: line.from,
          to: line.to,
          deco: Decoration.replace({
            block: true,
            widget: new ImageWidget(alt, url, width),
          }),
        });
      }
      continue;
    }

    const embedMatch = text.trim().match(/^!\[\[([^\]]+)\]\]$/);
    if (embedMatch) {
      const target = normalizeDocEmbedTarget(embedMatch[1]);
      decos.push({
        from: line.from,
        to: line.to,
        deco: Decoration.replace({
          widget: new DocEmbedWidget(target, findEmbeddedNote(notes, target)),
        }),
      });
      continue;
    }

    // Determine starting index for inline pattern scanning to avoid matching block prefixes
    let inlineStart = 0;
    const listMatch = text.match(/^(\s*[-*+]|\d+\.)\s/);

    if (headingMatch) {
      inlineStart = headingMatch[0].length;
    } else if (checkMatch) {
      inlineStart = checkMatch[0].length;
    } else if (listMatch) {
      inlineStart = listMatch[0].length;
    }

    // Paired inline delimiters: hide the open/close markers and style the span
    // between them. `strict` rejects empty spans; `breakOnFail` stops at the
    // first unmatched opener; `okStart`/`okEnd` are per-delimiter guards.
    const scanInline = (
      open: string,
      close: string,
      deco: typeof hidden,
      opts: { strict?: boolean; breakOnFail?: boolean; okStart?: (i: number) => boolean; okEnd?: (i: number) => boolean } = {},
    ) => {
      const { strict = true, breakOnFail = false, okStart, okEnd } = opts;
      let idx = text.indexOf(open, inlineStart);
      while (idx !== -1) {
        if (!okStart || okStart(idx)) {
          const end = text.indexOf(close, idx + open.length);
          const longEnough = strict ? end > idx + open.length : end >= idx + open.length;
          if (end !== -1 && longEnough && (!okEnd || okEnd(end))) {
            collectDeco(line.from + idx, line.from + idx + open.length, hidden);
            collectDeco(line.from + idx + open.length, line.from + end, open === '[['
              ? Decoration.mark({ class: 'cm-wikilink', attributes: { 'data-note-target': text.slice(idx + open.length, end) } })
              : deco);
            collectDeco(line.from + end, line.from + end + close.length, hidden);
            idx = text.indexOf(open, end + close.length);
            continue;
          }
        }
        if (breakOnFail) break;
        idx = text.indexOf(open, idx + open.length);
      }
    };

    scanInline('**', '**', boldDeco, { breakOnFail: true }); // Bold
    scanInline('*', '*', italicDeco, { // Italic (ignore bold **)
      okStart: (i) => text[i + 1] !== '*' && text[i - 1] !== '*',
      okEnd: (i) => text[i + 1] !== '*' && text[i - 1] !== '*',
    });
    scanInline('`', '`', codeDeco, { okStart: (i) => text[i + 1] !== '`' }); // Inline code
    scanInline('[[', ']]', wikilinkDeco, { strict: false, breakOnFail: true }); // Wikilinks

    // External links: [text](https://...)
    let extIdx = text.indexOf('[', inlineStart);
    while (extIdx !== -1) {
      if (text[extIdx + 1] !== '[') {
        const sub = text.slice(extIdx);
        const match = sub.match(/^\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/);
        if (match) {
          const label = match[1];
          const destUrl = match[2];
          collectDeco(line.from + extIdx, line.from + extIdx + 1, hidden);
          collectDeco(line.from + extIdx + 1, line.from + extIdx + 1 + label.length, Decoration.mark({
            class: 'cm-external-link',
            attributes: { 'data-url': destUrl }
          }));
          collectDeco(line.from + extIdx + 1 + label.length, line.from + extIdx + match[0].length, hidden);
          extIdx += match[0].length;
          continue;
        }
      }
      extIdx = text.indexOf('[', extIdx + 1);
    }

    // AI Directives: {{ai: prompt}}
    let dirIdx = text.indexOf('{{ai:', inlineStart);
    while (dirIdx !== -1) {
      const endDir = text.indexOf('}}', dirIdx + 5);
      if (endDir !== -1) {
        collectDeco(line.from + dirIdx, line.from + endDir + 2, directiveDeco);
        dirIdx = text.indexOf('{{ai:', endDir + 2);
      } else {
        break;
      }
    }
  }

  // Sort decorations by start position ascending, then end position descending.
  // Line decorations (from === to) must always precede mark decorations (from < to) starting at the same position.
  decos.sort((a, b) => {
    if (a.from !== b.from) {
      return a.from - b.from;
    }
    const aIsLine = a.from === a.to;
    const bIsLine = b.from === b.to;
    if (aIsLine && !bIsLine) return -1;
    if (!aIsLine && bIsLine) return 1;
    return b.to - a.to;
  });

  // Add all sorted decorations to builder
  for (const item of decos) {
    builder.add(item.from, item.to, item.deco);
  }

  return builder.finish();
}

function createWysiwygDecorations(
  /** Live notes list via getter so vault soft-refreshes don't reconfigure CM. */
  getNotes: () => NoteSummary[] = () => [],
) {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, getNotes());
    },
    update(decorations, transaction) {
      // Full rebuild is O(doc). Only do it when the doc changed, or when the
      // active line changed (live-preview hides markers on the cursor line).
      // Pure same-line selection moves used to re-scan the whole note every
      // click/drag and froze large notes for 1–2s.
      if (transaction.docChanged) {
        return buildDecorations(
          transaction.state,
          getNotes(),
        );
      }
      if (transaction.selection) {
        const prev = transaction.startState;
        const oldLine = prev.doc.lineAt(prev.selection.main.head).number;
        const newLine = transaction.state.doc.lineAt(transaction.state.selection.main.head).number;
        if (oldLine !== newLine) {
          return buildDecorations(
            transaction.state,
            getNotes(),
          );
        }
      }
      return decorations;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return field;
}

/* ─── Checkbox Click Handler ─────────────────────────────── */
const checkboxClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement;
    if (target.nodeName === 'INPUT' && target.classList.contains('cm-checkbox')) {
      event.preventDefault();
      const pos = view.posAtDOM(target);
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      const match = text.match(/^(\s*[-*+]\s)\[([xX ])\]/);
      if (match) {
        const checked = match[2].toLowerCase() === 'x';
        const replacement = checked ? '[ ]' : '[x]';
        const start = line.from + match[1].length;
        const end = start + 3;
        view.dispatch({
          changes: { from: start, to: end, insert: replacement },
        });
      }
      return true;
    }
    return false;
  },
});

/* ─── Component ──────────────────────────────────────────── */
export function filterLinkableNotes(notes: NoteSummary[], currentNoteId: string | undefined, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return notes
    .filter((candidate) => candidate.id !== currentNoteId && !candidate.is_archived)
    .filter((candidate) => !needle || candidate.title.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.title.localeCompare(b.title));
}

export const NoteEditor = memo(function NoteEditor({ note, content, onContentChange, onSave, onRename, onExecuteDirective, onOpenWikilink, notes = [], onOpenNote }: NoteEditorProps) {
  const [publishInfo, setPublishInfo] = useState<NotePublishInfo>({ published: false });
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishNotice, setPublishNotice] = useState('');
  const [viewMode, setViewMode] = useState<'editor' | 'kanban'>('editor');
  const [noteLinkPickerOpen, setNoteLinkPickerOpen] = useState(false);
  const [noteLinkQuery, setNoteLinkQuery] = useState('');
  const [mobileSaveState, setMobileSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const onContentChangeRef = useRef(onContentChange);
  const onSaveRef = useRef(onSave);
  const onExecuteDirectiveRef = useRef(onExecuteDirective);
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  const onOpenNoteRef = useRef(onOpenNote);
  const insertImageFromFileRef = useRef<(file: File, view?: EditorView, coords?: { x: number; y: number }) => Promise<boolean>>(async () => false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const saveFeedbackTimerRef = useRef<number | null>(null);
  // Keep notes off the extensions dependency graph — setNotes from vault soft
  // refresh was reconfigure-ing CodeMirror (full destroy/rebuild of plugins)
  // and freezing the UI for a second or two on every background return.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const linkableNotes = useMemo(
    () => filterLinkableNotes(notes, note?.id, noteLinkQuery),
    [notes, note?.id, noteLinkQuery],
  );
  const kanbanBoardCount = useMemo(() => (
    notes.filter((candidate) => candidate.id !== note?.id && hasObsidianKanbanMarker(candidate.content_preview)).length
      + (hasObsidianKanbanMarker(content) ? 1 : 0)
  ), [content, note?.id, notes]);

  useEffect(() => () => {
    if (saveFeedbackTimerRef.current !== null) window.clearTimeout(saveFeedbackTimerRef.current);
  }, []);

  // Inline, editable note title (Obsidian-style). Synced from the note.
  const [titleDraft, setTitleDraft] = useState(note?.title ?? '');
  useEffect(() => { setTitleDraft(note?.title ?? ''); }, [note?.id, note?.title]);
  useEffect(() => {
    if (!note?.id || typeof localStorage === 'undefined') {
      setViewMode(hasObsidianKanbanMarker(content) ? 'kanban' : 'editor');
      return;
    }
    const savedMode = localStorage.getItem(`cascade_note_view:${note.id}`);
    if (savedMode === 'kanban' || savedMode === 'editor') {
      setViewMode(savedMode);
      return;
    }
    setViewMode(hasObsidianKanbanMarker(content) ? 'kanban' : 'editor');
  }, [content, note?.id]);

  const selectViewMode = useCallback((mode: 'editor' | 'kanban') => {
    setViewMode(mode);
    if (note?.id && typeof localStorage !== 'undefined') {
      localStorage.setItem(`cascade_note_view:${note.id}`, mode);
    }
    if (mode === 'editor') requestAnimationFrame(() => viewRef.current?.focus());
  }, [note?.id]);

  const commitTitle = useCallback(() => {
    const next = titleDraft.trim();
    if (!note || !next || next === note.title) {
      setTitleDraft(note?.title ?? '');
      return;
    }
    onRename?.(next)?.catch(() => setTitleDraft(note.title));
  }, [titleDraft, note, onRename]);

  useEffect(() => {
    if (!note?.id) {
      setPublishInfo({ published: false });
      return;
    }
    let cancelled = false;
    api<NotePublishInfo>(`/api/notes/${note.id}/publish`)
      .then((info) => { if (!cancelled) setPublishInfo(info); })
      .catch(() => { if (!cancelled) setPublishInfo({ published: false }); });
    return () => { cancelled = true; };
  }, [note?.id, note?.updated_at]);

  const flashPublishNotice = useCallback((message: string) => {
    setPublishNotice(message);
    window.setTimeout(() => setPublishNotice(''), 2400);
  }, []);

  const copyPublicUrl = useCallback(async (url: string) => {
    await navigator.clipboard.writeText(url);
    flashPublishNotice('Copied public link');
  }, [flashPublishNotice]);

  const handlePublish = useCallback(async () => {
    if (!note || publishBusy) return;
    setPublishBusy(true);
    try {
      const result = await api<{ slug: string; url: string; published_at: string; updated_at: string }>(
        `/api/notes/${note.id}/publish`,
        {
          method: 'POST',
          body: JSON.stringify({ title: titleDraft.trim() || note.title, content }),
        },
      );
      setPublishInfo({
        published: true,
        slug: result.slug,
        url: result.url,
        published_at: result.published_at,
        updated_at: result.updated_at,
      });
      await copyPublicUrl(result.url);
    } catch (err) {
      flashPublishNotice(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setPublishBusy(false);
    }
  }, [note, publishBusy, titleDraft, content, copyPublicUrl, flashPublishNotice]);

  const handleUnpublish = useCallback(async () => {
    if (!note || publishBusy || !publishInfo.published) return;
    if (!window.confirm('Unpublish this note? The public link will stop working.')) return;
    setPublishBusy(true);
    try {
      await api(`/api/notes/${note.id}/publish`, { method: 'DELETE' });
      setPublishInfo({ published: false });
      flashPublishNotice('Unpublished');
    } catch (err) {
      flashPublishNotice(err instanceof Error ? err.message : 'Unpublish failed');
    } finally {
      setPublishBusy(false);
    }
  }, [note, publishBusy, publishInfo.published, flashPublishNotice]);

  const insertMediaFromFile = useCallback(async (
    file: File,
    config: {
      accept: (file: File) => boolean;
      maxBytes: number;
      tooLargeLabel: string;
      uploadingLabel: string;
      mediaType: string;
      buildMarkdown: (file: File, url: string) => string;
      successLabel: string;
      failLabel: string;
    },
    view?: EditorView,
    coords?: { x: number; y: number },
  ) => {
    const editorView = view ?? viewRef.current;
    if (!note?.id || !editorView) return false;
    if (!config.accept(file)) return false;
    if (file.size > config.maxBytes) {
      flashPublishNotice(`${config.tooLargeLabel} is too large (max ${config.maxBytes / (1024 * 1024)}MB)`);
      return false;
    }

    flashPublishNotice(`Uploading ${config.uploadingLabel}...`);
    try {
      const data = await readFileAsBase64(file);
      const result = await api<{ url: string }>(`/api/notes/${note.id}/assets`, {
        method: 'POST',
        body: JSON.stringify({ media_type: config.mediaType, data, filename: file.name }),
      });
      const markdown = config.buildMarkdown(file, result.url);
      const pos = coords ? editorView.posAtCoords(coords) : null;
      const from = pos ?? editorView.state.selection.main.from;
      const to = pos ?? editorView.state.selection.main.to;
      const line = editorView.state.doc.lineAt(from);
      const prefix = line.text.trim() ? '\n\n' : '';
      const insert = `${prefix}${markdown}\n`;
      editorView.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      editorView.focus();
      flashPublishNotice(config.successLabel);
      return true;
    } catch (err) {
      flashPublishNotice(err instanceof Error ? err.message : config.failLabel);
      return false;
    }
  }, [note, flashPublishNotice]);

  const insertImageFromFile = useCallback((file: File, view?: EditorView, coords?: { x: number; y: number }) =>
    insertMediaFromFile(file, {
      accept: (f) => f.type.startsWith('image/'),
      maxBytes: NOTE_IMAGE_MAX_BYTES,
      tooLargeLabel: 'Image',
      uploadingLabel: 'image',
      mediaType: file.type,
      buildMarkdown: (f, url) => `![${(f.name || 'image').replace(/\.[^.]+$/, '') || 'image'}](${url})`,
      successLabel: 'Image pasted',
      failLabel: 'Image upload failed',
    }, view, coords),
  [insertMediaFromFile]);

  const insertAudioFromFile = useCallback((file: File) =>
    insertMediaFromFile(file, {
      accept: (f) => f.type === 'audio/mpeg' || f.name.toLowerCase().endsWith('.mp3'),
      maxBytes: NOTE_AUDIO_MAX_BYTES,
      tooLargeLabel: 'MP3',
      uploadingLabel: 'MP3',
      mediaType: 'audio/mpeg',
      buildMarkdown: (f, url) => `[${f.name || 'audio.mp3'}](${url})`,
      successLabel: 'MP3 attached',
      failLabel: 'MP3 upload failed',
    }),
  [insertMediaFromFile]);

  const insertVideoFromFile = useCallback((file: File) =>
    insertMediaFromFile(file, {
      accept: (f) => f.type === 'video/mp4' || f.name.toLowerCase().endsWith('.mp4'),
      maxBytes: NOTE_AUDIO_MAX_BYTES,
      tooLargeLabel: 'MP4',
      uploadingLabel: 'MP4',
      mediaType: 'video/mp4',
      buildMarkdown: (f, url) => `![${f.name || 'video.mp4'}](${url})`,
      successLabel: 'MP4 embedded',
      failLabel: 'MP4 upload failed',
    }),
  [insertMediaFromFile]);

  insertImageFromFileRef.current = insertImageFromFile;

  const insertNoteEmbed = useCallback((noteId: string, coords?: { x: number; y: number }) => {
    const view = viewRef.current;
    if (!view) return false;
    const embedded = notesRef.current.find((item) => item.id === noteId);
    if (!embedded) return false;
    const insert = noteEmbedMarkdown(embedded);
    const pos = coords ? view.posAtCoords(coords) : null;
    const from = pos ?? view.state.selection.main.from;
    const to = pos ?? view.state.selection.main.to;
    const needsPrefix = from > 0 && !/\s/.test(view.state.doc.sliceString(from - 1, from)) ? ' ' : '';
    const needsSuffix = to < view.state.doc.length && !/\s/.test(view.state.doc.sliceString(to, to + 1)) ? ' ' : '';
    const text = `${needsPrefix}${insert}${needsSuffix}`;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }, []);

  // Keep refs updated
  contentRef.current = content;
  onContentChangeRef.current = onContentChange;
  onSaveRef.current = onSave;
  onExecuteDirectiveRef.current = onExecuteDirective;
  onOpenWikilinkRef.current = onOpenWikilink;
  onOpenNoteRef.current = onOpenNote;

  // Word count and stats
  const stats = useMemo(() => {
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const chars = content.length;
    const readingTime = Math.max(1, Math.ceil(words / 200));
    return { words, chars, readingTime };
  }, [content]);

  // Build extensions
  const extensions: Extension[] = useMemo(
    () => [
      cascadeTheme,
      syntaxHighlighting(cascadeHighlightStyle),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      history(),
      EditorView.lineWrapping,
      cmPlaceholder('Start writing...'),
      createWysiwygDecorations(
        () => notesRef.current,
      ),
      checkboxClickHandler,
      EditorView.domEventHandlers({
        dragover(event) {
          const hasNote = event.dataTransfer?.types.includes(NOTE_DND_TYPE);
          const hasImage = Array.from(event.dataTransfer?.items || [])
            .some((item) => item.kind === 'file' && item.type.startsWith('image/'));
          if (!hasNote && !hasImage) return false;
          event.preventDefault();
          event.dataTransfer!.dropEffect = 'copy';
          return true;
        },
        drop(event) {
          const noteId = event.dataTransfer?.getData(NOTE_DND_TYPE);
          if (noteId) {
            event.preventDefault();
            return insertNoteEmbed(noteId, { x: event.clientX, y: event.clientY });
          }
          const image = imageFileFromDataTransfer(event.dataTransfer);
          if (image) {
            event.preventDefault();
            void insertImageFromFileRef.current(image, undefined, { x: event.clientX, y: event.clientY });
            return true;
          }
          return false;
        },
        paste(event, view) {
          const image = imageFileFromDataTransfer(event.clipboardData);
          if (!image) return false;
          event.preventDefault();
          void insertImageFromFileRef.current(image, view);
          return true;
        },
        mousedown(event, view) {
          const target = event.target as HTMLElement;
          const privateBlock = target.closest('.cm-private-block') as HTMLElement | null;
          if (privateBlock) {
            const from = Number(privateBlock.dataset.privateFrom);
            if (Number.isFinite(from)) {
              event.preventDefault();
              const line = view.state.doc.lineAt(Math.min(from, view.state.doc.length));
              view.dispatch({
                selection: { anchor: Math.min(line.to + 1, view.state.doc.length) },
                scrollIntoView: true,
              });
              view.focus();
              return true;
            }
          }
          const docEmbed = target.closest('.cm-doc-embed');
          if (docEmbed) {
            const noteId = docEmbed.getAttribute('data-note-id');
            if (noteId) {
              event.preventDefault();
              onOpenNoteRef.current?.(noteId);
              return true;
            }
          }
          const wikilink = target.closest('.cm-wikilink');
          if (wikilink) {
            const title = wikilink.getAttribute('data-note-target') || wikilink.textContent?.trim();
            if (title) {
              event.preventDefault();
              onOpenWikilinkRef.current?.(title);
              return true;
            }
          }
          const extLink = target.closest('.cm-external-link');
          if (extLink) {
            const url = extLink.getAttribute('data-url');
            if (url) {
              event.preventDefault();
              window.open(url, '_blank', 'noopener,noreferrer');
              return true;
            }
          }
          return false;
        },
      }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
        {
          key: 'Mod-Shift-s',
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
        {
          key: 'Mod-b',
          run: (view) => {
            toggleInlineFormat(view, '**');
            return true;
          },
        },
        {
          key: 'Mod-i',
          run: (view) => {
            toggleInlineFormat(view, '*');
            return true;
          },
        },
        {
          key: 'Mod-k',
          run: (view) => {
            insertLink(view);
            return true;
          },
        },
      ]),
      // Highest precedence so it beats defaultKeymap's Mod-Enter (insertBlankLine):
      // run the {{ai: …}} directive at the cursor through the agent panel.
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              const prompt = directiveAtCursor(view);
              if (!prompt) return false;
              onExecuteDirectiveRef.current?.(prompt);
              return true;
            },
          },
        ])
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newDoc = update.state.doc.toString();
          contentRef.current = newDoc;
          onContentChangeRef.current(newDoc);
        }
      }),
    ],
    [insertNoteEmbed],
  );

  // Create/destroy editor
  useEffect(() => {
    if (!editorRef.current) return;

    const state = EditorState.create({
      doc: contentRef.current,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [note?.id]);

  // Reconfigure extensions dynamically when they change (callbacks only —
  // notes are read via notesRef so vault refresh never hits this path).
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: StateEffect.reconfigure.of(extensions),
      });
    }
  }, [extensions, note?.id]);

  // Update content when note changes externally
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== content) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    }
  }, [note?.id, content]);

  // Toolbar actions
  const toolbarAction = useCallback((action: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.focus();

    switch (action) {
      case 'bold':
        toggleInlineFormat(view, '**');
        break;
      case 'italic':
        toggleInlineFormat(view, '*');
        break;
      case 'strikethrough':
        toggleInlineFormat(view, '~~');
        break;
      case 'code':
        toggleInlineFormat(view, '`');
        break;
      case 'link':
        insertLink(view);
        break;
      case 'image':
        imageInputRef.current?.click();
        break;
      case 'h1':
        toggleLinePrefix(view, '# ');
        break;
      case 'h2':
        toggleLinePrefix(view, '## ');
        break;
      case 'h3':
        toggleLinePrefix(view, '### ');
        break;
      case 'checklist':
        toggleLinePrefix(view, '- [ ] ');
        break;
      case 'bullet':
        toggleLinePrefix(view, '- ');
        break;
      case 'numbered':
        toggleLinePrefix(view, '1. ');
        break;
      case 'hr':
        insertAtCursor(view, '\n---\n');
        break;
      case 'private':
        insertPrivateBlock(view);
        break;
    }
  }, []);

  const handleMobileSave = useCallback(async () => {
    if (mobileSaveState === 'saving') return;
    setMobileSaveState('saving');
    if (saveFeedbackTimerRef.current !== null) window.clearTimeout(saveFeedbackTimerRef.current);
    try {
      await Promise.resolve(onSaveRef.current());
      setMobileSaveState('saved');
      saveFeedbackTimerRef.current = window.setTimeout(() => setMobileSaveState('idle'), 1800);
    } catch {
      setMobileSaveState('error');
    }
  }, [mobileSaveState]);

  const insertNoteLink = useCallback((target: NoteSummary) => {
    const view = viewRef.current;
    if (!view) return;
    insertAtCursor(view, `[[${target.title.replace(/\]\]/g, '')}]]`);
    setNoteLinkPickerOpen(false);
    setNoteLinkQuery('');
    requestAnimationFrame(() => view.focus());
  }, []);

  if (!note) {
    return (
      <div className="editor-container">
        <div className="editor-empty">
          <span className="empty-icon"><FileText size={32} /></span>
          <span className="empty-title">No note selected</span>
          <span className="empty-hint">
            Choose a note from the sidebar or press <kbd>Ctrl+N</kbd> to create one
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-container" id="editor-container">
      {/* Toolbar */}
      <div className="editor-toolbar" id="editor-toolbar">
        <button id="toolbar-bold" className="toolbar-btn" onClick={() => toolbarAction('bold')} title="Bold (Ctrl+B)"><strong>B</strong></button>
        <button id="toolbar-italic" className="toolbar-btn" onClick={() => toolbarAction('italic')} title="Italic (Ctrl+I)"><em>I</em></button>
        <button id="toolbar-strike" className="toolbar-btn" onClick={() => toolbarAction('strikethrough')} title="Strikethrough"><s>S</s></button>
        <button id="toolbar-code" className="toolbar-btn mono" onClick={() => toolbarAction('code')} title="Inline Code">&lt;/&gt;</button>
        <button id="toolbar-link" className="toolbar-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => toolbarAction('link')} title="Insert Link (Ctrl+K)"><Link2 size={16} /></button>
        <button id="toolbar-image" className="toolbar-btn" onClick={() => toolbarAction('image')} title="Upload image, MP3, or MP4 (images also support paste/drop)">📎</button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*,audio/mpeg,.mp3,video/mp4,.mp4"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file?.type.startsWith('image/')) void insertImageFromFile(file);
            else if (file?.type === 'video/mp4' || file?.name.toLowerCase().endsWith('.mp4')) void insertVideoFromFile(file);
            else if (file) void insertAudioFromFile(file);
          }}
        />

        <div className="toolbar-divider" />

        <button id="toolbar-h1" className="toolbar-btn" onClick={() => toolbarAction('h1')} title="Heading 1">H1</button>
        <button id="toolbar-h2" className="toolbar-btn" onClick={() => toolbarAction('h2')} title="Heading 2">H2</button>
        <button id="toolbar-h3" className="toolbar-btn" onClick={() => toolbarAction('h3')} title="Heading 3">H3</button>

        <div className="toolbar-divider" />

        <button id="toolbar-checklist" className="toolbar-btn" onClick={() => toolbarAction('checklist')} title="Checklist">☑</button>
        <button id="toolbar-bullet" className="toolbar-btn" onClick={() => toolbarAction('bullet')} title="Bullet List">•</button>
        <button id="toolbar-numbered" className="toolbar-btn" onClick={() => toolbarAction('numbered')} title="Numbered List">1.</button>

        <div className="toolbar-divider" />

        <button id="toolbar-hr" className="toolbar-btn" onClick={() => toolbarAction('hr')} title="Horizontal Rule">―</button>
        <button id="toolbar-private" className="toolbar-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => toolbarAction('private')} title="Insert private block (hidden from agents)"><LockKeyhole size={15} /></button>

        <div className="toolbar-divider" />

        <button
          id="toolbar-publish"
          className={`toolbar-btn${publishInfo.published ? ' active' : ''}`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { void handlePublish(); }}
          disabled={publishBusy}
          title={publishInfo.published ? 'Republish snapshot & copy link' : 'Publish to public view'}
        >
          <Globe size={15} />
        </button>
        {publishInfo.published && publishInfo.url && (
          <>
            <button
              id="toolbar-copy-public-link"
              className="toolbar-btn"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => { void copyPublicUrl(publishInfo.url!); }}
              title="Copy public link"
            >
              <Link2 size={15} />
            </button>
            <button
              id="toolbar-open-public"
              className="toolbar-btn"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => window.open(publishInfo.url, '_blank', 'noopener,noreferrer')}
              title="Open public view"
            >
              <ExternalLink size={15} />
            </button>
          </>
        )}
        <div className="toolbar-spacer" />
        <div className="editor-view-toggle" role="group" aria-label="Note view">
          <button
            type="button"
            className={`toolbar-btn${viewMode === 'editor' ? ' active' : ''}`}
            onClick={() => selectViewMode('editor')}
            title="Markdown view"
            aria-pressed={viewMode === 'editor'}
          >
            <FileText size={15} />
          </button>
          <button
            type="button"
            className={`toolbar-btn${viewMode === 'kanban' ? ' active' : ''}`}
            onClick={() => selectViewMode('kanban')}
            title="Kanban view"
            aria-pressed={viewMode === 'kanban'}
          >
            <Columns3 size={15} />
          </button>
        </div>
      </div>

      {/* Inline editable title */}
      <input
        id="editor-title"
        className="editor-title"
        value={titleDraft}
        spellCheck={false}
        placeholder="Untitled"
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitTitle(); viewRef.current?.focus(); }
          else if (e.key === 'Escape') { setTitleDraft(note.title); (e.target as HTMLInputElement).blur(); }
        }}
      />

      {/* Editor */}
      <div className={`editor-codemirror${viewMode === 'kanban' ? ' is-hidden' : ''}`} id="editor-codemirror" ref={editorRef} />
      {viewMode === 'kanban' && (
        <KanbanView content={content} onContentChange={onContentChange} showSuperkanbanToggle={kanbanBoardCount > 1} />
      )}

      <div className="mobile-note-actions" aria-label="Note actions">
        <button type="button" className="mobile-note-action" onClick={() => { void handleMobileSave(); }} disabled={mobileSaveState === 'saving'}>
          <Save size={18} />
          <span>{mobileSaveState === 'saving' ? 'Saving…' : mobileSaveState === 'saved' ? 'Saved' : mobileSaveState === 'error' ? 'Retry save' : 'Save'}</span>
        </button>
        <button type="button" className="mobile-note-action" onClick={() => setNoteLinkPickerOpen(true)}>
          <Link2 size={18} />
          <span>Link note</span>
        </button>
      </div>

      {noteLinkPickerOpen && (
        <div className="note-link-picker-backdrop" onMouseDown={() => setNoteLinkPickerOpen(false)}>
          <section className="note-link-picker" role="dialog" aria-modal="true" aria-label="Link a note" onMouseDown={(event) => event.stopPropagation()}>
            <div className="note-link-picker-header">
              <div>
                <strong>Link a note</strong>
                <span>Insert a link at the cursor</span>
              </div>
              <button type="button" className="note-link-picker-close" aria-label="Close note picker" onClick={() => setNoteLinkPickerOpen(false)}><X size={20} /></button>
            </div>
            <label className="note-link-picker-search">
              <Search size={17} />
              <input autoFocus value={noteLinkQuery} onChange={(event) => setNoteLinkQuery(event.target.value)} placeholder="Search notes" />
            </label>
            <div className="note-link-picker-list">
              {linkableNotes.map((candidate) => (
                <button type="button" key={candidate.id} onClick={() => insertNoteLink(candidate)}>
                  <FileText size={17} />
                  <span>{candidate.title}</span>
                </button>
              ))}
              {linkableNotes.length === 0 && <p>{noteLinkQuery ? 'No matching notes' : 'No other notes yet'}</p>}
            </div>
          </section>
        </div>
      )}

      {/* Status bar */}
      <div className="editor-status-bar" id="editor-status-bar">
        <span className="status-item">{stats.words} words</span>
        <span className="status-item">{stats.chars} chars</span>
        <span className="status-item">~{stats.readingTime} min read</span>
        {viewMode === 'kanban' && <span className="status-item">Kanban · Markdown backed</span>}
        {note.updated_at && (
          <span className="status-item status-saved">
            Saved {formatRelativeDate(note.updated_at)}
          </span>
        )}
        {publishInfo.published && publishInfo.updated_at && (
          <button
            type="button"
            className="status-item status-public"
            onClick={() => { void handleUnpublish(); }}
            title="Click to unpublish"
          >
            Public · {formatRelativeDate(publishInfo.updated_at)}
          </button>
        )}
        {publishNotice && <span className="status-item status-notice">{publishNotice}</span>}
      </div>
    </div>
  );
});

/* ─── Editor Helpers ─────────────────────────────────────── */
function toggleInlineFormat(view: EditorView, marker: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2) {
    // Remove format
    view.dispatch({
      changes: { from, to, insert: selected.slice(marker.length, -marker.length) },
    });
  } else {
    // Add format
    view.dispatch({
      changes: { from, to, insert: `${marker}${selected || 'text'}${marker}` },
      selection: { anchor: from + marker.length, head: to + marker.length },
    });
  }
}

function toggleLinePrefix(view: EditorView, prefix: string) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const text = line.text;

  // Check if any heading prefix exists
  const headingMatch = text.match(/^(#{1,6}\s|[-*+]\s(\[.\]\s)?|\d+\.\s)/);
  if (headingMatch) {
    // Remove existing prefix
    view.dispatch({
      changes: { from: line.from, to: line.from + headingMatch[0].length, insert: '' },
    });
    // Add new prefix if it's different
    if (headingMatch[0] !== prefix) {
      view.dispatch({
        changes: { from: line.from, insert: prefix },
      });
    }
  } else {
    view.dispatch({
      changes: { from: line.from, insert: prefix },
    });
  }
}

function insertLink(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = selected ? `[${selected}](url)` : '[link text](url)';
  view.dispatch({
    changes: { from, to, insert },
  });
}

function insertAtCursor(view: EditorView, text: string) {
  const { from } = view.state.selection.main;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  });
}

function insertPrivateBlock(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const prefix = from > 0 && view.state.sliceDoc(from - 1, from) !== '\n' ? '\n' : '';
  const body = selected || 'credential=value';
  const insert = `${prefix}:::private\n${body}\n:::\n`;
  const bodyFrom = from + prefix.length + ':::private\n'.length;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: bodyFrom, head: bodyFrom + body.length },
  });
}

// Extract the prompt of the {{ai: …}} directive on the cursor's line. Prefers a
// directive the cursor sits inside; otherwise falls back to the first on the line.
function directiveAtCursor(view: EditorView): string | null {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const col = head - line.from;
  const re = /\{\{ai:([\s\S]*?)\}\}/g;
  let match: RegExpExecArray | null;
  let fallback: string | null = null;
  while ((match = re.exec(line.text))) {
    const prompt = match[1].trim();
    if (!prompt) continue;
    if (col >= match.index && col <= match.index + match[0].length) return prompt;
    if (fallback === null) fallback = prompt;
  }
  return fallback;
}
