/**
 * @file CommandPalette.tsx — Quick note switcher with fuzzy filtering
 *
 * A modal overlay (Ctrl+P) that lets users quickly find and open notes by
 * typing a query. Filters notes by title and tags using substring matching.
 * Supports full keyboard navigation:
 * - Arrow keys to move highlight
 * - Enter to select highlighted note (or create a new note if no matches)
 * - Escape to close
 *
 * The highlighted item auto-scrolls into view. When no results match and a
 * query is entered, offers a "Create note" action.
 *
 * @component
 */

import { useState, useEffect } from 'react';
import type { NoteSummary } from '../api';
import { Sparkles, FileText } from 'lucide-react';
import { SearchListOverlay } from './SearchListOverlay';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  notes: NoteSummary[];
  onSelectNote: (id: string) => void;
  onCreateNote: () => void;
}

export function CommandPalette({
  open,
  onClose,
  notes,
  onSelectNote,
  onCreateNote,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  useEffect(() => { if (open) setQuery(''); }, [open]);

  // Fuzzy filter
  const filtered = query.trim()
    ? notes.filter((note) => {
        const q = query.toLowerCase();
        const title = (note.title || '').toLowerCase();
        const tags = note.tags.join(' ').toLowerCase();
        return title.includes(q) || tags.includes(q);
      })
    : notes;

  const createNote = () => { onCreateNote(); onClose(); };

  return (
    <SearchListOverlay
      open={open}
      prefix="command-palette"
      label="Open anything"
      placeholder="Search notes or type to create..."
      query={query}
      onQueryChange={setQuery}
      onClose={onClose}
      items={filtered}
      onSelect={(note) => { onSelectNote(note.id); onClose(); }}
      onEmptySelect={createNote}
      footer={`${filtered.length} notes`}
      renderItem={(note) => (
        <>
          <span className="item-icon"><FileText size={16} /></span>
          <span className="item-info">
            <span className="item-title">{note.title || 'Untitled'}</span>
            <span className="item-path">
              {note.content_preview?.slice(0, 60) || 'Empty note'}
            </span>
          </span>
          {note.tags.length > 0 && (
            <span className="item-tags">
              {note.tags.slice(0, 2).map((tag) => (
                <span key={tag} className="badge">{tag}</span>
              ))}
            </span>
          )}
        </>
      )}
    >
      {filtered.length === 0 && query.trim() && (
        <button className="command-palette-item highlighted" onClick={createNote}>
          <span className="item-icon"><Sparkles size={16} /></span>
          <span className="item-info">
            <span className="item-title">Create &quot;{query}&quot;</span>
            <span className="item-path">New note</span>
          </span>
        </button>
      )}

      {filtered.length === 0 && !query.trim() && (
        <div className="palette-empty">
          Start typing to search your notes...
        </div>
      )}
    </SearchListOverlay>
  );
}
