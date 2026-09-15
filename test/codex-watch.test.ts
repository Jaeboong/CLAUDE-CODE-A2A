import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Broker } from '../src/broker.js';
import { buildCodexWakeSignal, checkCodexInbox, readCodexWatchState, runCodexWatch } from '../src/codex-watch.js';
import { handleStop } from '../src/hooks.js';

let root: string;
let broker: Broker;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a2ab-codex-watch-'));
  broker = new Broker(root);
  broker.registerSession({ sessionId: 'codex-session', provider: 'codex', displayName: 'receiver', cwd: root });
  broker.registerSession({ sessionId: 'sender', provider: 'claude', displayName: 'sender', cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function send(kind: 'request' | 'notification' = 'request', deadlineSeconds?: number): string {
  return broker.send({ fromSessionId: 'sender', toSessionId: 'codex-session', kind, origin: 'agent', text: 'request body',
    ...(deadlineSeconds === undefined ? {} : { deadlineSeconds }),
  }).messageId;
}

describe('Codex queue delivery', () => {
  it('queues an idle-session signal without consuming the actual request', async () => {
    const id = send();
    broker.heartbeat('codex-session', { status: 'idle' });
    const calls: string[] = [];
    const result = await checkCodexInbox(broker, 'codex-session', [], async (id) => { calls.push(id); });
    assert.deepEqual(calls, ['codex-session']);
    assert.deepEqual(result.signaledIds, [id]);
    assert.equal(broker.inbox('codex-session').pendingRequests.length, 1);
    const again = await checkCodexInbox(broker, 'codex-session', result.signaledIds, async () => { assert.fail('duplicate signal'); });
    assert.equal(again.queued, false);
  });

  it('leaves failed submissions pending and permits a later retry', async () => {
    send();
    await assert.rejects(checkCodexInbox(broker, 'codex-session', [], async () => { throw new Error('queue unavailable'); }), /unavailable/);
    assert.equal(broker.inbox('codex-session').pendingRequests.length, 1);
    assert.equal((await checkCodexInbox(broker, 'codex-session', [], async () => {})).queued, true);
  });

  it('never wakes for notifications, expired requests, offline or non-Codex sessions', async () => {
    send('notification');
    send('request', -1);
    const queue = async (): Promise<void> => { assert.fail('must not wake'); };
    assert.equal((await checkCodexInbox(broker, 'codex-session', [], queue)).queued, false);
    send();
    broker.markOffline('codex-session');
    assert.equal((await checkCodexInbox(broker, 'codex-session', [], queue)).stopped, true);
    assert.equal((await checkCodexInbox(broker, 'sender', [], queue)).stopped, true);
    assert.equal((await checkCodexInbox(broker, 'missing', [], queue)).stopped, true);
  });

  it('Stop racing with a submitted signal still consumes the body only once', async () => {
    send();
    await checkCodexInbox(broker, 'codex-session', [], async () => {
      assert.match(handleStop({ session_id: 'codex-session' }, broker)?.reason ?? '', /request body/);
    });
    assert.deepEqual(broker.popRequests('codex-session'), []);
    assert.equal(handleStop({ session_id: 'codex-session' }, broker), undefined);
  });

  it('queues another signal for a new request but prunes consumed receipt IDs', async () => {
    const first = send();
    const one = await checkCodexInbox(broker, 'codex-session', [], async () => {});
    broker.popRequests('codex-session');
    const second = send();
    const two = await checkCodexInbox(broker, 'codex-session', one.signaledIds, async () => {});
    assert.equal(two.queued, true);
    assert.deepEqual(two.signaledIds, [second]);
    assert.notEqual(first, second);
  });

  it('wake signal directs atomic receive and contains no request body', () => {
    const signal = buildCodexWakeSignal('codex-session');
    assert.match(signal, /receive --session codex-session/);
    assert.match(signal, /untrusted/);
    assert.match(signal, /requests is empty/);
    assert.throws(() => buildCodexWakeSignal('id; touch /tmp/unwanted'), /path-safe/);
  });
});

describe('Codex watcher lifecycle', () => {
  it('persists receipts across watcher restarts without consuming requests', async () => {
    const id = send();
    let calls = 0;
    const options = { pollMs: 5, maxMs: 30, queue: async () => { calls++; } };
    await runCodexWatch(broker, 'codex-session', root, options);
    await runCodexWatch(broker, 'codex-session', root, options);
    assert.equal(calls, 1);
    assert.equal(readCodexWatchState(root, 'codex-session')?.phase, 'stopped');
    assert.deepEqual(readCodexWatchState(root, 'codex-session')?.signaledIds, [id]);
    assert.equal(broker.inbox('codex-session').pendingRequests.length, 1);
  });

  it('does not run a second watcher for the same live session', async () => {
    send();
    let calls = 0;
    const options = { pollMs: 5, maxMs: 30, queue: async () => { calls++; } };
    await Promise.all([runCodexWatch(broker, 'codex-session', root, options), runCodexWatch(broker, 'codex-session', root, options)]);
    assert.equal(calls, 1);
  });

  it('records failure and stops on abort, retaining the inbox', async () => {
    send();
    const controller = new AbortController();
    await runCodexWatch(broker, 'codex-session', root, { signal: controller.signal, queue: async () => {
      controller.abort(); throw new Error('unavailable');
    } });
    const state = readCodexWatchState(root, 'codex-session');
    assert.equal(state?.phase, 'stopped');
    assert.match(state?.lastError ?? '', /unavailable/);
    assert.deepEqual(state?.signaledIds, []);
    assert.equal(broker.inbox('codex-session').pendingRequests.length, 1);
  });

  it('stops without queueing after the owning process exits', async () => {
    send();
    await runCodexWatch(broker, 'codex-session', root, { ownerPid: 2147483647, queue: async () => { assert.fail('owner is dead'); } });
    assert.equal(readCodexWatchState(root, 'codex-session')?.phase, 'stopped');
  });
});
