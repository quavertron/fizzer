/**
 * Chat projection reconciliation and session trace normalization.
 */

import type { ChatBlock, ChatMessage } from './types';
import { stripChatControlMarkers } from './shared';

export function newId(prefix: string) {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}

/** Persisted row order is authoritative. Fall back to timestamps only while an
 * optimistic row is still missing its server sequence. */
export function sortChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const seqA = a.message.seq;
      const seqB = b.message.seq;
      if (typeof seqA === 'number' && typeof seqB === 'number' && seqA !== seqB) {
        return seqA - seqB;
      }
      const byTime = Date.parse(a.message.createdAt) - Date.parse(b.message.createdAt);
      return byTime || a.index - b.index;
    })
    .map(({ message }) => message);
}

export function normalizeChatRunBlocks(content: unknown): ChatBlock[] {
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ChatBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', text: String(block.thinking || block.text || '') });
    } else if (block.type === 'redacted_thinking') {
      blocks.push({ type: 'thinking', text: '', redacted: true });
    } else if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: typeof block.id === 'string' ? block.id : undefined,
        name: typeof block.name === 'string' ? block.name : 'tool',
        input: block.input,
      });
    } else if (block.type === 'tool_result') {
      const rawContent = block.content;
      let contentText = '';
      if (typeof rawContent === 'string') {
        contentText = rawContent;
      } else if (Array.isArray(rawContent)) {
        contentText = rawContent
          .map((part) => {
            if (!part || typeof part !== 'object') return '';
            const rec = part as Record<string, unknown>;
            if (typeof rec.text === 'string') return rec.text;
            return '';
          })
          .filter(Boolean)
          .join('\n');
      } else if (rawContent != null) {
        try {
          contentText = JSON.stringify(rawContent);
        } catch {
          contentText = String(rawContent);
        }
      }
      blocks.push({
        type: 'tool_result',
        toolUseId: typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : typeof block.toolUseId === 'string'
            ? block.toolUseId
            : undefined,
        content: contentText,
        text: contentText,
        isError: block.is_error === true || block.isError === true,
      });
    }
  }
  return blocks;
}

/** Placeholder bodies carry no answer after their run settles. */
export function isLiveAgentPlaceholder(body: string | undefined): boolean {
  const trimmed = String(body || '').trim();
  return trimmed === '' || /^(Thinking(?:\.{3}|…)|Queued\.{3})$/i.test(trimmed);
}

export function isLiveAgentStatus(status: ChatMessage['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'sending';
}

export interface ChatMessageSnapshotBaseline {
  ids: ReadonlyMap<string, ChatMessage>;
}

/** Capture what the renderer knew when a transcript request started. */
export function captureChatMessageSnapshotBaseline(
  messages: ChatMessage[],
): ChatMessageSnapshotBaseline {
  return {
    ids: new Map(messages.map((message) => [message.id, message])),
  };
}

export function hasVisibleChatMessageContent(message: ChatMessage): boolean {
  return Boolean(
    stripChatControlMarkers(message.body || '')
    || message.images?.length
    || message.hasImages
    || message.attachments?.length
    || message.mission
    || message.changeRequest
    || message.clarification,
  );
}

/** Keep useful trace data while excluding settled, content-free history rows. */
export function isEmptyChatMessage(message: ChatMessage): boolean {
  if (isLiveAgentStatus(message.status) || message.status === 'failed') return false;
  const body = stripChatControlMarkers(message.body || '');
  const agent = message.agentId || message.registrationId || message.runId != null;
  return !hasVisibleChatMessageContent({ ...message, body: agent && isLiveAgentPlaceholder(body) ? '' : body })
    && !message.harnessLog?.trim() && !message.hasHarness
    && !message.blocks?.some((block) => block.text?.trim() || block.redacted
      || block.type === 'tool_use' || block.type === 'tool_result');
}

/** Server projections replace content; retain only detail omitted by slim list rows. */
export function mergeRemoteChatMessage(local: ChatMessage, remote: ChatMessage, slim = false): ChatMessage {
  // An agent shell cannot replace a human prompt that happens to share its id.
  if (!local.agentId && !local.registrationId && (remote.agentId || remote.registrationId)) {
    return { ...local, seq: remote.seq ?? local.seq };
  }
  const next = { ...remote, seq: remote.seq ?? local.seq };
  if (remote.hasImages && !remote.images?.length && local.images?.length) {
    next.images = local.images;
    delete next.hasImages;
  }
  if (slim && local.body === remote.body && local.status === remote.status && local.runId === remote.runId) {
    // Compare the server's list projection, not trace length: tools may have changed.
    const projectedBlocks = local.blocks?.map((block) => {
      const text = typeof block.text === 'string' ? Array.from(block.text) : [];
      return text.length > 2_000 ? { ...block, text: `${text.slice(0, 1_999).join('')}…` } : block;
    });
    if (JSON.stringify(projectedBlocks) === JSON.stringify(remote.blocks)) {
      next.blocks = local.blocks;
      // Live harness bytes can advance without any visible body or block change.
      if (!isLiveAgentStatus(remote.status) && remote.hasHarness && remote.harnessLog == null) {
        next.harnessLog = local.harnessLog;
      }
    }
  }
  return next;
}

/** Apply a vault broadcast or list-API row onto a channel transcript. */
export function applyRemoteChatMessage(existing: ChatMessage[], remote: ChatMessage, slim = false): ChatMessage[] {
  const index = existing.findIndex((message) => message.id === remote.id);
  const local = index === -1 ? undefined : existing[index];
  if (isEmptyChatMessage(remote)) {
    const localIsHuman = Boolean(local && !local.agentId && !local.registrationId);
    // Never drop a human prompt. Dual-post suppress only applies to agent shells.
    if (localIsHuman) return existing;
    if (index === -1) return existing;
    const next = existing.filter((message) => message.id !== remote.id);
    return next.length === existing.length ? existing : next;
  }
  if (!local) return [...existing, remote];
  const merged = mergeRemoteChatMessage(local, remote, slim);
  if (merged === local) return existing;
  const next = [...existing];
  next[index] = merged;
  return next;
}

/**
 * Reconcile a list response without erasing rows created while that request was
 * in flight. The HTTP payload is a point-in-time snapshot: a socket event, an
 * optimistic human prompt, or a projected answer may legitimately be
 * newer than it and therefore absent. Rows that were already authoritative at
 * request start are still removed when absent, so reconnect can converge after
 * a deletion that happened while this renderer was offline.
 */
export function reconcileChatMessageSnapshot(
  existing: ChatMessage[],
  remote: ChatMessage[],
  baseline: ChatMessageSnapshotBaseline,
): ChatMessage[] {
  const cachedById = new Map(existing.map((message) => [message.id, message]));
  const remoteIds = new Set(remote.map((message) => message.id));
  const reconciled = remote.flatMap((message) => {
    const cached = cachedById.get(message.id);
    if (!cached && baseline.ids.has(message.id)) return [];
    if (cached && cached !== baseline.ids.get(message.id)) return [cached];
    return applyRemoteChatMessage(cached ? [cached] : [], message, true);
  });

  for (const local of existing) {
    if (remoteIds.has(local.id)) continue;
    const changedDuringRequest = baseline.ids.get(local.id) !== local;
    const isOptimisticNow = local.seq == null;
    if (
      (changedDuringRequest || isOptimisticNow)
      && (hasVisibleChatMessageContent(local) || isLiveAgentStatus(local.status))
    ) reconciled.push(local);
  }

  return reconciled;
}
