import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { Broker } from '../src/broker.js';
import { main } from '../src/cli.js';

let root = '';
let previousHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a2ab-cli-'));
  previousHome = process.env['A2AB_HOME'];
  process.env['A2AB_HOME'] = root;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env['A2AB_HOME'];
  } else {
    process.env['A2AB_HOME'] = previousHome;
  }
  rmSync(root, { recursive: true, force: true });
});

async function captureJson(args: ReadonlyArray<string>): Promise<unknown> {
  let output = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    await main(args);
  } finally {
    process.stdout.write = originalWrite;
  }
  return JSON.parse(output) as unknown;
}

describe('peers CLI', () => {
  it('--active-only를 붙이면 active 세션만 출력한다', async () => {
    const broker = new Broker(root);
    broker.registerSession({
      sessionId: 'self',
      provider: 'codex',
      displayName: 'self',
      cwd: 'C:/work/app',
    });
    broker.registerSession({
      sessionId: 'active-peer',
      provider: 'claude',
      displayName: 'active',
      cwd: 'C:/work/app',
    });
    broker.registerSession({
      sessionId: 'offline-peer',
      provider: 'claude',
      displayName: 'offline',
      cwd: 'C:/work/app',
    });
    broker.markOffline('offline-peer');

    const unfiltered = await captureJson(['peers', '--session', 'self']) as {
      peers: Array<{ sessionId: string }>;
    };
    const activeOnly = await captureJson([
      'peers',
      '--session',
      'self',
      '--active-only',
    ]) as { peers: Array<{ sessionId: string }> };

    assert.deepEqual(
      unfiltered.peers.map((peer) => peer.sessionId),
      ['active-peer', 'offline-peer'],
    );
    assert.deepEqual(
      activeOnly.peers.map((peer) => peer.sessionId),
      ['active-peer'],
    );
  });
});

describe('receive CLI', () => {
  it('returns untrusted request context once and leaves notifications for pull', async () => {
    const broker = new Broker(root);
    for (const sessionId of ['receiver', 'sender']) {
      broker.registerSession({ sessionId, provider: 'codex', displayName: sessionId, cwd: root });
    }
    for (const kind of ['request', 'notification'] as const) {
      broker.send({ fromSessionId: 'sender', toSessionId: 'receiver', origin: 'agent', kind, text: kind });
    }
    const first = await captureJson(['receive', '--session', 'receiver']) as { requests: unknown[]; context: string };
    assert.equal(first.requests.length, 1);
    assert.match(first.context, /untrusted/i);
    const second = await captureJson(['receive', '--session', 'receiver']) as { requests: unknown[]; context: null };
    assert.deepEqual(second.requests, []);
    assert.equal(second.context, null);
    assert.equal(broker.inbox('receiver').notifications.length, 1);
  });
});

it('a watcher startup failure cannot discard a request already claimed by Stop', () => {
  const broker = new Broker(root);
  for (const sessionId of ['sender', 'invalid/session']) {
    broker.registerSession({ sessionId, provider: 'codex', displayName: sessionId, cwd: root });
  }
  broker.send({ fromSessionId: 'sender', toSessionId: 'invalid/session', kind: 'request', origin: 'agent', text: 'must reach model' });
  const source = `import {main} from ${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)}; await main(['hook','stop']);`;
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    input: JSON.stringify({ session_id: 'invalid/session' }), encoding: 'utf8',
  });
  const result = JSON.parse(out) as { decision: string; reason: string };
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /must reach model/);
});
