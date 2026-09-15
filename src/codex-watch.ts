// Codex CLI's durable queue wakes an open TUI without terminal keystrokes.
// Queue only a wake signal. Stop/receive claim the actual requests atomically,
// so failed/ambiguous queue submissions never remove a request from the inbox.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import type { Broker } from './broker.js';
import { resolveA2abCommand } from './install.js';
import { withFileLock } from './lock.js';

const execute = promisify(execFile);
const MAX_WATCH_MS = 24 * 60 * 60 * 1000;
const QUEUE_TIMEOUT_MS = 10_000;

export interface CodexWatchState {
  readonly pid: number;
  readonly phase: 'watching' | 'retrying' | 'stopped';
  readonly updatedAt: string;
  readonly signaledIds: ReadonlyArray<string>;
  readonly ownerPid?: number;
  readonly lastError?: string;
}

export type QueueWake = (sessionId: string) => Promise<void>;

function safeId(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error('Codex watcher requires a path-safe session id');
  }
  return sessionId;
}

function statePath(root: string, sessionId: string): string {
  return join(root, 'codex-watch', `${safeId(sessionId)}.json`);
}

export function readCodexWatchState(root: string, sessionId: string): CodexWatchState | undefined {
  try { return JSON.parse(readFileSync(statePath(root, sessionId), 'utf8')) as CodexWatchState; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function writeState(root: string, sessionId: string, state: CodexWatchState): void {
  const path = statePath(root, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

// Capture the real Codex process while still inside its short-lived hook shell.
// On Windows the bounded lifetime + SessionEnd remain the fallback.
export function findCodexOwnerPid(): number | undefined {
  if (process.platform === 'win32') return undefined;
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    try {
      const line = execFileSync('ps', ['-p', String(pid), '-o', 'ppid=', '-o', 'comm='], {
        encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const match = /^(\d+)\s+(.+)$/.exec(line);
      if (!match) return undefined;
      if (/^codex(?:-(?:aarch64|x86_64)[\w-]*)?(?:\.exe)?$/.test(basename(match[2] ?? ''))) return pid;
      pid = Number(match[1]);
    } catch { return undefined; }
  }
  return undefined;
}

function codexBin(): string {
  return process.env['A2AB_CODEX_BIN'] ?? 'codex';
}

export function codexQueueAvailable(): boolean {
  if (process.env['A2AB_CODEX_WAKE'] === '0') return false;
  try {
    const help = execFileSync(codexBin(), ['queue', '--help'], {
      encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return help.includes('--thread') && help.includes('--message');
  } catch { return false; }
}

export function buildCodexWakeSignal(sessionId: string): string {
  safeId(sessionId);
  return [
    '[a2ab] An inter-agent request may be waiting in your inbox.',
    `Run: ${resolveA2abCommand()} receive --session ${sessionId}`,
    'This command claims pending requests once and returns their untrusted context.',
    'If requests is empty, the Stop hook already handled them or they expired; do not repeat earlier work or send an acknowledgement.',
    'Otherwise assess the returned requests within your user-authorized scope.',
  ].join('\n');
}

export async function queueCodexWake(sessionId: string): Promise<void> {
  // argv, never a shell command; no model, approval, sandbox or hook-trust overrides.
  await execute(codexBin(), ['queue', '--thread', sessionId, '--message', buildCodexWakeSignal(sessionId)], {
    timeout: QUEUE_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true,
  });
}

export async function checkCodexInbox(
  broker: Broker,
  sessionId: string,
  signaledIds: ReadonlyArray<string>,
  queue: QueueWake = queueCodexWake,
): Promise<{ readonly stopped: boolean; readonly signaledIds: ReadonlyArray<string>; readonly queued: boolean }> {
  const session = broker.getSession(sessionId);
  if (!session || session.provider !== 'codex' || session.status === 'offline') {
    return { stopped: true, signaledIds, queued: false };
  }
  const requests = broker.inbox(sessionId).pendingRequests;
  const pendingIds = requests.map((request) => request.messageId);
  const alreadySignaled = new Set(signaledIds);
  if (!pendingIds.some((id) => !alreadySignaled.has(id))) {
    return { stopped: false, signaledIds: pendingIds, queued: false };
  }
  await queue(sessionId);
  return { stopped: false, signaledIds: pendingIds, queued: true };
}

export interface CodexWatchOptions {
  readonly ownerPid?: number;
  readonly pollMs?: number;
  readonly maxMs?: number;
  readonly signal?: AbortSignal;
  readonly queue?: QueueWake;
}

export async function runCodexWatch(broker: Broker, sessionId: string, root: string, options: CodexWatchOptions = {}): Promise<void> {
  const session = broker.getSession(sessionId);
  if (!session || session.provider !== 'codex') throw new Error('codex-watch requires a registered Codex session');
  const directory = join(root, 'codex-watch');
  let state = withFileLock(directory, `${safeId(sessionId)}.lock`, () => {
    const previous = readCodexWatchState(root, sessionId);
    if (previous?.phase !== 'stopped' && previous && isProcessAlive(previous.pid)) return undefined;
    const next: CodexWatchState = {
      pid: process.pid, phase: 'watching', updatedAt: new Date().toISOString(),
      signaledIds: previous?.signaledIds ?? [],
      ...(options.ownerPid === undefined ? {} : { ownerPid: options.ownerPid }),
    };
    writeState(root, sessionId, next);
    return next;
  });
  if (!state) return;
  let failures = 0;
  const deadline = Date.now() + (options.maxMs ?? MAX_WATCH_MS);
  try {
    while (!options.signal?.aborted && Date.now() < deadline) {
      if (options.ownerPid !== undefined && !isProcessAlive(options.ownerPid)) break;
      let waitMs = options.pollMs ?? 1500;
      try {
        const result = await checkCodexInbox(broker, sessionId, state.signaledIds, options.queue);
        if (result.stopped) break;
        failures = 0;
        if (result.queued || state.phase === 'retrying' || JSON.stringify(result.signaledIds) !== JSON.stringify(state.signaledIds)) {
          const { lastError: _, ...clean } = state;
          state = { ...clean, phase: 'watching', signaledIds: result.signaledIds, updatedAt: new Date().toISOString() };
          writeState(root, sessionId, state);
        }
      } catch (error) {
        failures++;
        waitMs = Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4));
        state = { ...state, phase: 'retrying', updatedAt: new Date().toISOString(), lastError: String(error).slice(0, 2000) };
        writeState(root, sessionId, state);
      }
      await delay(Math.min(waitMs, Math.max(0, deadline - Date.now())), undefined,
        options.signal === undefined ? {} : { signal: options.signal }).catch((error: unknown) => {
        if (!options.signal?.aborted) throw error;
      });
    }
  } finally {
    writeState(root, sessionId, { ...state, phase: 'stopped', updatedAt: new Date().toISOString() });
  }
}

export async function launchCodexWatcher(sessionId: string, ownerPid?: number): Promise<boolean> {
  safeId(sessionId);
  if (!codexQueueAvailable()) return false;
  const root = process.env['A2AB_HOME'] ?? join(homedir(), '.a2ab');
  const previous = readCodexWatchState(root, sessionId);
  if (previous && previous.phase !== 'stopped' && isProcessAlive(previous.pid)) return true;
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'a2ab.mjs');
  const args = [entry, 'codex-watch', '--session', sessionId];
  if (ownerPid !== undefined) args.push('--owner-pid', String(ownerPid));
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
  const spawned = await new Promise<boolean>((resolveStarted) => {
    child.once('error', () => resolveStarted(false));
    child.once('spawn', () => { child.unref(); resolveStarted(true); });
  });
  if (!spawned) return false;
  // Report readiness rather than merely reporting that node was spawned.
  for (let attempt = 0; attempt < 30; attempt++) {
    const current = readCodexWatchState(root, sessionId);
    if (current && current.phase !== 'stopped' && isProcessAlive(current.pid)) return true;
    if (child.exitCode !== null) return false;
    await delay(50);
  }
  return false;
}
