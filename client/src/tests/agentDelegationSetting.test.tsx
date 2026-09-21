import { beforeEach, expect, it, vi } from 'vitest';

// Exercise the existing editor and save callbacks without a browser or backend.
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, handle: null as any }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState(initial: any) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.slots[index], (value: any) => { hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value; }];
  },
  useMemo: (fn: () => any) => fn(),
  useCallback: (fn: any) => fn,
  useEffect() {},
  useImperativeHandle: (_ref: any, create: () => any) => { hooks.handle = create(); },
}));
import { ChatAgentPanel } from '../components/ChatAgentPanel';
import { ChatAgentToggle } from '../components/ChatAgentToggle';

const saveIdentity = vi.fn();
const saveMember = vi.fn();
const registration = {
  id: 'source', vaultAgentId: 'identity-source', ownerUserId: 1, agentId: 'codex', displayName: 'Source',
  avatarUrl: '', mention: 'source', model: 'model', cwd: '', contextPrompt: '', reasoningEffort: '',
  priorityServiceTier: false, taggableByAgents: false, replyToEveryMessage: true, orchestrator: true,
  nextStepSuggestions: false, pingableByOthers: false, yolo: false, hermesProfile: '', hermesSafeMode: false,
  conversationId: 'session',
};
function render(member = registration, canManage = true) {
  hooks.cursor = 0;
  return (ChatAgentPanel as any).render({
    channelId: 'room', currentUser: 'owner', currentUserId: 1,
    availableAgents: [{ id: 'codex', label: 'Codex', models: [{ id: 'model', label: 'Model' }] }],
    registeredAgents: [member], registeredAgentRows: [], vaultAgents: [],
    canManageRegistration: () => canManage, onRegisterAgent: saveMember, onUpsertVaultAgent: saveIdentity,
    onRemoveAgent() {}, async onInviteUser() {}, onExpandRail() {}, onChromeChange() {},
  }, null);
}
function nodes(tree: any, predicate: (node: any) => boolean): any[] {
  if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
const toggle = (tree: any) => nodes(tree, n => n.type === ChatAgentToggle && n.props.name === 'Missions and delegation')[0];

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.handle = null;
  saveIdentity.mockReset(); saveIdentity.mockResolvedValue(undefined); saveMember.mockReset();
});

it('defaults on, saves identity-wide false, and shows stored false when reopened', async () => {
  render(); hooks.handle.openMemberSettings(registration);
  const control = toggle(render());
  expect(control.props.checked).toBe(true);
  expect(control.props.hint).toContain('wherever it is registered');
  control.props.onChange({ target: { checked: false } });
  const tree = render();
  expect(toggle(tree).props.checked).toBe(false);
  await nodes(tree, n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  expect(saveIdentity).toHaveBeenCalledWith(expect.objectContaining({ id: 'identity-source', missionsEnabled: false }));
  expect(saveMember).toHaveBeenCalledWith('room', expect.objectContaining({ missionsEnabled: false, orchestrator: true, replyToEveryMessage: true }));
  hooks.slots = [];
  const stored = { ...registration, missionsEnabled: false };
  render(stored); hooks.handle.openMemberSettings(stored);
  expect(toggle(render(stored)).props.checked).toBe(false);
});

it('shows the toggle as disabled for another owner', () => {
  render(registration, false); hooks.handle.openMemberSettings(registration);
  expect(toggle(render(registration, false)).props.disabled).toBe(true);
});


it('omits an unknown cached capability during an unrelated profile save', async () => {
  render(); hooks.handle.openMemberSettings(registration);
  await nodes(render(), n => n.type === 'form')[0].props.onSubmit({ preventDefault() {} });
  const payload = JSON.parse(JSON.stringify(saveIdentity.mock.calls[0][0]));
  expect(payload).not.toHaveProperty('missionsEnabled');
});
