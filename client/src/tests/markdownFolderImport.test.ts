import { describe, expect, it, vi } from 'vitest';
import { importMarkdownFolder, markdownImportEntries, type MarkdownImportFile } from '../markdownFolderImport';

function file(path: string, content = `# ${path}`): MarkdownImportFile {
  return {
    name: path.split('/').at(-1)!,
    webkitRelativePath: path,
    text: async () => content,
  };
}

describe('Markdown folder import', () => {
  it('preserves nested folders and imports only visible Markdown files', async () => {
    const files = [
      file('Project/README.md', '# Project'),
      file('Project/docs/Architecture.md', '# Architecture'),
      file('Project/docs/api/HTTP.MD', '# HTTP'),
      file('Project/docs/.drafts/Hidden.md'),
      file('Project/src/app.ts'),
    ];
    expect(markdownImportEntries(files).map(({ folders, title }) => ({ folders, title }))).toEqual([
      { folders: ['docs', 'api'], title: 'HTTP' },
      { folders: ['docs'], title: 'Architecture' },
      { folders: [], title: 'README' },
    ]);

    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let nextFolder = 0;
    const callApi = vi.fn(async (path: string, options?: RequestInit) => {
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      requests.push({ path, body });
      if (path.endsWith('/folders')) return { folder: { id: `folder-${++nextFolder}` } };
      return { note: { id: `note-${requests.length}` } };
    });

    await expect(importMarkdownFolder('vault/id', files, callApi as never))
      .resolves.toEqual({ folders: 2, notes: 3 });
    expect(requests).toEqual([
      { path: '/api/vaults/vault%2Fid/folders', body: { name: 'docs' } },
      { path: '/api/vaults/vault%2Fid/folders', body: { name: 'api', parent_id: 'folder-1' } },
      { path: '/api/vaults/vault%2Fid/notes', body: { title: 'HTTP', content: '# HTTP', folder_id: 'folder-2', is_listed: true } },
      { path: '/api/vaults/vault%2Fid/notes', body: { title: 'Architecture', content: '# Architecture', folder_id: 'folder-1', is_listed: true } },
      { path: '/api/vaults/vault%2Fid/notes', body: { title: 'README', content: '# Project', is_listed: true } },
    ]);
  });

  it('rejects a selected folder without Markdown notes', async () => {
    await expect(importMarkdownFolder('vault', [file('Project/src/app.ts')], vi.fn() as never))
      .rejects.toThrow('contains no Markdown files');
  });
});
