import type { ChatMessage } from './types';

/** Presentation only. Never changes the persisted human request or its actions. */
export function missionCoordinatorCarrier(root: ChatMessage): ChatMessage {
  if (!root.mission) throw new Error('Mission projection required');
  return {
    id: `mission-coordinator-row:${root.mission.id}`,
    channelId: root.channelId,
    author: root.mission.coordinator,
    registrationId: root.mission.coordinatorRegistrationId,
    agentId: 'mission-coordinator',
    body: '',
    createdAt: root.createdAt,
  };
}

export function isHumanMissionRoot(message: ChatMessage): boolean {
  return Boolean(message.mission && !message.agentId && !message.registrationId);
}
