import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { messageText, orderRequests } from '../src/protocol.js';
import type { A2AMessage } from '../src/protocol.js';

function makeRequest(overrides: Partial<A2AMessage> & Pick<A2AMessage, 'messageId'>): A2AMessage {
  return {
    kind: 'request',
    origin: 'agent',
    fromSessionId: 'a',
    toSessionId: 'b',
    contextId: 'ctx',
    parts: [{ type: 'text', text: 'hi' }],
    idempotencyKey: overrides.messageId,
    createdAt: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

describe('orderRequests (프로토콜 7.1)', () => {
  it('사람 request가 더 늦게 왔어도 에이전트 request보다 앞선다', () => {
    const agentEarly = makeRequest({ messageId: 'm1', origin: 'agent', createdAt: '2026-07-25T00:00:01.000Z' });
    const humanLate = makeRequest({ messageId: 'm2', origin: 'human', createdAt: '2026-07-25T00:00:09.000Z' });
    const ordered = orderRequests([agentEarly, humanLate]);
    assert.deepEqual(ordered.map((m) => m.messageId), ['m2', 'm1']);
  });

  it('같은 origin끼리는 선입선출', () => {
    const late = makeRequest({ messageId: 'm1', createdAt: '2026-07-25T00:00:09.000Z' });
    const early = makeRequest({ messageId: 'm2', createdAt: '2026-07-25T00:00:01.000Z' });
    const ordered = orderRequests([late, early]);
    assert.deepEqual(ordered.map((m) => m.messageId), ['m2', 'm1']);
  });

  it('생성 시각까지 같으면 messageId로 결정적 정렬', () => {
    const a = makeRequest({ messageId: 'zz' });
    const b = makeRequest({ messageId: 'aa' });
    const ordered = orderRequests([a, b]);
    assert.deepEqual(ordered.map((m) => m.messageId), ['aa', 'zz']);
  });

  it('입력 배열을 변형하지 않는다', () => {
    const a = makeRequest({ messageId: 'm1', origin: 'agent' });
    const b = makeRequest({ messageId: 'm2', origin: 'human' });
    const input = [a, b];
    orderRequests(input);
    assert.deepEqual(input.map((m) => m.messageId), ['m1', 'm2']);
  });
});

describe('messageText', () => {
  it('text/data/file 파트를 사람이 읽을 문자열로 합친다', () => {
    const text = messageText([
      { type: 'text', text: 'hello' },
      { type: 'data', data: { a: 1 } },
      { type: 'file', path: 'C:/x/y.ts', note: 'patch' },
    ]);
    assert.equal(text, 'hello\n{"a":1}\n[file] C:/x/y.ts — patch');
  });
});
