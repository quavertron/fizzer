import { Forward, Reply } from 'lucide-react';
import { stripChatControlMarkers } from '../chat/shared';
import type { ChatMessage } from '../chat/types';

/**
 * Renders the reply/forward provenance quotes for a chat message.
 * Shared between ChatView and ChatWorkTrace, which had identical markup.
 *
 * The reply quote becomes a button when the parent can actually scroll to the
 * quoted message. Callers that cannot jump (the work trace) omit the handler
 * and get the original inert markup.
 */
export function ChatQuoteRefs({ message, onJumpToMessage, canJumpToReply = false }: {
  message: ChatMessage;
  onJumpToMessage?: (messageId: string) => void;
  /** False when the quoted message is not in the loaded window, so there is nothing to scroll to. */
  canJumpToReply?: boolean;
}) {
  const replyId = message.replyTo?.messageId;
  const jumpable = Boolean(replyId && canJumpToReply && onJumpToMessage);
  return (
    <>
      {message.replyTo && (
        jumpable ? (
          <button
            type="button"
            className="chat-reply-quote is-jumpable"
            title={`Jump to ${message.replyTo.author}'s message`}
            aria-label={`Jump to ${message.replyTo.author}'s message`}
            onClick={(event) => {
              // The chunk around this quote toggles selection on click.
              event.stopPropagation();
              onJumpToMessage!(replyId!);
            }}
          >
            <Reply size={12} />
            <strong>{message.replyTo.author}</strong>
            <span>{stripChatControlMarkers(message.replyTo.preview)}</span>
          </button>
        ) : (
          <div
            className="chat-reply-quote"
            title={replyId ? 'The quoted message is not loaded in this view' : undefined}
          >
            <Reply size={12} />
            <strong>{message.replyTo.author}</strong>
            <span>{stripChatControlMarkers(message.replyTo.preview)}</span>
          </div>
        )
      )}
      {message.forwardedFrom && (
        <div className="chat-forward-quote">
          <Forward size={12} />
          <span>
            Forwarded from <strong>#{message.forwardedFrom.channelName}</strong>
            {' · '}
            {message.forwardedFrom.author}
          </span>
        </div>
      )}
    </>
  );
}
