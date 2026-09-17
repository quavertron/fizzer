import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

// Exercise the picker's rendered controls without a DOM, matching the
// chatComposerMedia test's mocked-hooks approach.
type EffectSlot = { deps?: unknown[]; cleanup?: () => void };
type StateSlot = { value: unknown };
type Slot = EffectSlot | StateSlot;
const hooks = vi.hoisted(() => ({
  slots: [] as Slot[],
  cursor: 0,
  effects: [] as (() => void)[],
}));
vi.mock('react', async (original) => {
  const mod = await original<typeof import('react')>();
  return {
    ...mod,
    useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void] {
      const index = hooks.cursor++;
      let slot = hooks.slots[index] as StateSlot | undefined;
      if (!slot || !('value' in slot)) {
        slot = { value: initial };
        hooks.slots[index] = slot;
      }
      const set = (value: T | ((previous: T) => T)) => {
        slot!.value = typeof value === 'function' ? (value as (previous: T) => T)(slot!.value as T) : value;
      };
      return [slot.value as T, set];
    },
    useEffect(callback: () => void | (() => void), deps?: unknown[]) {
      const index = hooks.cursor++;
      const previous = hooks.slots[index] as EffectSlot | undefined;
      if (!previous || !deps || deps.some((value, i) => value !== previous.deps?.[i])) {
        hooks.effects.push(() => {
          previous?.cleanup?.();
          const cleanup = callback();
          hooks.slots[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined };
        });
      }
    },
  };
});

import { ServerPicker } from '../components/ServerPicker';

function render(): ReactNode {
  hooks.cursor = 0;
  const tree = ServerPicker();
  hooks.effects.splice(0).forEach((run) => run());
  return tree;
}

function isElement(node: unknown): node is { type: unknown; props: Record<string, unknown> } {
  return node !== null && typeof node === 'object' && 'props' in node;
}

function nodes(tree: unknown, predicate: (node: { type: unknown; props: Record<string, unknown> }) => boolean): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!isElement(tree)) return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props.children, predicate)];
}

const byClass = (tree: ReactNode, name: string) =>
  nodes(tree, (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes(name));
const byType = (tree: ReactNode, type: string) => nodes(tree, (node) => node.type === type);
const text = (node: unknown): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(text).join(' ');
  if (isElement(node)) return text(node.props.children);
  return '';
};
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const listConnections = vi.fn();
const openConnection = vi.fn();

beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.cursor = 0;
  listConnections.mockReset();
  openConnection.mockReset();
  vi.stubGlobal('window', {
    electronAPI: { listConnections, openConnection },
    location: { origin: 'https://current.example', host: 'current.example' },
  });
});

describe('login screen server picker', () => {
  it('renders nothing outside the desktop shell', () => {
    vi.stubGlobal('window', { location: { origin: 'https://current.example', host: 'current.example' } });
    expect(render()).toBeNull();
  });

  it('lists other known servers and opens one on click', async () => {
    listConnections.mockResolvedValue([
      { id: '', name: 'This Mac', origin: 'http://127.0.0.1:3000', local: true, hasSession: true },
      { id: 'v1', name: 'current.example', origin: 'https://current.example', local: false, hasSession: true },
      { id: '', name: 'b.example', origin: 'https://b.example', local: false, hasSession: false },
    ]);
    openConnection.mockResolvedValue({ success: true });
    render();
    await flush();
    const tree = render();
    const rows = byClass(tree, 'auth-server');
    // The current origin is not offered as a switch target.
    expect(rows.map((row) => text(row))).toEqual(['This Mac Signed in', 'b.example Sign in required']);
    openConnection.mockClear();
    (rows[1].props.onClick as () => void)();
    await flush();
    expect(openConnection).toHaveBeenCalledWith({ id: '', origin: 'https://b.example' });
  });

  it('connects to a typed address from the add-server form', async () => {
    listConnections.mockResolvedValue([]);
    openConnection.mockResolvedValue({ success: true });
    render();
    await flush();
    (byClass(render(), 'auth-server-add-toggle')[0].props.onClick as () => void)();
    let tree = render();
    (byType(tree, 'input')[0].props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'fizzer.example.com:8443' } });
    tree = render();
    (byType(tree, 'input')[0].props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({ key: 'Enter', preventDefault() {} });
    await flush();
    expect(openConnection).toHaveBeenCalledWith({ id: '', origin: 'fizzer.example.com:8443' });
  });

  it('surfaces a failed connection instead of navigating', async () => {
    listConnections.mockResolvedValue([
      { id: '', name: 'b.example', origin: 'https://b.example', local: false, hasSession: true },
    ]);
    openConnection.mockResolvedValue({ success: false, error: 'timed out' });
    render();
    await flush();
    (byClass(render(), 'auth-server')[0].props.onClick as () => void)();
    await flush();
    const tree = render();
    expect(byClass(tree, 'error').map(text)).toEqual(['timed out']);
  });
});
