export const CHAT_RELATIONSHIPS = [
  'builds_on',
  'review_request',
  'question',
  'contradiction',
  'decision',
] as const;

export type ChatRelationship = typeof CHAT_RELATIONSHIPS[number];

export const CHAT_RELATIONSHIP_LABELS: Record<ChatRelationship, string> = {
  builds_on: 'Builds on',
  review_request: 'Review request',
  question: 'Question',
  contradiction: 'Contradiction',
  decision: 'Decision',
};
