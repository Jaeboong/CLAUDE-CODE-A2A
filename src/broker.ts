// 브로커 코어: 등록·발견·전달·턴 경계 소비.
// 허용된 책임(핸드오프 6.3)만 수행하며 판단(6.4)은 하지 않는다.

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_NOTIFICATION_TTL_SECONDS,
  DEFAULT_REQUEST_DEADLINE_SECONDS,
  orderRequests,
} from './protocol.js';
import type {
  InboxItem,
  InboxResult,
  MessageKind,
  MessageOrigin,
  MessagePart,
  PathConflict,
  PeersResult,
  SessionRecord,
  SessionStatus,
  StoredMessage,
} from './protocol.js';
import { Store } from './store.js';

export interface RegisterSessionInput {
  readonly sessionId: string;
  readonly provider: string;
  readonly displayName: string;
  readonly cwd: string;
  readonly currentTask?: string;
  readonly branch?: string;
}

export interface HeartbeatPatch {
  readonly branch?: string;
  readonly currentTask?: string;
  readonly status?: SessionStatus;
}

export interface SendInput {
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly kind: MessageKind;
  readonly origin: MessageOrigin;
  readonly text?: string;
  readonly parts?: ReadonlyArray<MessagePart>;
  readonly contextId?: string;
  readonly replyToMessageId?: string;
  readonly idempotencyKey?: string;
  readonly ttlSeconds?: number;
  readonly deadlineSeconds?: number;
}

