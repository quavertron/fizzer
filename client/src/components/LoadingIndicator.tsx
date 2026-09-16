/** Quiet visual feedback with a descriptive screen-reader status. */
export function LoadingIndicator({ label = 'Loading' }: { label?: string }) {
  return <span className="loading-indicator" role="status" aria-label={label} />;
}
