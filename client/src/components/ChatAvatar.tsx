import { agentOwnerStyle, type AgentOwnership } from '../chat/agents';
import { Bot } from 'lucide-react';

function initialFor(name: string) {
  return (name.trim().charAt(0) || '?').toUpperCase();
}

export function ChatAvatar({
  name,
  kind,
  avatarUrl = '',
  size = 'md',
  onClick,
  title,
  ownership = 'unknown',
  ownerLabel,
}: {
  name: string;
  kind: 'agent' | 'human';
  avatarUrl?: string;
  size?: 'sm' | 'md';
  /** When set, the avatar is a button (e.g. open agent settings from a message). */
  onClick?: (event: React.MouseEvent) => void;
  title?: string;
  ownership?: AgentOwnership;
  ownerLabel?: string;
}) {
  const className = `chat-avatar chat-avatar-${size} chat-avatar-${kind}${onClick ? ' is-clickable' : ''}`;
  const ownerTitle = kind === 'agent' ? (ownerLabel ? `${ownerLabel}’s agent` : 'Owner unknown') : '';
  const avatarTitle = [title || (onClick ? `Open settings for ${name}` : ''), ownerTitle].filter(Boolean).join(' · ');
  const content = avatarUrl
    ? <img src={avatarUrl} alt="" />
    : kind === 'agent'
      ? <Bot size={size === 'sm' ? 14 : 15} />
      : initialFor(name);
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        data-agent-ownership={kind === 'agent' ? ownership : undefined}
        style={kind === 'agent' ? agentOwnerStyle(ownerLabel) : undefined}
        title={avatarTitle}
        aria-label={avatarTitle || `Open settings for ${name}`}
      >
        {content}
      </button>
    );
  }
  return (
    <div
      className={className}
      data-agent-ownership={kind === 'agent' ? ownership : undefined}
        style={kind === 'agent' ? agentOwnerStyle(ownerLabel) : undefined}
      title={avatarTitle || undefined}
      role={kind === 'agent' ? 'img' : undefined}
      aria-label={kind === 'agent' ? `${name} · ${ownerTitle}` : undefined}
      aria-hidden={kind === 'human' ? true : undefined}
    >
      {content}
    </div>
  );
}
