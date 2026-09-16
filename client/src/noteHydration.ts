import { ApiError } from './api';

/** Only explicit access denial or absence invalidates a restored tab. */
export async function hydrateNote<T>({ fetchNote, isCurrent, apply, terminal, retry }: {
  fetchNote: () => Promise<T>;
  isCurrent: () => boolean;
  apply: (note: T) => void;
  terminal: (status: number) => void;
  retry: () => void;
}): Promise<void> {
  try {
    const note = await fetchNote();
    if (isCurrent()) apply(note);
  } catch (error) {
    if (!isCurrent()) return;
    if (error instanceof ApiError && [403, 404, 410].includes(error.status)) terminal(error.status);
    else retry(); // Includes expired auth: never infer deletion from a 401.
  }
}
