import { useEffect, useRef, useState } from 'react';
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
  const items = message.reactions?.items || {};
  const hasItems = choices.some(([emoji]) => items[emoji]?.length);
  useEffect(() => {
    const chunk = rootRef.current?.closest('.chat-message-chunk');
    if (!chunk) return;
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.pointerType === 'pen') setRevealed(true);
    };
    chunk.addEventListener('pointerup', onPointerUp);
    return () => chunk.removeEventListener('pointerup', onPointerUp);
  }, []);
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
    {choices.filter(([emoji]) => open || items[emoji]?.length).map(([emoji, label]) => {
      const count = items[emoji]?.length || 0;
      const own = items[emoji]?.includes(`user:${userId}`) || false;
      return <button key={emoji} type="button" disabled={pending} aria-pressed={own}
        aria-label={`${label}${count ? `, ${count}` : ''}${own ? ', your reaction' : ''}`}
        onClick={() => void toggle(emoji)}>{emoji}{count > 0 && <span>{count}</span>}</button>;
    })}
    <button type="button" className="chat-reactions-add" aria-label="Add reaction" aria-expanded={open} disabled={pending}
      onClick={() => setOpen(!open)}>☺+</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
