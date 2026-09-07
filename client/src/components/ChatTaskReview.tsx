import { LoadingIndicator } from './LoadingIndicator';
import { useCallback, useMemo, useState } from 'react';
import { FileCode2, MessageSquareText, RefreshCw } from 'lucide-react';
import { createWorkItemReview, fetchWorkItem, type WorkItemReview } from '../chat/workItems';
import {
  reportWorkItemGitState,
  workspaceBridge,
  type WorkspaceDiff,
  type WorkspaceFileDiff,
} from '../chat/workspaces';

type Props = {
  workItemId: string;
  worktreePath: string;
};

/** Progressive, desktop-local review of one durable task workspace. */
export function ChatTaskReview({ workItemId, worktreePath }: Props) {
  const bridge = useMemo(workspaceBridge, []);
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState<WorkspaceDiff | null>(null);
  const [fileDiff, setFileDiff] = useState<WorkspaceFileDiff | null>(null);
  const [selectedFile, setSelectedFile] = useState('');
  const [reviews, setReviews] = useState<WorkItemReview[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setBusy('refresh');
    setError('');
    try {
      const detailPromise = fetchWorkItem(workItemId);
      if (!bridge?.getWorktreeDiff) {
        const detail = await detailPromise;
        setReviews(detail.reviews);
        setEvidence(null);
        return;
      }
      const [diff, status, detail] = await Promise.all([
        bridge.getWorktreeDiff(worktreePath),
        bridge.getWorktreeStatus(worktreePath),
        detailPromise,
      ]);
      if (!diff.ok) throw new Error(diff.error);
      setEvidence(diff);
      setReviews(detail.reviews);
      if (status.ok) {
        await reportWorkItemGitState(workItemId, status);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load task review');
    } finally {
      setBusy('');
    }
  }, [bridge, workItemId, worktreePath]);

  const selectFile = async (path: string) => {
    if (!bridge?.getWorktreeFileDiff) return;
    setSelectedFile(path);
    setFileDiff(null);
    setBusy('file');
    setError('');
    try {
      const result = await bridge.getWorktreeFileDiff({ dir: worktreePath, file: path });
      if (!result.ok) throw new Error(result.error);
      setFileDiff(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load file diff');
    } finally {
      setBusy('');
    }
  };

  const saveReview = async (kind: 'comment' | 'change_request') => {
    if (!evidence || !note.trim()) return;
    setBusy(kind);
    setError('');
    try {
      await createWorkItemReview(workItemId, {
        kind,
        note: note.trim(),
        filePath: selectedFile || undefined,
        baseCommit: evidence.baseCommit,
        headCommit: evidence.head,
      });
      const detail = await fetchWorkItem(workItemId);
      setReviews(detail.reviews);
      setNote('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save review');
    } finally {
      setBusy('');
    }
  };

  return (
    <details
      className="chat-task-review"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next && !evidence && busy !== 'refresh') void refresh();
      }}
    >
      <summary>
        <FileCode2 size={11} />
        <span>Review changes</span>
        {evidence && <small>{evidence.files.length} file{evidence.files.length === 1 ? '' : 's'}</small>}
      </summary>
      <div className="chat-task-review-body">
        <div className="chat-task-review-meta">
          {evidence ? (
            <span>
              <code>{evidence.branch}</code> from <code>{evidence.baseCommit.slice(0, 7)}</code>
              {evidence.summary ? ` · ${evidence.summary}` : ''}
            </span>
          ) : (
            <span>{bridge?.getWorktreeDiff ? <LoadingIndicator label="Loading local evidence" /> : 'Update the desktop app to inspect local changes.'}</span>
          )}
          <button type="button" onClick={() => void refresh()} disabled={busy === 'refresh'} aria-label="Refresh task review">
            <RefreshCw size={10} />
          </button>
        </div>

        {evidence && evidence.files.length === 0 && <p>No changes relative to the task base.</p>}
        {evidence && evidence.files.length > 0 && (
          <div className="chat-task-review-files">
            {evidence.files.map((file) => (
              <button
                type="button"
                key={`${file.status}:${file.path}`}
                className={selectedFile === file.path ? 'is-active' : undefined}
                onClick={() => void selectFile(file.path)}
              >
                <span>{file.status}</span>{file.path}
              </button>
            ))}
          </div>
        )}
        {busy === 'file' && <LoadingIndicator label="Loading file diff" />}
        {fileDiff && (
          <div className="chat-task-review-patch">
            <div>{fileDiff.path}{fileDiff.truncated ? ' · truncated' : ''}</div>
            {fileDiff.kind === 'binary'
              ? <p>Binary or non-regular file; textual evidence is unavailable.</p>
              : <pre>{fileDiff.text || 'No textual diff.'}</pre>}
          </div>
        )}

        {reviews.some((review) => review.kind !== 'handoff') && (
          <div className="chat-task-review-comments">
            {reviews.filter((review) => review.kind !== 'handoff').map((review) => (
              <div key={review.id} className={review.kind === 'change_request' ? 'is-change-request' : undefined}>
                <strong>{review.kind === 'change_request' ? 'Changes requested' : 'Comment'}</strong>
                <span>{review.authorUsername || 'reviewer'}{review.filePath ? ` · ${review.filePath}` : ''} · {review.headCommit.slice(0, 7)}</span>
                <p>{review.note}</p>
              </div>
            ))}
          </div>
        )}

        {evidence && (
          <div className="chat-task-review-compose">
            <label>
              <MessageSquareText size={11} /> Review note{selectedFile ? ` on ${selectedFile}` : ''}
            </label>
            <textarea value={note} rows={3} onChange={(event) => setNote(event.target.value)} placeholder="Leave snapshot-bound review feedback…" />
            <div>
              <button type="button" disabled={!note.trim() || Boolean(busy)} onClick={() => void saveReview('comment')}>Comment</button>
              <button type="button" className="is-change-request" disabled={!note.trim() || Boolean(busy)} onClick={() => void saveReview('change_request')}>Request changes</button>
            </div>
            <small>Change requests are durable review records; they do not push, merge, or dispatch work.</small>
          </div>
        )}
        {error && <p className="chat-workspaces-notice is-warn">{error}</p>}
      </div>
    </details>
  );
}
