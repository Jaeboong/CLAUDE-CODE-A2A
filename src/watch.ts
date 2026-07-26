// 인박스 감시자 — idle 세션 깨우기.
// Stop/SessionStart hook에서 asyncRewake로 실행되어 백그라운드에서 인박스를 감시한다.
// request가 도착하면 pop 후 exit 2 → Claude Code가 모델을 깨워 페이로드를 주입한다.
// notification은 깨우지 않는다 (프로토콜 2.1: push 불가).

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Broker } from './broker.js';
import { buildRequestInjection } from './hooks.js';

export type WatchTick = 'none' | 'popped' | 'lock-lost' | 'offline';

export interface WatchContext {
  readonly broker: Broker;
  readonly sessionId: string;
  readonly lockPath: string;
  readonly nonce: string;
}

export interface RunWatchOptions {
  readonly pollMs?: number;
  readonly maxMs?: number;
}

export interface WatchResult {
  readonly exitCode: number;
  readonly payload?: string;
}

export function watchLockPath(rootDir: string, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(rootDir, 'watch', `${safe}.lock`);
}

// 세션당 watcher는 하나만: 최신 watcher가 lock을 덮어쓰면 이전 것은 스스로 물러난다.
export function acquireLock(lockPath: string, nonce: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ nonce, pid: process.pid }), 'utf8');
}

function ownsLock(lockPath: string, nonce: string): boolean {
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce?: string };
    return lock.nonce === nonce;
  } catch {
    return false;
  }
}

export function checkOnce(ctx: WatchContext): { tick: WatchTick; payload?: string } {
  if (!ownsLock(ctx.lockPath, ctx.nonce)) {
    return { tick: 'lock-lost' };
  }
  const session = ctx.broker.getSession(ctx.sessionId);
  if (session === undefined || session.status === 'offline') {
    return { tick: 'offline' };
  }
  const requests = ctx.broker.popRequests(ctx.sessionId);
  if (requests.length > 0) {
    return {
      tick: 'popped',
      payload: buildRequestInjection(ctx.sessionId, requests, ctx.broker),
    };
  }
  return { tick: 'none' };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWatch(
  broker: Broker,
  sessionId: string,
  rootDir: string,
  opts: RunWatchOptions = {},
): Promise<WatchResult> {
  const pollMs = opts.pollMs ?? 1500;
  // hook timeout(14400s)보다 약간 짧게 스스로 종료한다.
  const maxMs = opts.maxMs ?? 14_100_000;
  const lockPath = watchLockPath(rootDir, sessionId);
  const nonce = randomUUID();
  acquireLock(lockPath, nonce);

  const ctx: WatchContext = { broker, sessionId, lockPath, nonce };
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const result = checkOnce(ctx);
    if (result.tick === 'popped') {
      return { exitCode: 2, ...(result.payload === undefined ? {} : { payload: result.payload }) };
    }
    if (result.tick === 'lock-lost' || result.tick === 'offline') {
      return { exitCode: 0 };
    }
    await sleep(pollMs);
  }
  return { exitCode: 0 };
}
