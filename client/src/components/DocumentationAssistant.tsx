import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Bot,
  EyeOff,
  Flag,
  GitPullRequest,
  History,
  Loader2,
  Maximize2,
  MessageCircle,
  Minimize2,
  Plus,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { ChatMessageText } from './ChatMarkdown';
import type { DesktopRunnerHealth } from '../chat/types';
import {
  buildDocumentationIssuePrompt,
  buildDocumentationPrompt,
  createDocumentationConversation,
  documentationConversationTitle,
  documentationErrorMessage,
  isDocumentationIssueRequest,
  loadDocumentationConversations,
  parseDocumentationIssueDraft,
  saveDocumentationConversations,
  startDocumentationRun,
  type DocumentationAssistantTurn,
  type DocumentationConversation,
  type DocumentationIssueDraft,
  type DocumentationRunStatus,
} from '../documentationAssistant';
import guideMarkdown from '../../../docs/user-guide.md?raw';

const LAUNCHER_HIDDEN_STORAGE_KEY = 'fizzer_guide_launcher_hidden';

export interface DocumentationAssistantProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  vaultId: string | null;
  runnerHealth: DesktopRunnerHealth | null;
  onReportFeedback: (body: string) => Promise<void>;
}

type ConversationState = {
  conversations: DocumentationConversation[];
  activeId: string;
};

type IssueBridgeResult =
  | { ok: true; url: string; number: number }
  | { ok: false; error: string };

type FizzerIssueBridge = {
  createFizzerIssue?: (draft: DocumentationIssueDraft) => Promise<IssueBridgeResult>;
};

function issueBridge(): FizzerIssueBridge | undefined {
  return (window as unknown as { electronAPI?: FizzerIssueBridge }).electronAPI;
}

