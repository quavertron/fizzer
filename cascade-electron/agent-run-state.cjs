'use strict';

const crypto = require('crypto');

/**
 * Main-process run/event registry. Renderer reloads must not erase ownership of
 * a still-running child or lose events produced while Chromium is unavailable.
 */
class AgentRunState {
  constructor({ maxEvents = 4000 } = {}) {
    this.instanceId = crypto.randomUUID();
    this.maxEvents = maxEvents;
    this.nextSeq = 1;
    this.active = new Set();
    this.events = [];
    this.terminals = new Map();
  }

  start(runId) {
    const id = Number(runId);
    if (!Number.isFinite(id)) throw new Error('Invalid run id');
    if (this.active.has(id) || this.terminals.has(id)) return false;
    this.active.add(id);
    return true;
  }

  record(payload) {
    const runId = Number(payload?.runId);
    if (!Number.isFinite(runId)) return null;
    const event = { ...payload, bridgeSeq: this.nextSeq++ };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    if (payload?.type === 'status') {
      try {
        const status = JSON.parse(payload.payload_json || '{}')?.status;
        if (status === 'completed' || status === 'failed' || status === 'canceled') {
          this.active.delete(runId);
          event.receiptRequired = true;
          this.terminals.set(runId, event);
        }
      } catch { /* malformed status is forwarded but cannot settle ownership */ }
    }
    return event;
  }

  cancel(runId) {
    this.active.delete(Number(runId));
  }

  acknowledge(instanceId, seq) {
    if (instanceId !== this.instanceId) return false;
    for (const [runId, event] of this.terminals) {
      if (event.bridgeSeq !== seq) continue;
      this.terminals.delete(runId);
      this.events = this.events.filter((item) => item.bridgeSeq !== seq);
      return true;
    }
    return false;
  }

  snapshot(afterSeq = 0) {
    const cursor = Number.isFinite(Number(afterSeq)) ? Number(afterSeq) : 0;
    return {
      instanceId: this.instanceId,
      activeRunIds: [...this.active],
      // A renderer cursor only acknowledges progress, not server receipt of a
      // terminal result. Keep those results independently of the log cap.
      events: [...new Map([
        ...this.events.filter((event) => event.bridgeSeq > cursor),
        ...this.terminals.values(),
      ].map((event) => [event.bridgeSeq, event])).values()]
        .sort((a, b) => a.bridgeSeq - b.bridgeSeq),
      cursor: this.nextSeq - 1,
    };
  }
}

/**
 * A child may leave the CLI process registry immediately before its owning
 * promise settles. Treat that narrow cleanup race as an idempotent cancel,
 * while still refusing a genuinely live, unowned run after a short barrier.
 */
async function settleCancelAcknowledgement(cancelled, running, timeoutMs = 1000) {
  if (cancelled) {
    if (running) await Promise.resolve(running).catch(() => {});
    return true;
  }
  if (!running) return false;

  let timer;
  try {
    return await Promise.race([
      Promise.resolve(running).then(() => true, () => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = { AgentRunState, settleCancelAcknowledgement };
