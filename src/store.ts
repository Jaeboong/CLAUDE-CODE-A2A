// 파일 기반 영속 저장소 (스파이크 단계).
// - 머신 전역 상태를 담당하며, 쓰기는 temp+rename으로 원자적으로 수행한다.
// - SQLite 전환 시 이 모듈만 교체한다 (핸드오프 14절: 저장 계층 인터페이스 분리).

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './lock.js';

import type { SessionRecord, StoredMessage } from './protocol.js';

interface RegistryFile {
  readonly sessions: Readonly<Record<string, SessionRecord>>;
}

interface InboxFile {
  readonly messages: ReadonlyArray<StoredMessage>;
}

const EMPTY_REGISTRY: RegistryFile = { sessions: {} };
const EMPTY_INBOX: InboxFile = { messages: [] };

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmpPath, filePath);
}

export class Store {
  private readonly rootDir: string;
  private inTransaction = false;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  transaction<T>(operation: () => T): T {
    if (this.inTransaction) return operation();
    return withFileLock(this.rootDir, '.broker-lock', () => {
      this.inTransaction = true;
      try { return operation(); } finally { this.inTransaction = false; }
    });
  }

  private registryPath(): string {
    return join(this.rootDir, 'registry.json');
  }

  private inboxPath(sessionId: string): string {
    // sessionId는 UUID 또는 우리가 만든 id라 경로 안전성 검사만 최소로 한다.
    const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(this.rootDir, 'inbox', `${safe}.json`);
  }

  readSessions(): Readonly<Record<string, SessionRecord>> {
    return readJson(this.registryPath(), EMPTY_REGISTRY).sessions;
  }

  writeSessions(sessions: Readonly<Record<string, SessionRecord>>): void {
    writeJsonAtomic(this.registryPath(), { sessions } satisfies RegistryFile);
  }

  readInbox(sessionId: string): ReadonlyArray<StoredMessage> {
    return readJson(this.inboxPath(sessionId), EMPTY_INBOX).messages;
  }

  writeInbox(sessionId: string, messages: ReadonlyArray<StoredMessage>): void {
    writeJsonAtomic(this.inboxPath(sessionId), { messages } satisfies InboxFile);
  }

  appendAudit(event: Readonly<Record<string, unknown>>): void {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    const auditPath = join(this.rootDir, 'audit.jsonl');
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, line, 'utf8');
  }
}
