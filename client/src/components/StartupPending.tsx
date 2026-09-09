export function StartupPending({ kind, failed, onRetry }: {
  kind: 'auth' | 'note'; failed: boolean; onRetry: () => void;
}) {
  return <section className="pane-empty" style={{ padding: 24, gap: 16, maxWidth: '100%', textAlign: 'center' }}>
    <div role="status" aria-live="polite">{kind === 'auth'
      ? failed ? 'Could not connect to Fizzer. Your session has not been checked.' : 'Connecting to Fizzer…'
      : failed ? 'Could not load this note. Your tab has been kept.' : 'Loading note…'}</div>
    <button type="button" onClick={onRetry}>Retry</button>
  </section>;
}
