// a2ab CLI — 운영·진단·에이전트용 pull 도구 (핸드오프 17절).
// hook 하위 명령은 Claude Code hook의 stdin JSON을 받아 HookOutput JSON을 출력한다.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { Broker } from './broker.js';
import type { SendInput } from './broker.js';
import {
  handlePostToolUse,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
} from './hooks.js';
import type { HookInput, HookOutput } from './hooks.js';
import type { MessageKind, MessageOrigin } from './protocol.js';
import { runWatch } from './watch.js';

function rootDir(): string {
  return process.env['A2AB_HOME'] ?? join(homedir(), '.a2ab');
}

// id 또는 displayName으로 세션을 찾는다. 이름이 중복이면 명시적으로 실패한다.
function resolveSessionId(broker: Broker, ref: string): string {
  if (broker.hasSession(ref)) {
    return ref;
  }
  const byName = broker.listSessions().filter((s) => s.displayName === ref);
  if (byName.length === 1 && byName[0] !== undefined) {
    return byName[0].sessionId;
  }
  if (byName.length > 1) {
    throw new Error(`ambiguous session name: ${ref} (matches ${byName.length} sessions)`);
  }
  throw new Error(`unknown session: ${ref}`);
}

function parseKind(raw: string | undefined): MessageKind {
  if (raw === 'request' || raw === 'notification') {
    return raw;
  }
  throw new Error(`--kind must be request|notification, got: ${raw ?? '(missing)'}`);
}

function parseOrigin(raw: string | undefined): MessageOrigin {
  if (raw === undefined) {
    return 'agent';
  }
  if (raw === 'human' || raw === 'agent') {
    return raw;
  }
  throw new Error(`--origin must be human|agent, got: ${raw}`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readStdinJson(): HookInput {
  try {
    // PowerShell 파이프는 BOM을 붙일 수 있으므로 제거한다.
    const raw = readFileSync(0, 'utf8').replace(/^﻿/, '');
    return raw.trim() === '' ? {} : (JSON.parse(raw) as HookInput);
  } catch {
    return {};
  }
}

async function runHook(event: string, broker: Broker): Promise<void> {
  const input = readStdinJson();

  // watch: 백그라운드 인박스 감시 (asyncRewake). request 도착 시 exit 2로 모델을 깨운다.
  if (event === 'watch') {
    const sessionId = input.session_id;
    if (sessionId === undefined || !broker.hasSession(sessionId)) {
      return;
    }
    const result = await runWatch(broker, sessionId, rootDir());
    if (result.payload !== undefined) {
      // exit 2 경로의 hook 출력 채널은 stderr다.
      process.stderr.write(`${result.payload}\n`);
    }
    process.exit(result.exitCode);
  }

  let output: HookOutput | undefined;
  switch (event) {
    case 'session-start':
      output = handleSessionStart(input, broker);
      break;
    case 'stop':
      output = handleStop(input, broker);
      break;
    case 'post-tool-use':
      output = handlePostToolUse(input, broker);
      break;
    case 'session-end':
      output = handleSessionEnd(input, broker);
      break;
    default:
      throw new Error(`unknown hook event: ${event}`);
  }
  if (output !== undefined) {
    printJson(output);
  }
}

const CLI_OPTIONS = {
  'session': { type: 'string' },
  'session-id': { type: 'string' },
  'name': { type: 'string' },
  'provider': { type: 'string' },
  'cwd': { type: 'string' },
  'task': { type: 'string' },
  'branch': { type: 'string' },
  'from': { type: 'string' },
  'to': { type: 'string' },
  'kind': { type: 'string' },
  'origin': { type: 'string' },
  'text': { type: 'string' },
  'context': { type: 'string' },
  'reply-to': { type: 'string' },
  'idempotency-key': { type: 'string' },
  'ttl': { type: 'string' },
  'deadline': { type: 'string' },
} as const;

export async function main(argv: ReadonlyArray<string>): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: CLI_OPTIONS,
    allowPositionals: true,
  });
  const [command, ...rest] = positionals;
  const broker = new Broker(rootDir());

  switch (command) {
    case 'register': {
      const sessionId = values['session-id'] ?? crypto.randomUUID();
      const name = values['name'];
      if (name === undefined) {
        throw new Error('register requires --name');
      }
      const record = broker.registerSession({
        sessionId,
        provider: values['provider'] ?? 'unknown',
        displayName: name,
        cwd: values['cwd'] ?? process.cwd(),
        ...(values['task'] === undefined ? {} : { currentTask: values['task'] }),
        ...(values['branch'] === undefined ? {} : { branch: values['branch'] }),
      });
      printJson(record);
      return;
    }
    case 'peers': {
      const ref = values['session'];
      if (ref === undefined) {
        throw new Error('peers requires --session <id|name>');
      }
      printJson(broker.peers(resolveSessionId(broker, ref)));
      return;
    }
    case 'inbox': {
      const ref = values['session'];
      if (ref === undefined) {
        throw new Error('inbox requires --session <id|name>');
      }
      printJson(broker.inbox(resolveSessionId(broker, ref)));
      return;
    }
    case 'send': {
      const from = values['from'];
      const to = values['to'];
      if (from === undefined || to === undefined) {
        throw new Error('send requires --from and --to');
      }
      const input: SendInput = {
        fromSessionId: resolveSessionId(broker, from),
        toSessionId: resolveSessionId(broker, to),
        kind: parseKind(values['kind']),
        origin: parseOrigin(values['origin']),
        text: values['text'] ?? '',
        ...(values['context'] === undefined ? {} : { contextId: values['context'] }),
        ...(values['reply-to'] === undefined
          ? {}
          : { replyToMessageId: values['reply-to'] }),
        ...(values['idempotency-key'] === undefined
          ? {}
          : { idempotencyKey: values['idempotency-key'] }),
        ...(values['ttl'] === undefined ? {} : { ttlSeconds: Number(values['ttl']) }),
        ...(values['deadline'] === undefined
          ? {}
          : { deadlineSeconds: Number(values['deadline']) }),
      };
      printJson(broker.send(input));
      return;
    }
    case 'touch': {
      const ref = values['session'];
      if (ref === undefined || rest.length === 0) {
        throw new Error('touch requires --session <id|name> <paths...>');
      }
      broker.addTouchingPaths(resolveSessionId(broker, ref), rest);
      printJson({ ok: true, added: rest });
      return;
    }
    case 'status': {
      const sessions = broker.listSessions().map((s) => ({
        sessionId: s.sessionId,
        displayName: s.displayName,
        provider: s.provider,
        status: s.status,
        cwd: s.cwd,
        branch: s.branch ?? null,
        touching: s.touchingPaths.length,
        lastSeenAt: s.lastSeenAt,
      }));
      printJson({ root: rootDir(), sessions });
      return;
    }
    case 'hook': {
      const [event] = rest;
      if (event === undefined) {
        throw new Error('hook requires an event: session-start|stop|post-tool-use|session-end|watch');
      }
      await runHook(event, broker);
      return;
    }
    default:
      throw new Error(
        `unknown command: ${command ?? '(none)'}\n` +
          'usage: a2ab register|peers|inbox|send|touch|status|hook',
      );
  }
}
