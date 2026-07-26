import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Broker } from '../src/broker.js';

let root = '';
let broker: Broker;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a2ab-test-'));
  broker = new Broker(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function registerPair(): void {
  broker.registerSession({
    sessionId: 'sess-a',
    provider: 'claude',
    displayName: 'alpha',
    cwd: 'C:/work/app',
  });
  broker.registerSession({
    sessionId: 'sess-b',
    provider: 'codex',
    displayName: 'beta',
    cwd: 'C:/work/app',
  });
}

describe('세션 등록과 peers', () => {
  it('등록된 상대 세션이 peers에 보인다', () => {
    registerPair();
    const result = broker.peers('sess-a');
    assert.equal(result.selfSessionId, 'sess-a');
    assert.deepEqual(result.peers.map((p) => p.sessionId), ['sess-b']);
    assert.equal(result.peers[0]?.provider, 'codex');
  });

  it('offline 세션은 status로 표시된다', () => {
    registerPair();
    broker.markOffline('sess-b');
    const result = broker.peers('sess-a');
    assert.equal(result.peers[0]?.status, 'offline');
  });

  it('같은 파일을 건드리면 same-file 충돌이 잡힌다', () => {
    registerPair();
    broker.addTouchingPaths('sess-a', ['C:/work/app/src/auth.ts']);
    broker.addTouchingPaths('sess-b', ['C:/work/app/src/auth.ts', 'C:/work/app/src/other.ts']);
    const result = broker.peers('sess-a');
    const conflicts = result.peers[0]?.conflictsWithMe ?? [];
    assert.deepEqual(conflicts, [{ path: 'C:/work/app/src/auth.ts', kind: 'same-file' }]);
  });

  it('같은 프로젝트 같은 브랜치면 same-branch 충돌이 잡힌다', () => {
    registerPair();
    broker.heartbeat('sess-a', { branch: 'main' });
    broker.heartbeat('sess-b', { branch: 'main' });
    const result = broker.peers('sess-a');
    const kinds = (result.peers[0]?.conflictsWithMe ?? []).map((c) => c.kind);
    assert.ok(kinds.includes('same-branch'));
  });

  it('브랜치가 다르면 same-branch 충돌이 없다', () => {
    registerPair();
    broker.heartbeat('sess-a', { branch: 'main' });
    broker.heartbeat('sess-b', { branch: 'feature/x' });
    const result = broker.peers('sess-a');
    const kinds = (result.peers[0]?.conflictsWithMe ?? []).map((c) => c.kind);
    assert.ok(!kinds.includes('same-branch'));
  });
});

describe('send와 inbox', () => {
  beforeEach(registerPair);

  it('request가 수신자 인박스에 들어간다', () => {
    const sent = broker.send({
      fromSessionId: 'sess-a',
      toSessionId: 'sess-b',
      kind: 'request',
      origin: 'agent',
      text: 'review auth.ts please',
    });
    assert.equal(sent.delivered, true);
    assert.equal(sent.deduped, false);

    const inbox = broker.inbox('sess-b');
    assert.equal(inbox.pendingRequests.length, 1);
    assert.equal(inbox.notifications.length, 0);
    assert.equal(inbox.pendingRequests[0]?.fromSessionId, 'sess-a');
  });

  it('pendingRequests는 사람 우선 + FIFO로 정렬된다', () => {
    broker.send({ fromSessionId: 'sess-a', toSessionId: 'sess-b', kind: 'request', origin: 'agent', text: 'agent-1' });
    broker.send({ fromSessionId: 'sess-a', toSessionId: 'sess-b', kind: 'request', origin: 'human', text: 'human-1' });
    const inbox = broker.inbox('sess-b');
    assert.deepEqual(
      inbox.pendingRequests.map((m) => m.origin),
      ['human', 'agent'],
    );
  });

  it('notification은 pendingRequests가 아니라 notifications로 분류된다', () => {
    broker.send({ fromSessionId: 'sess-a', toSessionId: 'sess-b', kind: 'notification', origin: 'agent', text: 'FYI' });
    const inbox = broker.inbox('sess-b');
    assert.equal(inbox.pendingRequests.length, 0);
    assert.equal(inbox.notifications.length, 1);
  });

  it('TTL이 지난 notification은 inbox에서 빠진다', () => {
    broker.send({
      fromSessionId: 'sess-a',
      toSessionId: 'sess-b',
      kind: 'notification',
      origin: 'agent',
      text: 'stale',
      ttlSeconds: 0,
    });
    const inbox = broker.inbox('sess-b');
    assert.equal(inbox.notifications.length, 0);
  });

  it('deadline이 지난 request는 inbox에서 빠진다 (failed-timeout)', () => {
    broker.send({
      fromSessionId: 'sess-a',
      toSessionId: 'sess-b',
      kind: 'request',
      origin: 'agent',
      text: 'too late',
      deadlineSeconds: 0,
    });
    const inbox = broker.inbox('sess-b');
    assert.equal(inbox.pendingRequests.length, 0);
  });

  it('같은 idempotencyKey 재전송은 중복 적재하지 않는다', () => {
    const first = broker.send({
      fromSessionId: 'sess-a',
      toSessionId: 'sess-b',
      kind: 'request',
      origin: 'agent',
      text: 'once',
      idempotencyKey: 'key-1',
    });
    const second = broker.send({
      fromSessionId: 'sess-a',
      toSessionId: 'sess-b',
      kind: 'request',
      origin: 'agent',
      text: 'once',
      idempotencyKey: 'key-1',
    });
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(broker.inbox('sess-b').pendingRequests.length, 1);
  });

  it('자기 자신에게 보내기는 거부된다 (프로토콜 11절 정책)', () => {
    assert.throws(() =>
      broker.send({ fromSessionId: 'sess-a', toSessionId: 'sess-a', kind: 'request', origin: 'agent', text: 'loop' }),
    );
  });
});

describe('턴 경계 소비 (popRequests / ackNotifications)', () => {
  beforeEach(registerPair);

  it('popRequests는 정확히 한 번만 반환한다', () => {
    broker.send({ fromSessionId: 'sess-a', toSessionId: 'sess-b', kind: 'request', origin: 'agent', text: 'do it' });
    const first = broker.popRequests('sess-b');
    const second = broker.popRequests('sess-b');
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
  });

  it('popRequests는 notification을 건드리지 않는다', () => {
    broker.send({ fromSessionId: 'sess-a', toSessionId: 'sess-b', kind: 'notification', origin: 'agent', text: 'FYI' });
    const popped = broker.popRequests('sess-b');
    assert.equal(popped.length, 0);
    assert.equal(broker.inbox('sess-b').notifications.length, 1);
  });

  it('ackNotifications는 새 통보를 한 번만 반환하고, inbox pull에는 계속 남긴다', () => {
    broker.send({ fromSessionId: 'sess-a', toSessionId: 'sess-b', kind: 'notification', origin: 'agent', text: 'FYI' });
    const first = broker.ackNotifications('sess-b');
    const second = broker.ackNotifications('sess-b');
    assert.equal(first.length, 1);
    assert.equal(second.length, 0);
    // 프로토콜 2.1: acked 후에도 TTL 내에는 모델이 pull로 볼 수 있어야 한다.
    assert.equal(broker.inbox('sess-b').notifications.length, 1);
  });
});

describe('영속성', () => {
  it('브로커 인스턴스를 새로 만들어도 상태가 유지된다', () => {
    registerPair();
    broker.send({ fromSessionId: 'sess-a', toSessionId: 'sess-b', kind: 'request', origin: 'agent', text: 'persist me' });

    const reopened = new Broker(root);
    assert.equal(reopened.peers('sess-a').peers.length, 1);
    assert.equal(reopened.inbox('sess-b').pendingRequests.length, 1);
  });
});
