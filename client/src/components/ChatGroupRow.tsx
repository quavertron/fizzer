import { isLiveAgentStatus } from '../chat/runBlocks';
import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Paperclip } from 'lucide-react';
import { api, type NoteSummary } from '../api';
import { bodyHasNoteRefs } from '../docEmbeds';
import { formatChatTime } from '../chat/time';
import type { ChatAgentRegistration, ChatMessage, PlanUsage, SharedChatNote } from '../chat/types';
import { hasRunActivity } from '../chat/harnessActivity';
import { isSteeringContinuationMessage } from '../chat/workTrace';
import type { MissionMessageIdentity } from '../chat/missionIdentity';
import type { ChatMessageGroup } from '../chat/workTrace';
import { escapeRegExp, normalizeMention } from '../chat/mentions';
import { CascadeRunPanel } from './CascadeRunPanel';
import { ChatAvatar } from './ChatAvatar';
import { ChatClarificationCard } from './ChatClarificationCard';
import { isMp4Attachment } from './ChatComposer';
import { ChatMessageText } from './ChatMarkdown';
import { ChatMissionCard, MissionMessageLabel } from './ChatMissionCard';
import { ChatQuoteRefs } from './ChatQuoteRefs';
import { PlanUsageMeters } from './ChatAgentPanel';
import { SwipeToReply, swipeGestureActive } from './SwipeToReply';

export function getRunningMessageState(messages: ChatMessage[]) {
  const byAgent = new Map<string, { latestId: string; count: number }>();
  for (const message of messages) {
    if (message.status !== 'running') continue;
    const key = message.registrationId || message.agentId;
    if (!key) continue;
    const previous = byAgent.get(key);
    byAgent.set(key, { latestId: message.id, count: (previous?.count || 0) + 1 });
  }
  return byAgent;
}

export function getSteeringPromptLabels(
  messages: ChatMessage[],
  registeredAgents: ChatAgentRegistration[],
  runningState = getRunningMessageState(messages),
) {
  const labels = new Map<string, string>();
  for (const [key, state] of runningState) {
    if (state.count <= 1) continue;
    const registration = registeredAgents.find((item) => item.id === key || item.agentId === key);
    if (!registration) continue;
    const mention = normalizeMention(registration.mention || registration.agentId);
    const latestIndex = messages.findIndex((message) => message.id === state.latestId);
    for (let index = latestIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.agentId) continue;
      const explicitlyMentions = new RegExp(`(^|\\s)@${escapeRegExp(mention)}(?=\\s|$|[.,!?;:])`, 'i').test(message.body);
      const repliesToAgent = normalizeMention(message.replyTo?.mention || '') === mention;
      if (explicitlyMentions || repliesToAgent) labels.set(message.id, mention);
      break;
    }
  }
  // Once the interrupted response settles as canceled, there is no longer a
  // pair of simultaneously running bubbles and the live-only decal above used
  // to disappear. Preserve it from the durable transcript shape: canceled
  // agent response, human correction, then the same agent's continuation.
  for (let index = 1; index < messages.length - 1; index += 1) {
    const prompt = messages[index];
    if (prompt.agentId || labels.has(prompt.id)) continue;
    const before = messages[index - 1];
    const after = messages[index + 1];
    const beforeKey = before.registrationId || before.agentId;
    const afterKey = after.registrationId || after.agentId;
    if (!beforeKey || beforeKey !== afterKey || before.status !== 'canceled') continue;
    if (!isSteeringContinuationMessage(before)) continue;
    const registration = registeredAgents.find((item) => item.id === afterKey || item.agentId === afterKey);
    if (!registration) continue;
    labels.set(prompt.id, normalizeMention(registration.mention || registration.agentId));
  }
  return labels;
}

function hasExpandableTrace(message: ChatMessage): boolean {
  return hasRunActivity(message);
}

/**
 * Keep runtime details behind message selection and surface failures,
 * but let a successful final answer return to being a normal chat message.
 * Completed traces remain selectable, so none of the persisted run detail is
 * discarded or made inaccessible.
 */
export function shouldRenderRunPanel(
  message: ChatMessage,
  selected: boolean,
  _isLatestRunningMessage: boolean,
): boolean {
  if (selected || message.status === 'running') return true;
  if (message.agentId && isLiveAgentStatus(message.status)) return true;
  if (message.status === 'failed' || message.status === 'canceled') return true;
  return false;
}

function groupHasDocEmbed(group: ChatMessageGroup): boolean {
  return group.messages.some((message) => message.body && bodyHasNoteRefs(message.body));
}

