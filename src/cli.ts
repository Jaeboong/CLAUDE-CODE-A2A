// a2ab CLI — 운영·진단·에이전트용 pull 도구 (핸드오프 17절).
// hook 하위 명령은 Claude Code hook의 stdin JSON을 받아 HookOutput JSON을 출력한다.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { Broker } from './broker.js';
import {
  findCodexOwnerPid, isProcessAlive, launchCodexWatcher, readCodexWatchState, runCodexWatch,
} from './codex-watch.js';
import type { SendInput } from './broker.js';
import {
  buildRequestInjection,
  handlePostToolUse,
  handleSessionEnd,
  handleSessionStart,
  handleStop,
} from './hooks.js';
import type { HookInput, HookOutput } from './hooks.js';
import { installAllHooks } from './install.js';
import type { InstallTarget } from './install.js';
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

// 미지정은 '자동 감지'다. 'claude'로 접지 않는다.
function parseTarget(raw: string | undefined): InstallTarget | 'both' | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw === 'claude' || raw === 'codex' || raw === 'both') {
    return raw;
  }
  throw new Error(`--target must be claude|codex|both, got: ${raw}`);
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

// watcher 한 세대는 약 4시간(Claude Code hook timeout 상한)이다. 이만큼 이어받으면
// 하루가 조금 넘게 커버된다.
//
// 무제한으로 두지 않는 이유: 세션은 SessionEnd hook에서만 offline이 된다. 터미널이
// 강제 종료되면 그 hook이 안 돌아 레지스트리에는 영원히 active로 남고, 그러면 후계자
// 체인이 영원히 이어져 고아 프로세스가 4시간마다 되살아난다. 상한이 그 사고를 막는다.
// 정상 종료된 세션은 상한과 무관하게 다음 폴링(1.5초)에서 즉시 멈춘다.
const MAX_WATCH_RENEWALS = 6;

