import { normalizeMention } from './mentions';
import { stripChatControlMarkers } from './shared';
import type { ChatAgentRegistration, ChatMessage, ChatReplyRef } from './types';

export function buildReplyPreview(message: ChatMessage) {
  const body = stripChatControlMarkers(message.body);
  if (body) return body.length > 120 ? `${body.slice(0, 119)}…` : body;
  if (message.images?.length) return `[${message.images.length} image${message.images.length === 1 ? '' : 's'}]`;
  if (message.attachments?.length) return message.attachments[0]?.name || '[attachment]';
  return '(message)';
}

export function resolveReplyMention(message: ChatMessage, registeredAgents: ChatAgentRegistration[]) {
  if (message.registrationId) {
    const registration = registeredAgents.find((item) => item.id === message.registrationId);
    if (registration) return normalizeMention(registration.mention || registration.agentId);
  }
  const byAuthor = registeredAgents.find((item) =>
    item.displayName === message.author
    || normalizeMention(item.mention) === normalizeMention(message.author),
  );
  if (byAuthor) return normalizeMention(byAuthor.mention || byAuthor.agentId);
  if (message.agentId) {
    const registration = registeredAgents.find((item) => item.agentId === message.agentId);
    if (registration) return normalizeMention(registration.mention || registration.agentId);
  }
  return normalizeMention(message.author);
}

export function buildReplyRef(message: ChatMessage, registeredAgents: ChatAgentRegistration[]): ChatReplyRef {
  return {
    messageId: message.id,
    author: message.author,
    mention: resolveReplyMention(message, registeredAgents),
    preview: buildReplyPreview(message),
  };
}
