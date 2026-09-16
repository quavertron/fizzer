import { LoadingIndicator } from './LoadingIndicator';
import { AtSign, CheckCheck, FileText, MessageCircle, Reply, X } from 'lucide-react';
import { formatRelativeDate, type CommunityUpdateItem, type CommunityUpdates } from '../api';
import { ModalShell } from './ModalShell';

type UpdatesModalProps = {
  open: boolean;
  loading: boolean;
  updates: CommunityUpdates;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
  onMarkAllRead: () => void;
  onOpenItem: (item: CommunityUpdateItem) => void;
};

function countLabel(count: number): string {
  return count >= 99 ? '99+' : String(count);
}

function itemIcon(kind: CommunityUpdateItem['kind']) {
  if (kind === 'mention') return <AtSign size={14} />;
  if (kind === 'reply') return <Reply size={14} />;
  if (kind === 'note') return <FileText size={14} />;
  return <MessageCircle size={14} />;
}

function kindLabel(kind: CommunityUpdateItem['kind']): string {
  if (kind === 'mention') return 'mentioned you';
  if (kind === 'reply') return 'replied to you';
  if (kind === 'note') return 'changed a note';
  return 'posted';
}

export function UpdatesModal({
  open,
  loading,
  updates,
  error,
  onClose,
  onRefresh,
  onMarkAllRead,
  onOpenItem,
}: UpdatesModalProps) {
  if (!open) return null;
  return (
    <ModalShell
      backdropClassName="overlay-backdrop updates-backdrop"
      dialogClassName="updates-modal"
      ariaLabelledby="updates-title"
      onClose={onClose}
    >
        <header className="updates-header">
          <div>
            <span className="surface-kicker">Activity center</span>
            <h2 id="updates-title">Updates</h2>
            <p>Everything new across your vaults and conversations.</p>
          </div>
          <div className="updates-header-actions">
            {updates.counts.total > 0 && (
              <button type="button" className="updates-mark-all" onClick={onMarkAllRead}>
                <CheckCheck size={14} /> Mark all read
              </button>
            )}
            <button type="button" className="btn-icon" onClick={onClose} aria-label="Close updates"><X size={17} /></button>
          </div>
        </header>

        <div className="updates-body">
          {loading && updates.groups.length === 0 && (
            <div className="updates-empty"><LoadingIndicator label="Loading updates" /></div>
          )}
          {!loading && error && (
            <div className="updates-empty updates-error">
              <span>{error}</span>
              <button type="button" onClick={onRefresh}>Try again</button>
            </div>
          )}
          {!loading && !error && updates.groups.length === 0 && (
            <div className="updates-empty">
              <CheckCheck size={20} />
              <strong>You’re caught up</strong>
              <span>New collaborator activity will appear here.</span>
            </div>
          )}
          {updates.groups.map((group) => (
            <section className="updates-group" key={group.vaultId} aria-labelledby={`updates-vault-${group.vaultId}`}>
              <div className="updates-group-heading">
                <h3 id={`updates-vault-${group.vaultId}`}>{group.vaultName}</h3>
                <span>{countLabel(group.unreadCount)}</span>
              </div>
              <div className="updates-list">
                {group.items.map((item) => (
                  <button type="button" className="updates-item" key={item.id} onClick={() => onOpenItem(item)}>
                    <span className={`updates-kind is-${item.kind}`} aria-hidden="true">{itemIcon(item.kind)}</span>
                    <span className="updates-copy">
                      <span className="updates-item-heading">
                        <strong>{item.actorDisplayName || item.actor}</strong>
                        <span>{kindLabel(item.kind)}</span>
                        <em>{formatRelativeDate(item.timestamp)}</em>
                      </span>
                      <span className="updates-target">{item.kind === 'note' ? '' : '#'}{item.targetTitle}</span>
                      <span className="updates-preview">{item.preview}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
          {updates.truncated && <div className="updates-truncated">Showing the newest updates. Open an item or mark all read to continue.</div>}
        </div>
    </ModalShell>
  );
}