export function DocumentationAssistant({
  open,
  onOpen,
  onClose,
  vaultId,
  runnerHealth,
  onReportFeedback,
}: DocumentationAssistantProps) {
  const launcherRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const issueAnswerRef = useRef('');
  const [conversationState, setConversationState] = useState<ConversationState>(() => {
    const conversations = loadDocumentationConversations();
    return { conversations, activeId: conversations[0].id };
  });
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<DocumentationRunStatus>('completed');
  const [error, setError] = useState('');
  const [activeRun, setActiveRun] = useState<{ cancel: () => Promise<void> } | null>(null);
  const [issueDraft, setIssueDraft] = useState<DocumentationIssueDraft | null>(null);
  const [issuePreparing, setIssuePreparing] = useState(false);
  const [issueCreateState, setIssueCreateState] = useState<'idle' | 'creating'>('idle');
  const [issueCreateError, setIssueCreateError] = useState('');
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState('');
  const [feedbackState, setFeedbackState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [feedbackError, setFeedbackError] = useState('');
  const [view, setView] = useState<'ask' | 'guide'>('ask');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [launcherVisible, setLauncherVisible] = useState(() => (
    typeof localStorage === 'undefined' || localStorage.getItem(LAUNCHER_HIDDEN_STORAGE_KEY) !== '1'
  ));

  const activeConversation = conversationState.conversations.find(
    (conversation) => conversation.id === conversationState.activeId,
  ) || conversationState.conversations[0];
  const turns = activeConversation?.turns || [];
  const desktopIssueBridge = issueBridge();
  const canCreateIssue = Boolean(desktopIssueBridge?.createFizzerIssue);
  const runInProgress = Boolean(activeRun) || issuePreparing || status === 'queued' || status === 'running';

  useEffect(() => {
    saveDocumentationConversations(conversationState.conversations);
  }, [conversationState.conversations]);

  useEffect(() => {
    if (!open || view !== 'ask' || historyOpen || issueDraft || feedbackOpen) return;
    const timer = window.setTimeout(() => questionRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [feedbackOpen, historyOpen, issueDraft, open, view]);

  const updateConversation = useCallback((
    conversationId: string,
    update: (conversation: DocumentationConversation) => DocumentationConversation,
  ) => {
    setConversationState((current) => ({
      ...current,
      conversations: current.conversations.map((conversation) => (
        conversation.id === conversationId ? update(conversation) : conversation
      )),
    }));
  }, []);

  const appendTurn = useCallback((conversationId: string, turn: DocumentationAssistantTurn) => {
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      turns: [...conversation.turns, turn],
      updatedAt: new Date().toISOString(),
    }));
  }, [updateConversation]);

  const close = useCallback(() => {
    onClose();
    setExpanded(false);
    window.setTimeout(() => launcherRef.current?.focus(), 0);
  }, [onClose]);

  const hideLauncher = useCallback(() => {
    onClose();
    setExpanded(false);
    setLauncherVisible(false);
    localStorage.setItem(LAUNCHER_HIDDEN_STORAGE_KEY, '1');
  }, [onClose]);

  const resetComposerPanels = useCallback(() => {
    setHistoryOpen(false);
    setIssueDraft(null);
    setIssueCreateError('');
    setFeedbackOpen(false);
    setFeedbackState('idle');
    setError('');
  }, []);

  const startNewConversation = useCallback(() => {
    if (runInProgress) return;
    const conversation = createDocumentationConversation();
    setConversationState((current) => ({
      conversations: [conversation, ...current.conversations],
      activeId: conversation.id,
    }));
    setDraft('');
    setStatus('completed');
    resetComposerPanels();
  }, [resetComposerPanels, runInProgress]);

  const selectConversation = useCallback((conversationId: string) => {
    if (runInProgress) return;
    setConversationState((current) => ({ ...current, activeId: conversationId }));
    setDraft('');
    setStatus('completed');
    resetComposerPanels();
  }, [resetComposerPanels, runInProgress]);

  const deleteConversation = useCallback((conversationId: string) => {
    if (runInProgress) return;
    setConversationState((current) => {
      const remaining = current.conversations.filter((conversation) => conversation.id !== conversationId);
      if (remaining.length === 0) {
        const replacement = createDocumentationConversation();
        return { conversations: [replacement], activeId: replacement.id };
      }
      return {
        conversations: remaining,
        activeId: current.activeId === conversationId ? remaining[0].id : current.activeId,
      };
    });
    setStatus('completed');
    resetComposerPanels();
  }, [resetComposerPanels, runInProgress]);

  const submit = useCallback(async () => {
    const question = draft.trim();
    if (!question || runInProgress || !vaultId || !activeConversation) return;

    const conversationId = activeConversation.id;
    const priorTurns = activeConversation.turns;
    const now = Date.now();
    const userTurn: DocumentationAssistantTurn = {
      id: `guide-user-${now}`,
      role: 'user',
      body: question,
      status: 'completed',
    };
    const issueRequest = isDocumentationIssueRequest(question);
    const assistantTurn: DocumentationAssistantTurn | null = issueRequest ? null : {
      id: `guide-assistant-${now}`,
      role: 'assistant',
      body: '',
      status: 'streaming',
    };

    setDraft('');
    setError('');
    setIssueDraft(null);
    setIssueCreateError('');
    setHistoryOpen(false);
    setStatus('queued');
    setIssuePreparing(issueRequest);
    issueAnswerRef.current = '';
    updateConversation(conversationId, (conversation) => ({
      ...conversation,
      title: conversation.turns.some((turn) => turn.role === 'user')
        ? conversation.title
        : documentationConversationTitle(question),
      turns: assistantTurn
        ? [...conversation.turns, userTurn, assistantTurn]
        : [...conversation.turns, userTurn],
      updatedAt: new Date().toISOString(),
    }));

    let terminalBeforeRunReturned = false;
    let terminalHandled = false;
    try {
      const run = await startDocumentationRun({
        vaultId,
        prompt: issueRequest
          ? buildDocumentationIssuePrompt(guideMarkdown, question, priorTurns)
          : buildDocumentationPrompt(guideMarkdown, question, priorTurns),
        onAnswer: (answer) => {
          if (issueRequest) {
            issueAnswerRef.current = answer;
            return;
          }
          if (!assistantTurn) return;
          updateConversation(conversationId, (conversation) => ({
            ...conversation,
            turns: conversation.turns.map((turn) => (
              turn.id === assistantTurn.id ? { ...turn, body: answer } : turn
            )),
            updatedAt: new Date().toISOString(),
          }));
        },
        onStatus: (nextStatus, detail) => {
          setStatus(nextStatus);
          if (nextStatus !== 'completed' && nextStatus !== 'failed' && nextStatus !== 'canceled') return;
          terminalBeforeRunReturned = true;
          setActiveRun(null);
          setIssuePreparing(false);
          if (terminalHandled) return;
          terminalHandled = true;

          if (issueRequest) {
            if (nextStatus === 'completed') {
              setIssueDraft(parseDocumentationIssueDraft(issueAnswerRef.current, priorTurns, question));
              return;
            }
            const message = detail || (nextStatus === 'canceled' ? 'Canceled by you.' : 'Codex could not draft this issue.');
            setError(message);
            appendTurn(conversationId, {
              id: `guide-assistant-${now}`,
              role: 'assistant',
              body: message,
              status: nextStatus,
            });
            return;
          }

          if (!assistantTurn) return;
          if (nextStatus === 'failed') setError(detail || 'Codex could not answer this question.');
          if (nextStatus === 'canceled') setError(detail || 'Canceled by you.');
          updateConversation(conversationId, (conversation) => ({
            ...conversation,
            turns: conversation.turns.map((turn) => (
              turn.id === assistantTurn.id
                ? {
                  ...turn,
                  status: nextStatus,
                  body: turn.body || detail || (nextStatus === 'completed'
                    ? 'The guide returned no answer.'
                    : nextStatus === 'canceled' ? 'Canceled by you.' : 'Codex could not answer this question.'),
                }
                : turn
            )),
            updatedAt: new Date().toISOString(),
          }));
        },
      });
      if (!terminalBeforeRunReturned) setActiveRun(run);
    } catch (runError) {
      const message = documentationErrorMessage(runError);
      setError(message);
      setStatus('failed');
      setIssuePreparing(false);
      if (assistantTurn) {
        updateConversation(conversationId, (conversation) => ({
          ...conversation,
          turns: conversation.turns.map((turn) => (
            turn.id === assistantTurn.id ? { ...turn, status: 'failed', body: message } : turn
          )),
          updatedAt: new Date().toISOString(),
        }));
      } else {
        appendTurn(conversationId, {
          id: `guide-assistant-${now}`,
          role: 'assistant',
          body: message,
          status: 'failed',
        });
      }
    }
  }, [activeConversation, appendTurn, draft, runInProgress, updateConversation, vaultId]);

  const stop = useCallback(async () => {
    if (!activeRun) return;
    await activeRun.cancel();
    setActiveRun(null);
    setStatus('canceled');
  }, [activeRun]);

  const createIssue = useCallback(async () => {
    if (!issueDraft || issueCreateState === 'creating') return;
    const bridge = issueBridge();
    if (!bridge?.createFizzerIssue) {
      setIssueCreateError('Issue creation requires Fizzer Desktop with the GitHub CLI (gh) signed in.');
      return;
    }
    setIssueCreateState('creating');
    setIssueCreateError('');
    try {
      const result = await bridge.createFizzerIssue(issueDraft);
      if (!result.ok) {
        setIssueCreateError(result.error || 'GitHub could not create the issue.');
        return;
      }
      appendTurn(conversationState.activeId, {
        id: `guide-issue-${Date.now()}`,
        role: 'assistant',
        body: `Created [GitHub issue #${result.number}](${result.url}).`,
        status: 'completed',
      });
      setIssueDraft(null);
    } catch (createError) {
      setIssueCreateError(createError instanceof Error ? createError.message : 'GitHub could not create the issue.');
    } finally {
      setIssueCreateState('idle');
    }
  }, [appendTurn, conversationState.activeId, issueCreateState, issueDraft]);

  const sendFeedback = useCallback(async () => {
    const body = feedbackDraft.trim();
    if (!body || feedbackState === 'sending') return;
    setFeedbackState('sending');
    setFeedbackError('');
    try {
      await onReportFeedback(body);
      setFeedbackDraft('');
      setFeedbackState('sent');
    } catch (feedbackFailure) {
      setFeedbackState('error');
      setFeedbackError(feedbackFailure instanceof Error ? feedbackFailure.message : 'Could not send feedback.');
    }
  }, [feedbackDraft, feedbackState, onReportFeedback]);

  return (
    <>
      {launcherVisible && <button
        ref={launcherRef}
        type="button"
        className="documentation-assistant-launcher"
        onClick={open ? close : onOpen}
        aria-label="Ask the Fizzer Guide"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="fizzer-guide-dialog"
        title="Ask the Fizzer Guide"
      >
        {open ? <X size={18} /> : <Bot size={18} />}
      </button>}

      <aside
        id="fizzer-guide-dialog"
        className={`documentation-assistant${open ? ' is-open' : ''}${expanded ? ' is-expanded' : ''}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby="fizzer-guide-title"
        data-run-status={status}
        hidden={!open}
      >
        <header className="documentation-assistant-header">
          <div>
            <span className="surface-kicker">In-app help</span>
            <h2 id="fizzer-guide-title">Fizzer Guide</h2>
            <p>{view === 'ask' ? activeConversation?.title : 'Reference manual'}</p>
          </div>
          <div className="documentation-assistant-header-actions">
            <button
              type="button"
              className="btn-icon"
              onClick={() => setExpanded((current) => !current)}
              aria-label={expanded ? 'Exit full screen' : 'View Guide full screen'}
              title={expanded ? 'Exit full screen' : 'Full screen'}
            >
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" className="btn-icon" onClick={close} aria-label="Close Guide"><X size={16} /></button>
          </div>
        </header>

        <nav className="documentation-assistant-tabs" aria-label="Guide options">
          <button type="button" className={view === 'ask' && !historyOpen ? 'is-active' : ''} onClick={() => { setView('ask'); setHistoryOpen(false); }}><MessageCircle size={14} /> Ask</button>
          <button type="button" className={view === 'guide' ? 'is-active' : ''} onClick={() => { setView('guide'); setHistoryOpen(false); }}><BookOpen size={14} /> Read guide</button>
          <button type="button" disabled={runInProgress} onClick={startNewConversation}><Plus size={14} /> New</button>
          <button
            type="button"
            className={historyOpen ? 'is-active' : ''}
            disabled={runInProgress}
            aria-expanded={historyOpen}
            onClick={() => { setView('ask'); setHistoryOpen((current) => !current); }}
          ><History size={14} /> History</button>
          <button type="button" className="documentation-assistant-hide-launcher" onClick={hideLauncher} aria-label="Hide Guide button" title="Hide Guide button"><EyeOff size={14} /><span>Hide help button</span></button>
        </nav>

        <div className="documentation-assistant-body">
          {view === 'guide' ? (
            <article className="documentation-assistant-guide">
              <ChatMessageText messageId="fizzer-user-guide" body={guideMarkdown} mentionableAliases={[]} />
            </article>
          ) : historyOpen ? (
            <section className="documentation-assistant-history" aria-labelledby="guide-history-title">
              <div className="documentation-assistant-history-heading">
                <div>
                  <span className="surface-kicker">Stored on this device</span>
                  <h3 id="guide-history-title">Guide history</h3>
                </div>
                <span>{conversationState.conversations.length}</span>
              </div>
              <div className="documentation-assistant-history-list">
                {conversationState.conversations.map((conversation) => (
                  <div className={`documentation-assistant-history-row${conversation.id === activeConversation?.id ? ' is-active' : ''}`} key={conversation.id}>
                    <button type="button" className="documentation-assistant-history-select" onClick={() => selectConversation(conversation.id)}>
                      <strong>{conversation.title}</strong>
                      <span>{conversation.turns.length === 0 ? 'No messages yet' : `${conversation.turns.length} message${conversation.turns.length === 1 ? '' : 's'}`}</span>
                    </button>
                    <button type="button" className="documentation-assistant-history-delete" onClick={() => deleteConversation(conversation.id)} aria-label={`Delete ${conversation.title}`} title="Delete conversation"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </section>
          ) : turns.length === 0 ? (
            <div className="documentation-assistant-empty">
              <MessageCircle size={22} />
              <strong>What would you like to do?</strong>
              <span>Ask how Fizzer works, or ask the Guide to create a GitHub issue from this conversation.</span>
              <button type="button" onClick={() => setView('guide')}><BookOpen size={14} /> Browse the guide without an AI runner</button>
            </div>
          ) : null}
          {view === 'ask' && !historyOpen && turns.map((turn) => (
            <article className={`documentation-assistant-turn is-${turn.role}`} key={turn.id}>
              <span className="documentation-assistant-turn-label">{turn.role === 'user' ? 'You' : 'Fizzer Guide'}</span>
              {turn.body ? (
                turn.role === 'assistant' ? (
                  <ChatMessageText messageId={turn.id} body={turn.body} isAgent mentionableAliases={[]} />
                ) : <p>{turn.body}</p>
              ) : <span className="documentation-assistant-thinking"><Loader2 size={14} className="is-spinning" /> Thinking…</span>}
            </article>
          ))}
          {view === 'ask' && !historyOpen && issuePreparing && (
            <div className="documentation-assistant-turn is-assistant" role="status">
              <span className="documentation-assistant-turn-label">Fizzer Guide</span>
              <span className="documentation-assistant-thinking"><Loader2 size={14} className="is-spinning" /> Preparing an editable issue…</span>
            </div>
          )}
          {view === 'ask' && !historyOpen && runnerHealth?.online === false && (
            <p className="documentation-assistant-notice">Questions and issue drafts need a connected runner. You can still read the complete guide above.</p>
          )}
          {view === 'ask' && !historyOpen && error && <p className="documentation-assistant-error" role="alert">{error}</p>}
        </div>

        {view === 'ask' && !historyOpen && <footer className="documentation-assistant-footer">
          {issueDraft ? (
            <div className="documentation-assistant-issue-editor">
              <div className="documentation-assistant-issue-heading">
                <GitPullRequest size={16} />
                <div><strong>Public GitHub issue</strong><span>Review every field before creating it in grm4871/fizzer.</span></div>
              </div>
              <label>
                Title
                <input
                  value={issueDraft.title}
                  maxLength={180}
                  onChange={(event) => setIssueDraft((current) => current ? { ...current, title: event.target.value } : current)}
                />
              </label>
              <label>
                Label
                <select
                  value={issueDraft.label}
                  onChange={(event) => setIssueDraft((current) => current ? { ...current, label: event.target.value as DocumentationIssueDraft['label'] } : current)}
                >
                  <option value="bug">Bug</option>
                  <option value="enhancement">Enhancement</option>
                </select>
              </label>
              <label>
                Body
                <textarea
                  value={issueDraft.body}
                  rows={8}
                  maxLength={20_000}
                  onChange={(event) => setIssueDraft((current) => current ? { ...current, body: event.target.value } : current)}
                />
              </label>
              <p className="documentation-assistant-notice">
                {canCreateIssue
                  ? 'Creation uses your local GitHub CLI (gh). Nothing is created until you click Create issue.'
                  : 'Creation requires Fizzer Desktop with the GitHub CLI (gh) installed and signed in.'}
              </p>
              {issueCreateError && <p className="documentation-assistant-error" role="alert">{issueCreateError}</p>}
              <div className="documentation-assistant-actions">
                <button type="button" onClick={() => { setIssueDraft(null); setIssueCreateError(''); }}>Discard</button>
                <button
                  type="button"
                  disabled={!canCreateIssue || !issueDraft.title.trim() || !issueDraft.body.trim() || issueCreateState === 'creating'}
                  onClick={() => void createIssue()}
                >
                  {issueCreateState === 'creating' ? <><Loader2 size={13} className="is-spinning" /> Creating…</> : <><GitPullRequest size={13} /> Create issue</>}
                </button>
              </div>
            </div>
          ) : feedbackOpen ? (
            <div className="documentation-assistant-feedback">
              <strong>Send product feedback</strong>
              <p>Only this text and your username are sent to the Fizzer server owner. Your Guide conversation, notes, files, and traces are not attached.</p>
              <textarea value={feedbackDraft} onChange={(event) => setFeedbackDraft(event.target.value)} placeholder="What should we improve?" rows={4} autoFocus />
              {feedbackError && <span className="documentation-assistant-error" role="alert">{feedbackError}</span>}
              {feedbackState === 'sent' && <span className="documentation-assistant-success" role="status">Feedback sent. Thank you.</span>}
              <div className="documentation-assistant-actions">
                <button type="button" onClick={() => { setFeedbackOpen(false); setFeedbackState('idle'); }}>Back</button>
                <button type="button" disabled={!feedbackDraft.trim() || feedbackState === 'sending'} onClick={() => void sendFeedback()}>
                  {feedbackState === 'sending' ? 'Sending…' : 'Send feedback'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <textarea
                ref={questionRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); }
                  if (event.key === 'Escape') close();
                }}
                placeholder="Ask how Fizzer works, or ask to create an issue…"
                rows={2}
                aria-label="Question for the Fizzer Guide"
                disabled={runInProgress}
              />
              <div className="documentation-assistant-actions">
                <button type="button" className="documentation-assistant-feedback-button" disabled={runInProgress} onClick={() => setFeedbackOpen(true)}><Flag size={13} /> Feedback</button>
                {activeRun ? (
                  <button type="button" className="is-danger" onClick={() => void stop()}><Square size={12} /> Stop</button>
                ) : runInProgress ? (
                  <button type="button" disabled><Loader2 size={13} className="is-spinning" /> Starting…</button>
                ) : (
                  <button type="button" disabled={!draft.trim() || !vaultId || runnerHealth?.online === false} onClick={() => void submit()}><Send size={13} /> Ask</button>
                )}
              </div>
            </>
          )}
        </footer>}
      </aside>
    </>
  );
}
