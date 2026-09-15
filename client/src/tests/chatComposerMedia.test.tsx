import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

// Exercise the composer's rendered controls and async handlers without a DOM.
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useState(initial: any) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: any) => {
      hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value;
    }];
  },
  useRef(initial: any) {
    const index = hooks.cursor++;
    return hooks.slots[index] ||= { current: initial };
  },
  useCallback(callback: any, deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index];
    if (!previous || deps.some((value, i) => value !== previous.deps[i])) hooks.slots[index] = { callback, deps };
    return hooks.slots[index].callback;
  },
  useImperativeHandle: () => {},
  useEffect: effect,
  useLayoutEffect: effect,
}));
function effect(callback: () => any, deps?: unknown[]) {
  const index = hooks.cursor++;
  const previous = hooks.slots[index];
  if (!previous || !deps || deps.some((value, i) => value !== previous.deps[i])) {
    hooks.effects.push(() => {
      previous?.cleanup?.();
      hooks.slots[index] = { deps, cleanup: callback() };
    });
  }
}
vi.mock('../api', () => ({ api: vi.fn() }));
import { api } from '../api';
import { ChatComposer, CHAT_MEDIA_LIMIT, CHAT_MEDIA_MAX_BYTES } from '../components/ChatComposer';
const send = vi.fn();
function render(channelId = 'channel-a') {
  hooks.cursor = 0;
  const tree = (ChatComposer as any).render({ channelId, channelName: channelId, notes: [],
    mentionableAliases: [], registeredAgents: [], onSendMessage: send }, null);
  hooks.effects.splice(0).forEach((run) => run());
  return tree;
}
function nodes(tree: any, predicate: (node: any) => boolean): any[] {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, predicate));
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...nodes(tree.props?.children, predicate)];
}
const byType = (tree: ReactElement, type: string) => nodes(tree, (node) => node.type === type);
const button = (tree: ReactElement, title: string) => nodes(tree, (node) => node.props?.title === title)[0];
function paste(files = [new File(['image'], 'paste.png', { type: 'image/png' })], channel = 'channel-a') {
  byType(render(channel), 'textarea')[0].props.onPaste({ preventDefault() {}, clipboardData: {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
  } });
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let resolveUpload: (value: { url: string }) => void;
beforeEach(() => {
  hooks.slots = []; hooks.effects = []; hooks.cursor = 0;
  send.mockReset(); vi.mocked(api).mockReset();
  vi.mocked(api).mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve as any; }));
  vi.stubGlobal('window', {});
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('FileReader', class {
    result = 'data:image/png;base64,aW1hZ2U=';
    onload?: () => void;
    readAsDataURL() { this.onload?.(); }
  });
  let nextUrl = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:local-preview-${++nextUrl}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});

describe('composer media uploads', () => {
  it('renders the local image before a slow upload completes and sends only its completed attachment', async () => {
    paste(); await flush();
    const pending = render();
    expect(byType(pending, 'img')[0]?.props.src).toBe('blob:local-preview-1');
    expect(button(pending, 'Send message').props.disabled).toBe(true);
    byType(pending, 'textarea')[0].props.onKeyDown({ key: 'Enter', preventDefault() {} });
    expect(send).not.toHaveBeenCalled();
    resolveUpload({ url: '/assets/uploaded.png' }); await flush();
    button(render(), 'Send message').props.onClick();
    expect(send.mock.calls[0][2]).toEqual([{ name: 'paste.png', media_type: 'image/png', data: '', url: '/assets/uploaded.png' }]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview-1');
  });
  it('does not resurrect a removed upload or attach it after changing channel', async () => {
    paste(); await flush();
    const oldResolve = resolveUpload;
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    button(render(), 'Remove').props.onClick();
    expect(signal?.aborted).toBe(true);
    oldResolve({ url: '/assets/removed.png' }); await flush();
    expect(byType(render(), 'img')).toHaveLength(0);
    paste(); await flush();
    const channelResolve = resolveUpload;
    render('channel-b');
    channelResolve({ url: '/assets/wrong-channel.png' }); await flush();
    expect(byType(render('channel-b'), 'img')).toHaveLength(0);
    expect(button(render('channel-b'), 'Send message').props.disabled).toBe(true);
  });

  it('shows independent failures while other uploads finish and blocks sending until removed', async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error('Network unavailable'));
    vi.mocked(api).mockResolvedValueOnce({ url: '/assets/good.png' });
    paste([new File(['a'], 'bad.png', { type: 'image/png' }), new File(['b'], 'good.png', { type: 'image/png' })]);
    await flush();
    const tree = render();
    expect(byType(tree, 'img')).toHaveLength(2);
    expect(nodes(tree, (node) => node.props?.role === 'alert')[0].props.children).toContain('Network unavailable');
    expect(button(tree, 'Send message').props.disabled).toBe(true);
    button(tree, 'Remove').props.onClick();
    button(render(), 'Send message').props.onClick();
    expect(send.mock.calls[0][2]).toEqual([{ name: 'good.png', media_type: 'image/png', data: '', url: '/assets/good.png' }]);
  });

  it('reserves the attachment limit immediately across overlapping pastes and skips oversized files', async () => {
    const oversized = new File(['a'], 'large.png', { type: 'image/png' });
    Object.defineProperty(oversized, 'size', { value: CHAT_MEDIA_MAX_BYTES + 1 });
    paste([oversized]); await flush();
    expect(api).not.toHaveBeenCalled();
    for (let i = 0; i < CHAT_MEDIA_LIMIT + 2; i++) paste();
    await flush();
    expect(byType(render(), 'img')).toHaveLength(CHAT_MEDIA_LIMIT);
    expect(api).toHaveBeenCalledTimes(CHAT_MEDIA_LIMIT);
  });

  it('renders every image immediately even while the first file is still being encoded', async () => {
    const readers: any[] = [];
    vi.stubGlobal('FileReader', class {
      result = 'data:image/png;base64,aW1hZ2U=';
      onload?: () => void;
      readAsDataURL() { readers.push(this); }
    });
    paste([new File(['a'], 'a.png', { type: 'image/png' }), new File(['b'], 'b.png', { type: 'image/png' })]);
    expect(byType(render(), 'img')).toHaveLength(2);
    expect(api).not.toHaveBeenCalled();
    readers[1].onload(); await flush();
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('ignores delayed desktop clipboard reads after a channel switch', async () => {
    let complete: (value: unknown) => void = () => {};
    vi.stubGlobal('window', { electronAPI: { readClipboardImage: () => new Promise((resolve) => { complete = resolve; }) } });
    byType(render(), 'textarea')[0].props.onPaste({ clipboardData: { items: [], types: [] } });
    render('channel-b');
    complete({ data: 'aW1hZ2U=', media_type: 'image/png', url: 'data:image/png;base64,aW1hZ2U=' });
    await flush();
    expect(api).not.toHaveBeenCalled();
    expect(byType(render('channel-b'), 'img')).toHaveLength(0);
  });

  it('aborts and releases the preview on unmount, ignoring late upload completion', async () => {
    paste(); await flush();
    const signal = vi.mocked(api).mock.calls[0][1]?.signal;
    hooks.slots.forEach((slot) => slot?.cleanup?.());
    expect(signal?.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:local-preview-1');
    const slotsAfterUnmount = [...hooks.slots];
    resolveUpload({ url: '/assets/late.png' }); await flush();
    expect(hooks.slots).toEqual(slotsAfterUnmount);
    expect(send).not.toHaveBeenCalled();
  });

});