// 만료된 watcher를 이어받을 후계자를 detached로 띄운다.
// 세션 id는 stdin이 아니라 인자로 넘긴다 — 부모가 곧 종료하므로 파이프에 의존하지 않는다.
function spawnSuccessorWatcher(sessionId: string, generation: number): void {
  if (generation >= MAX_WATCH_RENEWALS) {
    return;
  }
  const args = process.argv.slice(1).filter((a, i, all) => {
    const prev = all[i - 1];
    return a !== '--renewals' && prev !== '--renewals';
  });
  if (!args.includes('--session')) {
    args.push('--session', sessionId);
  }
  args.push('--renewals', String(generation + 1));

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

async function runHook(
  event: string,
  broker: Broker,
  provider: string,
  sessionRef: string | undefined,
  generation: number,
): Promise<void> {
  const input = readStdinJson();

  // watch: 백그라운드 인박스 감시 (asyncRewake). request 도착 시 exit 2로 모델을 깨운다.
  if (event === 'watch') {
    // 후계자는 stdin 없이 --session으로 되살아난다.
    const sessionId = input.session_id ?? sessionRef;
    if (sessionId === undefined || !broker.hasSession(sessionId)) {
      return;
    }
    // 한 세대 수명 override. 기본값은 hook timeout에 묶여 4시간이라 검증이 불가능하다.
    const maxMsRaw = Number(process.env['A2AB_WATCH_MAX_MS'] ?? '');
    const result = await runWatch(
      broker,
      sessionId,
      rootDir(),
      Number.isFinite(maxMsRaw) && maxMsRaw > 0 ? { maxMs: maxMsRaw } : {},
    );
    if (result.payload !== undefined) {
      // exit 2 경로의 hook 출력 채널은 stderr다.
      process.stderr.write(`${result.payload}\n`);
    }
    if (result.renew === true) {
      spawnSuccessorWatcher(sessionId, generation);
    }
    process.exit(result.exitCode);
  }

  let output: HookOutput | undefined;
  switch (event) {
    case 'session-start': {
      // Register before launching the watcher so it cannot observe an unknown session.
      output = handleSessionStart(input, broker, provider);
      if (provider === 'codex' && output && input.session_id) {
        const watching = await launchCodexWatcher(input.session_id, findCodexOwnerPid()).catch(() => false);
        if (watching) output = codexWakeContext(output);
      }
      break;
    }
    case 'stop':
      output = handleStop(input, broker);
      if (input.session_id && broker.getSession(input.session_id)?.provider === 'codex') {
        // Optional wake support must never discard a request already claimed by Stop.
        await launchCodexWatcher(input.session_id, findCodexOwnerPid()).catch(() => false);
      }
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

function codexWakeContext(output: HookOutput): HookOutput {
  const context = output.hookSpecificOutput?.additionalContext;
  if (context === undefined) return output;
  return {
    ...output,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context.replace(
        '이 세션은 idle 상태에서 자동으로 깨어나지 않는다. 상대의 답을 기다리는 중이라면\n위 inbox 명령을 직접 실행해서 확인한다.',
        'Codex CLI용 inbox watcher가 시작되었다. 열린 CLI에서는 request가 codex queue를 통해 새 턴을 시작한다.\n' +
        '깨우기 신호를 받으면 안내된 receive 명령으로 요청을 한 번만 소비한다. notification은 깨우지 않는다.\n' +
        '자동 수신이 안 되면 a2ab status의 codexWake 상태와 inbox를 확인한다.',
      ),
    },
  };
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
  'settings': { type: 'string' },
  'target': { type: 'string' },
  'renewals': { type: 'string' },
  'print': { type: 'boolean' },
  'active-only': { type: 'boolean' },
  'owner-pid': { type: 'string' },
  'background': { type: 'boolean' },
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
      const result = broker.peers(resolveSessionId(broker, ref));
      printJson(
        values['active-only'] === true
          ? { ...result, peers: result.peers.filter((peer) => peer.status === 'active') }
          : result,
      );
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
    case 'receive': {
      const ref = values['session'];
      if (!ref) throw new Error('receive requires --session <id|name>');
      const sessionId = resolveSessionId(broker, ref);
      const requests = broker.popRequests(sessionId);
      printJson({ sessionId, requests, context: requests.length === 0 ? null : buildRequestInjection(sessionId, requests, broker) });
      return;
    }
    case 'codex-watch': {
      const ref = values['session'];
      if (!ref) throw new Error('codex-watch requires --session <id|name>');
      const sessionId = resolveSessionId(broker, ref);
      if (broker.getSession(sessionId)?.provider !== 'codex') throw new Error('codex-watch requires a Codex session');
      const ownerPid = values['owner-pid'] === undefined ? undefined : Number(values['owner-pid']);
      if (ownerPid !== undefined && (!Number.isSafeInteger(ownerPid) || ownerPid <= 1)) throw new Error('--owner-pid must be an integer greater than 1');
      if (values['background']) {
        const started = await launchCodexWatcher(sessionId, ownerPid);
        if (!started) throw new Error('Codex queue unavailable or disabled; install a CLI with codex queue or check A2AB_CODEX_BIN/A2AB_CODEX_WAKE');
        printJson({ started, sessionId });
        return;
      }
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      try {
        await runCodexWatch(broker, sessionId, rootDir(), {
          ...(ownerPid === undefined ? {} : { ownerPid }), signal: controller.signal,
        });
      } finally {
        process.removeListener('SIGTERM', stop);
        process.removeListener('SIGINT', stop);
      }
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
        ...(s.provider !== 'codex' ? {} : {
          codexWake: (() => {
            const state = readCodexWatchState(rootDir(), s.sessionId);
            return state === undefined ? null : { ...state, running: state.phase !== 'stopped' && isProcessAlive(state.pid) };
          })(),
        }),
      }));
      printJson({ root: rootDir(), sessions });
      return;
    }
    case 'init': {
      const target = parseTarget(values['target']);
      const installed = installAllHooks({
        ...(target === undefined ? {} : { target }),
        ...(values['settings'] === undefined ? {} : { settingsPath: values['settings'] }),
        ...(values['print'] === true ? { print: true } : {}),
      });
      printJson({ installed });
      return;
    }
    case 'hook': {
      const [event] = rest;
      if (event === undefined) {
        throw new Error('hook requires an event: session-start|stop|post-tool-use|session-end|watch');
      }
      await runHook(
        event,
        broker,
        values['provider'] ?? 'claude',
        values['session'],
        Number(values['renewals'] ?? '0'),
      );
      return;
    }
    default:
      throw new Error(
        `unknown command: ${command ?? '(none)'}\n` +
          'usage: a2ab init [--target claude|codex|both]|register|peers|inbox|receive|codex-watch|send|touch|status|hook',
      );
  }
}
