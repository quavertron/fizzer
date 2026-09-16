/**
 * Shared @mention parsing helpers used by chat send logic and the ChatView UI.
 */

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Canonical handle: strip @, trim, lowercase (matches server vault uniqueness). */
export function normalizeMention(value: string) {
  return value
    .replace(/^@+/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function mentionPattern(alias: string) {
  const escaped = alias.trim().split(/\s+/).map(escapeRegExp).join('[\\s-]*');
  return new RegExp(`@\\s*${escaped}(?=$|[\\s.,:;!?\\])}])`, 'gi');
}

export type MentionableAgent = {
  agentId: string;
  mention: string;
  taggableByAgents: boolean;
};

export function hasRegistrationForMention(
  mention: string,
  registrations: Array<Pick<MentionableAgent, 'agentId' | 'mention'>>,
): boolean {
  const target = normalizeMention(mention);
  return Boolean(target && registrations.some((registration) =>
    normalizeMention(registration.mention || registration.agentId) === target
  ));
}

/** Resolve the channel member behind an agent-authored message. Older desktop
 * helpers did not attach registrationId, so fall back to one unambiguous
 * agentId + display-name match instead of silently dropping agent handoffs. */
export function resolveAgentMessageRegistration<T extends MentionableAgent & { id: string; displayName: string }>(
  message: { registrationId?: string; agentId?: string; author?: string },
  registrations: T[],
): T | undefined {
  if (message.registrationId) {
    const exact = registrations.find((item) => item.id === message.registrationId);
    if (exact) return exact;
  }
  if (!message.agentId || !message.author) return undefined;
  const author = message.author.trim().toLowerCase();
  const matches = registrations.filter((item) =>
    item.agentId === message.agentId && item.displayName.trim().toLowerCase() === author
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Does a reply quote point at an agent, i.e. is it supposed to start a run?
 *
 * A reply ref falls back to an author-derived @name, so replying to a person
 * carries a mention too — the mention alone cannot answer this, and treating it
 * as one made "could not route reply" fire on every human reply.
 */
export function replyQuoteTargetsAgent(
  replyTo: { messageId: string; mention?: string } | undefined,
  messages: Array<{ id: string; agentId?: string; registrationId?: string }>,
): boolean {
  if (!replyTo) return false;
  const quoted = messages.find((message) => message.id === replyTo.messageId);
  // A derived reply mention can belong to a person too. If the quoted row is
  // outside the loaded window, let the server inspect the authoritative parent
  // rather than showing a false agent-routing failure in the renderer.
  if (!quoted) return false;
  return Boolean(quoted.agentId || quoted.registrationId);
}

export function getMentionedRegistrations<T extends MentionableAgent & { id?: string; vaultAgentId?: string }>(
  text: string,
  registrations: T[],
  fromAgent: boolean,
): T[] {
  const mentioned: T[] = [];
  const seen = new Set<string>();
  for (const registration of registrations) {
    if (fromAgent && !registration.taggableByAgents) continue;
    const mention = normalizeMention(registration.mention || registration.agentId);
    if (!mention || !mentionPattern(mention).test(text)) continue;
    // One trigger per vault identity (or registration id) even if denormalized copies exist.
    const key = registration.vaultAgentId || registration.id || mention;
    if (seen.has(key)) continue;
    seen.add(key);
    mentioned.push(registration);
  }
  return mentioned;
}

export function stripRegisteredAgentMentions(
  text: string,
  registrations: Array<{ agentId: string; mention: string }>,
) {
  let next = text;
  for (const registration of registrations) {
    const mention = normalizeMention(registration.mention || registration.agentId);
    if (mention) next = next.replace(mentionPattern(mention), ' ');
  }
  return next.replace(/\s+/g, ' ').trim();
}

export function isCompactCommand(
  text: string,
  registrations: Array<{ agentId: string; mention: string }>,
) {
  return /^\/compact$/i.test(stripRegisteredAgentMentions(text, registrations).trim());
}
