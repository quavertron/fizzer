import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { chatMessageStore } from '../chat/messageStore';
import type { ChatMessage } from '../chat/types';
import './ChatReactions.css';

const choices = [['😂', 'Laugh'], ['👍', 'Thumbs up'], ['❤️', 'Heart'], ['🎉', 'Celebrate'], ['👀', 'Eyes'], ['😢', 'Sad']] as const;

export function ChatReactions({ message, vaultId, userId }: { message: ChatMessage; vaultId: string; userId: number }) {
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const [pickerPosition, setPickerPosition] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!open || !addRef.current || !pickerRef.current) return;
    const anchor = addRef.current.getBoundingClientRect();
    const picker = pickerRef.current.getBoundingClientRect();
    setPickerPosition({
      top: Math.max(8, anchor.bottom + picker.height + 12 <= window.innerHeight
        ? anchor.bottom + 4 : anchor.top - picker.height - 4),
      left: Math.max(8, Math.min(anchor.right - picker.width, window.innerWidth - picker.width - 8)),
    });
  }, [open]);
  const items = message.reactions?.items || {};
  const hasItems = choices.some(([emoji]) => items[emoji]?.length);
  useEffect(() => {
    const chunk = rootRef.current?.closest<HTMLElement>('.chat-message-chunk');
    if (!chunk) return;
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.pointerType === 'pen') setRevealed(true);
    };
    chunk.addEventListener('pointerup', onPointerUp);
    return () => chunk.removeEventListener('pointerup', onPointerUp);
  }, []);
  useEffect(() => {
    if (!open && !revealed) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target) && !pickerRef.current?.contains(event.target)) {
        setOpen(false);
        setRevealed(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      setRevealed(false);
      addRef.current?.focus();
    };
    const reposition = () => setOpen(false);
    window.addEventListener('resize', reposition);
    document.addEventListener('scroll', reposition, true);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', reposition);
      document.removeEventListener('scroll', reposition, true);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open, revealed]);
  const toggle = async (emoji: string) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const { message: saved } = await api<{ message: ChatMessage }>(
        `/api/vaults/${encodeURIComponent(vaultId)}/channels/${encodeURIComponent(message.channelId)}/messages/${encodeURIComponent(message.id)}/reactions`,
        { method: 'PUT', body: JSON.stringify({ emoji, active: !items[emoji]?.includes(`user:${userId}`) }) },
      );
      // A late HTTP response must not replace newer streamed content or reactions.
      chatMessageStore.update(message.channelId, rows => rows.map(row => row.id === message.id
        && (saved.reactions?.version ?? -1) >= (row.reactions?.version ?? 0)
        ? { ...row, reactions: saved.reactions } : row));
      setOpen(false);
    } catch {
      setError('Could not update reaction. Try again.');
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return <div
    ref={rootRef}
    className={`chat-reactions${hasItems ? ' has-items' : ''}${open ? ' is-open' : ''}${revealed ? ' is-revealed' : ''}`}
    onClick={event => event.stopPropagation()}
  >
    {choices.filter(([emoji]) => items[emoji]?.length).map(([emoji, label]) => {
      const count = items[emoji]?.length || 0;
      const own = items[emoji]?.includes(`user:${userId}`) || false;
      return <button key={emoji} type="button" disabled={pending} aria-pressed={own}
        aria-label={`${label}${count ? `, ${count}` : ''}${own ? ', your reaction' : ''}`}
        onClick={() => void toggle(emoji)}>{emoji}{count > 0 && <span>{count}</span>}</button>;
    })}
    <button ref={addRef} type="button" className="chat-reactions-add" aria-label="Add reaction" aria-expanded={open} disabled={pending}
      onClick={() => setOpen(!open)}>☺+</button>
    {open && createPortal(<div ref={pickerRef} style={pickerPosition} className="chat-reactions-picker" role="group" aria-label="Choose reaction">
      {choices.map(([emoji, label]) => <button key={emoji} type="button" disabled={pending}
        aria-label={label} aria-pressed={items[emoji]?.includes(`user:${userId}`) || false}
        onClick={() => void toggle(emoji)}>{emoji}</button>)}
    </div>, document.body)}
    {error && <span role="alert">{error}</span>}
  </div>;
}
