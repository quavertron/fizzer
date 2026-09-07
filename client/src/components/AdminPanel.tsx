import { LoadingIndicator } from './LoadingIndicator';
/**
 * @file AdminPanel.tsx — Owner-only admin modal.
 *
 * Currently: issue single-use password-reset tokens for any account. Reachable
 * from the sidebar footer only when the logged-in user is the server owner
 * (first-registered account); the endpoints are owner-gated server-side too.
 */
import { useEffect, useState } from 'react';
import { Copy, Flag, KeyRound, MessageSquareText, X } from 'lucide-react';
import { api } from '../api';
import { ModalShell } from './ModalShell';

interface AdminUser {
  id: number;
  username: string;
  created_at: string;
}
interface GlobalReport {
  id: number;
  vaultId: string;
  vaultName: string;
  vaultVisibility: string;
  vaultOwnerUsername: string;
  reporterUsername: string;
  targetType: 'vault' | 'note' | 'message' | 'member';
  targetId: string;
  targetUsername: string | null;
  reason: string;
  detail: string;
}

interface ProductFeedback {
  id: number;
  body: string;
  source: string;
  surface: string;
  status: 'open' | 'dismissed' | 'resolved';
  createdAt: string;
  reporterUsername: string;
  reporterDisplayName: string;
}

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [productFeedback, setProductFeedback] = useState<ProductFeedback[]>([]);
  const [reports, setReports] = useState<GlobalReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [issuedFor, setIssuedFor] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ users: AdminUser[] }>('/api/admin/users'),
      api<{ reports: GlobalReport[] }>('/api/admin/reports'),
      api<{ feedback: ProductFeedback[] }>('/api/admin/product-feedback'),
    ])
      .then(([userData, reportData, feedbackData]) => {
        if (!alive) return;
        setUsers(userData.users);
        setReports(reportData.reports);
        setProductFeedback(feedbackData.feedback);
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to load users'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function issueReset(username: string) {
    setBusy(username);
    setError('');
    setCopied(false);
    try {
      const data = await api<{ token: string; username: string; expiresInMinutes: number }>(
        '/api/auth/reset/issue',
        { method: 'POST', body: JSON.stringify({ username }) },
      );
      setIssuedFor(data.username);
      setToken(data.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not issue token');
    } finally {
      setBusy(null);
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be blocked; the field is selectable as a fallback */ }
  }

  async function reviewReport(report: GlobalReport, action: 'dismiss' | 'resolve' | 'unlist') {
    setBusy(`report:${report.id}`);
    setError('');
    try {
      await api(`/api/admin/reports/${report.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
      setReports((current) => current.filter((item) => item.id !== report.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not review report');
    } finally {
      setBusy(null);
    }
  }

  async function reviewProductFeedback(item: ProductFeedback, action: 'dismiss' | 'resolve') {
    setBusy(`feedback:${item.id}`);
    setError('');
    try {
      await api(`/api/admin/product-feedback/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
      setProductFeedback((current) => current.filter((feedback) => feedback.id !== item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not review product feedback');
    } finally {
      setBusy(null);
    }
  }

  function targetLabel(report: GlobalReport) {
    if (report.targetType === 'member' && report.targetUsername) return `member @${report.targetUsername}`;
    if (report.targetType === 'vault') return 'public vault';
    return `${report.targetType} ${report.targetId}`;
  }

  const ownerId = users[0]?.id;

  return (
    <ModalShell backdropClassName="overlay-backdrop admin-backdrop" dialogClassName="admin-panel" onClose={onClose} ariaLabel="Admin">
        <div className="admin-panel-header">
          <div>
            <span className="surface-kicker">Workspace operations</span>
            <h2><KeyRound size={17} aria-hidden="true" /> Administration</h2>
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <p className="admin-panel-hint">
          Issue a single-use password-reset token (valid 1 hour). Hand it to the user; they redeem it
          via “Forgot password?” on the login screen.
        </p>
        {error && <div className="error">{error}</div>}
        {token && (
          <div className="admin-token">
            <div className="admin-token-label">Reset token for <strong>{issuedFor}</strong> — expires in 60 min</div>
            <div className="admin-token-row">
              <input readOnly value={token} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn" onClick={copyToken}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        )}
        <section className="admin-report-queue" aria-labelledby="admin-feedback-title">
          <div className="admin-report-title"><h3 id="admin-feedback-title"><MessageSquareText size={14} /> Product feedback</h3><span>{productFeedback.length} open</span></div>
          <p className="admin-panel-hint">Feedback from the in-app Fizzer guide. These are separate from trust-and-safety reports.</p>
          {productFeedback.map((item) => (
            <article key={item.id}>
              <div><strong>{item.reporterDisplayName || item.reporterUsername}</strong><span>@{item.reporterUsername}</span></div>
              <p>{item.body}</p>
              <small>{item.surface || item.source} · {item.createdAt}</small>
              <div>
                <button type="button" disabled={busy === `feedback:${item.id}`} onClick={() => void reviewProductFeedback(item, 'dismiss')}>Dismiss</button>
                <button type="button" disabled={busy === `feedback:${item.id}`} onClick={() => void reviewProductFeedback(item, 'resolve')}>Resolve</button>
              </div>
            </article>
          ))}
          {!loading && productFeedback.length === 0 && <p className="admin-panel-hint">No open product feedback.</p>}
        </section>
        <section className="admin-report-queue" aria-labelledby="admin-report-title">
          <div className="admin-report-title"><h3 id="admin-report-title"><Flag size={14} /> Reports</h3><span>{reports.length} open</span></div>
          {reports.map((report) => (
            <article key={report.id}>
              <div><strong>{report.vaultName}</strong><span>owned by @{report.vaultOwnerUsername}</span></div>
              <p><strong>{report.reason}</strong> · {targetLabel(report)}</p>
              {report.detail && <p>{report.detail}</p>}
              <small>Reported by @{report.reporterUsername}</small>
              <div>
                <button type="button" disabled={busy === `report:${report.id}`} onClick={() => void reviewReport(report, 'dismiss')}>Dismiss</button>
                <button type="button" disabled={busy === `report:${report.id}`} onClick={() => void reviewReport(report, 'resolve')}>Resolve</button>
                {report.vaultVisibility === 'public' && (
                  <button type="button" className="is-danger" disabled={busy === `report:${report.id}`} onClick={() => void reviewReport(report, 'unlist')}>Unlist vault</button>
                )}
              </div>
            </article>
          ))}
          {!loading && reports.length === 0 && <p className="admin-panel-hint">No open reports.</p>}
        </section>
        <section className="admin-accounts" aria-labelledby="admin-accounts-title">
          <div className="admin-report-title"><h3 id="admin-accounts-title">Accounts</h3><span>{users.length} total</span></div>
          <div className="admin-user-list">
          {loading ? (
            <div className="admin-panel-hint"><LoadingIndicator label="Loading accounts" /></div>
          ) : users.length === 0 ? (
            <div className="admin-panel-hint">No accounts.</div>
          ) : users.map((u) => (
            <div key={u.id} className="admin-user-row">
              <span className="truncate">{u.username}{u.id === ownerId ? ' · owner' : ''}</span>
              <button type="button" className="btn" disabled={busy === u.username} onClick={() => issueReset(u.username)}>
                {busy === u.username ? 'Issuing…' : 'Issue reset'}
              </button>
            </div>
          ))}
          </div>
        </section>
    </ModalShell>
  );
}
