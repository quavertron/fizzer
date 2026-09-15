/** Typed client surface for first-class vault missions. */

import type { Note } from './api';
import { api } from './api';
import type { ChatMessage, ChatMission, ChatMissionTask, ChatMissionEvent } from './chat/types';

export type MissionPhase = 'planning' | 'executing' | 'closed';
export type MissionNoteKind = 'mission' | 'milestone' | 'feature';

export type MissionNoteRef = {
  noteId: string;
  kind: MissionNoteKind;
  parentNoteId: string | null;
  title: string;
  revision: string;
};

export type MissionTask = ChatMissionTask & {
  purpose?: 'research' | 'implementation' | 'review' | 'fix' | 'integration' | 'verification' | string;
  briefNoteId?: string | null;
  briefRevisions?: Record<string, string>;
  reviewOutcome?: 'accepted' | 'changes_requested' | null;
  verificationPassed?: boolean | null;
};

export type MissionRecord = Omit<ChatMission, 'tasks'> & {
  vaultId: string;
  channelId: string;
  phase: MissionPhase;
  tasks: MissionTask[];
  notes: MissionNoteRef[];
  /** Registration that owns the coordinator controls for task steering. */
  coordinatorRegistrationId?: string;
  approvedAt?: string | null;
  approvedBy?: number | string | null;
  approvedRevisions?: Record<string, string> | null;
};

export type MissionSummary = Pick<MissionRecord, 'id' | 'title' | 'status' | 'phase' | 'updatedAt' | 'channelId'> & {
  vaultId: string;
  summary?: string;
  notes?: MissionNoteRef[];
};

export type MissionCreateInput = {
  id: string;
  title: string;
  coordinatorIdentityId: string;
  briefContent: string;
};

export type MissionNoteInput = {
  id?: string;
  kind: Exclude<MissionNoteKind, 'mission'>;
  parentNoteId: string | null;
  title: string;
  content: string;
};

export type MissionNote = Note & {
  revision?: string;
};

export type MissionTaskCreateInput = {
  coordinatorRegistrationId: string;
  title: string;
  assignee: string;
  prompt: string;
  dependsOn?: string[];
  priority?: number;
  reasoningEffort?: string;
  anonymous?: boolean;
  workspaceMode?: string;
  purpose?: MissionTask['purpose'];
  briefNoteId?: string | null;
};

export type MissionTaskUpdateInput = {
  status: ChatMissionTask['status'];
  summary: string;
  finding?: boolean;
  reviewOutcome?: MissionTask['reviewOutcome'];
  verificationPassed?: MissionTask['verificationPassed'];
};

export type MissionHistoryEvent = ChatMissionEvent;

export async function fetchMissions(vaultId: string): Promise<MissionSummary[]> {
  const result = await api<{ missions?: MissionSummary[] }>(`/api/vaults/${encodeURIComponent(vaultId)}/missions`);
  return result.missions ?? [];
}

export async function fetchMission(vaultId: string, missionId: string): Promise<MissionRecord> {
  const result = await api<{ mission: MissionRecord }>(
    `/api/vaults/${encodeURIComponent(vaultId)}/missions/${encodeURIComponent(missionId)}`,
  );
  return result.mission;
}

