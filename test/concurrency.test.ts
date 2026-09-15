import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { Broker } from '../src/broker.js';

it('concurrent processes preserve sends and claim every request at most once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a2ab-concurrency-'));
  try {
    const broker = new Broker(root);
    for (const sessionId of ['sender', 'receiver']) broker.registerSession({ sessionId, provider: 'codex', displayName: sessionId, cwd: root });
    const worker = (operation: string): Promise<string> => new Promise((resolve, reject) => {
      const source = `import {Broker} from ${JSON.stringify(new URL('../src/broker.ts', import.meta.url).href)}; const b = new Broker(process.argv[1]); ${operation}`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, root], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let error = '';
      child.stdout.on('data', (chunk) => { output += String(chunk); });
      child.stderr.on('data', (chunk) => { error += String(chunk); });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(error)));
    });
    await Promise.all(Array.from({ length: 6 }, () => worker(`for(let i=0;i<20;i++) b.send({fromSessionId:'sender',toSessionId:'receiver',kind:'request',origin:'agent',text:'test'});`)));
    assert.equal(broker.inbox('receiver').pendingRequests.length, 120);
    const results = await Promise.all(Array.from({ length: 6 }, () => worker(`console.log(JSON.stringify(b.popRequests('receiver').map(m=>m.messageId)));`)));
    const ids = results.flatMap((line) => JSON.parse(line) as string[]);
    assert.equal(ids.length, 120);
    assert.equal(new Set(ids).size, 120);
    assert.deepEqual(broker.popRequests('receiver'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
