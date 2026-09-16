import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { moveListSelection, useListSelection } from '../ui/listNavigation';

type SearchListOverlayProps<T> = {
  open: boolean;
  prefix: 'command-palette' | 'search';
  label: string;
  placeholder: string;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  items: T[];
  onSelect: (item: T) => void;
  onEmptySelect?: () => void;
  renderItem: (item: T) => ReactNode;
  children: ReactNode;
  status?: ReactNode;
  footer: ReactNode;
};

export function SearchListOverlay<T extends { id: string }>({
  open, prefix, label, placeholder, query, onQueryChange, onClose,
  items, onSelect, onEmptySelect, renderItem, children, status, footer,
}: SearchListOverlayProps<T>) {
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const palette = prefix === 'command-palette';
  const itemPrefix = palette ? 'palette-item' : 'search-result';
  const itemClass = palette ? 'command-palette-item' : 'search-result-item';

  useEffect(() => { setHighlightIndex(0); }, [open]);
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open]);
  useListSelection(listRef, highlightIndex, items.length, setHighlightIndex);

  if (!open) return null;

  return (
    <div
      className="overlay-backdrop"
      id={`${prefix}-backdrop`}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        className={palette ? prefix : 'search-overlay'}
        id={palette ? prefix : 'search-overlay'}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className={`${prefix}-input-wrap`}>
          <span className="search-icon"><Search size={16} /></span>
          <input
            ref={inputRef}
            id={`${prefix}-input`}
            className={`${prefix}-input`}
            autoFocus={!palette}
            value={query}
            onChange={(event) => {
              onQueryChange(event.target.value);
              setHighlightIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setHighlightIndex((index) => moveListSelection(index, event.key === 'ArrowDown' ? 1 : -1, items.length));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                if (items[highlightIndex]) onSelect(items[highlightIndex]);
                else if (query.trim()) onEmptySelect?.();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
              }
            }}
            placeholder={placeholder}
          />
          {status}
        </div>
        <div className={`${prefix}-results`} ref={listRef}>
          {items.map((item, index) => (
            <button
              key={item.id}
              id={`${itemPrefix}-${item.id}`}
              className={`${itemClass} ${index === highlightIndex ? 'highlighted' : ''}`}
              onClick={() => onSelect(item)}
              onMouseEnter={() => setHighlightIndex(index)}
            >
              {renderItem(item)}
            </button>
          ))}
          {children}
        </div>
        <footer className={`${prefix}-footer`}>
          <span><kbd>↑↓</kbd> navigate <kbd>↵</kbd> {palette ? 'select' : 'open'} <kbd>esc</kbd> close</span>
          <span>{footer}</span>
        </footer>
      </section>
    </div>
  );
}
