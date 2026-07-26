import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Broker } from '../src/broker.js';
import {
  handlePostToolUse,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
} from '../src/hooks.js';

let root = '';
let broker: Broker;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a2ab-hooks-'));
  broker = new Broker(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const startInput = {
  session_id: 'claude-sess-1',
  cwd: 'C:/work/app',
  hook_event_name: 'SessionStart',
};

describe('SessionStart hook', () => {
  it('세션을 자동 등록하고 additionalContext로 자기 id를 알려준다', () => {
    const out = handleSessionStart(startInput, broker);
    const registered = broker.peers('claude-sess-1');
    assert.equal(registered.selfSessionId, 'claude-sess-1');

    const ctx = out?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(ctx.includes('claude-sess-1'));
  });

  it('재시작 시 같은 session_id면 중복 등록하지 않는다', () => {
    handleSessionStart(startInput, broker);
    handleSessionStart(startInput, broker);
    // 자기 자신은 peers에 안 나오므로, 다른 세션에서 본 목록으로 확인
    broker.registerSession({ sessionId: 'other', provider: 'claude', displayName: 'o', cwd: 'C:/x' });
    const seen = broker.peers('other').peers.filter((p) => p.sessionId === 'claude-sess-1');
    assert.equal(seen.length, 1);
  });
});

describe('PostToolUse hook', () => {
  it('Write/Edit한 파일 경로를 touchingPaths로 수집한다', () => {
    handleSessionStart(startInput, broker);
    handlePostToolUse(
      {
        session_id: 'claude-sess-1',
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'C:/work/app/src/auth.ts' },
      },
      broker,
    );
    broker.registerSession({ sessionId: 'other', provider: 'claude', displayName: 'o', cwd: 'C:/x' });
    const peer = broker.peers('other').peers.find((p) => p.sessionId === 'claude-sess-1');
    assert.deepEqual(peer?.touchingPaths, ['C:/work/app/src/auth.ts']);
  });

  it('등록 안 된 세션의 이벤트는 무시한다', () => {
    assert.doesNotThrow(() =>
      handlePostToolUse(
        {
          session_id: 'unknown',
          hook_event_name: 'PostToolUse',
          tool_name: 'Write',
          tool_input: { file_path: 'C:/x/y.ts' },
        },
        broker,
      ),
    );
  });
});

describe('Stop hook — 턴 경계 소비', () => {
  beforeEach(() => {
    handleSessionStart(startInput, broker);
    broker.registerSession({ sessionId: 'peer-1', provider: 'codex', displayName: 'peer', cwd: 'C:/x' });
  });

  const stopInput = {
    session_id: 'claude-sess-1',
    hook_event_name: 'Stop',
    stop_hook_active: false,
  };

  it('request가 있으면 decision:block으로 턴을 이어가고 본문을 주입한다', () => {
    broker.send({ fromSessionId: 'peer-1', toSessionId: 'claude-sess-1', kind: 'request', origin: 'agent', text: 'need your review' });
    const out = handleStop(stopInput, broker);
    assert.equal(out?.decision, 'block');
    assert.ok(out?.reason?.includes('need your review'));
    // 프로토콜 5절: 검증되지 않은 외부 입력임을 명시
    assert.ok(out?.reason?.toLowerCase().includes('untrusted'));
  });

  it('소비 후 두 번째 Stop은 정상 종료를 허용한다 (무한 루프 방지)', () => {
    broker.send({ fromSessionId: 'peer-1', toSessionId: 'claude-sess-1', kind: 'request', origin: 'agent', text: 'once' });
    handleStop(stopInput, broker);
    const second = handleStop(stopInput, broker);
    assert.equal(second?.decision, undefined);
  });

  it('notification만 있으면 턴을 발생시키지 않고 systemMessage로 표시한다', () => {
    broker.send({ fromSessionId: 'peer-1', toSessionId: 'claude-sess-1', kind: 'notification', origin: 'agent', text: 'editing auth.ts' });
    const out = handleStop(stopInput, broker);
    assert.equal(out?.decision, undefined);
    assert.ok(out?.systemMessage?.includes('editing auth.ts'));
  });

  it('같은 notification을 두 번 표시하지 않는다', () => {
    broker.send({ fromSessionId: 'peer-1', toSessionId: 'claude-sess-1', kind: 'notification', origin: 'agent', text: 'once only' });
    handleStop(stopInput, broker);
    const second = handleStop(stopInput, broker);
    assert.equal(second, undefined);
  });

  it('인박스가 비어 있으면 아무것도 하지 않는다', () => {
    const out = handleStop(stopInput, broker);
    assert.equal(out, undefined);
  });
});

describe('SessionEnd hook', () => {
  it('세션을 offline으로 표시한다', () => {
    handleSessionStart(startInput, broker);
    broker.registerSession({ sessionId: 'other', provider: 'claude', displayName: 'o', cwd: 'C:/x' });
    handleSessionEnd({ session_id: 'claude-sess-1', hook_event_name: 'SessionEnd' }, broker);
    const peer = broker.peers('other').peers.find((p) => p.sessionId === 'claude-sess-1');
    assert.equal(peer?.status, 'offline');
  });
});