export interface SendResult {
  readonly delivered: boolean;
  readonly deduped: boolean;
  readonly messageId: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

// 비교용 경로 키. Windows에서는 대소문자를 무시한다. 표시용 원본은 보존한다.
function pathKey(p: string): string {
  const normalized = p.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function toInboxItem(m: StoredMessage): InboxItem {
  return {
    messageId: m.messageId,
    kind: m.kind,
    origin: m.origin,
    fromSessionId: m.fromSessionId,
    contextId: m.contextId,
    ...(m.taskId === undefined ? {} : { taskId: m.taskId }),
    ...(m.replyToMessageId === undefined ? {} : { replyToMessageId: m.replyToMessageId }),
    parts: m.parts,
    createdAt: m.createdAt,
    ...(m.deadlineAt === undefined ? {} : { deadlineAt: m.deadlineAt }),
  };
}

function isRequestExpired(m: StoredMessage, now: string): boolean {
  return m.deadlineAt !== undefined && m.deadlineAt <= now;
}

function isNotificationExpired(m: StoredMessage, now: string): boolean {
  const ttl = m.ttlSeconds ?? DEFAULT_NOTIFICATION_TTL_SECONDS;
  const expiresAtMs = Date.parse(m.createdAt) + ttl * 1000;
  return Date.parse(now) >= expiresAtMs;
}

export class Broker {
  private readonly store: Store;

  constructor(rootDir: string) {
    this.store = new Store(rootDir);
  }

  hasSession(sessionId: string): boolean {
    return this.store.readSessions()[sessionId] !== undefined;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.store.readSessions()[sessionId];
  }

  listSessions(): ReadonlyArray<SessionRecord> {
    return Object.values(this.store.readSessions());
  }

  registerSession(input: RegisterSessionInput): SessionRecord {
    return this.store.transaction(() => this.registerSessionUnlocked(input));
  }

  private registerSessionUnlocked(input: RegisterSessionInput): SessionRecord {
    const sessions = { ...this.store.readSessions() };
    const existing = sessions[input.sessionId];
    const now = nowIso();
    const record: SessionRecord = {
      sessionId: input.sessionId,
      provider: input.provider,
      displayName: input.displayName,
      projectId: pathKey(input.cwd),
      cwd: input.cwd,
      status: 'active',
      ...(input.currentTask === undefined ? {} : { currentTask: input.currentTask }),
      touchingPaths: existing?.touchingPaths ?? [],
      ...(input.branch === undefined
        ? existing?.branch === undefined
          ? {}
          : { branch: existing.branch }
        : { branch: input.branch }),
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
    };
    sessions[input.sessionId] = record;
    this.store.writeSessions(sessions);
    this.store.appendAudit({
      actor: input.sessionId,
      action: existing === undefined ? 'session.register' : 'session.reregister',
      resourceType: 'session',
      resourceId: input.sessionId,
    });
    return record;
  }

  markOffline(sessionId: string): void {
    this.patchSession(sessionId, { status: 'offline' });
    this.store.appendAudit({
      actor: sessionId,
      action: 'session.offline',
      resourceType: 'session',
      resourceId: sessionId,
    });
  }

  heartbeat(sessionId: string, patch: HeartbeatPatch = {}): void {
    this.patchSession(sessionId, patch);
  }

  addTouchingPaths(sessionId: string, paths: ReadonlyArray<string>): void {
    this.store.transaction(() => this.addTouchingPathsUnlocked(sessionId, paths));
  }

  private addTouchingPathsUnlocked(sessionId: string, paths: ReadonlyArray<string>): void {
    const sessions = { ...this.store.readSessions() };
    const record = sessions[sessionId];
    if (record === undefined) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    const known = new Set(record.touchingPaths.map(pathKey));
    const added = paths.filter((p) => !known.has(pathKey(p)));
    if (added.length === 0) {
      return;
    }
    sessions[sessionId] = {
      ...record,
      touchingPaths: [...record.touchingPaths, ...added],
      lastSeenAt: nowIso(),
    };
    this.store.writeSessions(sessions);
  }

  peers(selfSessionId: string): PeersResult {
    const sessions = this.store.readSessions();
    const self = sessions[selfSessionId];
    if (self === undefined) {
      throw new Error(`unknown session: ${selfSessionId}`);
    }
    const peers = Object.values(sessions)
      .filter((s) => s.sessionId !== selfSessionId)
      .map((s) => ({ ...s, conflictsWithMe: computeConflicts(self, s) }));
    return { selfSessionId, peers };
  }

  send(input: SendInput): SendResult {
    return this.store.transaction(() => this.sendUnlocked(input));
  }

  private sendUnlocked(input: SendInput): SendResult {
    if (input.fromSessionId === input.toSessionId) {
      throw new Error('self-send is not allowed');
    }
    if (!this.hasSession(input.fromSessionId)) {
      throw new Error(`unknown sender session: ${input.fromSessionId}`);
    }
    if (!this.hasSession(input.toSessionId)) {
      throw new Error(`unknown recipient session: ${input.toSessionId}`);
    }

    const inbox = this.store.readInbox(input.toSessionId);
    const idempotencyKey = input.idempotencyKey ?? randomUUID();
    const duplicate = inbox.find((m) => m.idempotencyKey === idempotencyKey);
    if (duplicate !== undefined) {
      return { delivered: true, deduped: true, messageId: duplicate.messageId };
    }

    const now = nowIso();
    const parts: ReadonlyArray<MessagePart> =
      input.parts ?? [{ type: 'text', text: input.text ?? '' }];
    const message: StoredMessage = {
      messageId: randomUUID(),
      kind: input.kind,
      origin: input.origin,
      fromSessionId: input.fromSessionId,
      toSessionId: input.toSessionId,
      contextId: input.contextId ?? randomUUID(),
      ...(input.kind === 'request' ? { taskId: randomUUID() } : {}),
      ...(input.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: input.replyToMessageId }),
      parts,
      idempotencyKey,
      ...(input.kind === 'request'
        ? {
            deadlineAt: new Date(
              Date.parse(now) +
                (input.deadlineSeconds ?? DEFAULT_REQUEST_DEADLINE_SECONDS) * 1000,
            ).toISOString(),
          }
        : { ttlSeconds: input.ttlSeconds ?? DEFAULT_NOTIFICATION_TTL_SECONDS }),
      createdAt: now,
      deliveryStatus: input.kind === 'request' ? 'pending' : 'enqueued',
    };

    this.store.writeInbox(input.toSessionId, [...inbox, message]);
    this.store.appendAudit({
      actor: input.fromSessionId,
      action: `message.send.${input.kind}`,
      resourceType: 'message',
      resourceId: message.messageId,
      metadata: { to: input.toSessionId, origin: input.origin },
    });
    return { delivered: true, deduped: false, messageId: message.messageId };
  }

  inbox(sessionId: string): InboxResult {
    return this.store.transaction(() => this.inboxUnlocked(sessionId));
  }

  private inboxUnlocked(sessionId: string): InboxResult {
    const { requests, notifications } = this.sweepInbox(sessionId);
    return {
      sessionId,
      pendingRequests: orderRequests(requests).map(toInboxItem),
      notifications: notifications.map(toInboxItem),
    };
  }

  // 턴 경계 소비: pending request를 정확히 한 번만 반환하고 consumed로 마킹한다.
  popRequests(sessionId: string): ReadonlyArray<InboxItem> {
    return this.store.transaction(() => this.popRequestsUnlocked(sessionId));
  }

  private popRequestsUnlocked(sessionId: string): ReadonlyArray<InboxItem> {
    const { requests } = this.sweepInbox(sessionId);
    if (requests.length === 0) {
      return [];
    }
    const now = nowIso();
    const poppedIds = new Set(requests.map((m) => m.messageId));
    const updated = this.store
      .readInbox(sessionId)
      .map((m) =>
        poppedIds.has(m.messageId)
          ? { ...m, deliveryStatus: 'consumed' as const, consumedAt: now }
          : m,
      );
    this.store.writeInbox(sessionId, updated);
    for (const m of requests) {
      this.store.appendAudit({
        actor: sessionId,
        action: 'message.consume',
        resourceType: 'message',
        resourceId: m.messageId,
      });
    }
    return orderRequests(requests).map(toInboxItem);
  }

  // 세션 계층 표시용: 아직 표시 안 된 notification을 한 번만 반환하고 acked로 마킹한다.
  // acked 후에도 TTL 내에는 inbox() pull에 계속 포함된다 (프로토콜 2.1/2.2).
  ackNotifications(sessionId: string): ReadonlyArray<InboxItem> {
    return this.store.transaction(() => this.ackNotificationsUnlocked(sessionId));
  }

  private ackNotificationsUnlocked(sessionId: string): ReadonlyArray<InboxItem> {
    const { notifications } = this.sweepInbox(sessionId);
    const fresh = notifications.filter((m) => m.deliveryStatus === 'enqueued');
    if (fresh.length === 0) {
      return [];
    }
    const now = nowIso();
    const freshIds = new Set(fresh.map((m) => m.messageId));
    const updated = this.store
      .readInbox(sessionId)
      .map((m) =>
        freshIds.has(m.messageId)
          ? { ...m, deliveryStatus: 'acked' as const, ackedAt: now }
          : m,
      );
    this.store.writeInbox(sessionId, updated);
    return fresh.map(toInboxItem);
  }

  private patchSession(sessionId: string, patch: HeartbeatPatch): void {
    this.store.transaction(() => this.patchSessionUnlocked(sessionId, patch));
  }

  private patchSessionUnlocked(sessionId: string, patch: HeartbeatPatch): void {
    const sessions = { ...this.store.readSessions() };
    const record = sessions[sessionId];
    if (record === undefined) {
      throw new Error(`unknown session: ${sessionId}`);
    }
    sessions[sessionId] = {
      ...record,
      ...(patch.branch === undefined ? {} : { branch: patch.branch }),
      ...(patch.currentTask === undefined ? {} : { currentTask: patch.currentTask }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      lastSeenAt: nowIso(),
    };
    this.store.writeSessions(sessions);
  }

  // 만료 처리(request timeout, notification TTL)를 반영하고 살아있는 메시지를 분류한다.
  private sweepInbox(sessionId: string): {
    requests: ReadonlyArray<StoredMessage>;
    notifications: ReadonlyArray<StoredMessage>;
  } {
    const now = nowIso();
    const messages = this.store.readInbox(sessionId);
    let dirty = false;

    const updated = messages.map((m) => {
      if (m.kind === 'request' && m.deliveryStatus === 'pending' && isRequestExpired(m, now)) {
        dirty = true;
        this.store.appendAudit({
          actor: 'broker',
          action: 'message.timeout',
          resourceType: 'message',
          resourceId: m.messageId,
        });
        return { ...m, deliveryStatus: 'failed-timeout' as const };
      }
      if (
        m.kind === 'notification' &&
        (m.deliveryStatus === 'enqueued' || m.deliveryStatus === 'acked') &&
        isNotificationExpired(m, now)
      ) {
        dirty = true;
        return { ...m, deliveryStatus: 'expired' as const };
      }
      return m;
    });

    if (dirty) {
      this.store.writeInbox(sessionId, updated);
    }

    return {
      requests: updated.filter((m) => m.kind === 'request' && m.deliveryStatus === 'pending'),
      notifications: updated.filter(
        (m) =>
          m.kind === 'notification' &&
          (m.deliveryStatus === 'enqueued' || m.deliveryStatus === 'acked'),
      ),
    };
  }
}

// 충돌 판정 (프로토콜 8.1). overlapping-dir은 스파이크 범위 밖 — 소음 대비 가치 실측 후 추가.
function computeConflicts(self: SessionRecord, other: SessionRecord): ReadonlyArray<PathConflict> {
  const conflicts: PathConflict[] = [];

  const otherPaths = new Map(other.touchingPaths.map((p) => [pathKey(p), p]));
  for (const mine of self.touchingPaths) {
    if (otherPaths.has(pathKey(mine))) {
      conflicts.push({ path: mine, kind: 'same-file' });
    }
  }

  if (
    self.branch !== undefined &&
    other.branch !== undefined &&
    self.branch === other.branch &&
    self.projectId === other.projectId
  ) {
    conflicts.push({ path: `${self.projectId}@${self.branch}`, kind: 'same-branch' });
  }

  return conflicts;
}
