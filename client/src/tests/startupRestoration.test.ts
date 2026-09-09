import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api';
import { WorkspaceStore } from '../workspace';
import { emptySession } from '../chat/session';
import { hydrateNote } from '../noteHydration';
import { StartupPending } from '../components/StartupPending';

function fixture() {
  const store = new WorkspaceStore(emptySession());
  store.switchVault('vault');
  store.openTab({ id: 'note', title: 'Private title', type: 'note', dirty: false });
  const epoch = store.epoch;
  return { store, options: {
    isCurrent: () => store.epoch === epoch && store.activeVaultId === 'vault' && store.active.openTabs.some(t => t.id === 'note'),
    apply: vi.fn(), retry: vi.fn(), terminal: vi.fn(() => store.closeTabs(['note'])),
  } };
}

describe('restored note hydration', () => {
  it.each([new TypeError('offline'), new ApiError('timeout', 408), new ApiError('limited', 429), new ApiError('deploy', 503), new ApiError('session', 401)])('keeps tab on transient/auth failure %#', async error => {
    const { store, options } = fixture();
    await hydrateNote({ ...options, fetchNote: async () => { throw error; } });
    expect(store.active.openTabs).toHaveLength(1);
    expect(options.retry).toHaveBeenCalledOnce();
    expect(options.terminal).not.toHaveBeenCalled();
    await hydrateNote({ ...options, fetchNote: async () => 'recovered' });
    expect(options.apply).toHaveBeenCalledWith('recovered');
  });
  it.each([403, 404, 410])('closes explicitly unavailable tab %i', async status => {
    const { store, options } = fixture();
    await hydrateNote({ ...options, fetchNote: async () => { throw new ApiError('unavailable', status); } });
    expect(store.active.openTabs).toHaveLength(0);
    expect(options.terminal).toHaveBeenCalledWith(status);
    expect(options.retry).not.toHaveBeenCalled();
  });
  it.each(['success', 'denied', 'offline'])('ignores delayed %s after logout/account switch even with same vault/tab IDs', async result => {
    const { store, options } = fixture();
    let finish!: () => void;
    const pending = hydrateNote({ ...options, fetchNote: () => new Promise<string>((resolve, reject) => {
      finish = () => result === 'success' ? resolve('old private body') : reject(result === 'denied' ? new ApiError('denied', 403) : new TypeError('offline'));
    }) });
    store.reset();
    store.switchVault('vault');
    store.openTab({ id: 'note', title: 'New account', type: 'note', dirty: false });
    finish();
    await pending;
    expect(options.apply).not.toHaveBeenCalled();
    expect(options.retry).not.toHaveBeenCalled();
    expect(options.terminal).not.toHaveBeenCalled();
    expect(store.active.openTabs[0].title).toBe('New account');
  });
});

describe('pending startup UI', () => {
  it.each(['auth', 'note'] as const)('renders neutral %s loading and actionable retry without private data', kind => {
    for (const failed of [false, true]) {
      const onRetry = vi.fn();
      const props = { kind, failed, onRetry };
      const html = renderToStaticMarkup(createElement(StartupPending, props));
      expect(html).toContain('role="status"');
      expect(html).toContain('Retry');
      expect(html).not.toContain('No note selected');
      expect(html).not.toContain('Private title');
      expect(html).toContain(kind === 'auth' ? 'Fizzer' : failed ? 'tab has been kept' : 'Loading note');
      const button = StartupPending(props).props.children[1];
      button.props.onClick();
      expect(onRetry).toHaveBeenCalledOnce();
    }
  });
});
