import { api, type Folder, type Note } from './api';

export type MarkdownImportFile = Pick<File, 'name' | 'webkitRelativePath' | 'text'>;
export type MarkdownImportResult = { folders: number; notes: number };

type ImportEntry = {
  file: MarkdownImportFile;
  folders: string[];
  title: string;
};

type ApiCall = typeof api;

function fileParts(file: MarkdownImportFile): string[] {
  const relative = file.webkitRelativePath || file.name;
  return relative.split(/[\\/]+/).filter(Boolean);
}

export function markdownImportEntries(files: readonly MarkdownImportFile[]): ImportEntry[] {
  const candidates = files
    .map((file) => ({ file, parts: fileParts(file) }))
    .filter(({ parts }) => parts.length > 0 && parts.every((part) => part !== '.' && part !== '..'));
  const root = candidates.length > 0
    && candidates.every(({ parts }) => parts.length > 1 && parts[0] === candidates[0].parts[0])
    ? candidates[0].parts[0]
    : null;

  return candidates
    .map(({ file, parts }) => ({ file, parts: root ? parts.slice(1) : parts }))
    .filter(({ parts }) => parts.length > 0
      && parts.every((part) => !part.startsWith('.'))
      && parts.at(-1)!.toLowerCase().endsWith('.md'))
    .map(({ file, parts }) => ({
      file,
      folders: parts.slice(0, -1),
      title: parts.at(-1)!.slice(0, -3).trim(),
    }))
    .filter(({ title }) => title.length > 0)
    .sort((left, right) => {
      const leftPath = [...left.folders, left.title].join('/');
      const rightPath = [...right.folders, right.title].join('/');
      return leftPath.localeCompare(rightPath);
    });
}

export async function importMarkdownFolder(
  vaultId: string,
  files: readonly MarkdownImportFile[],
  callApi: ApiCall = api,
): Promise<MarkdownImportResult> {
  const entries = markdownImportEntries(files);
  if (entries.length === 0) throw new Error('The selected folder contains no Markdown files.');

  const folderIds = new Map<string, string>();
  const folderPaths = new Map<string, string[]>();
  for (const entry of entries) {
    for (let depth = 1; depth <= entry.folders.length; depth += 1) {
      const parts = entry.folders.slice(0, depth);
      folderPaths.set(parts.join('/'), parts);
    }
  }

  const orderedFolders = [...folderPaths.entries()].sort((left, right) => {
    const depth = left[1].length - right[1].length;
    return depth || left[0].localeCompare(right[0]);
  });
  for (const [path, parts] of orderedFolders) {
    const parentPath = parts.slice(0, -1).join('/');
    const data = await callApi<{ folder: Folder }>(`/api/vaults/${encodeURIComponent(vaultId)}/folders`, {
      method: 'POST',
      body: JSON.stringify({ name: parts.at(-1), parent_id: folderIds.get(parentPath) }),
    });
    folderIds.set(path, data.folder.id);
  }

  for (const entry of entries) {
    const folderPath = entry.folders.join('/');
    await callApi<{ note: Note }>(`/api/vaults/${encodeURIComponent(vaultId)}/notes`, {
      method: 'POST',
      body: JSON.stringify({
        title: entry.title,
        content: await entry.file.text(),
        folder_id: folderIds.get(folderPath),
        is_listed: true,
      }),
    });
  }

  return { folders: orderedFolders.length, notes: entries.length };
}
