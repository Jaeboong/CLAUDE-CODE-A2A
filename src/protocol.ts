// A2A_MESSAGE_PROTOCOL.md의 타입을 코드로 고정한다.
// 이 파일은 wire contract이며 브로커/어댑터 구현에 의존하지 않는다.

export type MessageKind = 'request' | 'notification';

export type MessageOrigin = 'human' | 'agent';

export type MessagePart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'data'; readonly data: Readonly<Record<string, unknown>> }
  | { readonly type: 'file'; readonly path: string; readonly note?: string };

export interface A2AMessage {
  readonly messageId: string;
  readonly kind: MessageKind;
  readonly origin: MessageOrigin;
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly contextId: string;
  readonly taskId?: string;
  readonly replyToMessageId?: string;
  readonly parts: ReadonlyArray<MessagePart>;
  readonly idempotencyKey: string;
  readonly deadlineAt?: string;
  readonly ttlSeconds?: number;
  readonly createdAt: string;
}

// 저장 시 전달 상태를 함께 기록한다 (프로토콜 6절).
export type RequestDeliveryStatus = 'pending' | 'consumed' | 'failed-timeout';
export type NotificationDeliveryStatus = 'enqueued' | 'acked' | 'expired';

export interface StoredMessage extends A2AMessage {
  readonly deliveryStatus: RequestDeliveryStatus | NotificationDeliveryStatus;
  readonly ackedAt?: string;
  readonly consumedAt?: string;
}

export type SessionStatus = 'active' | 'idle' | 'offline';

export interface SessionRecord {
  readonly sessionId: string;
  readonly provider: string;
  readonly displayName: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly status: SessionStatus;
  readonly currentTask?: string;
  readonly touchingPaths: ReadonlyArray<string>;
  readonly branch?: string;
  readonly registeredAt: string;
  readonly lastSeenAt: string;
}

export interface PathConflict {
  readonly path: string;
  readonly kind: 'same-file' | 'same-branch' | 'overlapping-dir';
}

export interface PeerSession extends SessionRecord {
  readonly conflictsWithMe: ReadonlyArray<PathConflict>;
}

export interface PeersResult {
  readonly selfSessionId: string;
  readonly peers: ReadonlyArray<PeerSession>;
}

export interface InboxItem {
  readonly messageId: string;
  readonly kind: MessageKind;
  readonly origin: MessageOrigin;
  readonly fromSessionId: string;
  readonly contextId: string;
  readonly taskId?: string;
  readonly replyToMessageId?: string;
  readonly parts: ReadonlyArray<MessagePart>;
  readonly createdAt: string;
  readonly deadlineAt?: string;
}

export interface InboxResult {
  readonly sessionId: string;
  readonly pendingRequests: ReadonlyArray<InboxItem>;
  readonly notifications: ReadonlyArray<InboxItem>;
}

// 프로토콜 7.2 확정 기본값.
export const DEFAULT_NOTIFICATION_TTL_SECONDS = 3600;
export const DEFAULT_REQUEST_DEADLINE_SECONDS = 300;

// 프로토콜 7.1: 사람 request 우선, 그다음 선입선출.
export function orderRequests<T extends A2AMessage>(
  items: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const rank = (m: A2AMessage): number => (m.origin === 'human' ? 0 : 1);
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.messageId.localeCompare(b.messageId),
  );
}

export function messageText(parts: ReadonlyArray<MessagePart>): string {
  return parts
    .map((p) => {
      switch (p.type) {
        case 'text':
          return p.text;
        case 'data':
          return JSON.stringify(p.data);
        case 'file':
          return `[file] ${p.path}${p.note === undefined ? '' : ` — ${p.note}`}`;
      }
    })
    .join('\n');
}