export const ChatGroupRow = memo(function ChatGroupRow({
  group,
  selectedMessageId,
  jumpHighlightMessageId,
  avatarKind,
  avatarUrl,
  authorLabel,
  ownerLabel,
  planUsage,
  latestRunningMessageId,
  steeringPromptLabels,
  mentionableAliases,
  notes,
  onOpenNote,
  onOpenSharedNote,
  onCancelRun,
  onToggleSelect,
  onContextMenu,
  onReply,
  onJumpToMessage,
  loadedMessageIds,
  onLightbox,
  onImageLoad,
  onAgentAvatarClick,
  scrollRootRef,
  vaultId,
  onHydrateMessage,
  traceContent,
  traceAfterFirstMessage = false,
  contextMenuMessage,
  missionIdentities,
}: {
  group: ChatMessageGroup;
  missionIdentities?: ReadonlyMap<string, MissionMessageIdentity>;
  /** Pre-filtered by the parent: non-null only when the selection is inside this group. */
  selectedMessageId: string | null;
  /** Pre-filtered by the parent: briefly pulses the exact row reached by a jump. */
  jumpHighlightMessageId: string | null;
  avatarKind: 'agent' | 'human';
  avatarUrl?: string;
  authorLabel?: string;
  ownerLabel?: string;
  planUsage?: PlanUsage | null;
  latestRunningMessageId?: string;
  runningSiblingCount: number;
  steeringPromptLabels: ReadonlyMap<string, string>;
  mentionableAliases: string[];
  notes: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (messageId: string, title: string) => Promise<SharedChatNote | null>;
  onCancelRun: (runId: number) => void;
  onToggleSelect: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, message: ChatMessage) => void;
  onReply: (message: ChatMessage) => void;
  /** Scrolls to and selects a message in this channel (reply-quote click). */
  onJumpToMessage: (messageId: string) => void;
  /** Ids currently rendered, so a quote only offers a jump it can honour. */
  loadedMessageIds: ReadonlySet<string>;
  onLightbox: (src: string) => void;
  onImageLoad: () => void;
  /** Open channel membership settings for this agent (message avatar click). */
  onAgentAvatarClick?: (event: React.MouseEvent) => void;
  /** Chat scroller element — used as IntersectionObserver root. */
  scrollRootRef: RefObject<HTMLDivElement | null>;
  vaultId?: string;
  onHydrateMessage?: (message: ChatMessage) => void;
  /** A collapsed workflow trace carried by this agent row. */
  traceContent?: ReactNode;
  /** Keep later user-facing updates under this author header, after the mission/work trace. */
  traceAfterFirstMessage?: boolean;
  /** Mission origin targeted when the user right-clicks anywhere on this row. */
  contextMenuMessage?: ChatMessage;
}) {
  const head = group.messages[0];
  const tail = group.messages[group.messages.length - 1];
  const groupHasRunWidget = Boolean(traceContent)
    || group.messages.some((message) => message.status === 'running' || hasExpandableTrace(message));
  const groupSelected = group.messages.some((message) => message.id === selectedMessageId);
  const articleRef = useRef<HTMLElement | null>(null);
  const heightRef = useRef(0);
  // Start mounted so first paint / stick-to-bottom has real content; IO then unmounts offscreen.
  const [inView, setInView] = useState(true);
  const forceMounted = groupSelected
    || group.messages.some((message) => message.status === 'running')
    // Never unmount mid-swipe: orphan pointer capture freezes clicks until restart.
    || swipeGestureActive();

  useEffect(() => {
    const el = articleRef.current;
    const root = scrollRootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          setInView(true);
        } else if (!forceMounted && !swipeGestureActive()) {
          // Preserve height so scroll position doesn't jump when unmounting markdown.
          heightRef.current = el.offsetHeight || heightRef.current;
          setInView(false);
        }
      },
      {
        root: root || null,
        // Large margin keeps a buffer of mounted rows above/below the viewport.
        rootMargin: '600px 0px',
        threshold: 0,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRootRef, forceMounted, group.messages.length]);

  useLayoutEffect(() => {
    if (inView && articleRef.current) {
      heightRef.current = articleRef.current.offsetHeight || heightRef.current;
    }
  });

  const showBody = inView || forceMounted;
  const placeholderH = heightRef.current || (groupHasRunWidget ? 120 : 72);

  return (
    <article
      ref={articleRef}
      className={`chat-message-group ${tail.status ? `status-${tail.status}` : ''} ${groupHasRunWidget ? 'has-run-widget' : ''} ${groupSelected ? 'selected' : ''} ${showBody ? '' : 'is-offscreen'}`}
      style={showBody ? undefined : { height: placeholderH, minHeight: placeholderH }}
      aria-hidden={showBody ? undefined : true}
      onContextMenu={contextMenuMessage
        ? (event) => onContextMenu(event, contextMenuMessage)
        : undefined}
    >
      {showBody ? (
        <>
          <ChatAvatar
            name={authorLabel || head.author}
            kind={avatarKind}
            avatarUrl={avatarUrl}
            onClick={avatarKind === 'agent' ? onAgentAvatarClick : undefined}
            title={avatarKind === 'agent' && onAgentAvatarClick
              ? `Open settings for ${authorLabel || head.author}`
              : undefined}
          />
          <div className="chat-message-body">
            <div className="chat-message-meta">
              <strong>{authorLabel || head.author}</strong>
              {avatarKind === 'agent' && planUsage && <PlanUsageMeters usage={planUsage} />}
              {avatarKind === 'agent' && ownerLabel && <span className="chat-agent-owner">{ownerLabel}'s agent</span>}
              <time dateTime={tail.createdAt}>{formatChatTime(tail.createdAt)}</time>
              {avatarKind === 'agent' && tail.status === 'failed' && <span className="chat-message-status is-error">failed</span>}
              {avatarKind === 'agent' && tail.status === 'canceled' && isSteeringContinuationMessage(tail) && (
                <span className="chat-message-status is-steered">continued</span>
              )}
              {avatarKind === 'agent' && tail.status === 'canceled' && !isSteeringContinuationMessage(tail) && (
                <span className="chat-message-status is-error">canceled</span>
              )}
            </div>
            {group.messages.map((message, messageIndex) => {
              const hasRunWidget = message.status === 'running';
              const hasThoughtBlocks = hasExpandableTrace(message);
              const isLatestRunningMessage = message.status !== 'running' || latestRunningMessageId === message.id;
              const isTappable = hasRunWidget || hasThoughtBlocks;
              const selected = selectedMessageId === message.id;
              const jumpHighlighted = jumpHighlightMessageId === message.id;
              return (<Fragment key={message.id}>
                <SwipeToReply
                  messageId={message.id}
                  className={`chat-message-chunk ${isTappable ? 'has-run-widget' : ''} ${selected ? 'selected' : ''} ${jumpHighlighted ? 'is-jump-highlighted' : ''}`}
                  onReply={() => onReply(message)}
                  onClick={() => {
                    if (isTappable) onToggleSelect(message.id);
                  }}
                  onContextMenu={(event) => onContextMenu(event, message)}
                >
                  {!message.mission && missionIdentities?.has(message.id) && (
                    <MissionMessageLabel identity={missionIdentities.get(message.id)!} />
                  )}
                  <ChatQuoteRefs
                    message={message}
                    onJumpToMessage={onJumpToMessage}
                    canJumpToReply={Boolean(
                      message.replyTo && loadedMessageIds.has(message.replyTo.messageId),
                    )}
                  />
                  {steeringPromptLabels.has(message.id) && (
                    <div className="chat-steering-prompt">
                      ↳ Follow-up to @{steeringPromptLabels.get(message.id)}
                    </div>
                  )}
                  {message.images && message.images.length > 0 && (
                    <div className="chat-msg-images">
                      {message.images.map((src, imageIndex) => (
                        <a
                          key={imageIndex}
                          href={src}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => {
                            event.preventDefault();
                            onLightbox(src);
                          }}
                        >
                          <img src={src} alt="" className="chat-msg-image" onLoad={onImageLoad} />
                        </a>
                      ))}
                    </div>
                  )}
                  {message.hasImages && !message.images?.length && (
                    <div className="chat-msg-media-loading" role="status">
                      Loading media…
                    </div>
                  )}
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="chat-msg-attachments">
                      {message.attachments.map((attachment, attachmentIndex) => (
                        isMp4Attachment(attachment) ? (
                          <div key={attachmentIndex} className="chat-msg-video">
                            <video
                              className="chat-msg-video-el"
                              controls
                              playsInline
                              preload="metadata"
                              src={attachment.url}
                              onLoadedData={onImageLoad}
                            >
                              <a href={attachment.url} download={attachment.name} target="_blank" rel="noreferrer">
                                {attachment.name || 'video.mp4'}
                              </a>
                            </video>
                            {attachment.name && <span className="chat-msg-video-label">{attachment.name}</span>}
                          </div>
                        ) : (
                          <a
                            key={attachmentIndex}
                            className="chat-msg-attachment"
                            href={attachment.url}
                            download={attachment.name}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <Paperclip size={13} />
                            <span>{attachment.name}</span>
                          </a>
                        )
                      ))}
                    </div>
                  )}
                  {message.body
                    && !isSteeringContinuationMessage(message)
                    && !(avatarKind === 'agent' && isLiveAgentStatus(message.status))
                    && <ChatMessageText messageId={message.id} body={message.body} streaming={message.status === 'running'} isAgent={avatarKind === 'agent'} mentionableAliases={mentionableAliases} notes={notes} onOpenNote={onOpenNote} onOpenSharedNote={onOpenSharedNote} />}
                  {message.mission && (
                    <ChatMissionCard
                      mission={message.mission}
                      vaultId={vaultId}
                      channelId={message.channelId}
                      replyMessage={message}
                      onReply={onReply}
                      onContextMenu={onContextMenu}
                    />
                  )}
                  {message.clarification && (
                    <ChatClarificationCard message={message} vaultId={vaultId} />
                  )}
                  {message.changeRequest && (
                    <div className="chat-change-request">
                      <div className="chat-change-files">
                        {message.changeRequest.files.map((file) => (
                          <button type="button" className="chat-change-chip" key={file.path} title="Copy file path"
                            onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(file.path); }}>
                            <span>{file.path}</span>
                            <b className="is-add">+{file.additions}</b>
                            <b className="is-delete">−{file.deletions}</b>
                          </button>
                        ))}
                      </div>
                      <div className="chat-change-actions">
                        {message.changeRequest.commit && <code>{message.changeRequest.commit.slice(0, 8)}</code>}
                        {message.changeRequest.approvals.map((approval) => (
                          <span key={approval.userId} className="chat-change-approved">✓ {approval.username}</span>
                        ))}
                        {message.changeRequest.mergedAt ? (
                          <span className="chat-change-merged">Merged by {message.changeRequest.mergedBy}</span>
                        ) : vaultId ? (
                          <>
                            <button type="button" onClick={(event) => {
                              event.stopPropagation();
                              void api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/approve`, { method: 'POST' });
                            }}>Approve</button>
                            <button type="button" onClick={(event) => {
                              event.stopPropagation();
                              void api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/merge`, { method: 'POST' });
                            }}>Merge</button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  )}
                  {shouldRenderRunPanel(message, selected, isLatestRunningMessage) && (
                    <CascadeRunPanel
                      message={message}
                      onCancelRun={onCancelRun}
                      forceOpen={selected}
                      onContentGrow={onImageLoad}
                      vaultId={vaultId}
                      onHydrateMessage={onHydrateMessage}
                    />
                  )}
                </SwipeToReply>
                {traceAfterFirstMessage && messageIndex === 0 && traceContent}
              </Fragment>);
            })}
            {!traceAfterFirstMessage && traceContent}
          </div>
        </>
      ) : (
        <div className="chat-message-offscreen-stub" />
      )}
    </article>
  );
}, (prev, next) => {
  // segmentTranscript rebuilds group wrappers every stream tick — compare the
  // underlying message refs so settled groups skip re-render.
  const prevMsgs = prev.group.messages;
  const nextMsgs = next.group.messages;
  if (prevMsgs.length !== nextMsgs.length) return false;
  for (let i = 0; i < prevMsgs.length; i += 1) {
    if (prevMsgs[i] !== nextMsgs[i]) return false;
  }
  return prev.selectedMessageId === next.selectedMessageId
  && prev.jumpHighlightMessageId === next.jumpHighlightMessageId
  && prev.avatarKind === next.avatarKind
  && prev.avatarUrl === next.avatarUrl
  && prev.authorLabel === next.authorLabel
  && prev.ownerLabel === next.ownerLabel
  && prev.planUsage === next.planUsage
  && prev.latestRunningMessageId === next.latestRunningMessageId
  && prev.runningSiblingCount === next.runningSiblingCount
  && prev.steeringPromptLabels === next.steeringPromptLabels
  && prev.mentionableAliases === next.mentionableAliases
  // Same trick as ChatMessageText: note churn only invalidates groups that
  // actually render an embed.
  && (prev.notes === next.notes || !groupHasDocEmbed(next.group))
  && prev.onJumpToMessage === next.onJumpToMessage
  && prev.loadedMessageIds === next.loadedMessageIds
  && prev.onOpenNote === next.onOpenNote
  && prev.onOpenSharedNote === next.onOpenSharedNote
  && prev.onCancelRun === next.onCancelRun
  && prev.onToggleSelect === next.onToggleSelect
  && prev.onContextMenu === next.onContextMenu
  && prev.onReply === next.onReply
  && prev.onLightbox === next.onLightbox
  && prev.onImageLoad === next.onImageLoad
  && prev.onAgentAvatarClick === next.onAgentAvatarClick
  && prev.scrollRootRef === next.scrollRootRef
  && prev.vaultId === next.vaultId
  && prev.onHydrateMessage === next.onHydrateMessage
  && prev.traceAfterFirstMessage === next.traceAfterFirstMessage
  && prev.contextMenuMessage === next.contextMenuMessage
  && prev.traceContent === next.traceContent;
});