export async function createMission(vaultId: string, input: MissionCreateInput): Promise<MissionRecord> {
  const result = await api<{ mission: MissionRecord }>(`/api/vaults/${encodeURIComponent(vaultId)}/missions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return result.mission;
}

export async function createMissionNote(
  vaultId: string,
  missionId: string,
  input: MissionNoteInput,
): Promise<MissionRecord> {
  const result = await api<{ mission: MissionRecord }>(
    `/api/vaults/${encodeURIComponent(vaultId)}/missions/${encodeURIComponent(missionId)}/notes`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result.mission;
}

export async function stopMission(
  vaultId: string,
  channelId: string,
  missionId: string,
  coordinatorRegistrationId: string,
): Promise<MissionRecord> {
  const result = await api<{ mission: MissionRecord }>(
    `/api/vaults/${encodeURIComponent(vaultId)}/channels/${encodeURIComponent(channelId)}/missions/${encodeURIComponent(missionId)}/finish`,
    { method: 'POST', body: JSON.stringify({ coordinatorRegistrationId, status: 'canceled', summary: 'Stopped by the user.' }) },
  );
  return result.mission;
}

export async function fetchMissionNote(noteId: string): Promise<MissionNote> {
  const result = await api<{ note: MissionNote }>(`/api/notes/${encodeURIComponent(noteId)}`);
  return result.note;
}

export async function saveMissionNote(
  noteId: string,
  content: string,
  expectedRevision: string,
): Promise<MissionNote> {
  const result = await api<{ note: MissionNote }>(`/api/notes/${encodeURIComponent(noteId)}`, {
    method: 'PUT',
    body: JSON.stringify({ content, expectedRevision }),
  });
  return result.note;
}

export async function fetchMissionHistory(
  vaultId: string,
  channelId: string,
  missionId: string,
): Promise<MissionHistoryEvent[]> {
  const result = await api<{ events?: MissionHistoryEvent[] }>(
    `/api/vaults/${encodeURIComponent(vaultId)}/channels/${encodeURIComponent(channelId)}/missions/${encodeURIComponent(missionId)}/history`,
  );
  return result.events ?? [];
}

export async function delegateMissionTask(
  vaultId: string,
  channelId: string,
  missionId: string,
  input: MissionTaskCreateInput,
): Promise<{ mission: MissionRecord; task: MissionTask; scheduled: boolean; message?: ChatMessage }> {
  return api<{ mission: MissionRecord; task: MissionTask; scheduled: boolean; message?: ChatMessage }>(
    `/api/vaults/${encodeURIComponent(vaultId)}/channels/${encodeURIComponent(channelId)}/missions/${encodeURIComponent(missionId)}/tasks`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

export async function updateMissionTask(
  vaultId: string,
  channelId: string,
  taskId: string,
  input: MissionTaskUpdateInput,
): Promise<MissionRecord> {
  const result = await api<{ mission: MissionRecord }>(
    `/api/vaults/${encodeURIComponent(vaultId)}/channels/${encodeURIComponent(channelId)}/missions/tasks/${encodeURIComponent(taskId)}`,
    { method: 'PATCH', body: JSON.stringify(input) },
  );
  return result.mission;
}

export async function steerMissionTask(
  vaultId: string,
  channelId: string,
  taskId: string,
  input: { coordinatorRegistrationId: string; message: string; attempt?: number; runId?: number },
): Promise<unknown> {
  const result = await api<{ steering: unknown }>(
    `/api/vaults/${encodeURIComponent(vaultId)}/channels/${encodeURIComponent(channelId)}/missions/tasks/${encodeURIComponent(taskId)}/steer`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result.steering;
}

/** Fetch the recent channel projection used for live mission conversation UI. */
export async function fetchMissionChannelMessages(
  vaultId: string,
  channelId: string,
): Promise<ChatMessage[]> {
  const result = await api<{ messages?: ChatMessage[] }>(
    `/api/vaults/${encodeURIComponent(vaultId)}/channels/${encodeURIComponent(channelId)}/messages?detail=list&limit=120`,
  );
  return result.messages ?? [];
}

/**
 * Hydrate every persisted message belonging to a selected task/run. The list
 * projection is paginated and intentionally omits harness logs, so task traces
 * must walk older pages and then fetch authorized full message detail.
 */
export async function fetchMissionTaskTrace(
  vaultId: string,
  channelId: string,
  taskId: string,
  runId?: number,
): Promise<ChatMessage[]> {
  const base = `/api/vaults/${encodeURIComponent(vaultId)}/channels/${encodeURIComponent(channelId)}/messages`;
  const listed: ChatMessage[] = [];
  let beforeSeq: number | null = null;
  for (;;) {
    const query: string = `${base}?detail=list&limit=120${beforeSeq == null ? '' : `&beforeSeq=${beforeSeq}`}`;
    const page: { messages?: ChatMessage[]; beforeSeq?: number | null; hasMore?: boolean } = await api(query);
    const messages = page.messages ?? [];
    listed.push(...messages);
    const nextBefore: number | null = page.beforeSeq ?? null;
    if (!page.hasMore || nextBefore == null || nextBefore === beforeSeq || messages.length === 0) break;
    beforeSeq = nextBefore;
  }

  const exact = listed.filter((message) => (
    runId != null ? message.runId === runId : message.missionTaskId === taskId
  ));
  const detailed = await Promise.all(exact.map(async (message) => {
    try {
      const result = await api<{ message: ChatMessage }>(
        `${base}/${encodeURIComponent(message.id)}`,
      );
      return result.message ?? message;
    } catch {
      return message;
    }
  }));
  return detailed;
}

export async function renameMissionNote(noteId: string, title: string): Promise<MissionNote> {
  const result = await api<{ note: MissionNote }>(`/api/notes/${encodeURIComponent(noteId)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ title }),
  });
  return result.note;
}
