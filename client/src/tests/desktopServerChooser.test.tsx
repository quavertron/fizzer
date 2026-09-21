import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopVaultChooser } from '../components/DesktopVaultChooser';

afterEach(() => vi.unstubAllGlobals());

function renderChooser(hostname: string) {
  vi.stubGlobal('window', { location: { hostname, host: hostname, origin: `https://${hostname}` }, electronAPI: {} });
  return renderToStaticMarkup(<DesktopVaultChooser vaults={[]} activeVaultId={null}
    onSelect={() => {}} onCreate={async () => false} onContinue={() => {}} onConnectLocal={() => {}} />);
}

it('offers another server before a local desktop login without requiring a vault', () => {
  const html = renderChooser('localhost');
  expect(html).toContain('Choose a server');
  expect(html).toContain('Connect to local server');
  expect(html).toContain('Connect to remote server');
  expect(html).not.toContain('Open selected vault');
  expect(html).not.toContain('No vaults yet');
});

it('identifies the current remote server without presenting it as local', () => {
  const html = renderChooser('remote.example');
  expect(html).toContain('remote.example');
  expect(html).toContain('Connect to remote server');
  expect(html).not.toContain('Connect to local server');
});
