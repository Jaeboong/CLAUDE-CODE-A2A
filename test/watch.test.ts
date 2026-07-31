import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Broker } from '../src/broker.js';
import { acquireLock, checkOnce, runWatch, watchLockPath } from '../src/watch.js';
import type { WatchContext } from '../src/watch.js';

let root = '';
let broker: Broker;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a2ab-watch-'));
  broker = new Broker(root);
  broker.registerSession({ sessionId: 'me', provider: 'claude', displayName: 'me', cwd: 'C:/x' });
  broker.registerSession({ sessionId: 'peer', provider: 'claude', displayName: 'peer', cwd: 'C:/y' });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeContext(): WatchContext {
  const lockPath = watchLockPath(root, 'me');
  const nonce = 'nonce-1';
  acquireLock(lockPath, nonce);
  return { broker, sessionId: 'me', lockPath, nonce };
}

describe('checkOnce', () => {
  it('인박스가 비어 있으면 none', () => {
    const result = checkOnce(makeContext());
    assert.equal(result.tick, 'none');
  });

  it('request가 도착하면 popped + 주입 페이로드를 만든다', () => {
    const ctx = makeContext();
    broker.send({ fromSessionId: 'peer', toSessionId: 'me', kind: 'request', origin: 'agent', text: 'wake up please' });
    const result = checkOnce(ctx);
    assert.equal(result.tick, 'popped');
    assert.ok(result.payload?.includes('wake up please'));
    assert.ok(result.payload?.toLowerCase().includes('untrusted'));
    // pop이므로 두 번째 확인은 none
    assert.equal(checkOnce(ctx).tick, 'none');
  });

  it('notification만으로는 깨우지 않는다 (프로토콜 2.1)', () => {
    const ctx = makeContext();
    broker.send({ fromSessionId: 'peer', toSessionId: 'me', kind: 'notification', origin: 'agent', text: 'FYI only' });
    assert.equal(checkOnce(ctx).tick, 'none');
  });

  it('세션이 offline이면 감시를 중단한다', () => {
    const ctx = makeContext();
    broker.markOffline('me');
    assert.equal(checkOnce(ctx).tick, 'offline');
  });

  it('더 새 watcher가 lock을 가져가면 물러난다', () => {
    const ctx = makeContext();
    writeFileSync(ctx.lockPath, JSON.stringify({ nonce: 'newer-nonce', pid: 999 }), 'utf8');
    assert.equal(checkOnce(ctx).tick, 'lock-lost');
  });
});

describe('runWatch', () => {
  it('대기 중 request가 있으면 즉시 exit 2 + 페이로드', async () => {
    broker.send({ fromSessionId: 'peer', toSessionId: 'me', kind: 'request', origin: 'agent', text: 'urgent' });
    const result = await runWatch(broker, 'me', root, { pollMs: 10, maxMs: 1000 });
    assert.equal(result.exitCode, 2);
    assert.ok(result.payload?.includes('urgent'));
  });

  // hook timeout 상한 때문에 watcher는 반드시 죽는다. 그대로 끝내면 오래 유휴인 세션은
  // 인박스를 보는 사람이 없어져 request가 조용히 만료된다 — 후계자를 띄우라고 알려야 한다.
  it('감시 시간 초과 시 exit 0 + renew', async () => {
    const result = await runWatch(broker, 'me', root, { pollMs: 10, maxMs: 50 });
    assert.equal(result.exitCode, 0);
    assert.equal(result.payload, undefined);
    assert.equal(result.renew, true);
  });

  // 세션이 끝났거나 더 새 watcher가 들어온 경우는 이어받을 이유가 없다.
  it('세션 종료·lock 상실로 물러날 때는 renew하지 않는다', async () => {
    broker.markOffline('me');
    const offline = await runWatch(broker, 'me', root, { pollMs: 10, maxMs: 5000 });
    assert.equal(offline.exitCode, 0);
    assert.equal(offline.renew, undefined);

    broker.registerSession({ sessionId: 'me', provider: 'claude', displayName: 'me', cwd: 'C:/x' });
    const running = runWatch(broker, 'me', root, { pollMs: 10, maxMs: 5000 });
    acquireLock(watchLockPath(root, 'me'), 'newer-watcher');
    const lockLost = await running;
    assert.equal(lockLost.exitCode, 0);
    assert.equal(lockLost.renew, undefined);
  });

  it('새 watcher가 시작되면 기존 watcher의 lock을 대체한다', () => {
    const lockPath = watchLockPath(root, 'me');
    acquireLock(lockPath, 'old');
    acquireLock(lockPath, 'new');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce: string };
    assert.equal(lock.nonce, 'new');
  });
});
