import { describe, expect, it } from 'vitest';
import {
  DESKTOP_RUNNER_SOCKET_OPTIONS,
  deliverTerminalWithReceipt,
  LatestRunnerSetup,
  reconcileCancelAcknowledgement,
  registerThenReplayBufferedEvents,
} from '../desktopRunnerHost';

it('only releases a terminal result after a successful server receipt', () => {
  let callback!: (error: Error | null, response?: { success?: boolean }) => void;
  const sent: unknown[][] = [];
  const socket = {
    timeout: () => ({ emit: (...args: unknown[]) => {
      callback = args.at(-1) as typeof callback;
      sent.push(args.slice(0, -1));
    } }),
  } as unknown as Parameters<typeof deliverTerminalWithReceipt>[0];
  let received = 0;
  let settled = 0;
  const send = () => deliverTerminalWithReceipt(socket,
    { runId: 42, type: 'status', payload: { status: 'completed' } },
    () => { received += 1; }, () => { settled += 1; });
  send();
  expect(received).toBe(0);
  callback(new Error('connection dropped'));
  expect(received).toBe(0);
  send();
  callback(null, { success: false });
  expect(received).toBe(0);
  send();
  callback(null, { success: true });
  expect(received).toBe(1);
  expect(settled).toBe(3);
  expect(sent[0]).toEqual(['runner:runEvent', {
    runId: 42, type: 'status', payload: { status: 'completed' }, receipt: true,
  }]);
});

describe('desktop runner transport isolation', () => {
  it('uses a dedicated polling manager instead of a renderer WebSocket upgrade', () => {
    expect(DESKTOP_RUNNER_SOCKET_OPTIONS).toEqual({
      forceNew: true,
      transports: ['polling'],
      upgrade: false,
    });
  });
});

describe('desktop runner server-restart recovery', () => {
  it('registers ownership before replaying a buffered terminal event', () => {
    const sent: string[] = [];
    registerThenReplayBufferedEvents(
      () => sent.push('runner:register'),
      ['completed'],
      (event) => sent.push(`runner:runEvent:${event}`),
    );
    expect(sent).toEqual(['runner:register', 'runner:runEvent:completed']);
  });
});

describe('desktop runner credential setup', () => {
  it('coalesces repeated setup for the same login', async () => {
    const setup = new LatestRunnerSetup();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const task = async () => {
      calls += 1;
      await gate;
    };

    const first = setup.ensure('same-login', task);
    const second = setup.ensure('same-login', task);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(second).toBe(first);
    release();
    await first;
  });

  it('invalidates a late setup completion during logout', async () => {
    const setup = new LatestRunnerSetup();
    let release!: () => void;
    let activated = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = setup.ensure('login', async (isCurrent) => {
      await gate;
      activated = isCurrent();
    });

    setup.invalidate();
    release();
    await pending;
    expect(activated).toBe(false);
  });

  it('supersedes an older login when credentials change', async () => {
    const setup = new LatestRunnerSetup();
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    let oldCurrent = true;
    let newCurrent = false;
    const old = setup.ensure('old', async (isCurrent) => {
      await oldGate;
      oldCurrent = isCurrent();
    });
    const next = setup.ensure('new', async (isCurrent) => {
      newCurrent = isCurrent();
    });
    releaseOld();
    await Promise.all([old, next]);
    expect(oldCurrent).toBe(false);
    expect(newCurrent).toBe(true);
  });
});

describe('desktop runner cancellation acknowledgement', () => {
  it('is idempotent once the run is already settled locally', async () => {
    expect(await reconcileCancelAcknowledgement(false, 42, new Set(), 10)).toBe(true);
  });

  it('accepts the child-cleanup race when the terminal event arrives', async () => {
    const active = new Set([42]);
    setTimeout(() => active.delete(42), 5);
    expect(await reconcileCancelAcknowledgement(false, 42, active, 100)).toBe(true);
  });

  it('still refuses a genuinely active run that did not stop', async () => {
    expect(await reconcileCancelAcknowledgement(false, 42, new Set([42]), 10)).toBe(false);
  });
});
