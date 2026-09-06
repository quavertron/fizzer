import type { ChatMessage } from './types';

export interface MissionMessageIdentity {
  id: string;
  title: string;
  role: 'Worker' | 'Coordinator';
  taskTitle?: string;
}

// Calm, readable accents on the existing dark surface. Identity never changes
// with status, message order, or the agent doing the work; the name carries it too.
const ACCENTS = ['#8ba7de', '#78b7b0', '#b6a0d2', '#c9ad70', '#cf9aa8'];
export function missionAccent(id: string): string {
  let hash = 0;
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return ACCENTS[hash % ACCENTS.length];
}

/** Resolve only persisted task/run/reply identities, never proximity or author. */
export function missionMessageIdentities(messages: ChatMessage[]): Map<string, MissionMessageIdentity> {
  const missions = new Map<string, MissionMessageIdentity>();
  const tasks = new Map<string, MissionMessageIdentity>();
  const runs = new Map<number, MissionMessageIdentity>();
  const identities = new Map<string, MissionMessageIdentity>();
  for (const message of messages) {
    if (!message.mission) continue;
    const mission = message.mission;
    const identity: MissionMessageIdentity = { id: mission.id, title: mission.title, role: 'Coordinator' };
    missions.set(mission.id, identity);
    identities.set(message.id, identity);
    for (const task of mission.tasks) {
      const worker: MissionMessageIdentity = { ...identity, role: 'Worker', taskTitle: task.title };
      tasks.set(task.id, worker);
      if (task.runId != null) runs.set(task.runId, worker);
    }
  }
  for (const message of messages) {
    if (!message.agentId && !message.registrationId) continue;
    const missionId = message.id.match(/^(?:sys-mission-|mission-explanation-)([0-9a-f-]{36})-/i)?.[1];
    const identity = (message.missionTaskId ? tasks.get(message.missionTaskId) : undefined)
      || (message.runId != null ? runs.get(message.runId) : undefined)
      || (missionId ? missions.get(missionId) : undefined)
      || (message.replyTo?.messageId ? identities.get(message.replyTo.messageId) : undefined);
    if (identity) identities.set(message.id, identity);
  }
  return identities;
}
