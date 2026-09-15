import { describe, it, expect } from 'vitest';
import { isHumanMissionRoot, missionCoordinatorCarrier } from '../chat/missionAttribution';
import type { ChatMessage } from '../chat/types';

describe('mission coordinator attribution', () => {
  it('creates presentation-only coordinator identity without copying human content or actions', () => {
    const root: ChatMessage = { id: 'human-root', channelId: 'room', author: 'Owner', body: 'Fix it', createdAt: '2026-09-15T12:00:00Z', mission: {
      id: 'mission', rootMessageId: 'human-root', title: 'Fix', objective: 'Fix', status: 'active', coordinator: 'Astra', coordinatorMention: 'astra', coordinatorRegistrationId: 'exact-registration', tasks: [], summary: '', createdAt: '', updatedAt: '',
    } };
    const before = JSON.stringify(root);
    expect(isHumanMissionRoot(root)).toBe(true);
    expect(missionCoordinatorCarrier(root)).toEqual({ id: 'mission-coordinator-row:mission', channelId: 'room', author: 'Astra', registrationId: 'exact-registration', agentId: 'mission-coordinator', body: '', createdAt: root.createdAt });
    expect(JSON.stringify(root)).toBe(before);
    expect(isHumanMissionRoot({ ...root, registrationId: 'agent' })).toBe(false);
  });
});
