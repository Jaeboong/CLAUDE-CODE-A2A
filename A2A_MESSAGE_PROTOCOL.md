# A2A 메시지 전달 프로토콜 — 초안

갱신: 2026-07-25
상태: 설계 확정 항목 + 미결정 항목 분리
관계: [A2A_BROKER_HANDOFF.md](./A2A_BROKER_HANDOFF.md)의 4.1-5, 10, 11절을 구체화한다.

## 0. 이 문서가 정하는 것

핸드오프 문서는 "새 메시지가 오면 새 턴을 발생시킨다"(요구사항 5)까지만 정했다.
이 문서는 **어떤 메시지가 턴을 발생시키고, 어떤 메시지는 발생시키지 않는지**를 프로토콜 1급 개념으로 고정한다.

핵심 전제: 하나의 세션은 두 계층으로 나뉜다.

- **에이전트 계층(agent)**: 모델의 턴 루프. 여기에 도착하면 모델이 턴을 소비한다.
- **세션 계층(session)**: 프로세스 + UI + 사람 + 감사 로그. 여기에 도착해도 모델은 턴을 쓰지 않는다.

## 1. 메시지 종류 — Sender가 지정

봉투에 필드 하나로 종류를 구분한다. Sender가 설정한다.

```ts
type MessageKind = 'request' | 'notification';
```

- `request`: 응답이 필요하다. 수신자의 **에이전트 계층**에 전달되어 턴을 발생시킨다.
- `notification`: 통보다. 수신자의 **세션 계층**에만 즉시 도달하고, 에이전트 턴은 발생시키지 않는다.

## 2. 전달 의미 (확정)

| | request (응답 필요) | notification (통보) |
| --- | --- | --- |
| 도착 계층 | 에이전트 턴 루프 | 세션 계층(사람/로그) + 인박스 |
| 턴 발생 | O — 턴 경계에서 자동 소비, 응답 생성 | X — 모델이 턴을 쓰지 않음 |
| 수신 모델이 보는 시점 | 다음 턴 경계에서 강제 | 다음 자발적 `inbox()`/`peers()` 호출 때만 (pull) |
| Task 수명주기 | 생성 (submitted→working→completed…) | 없음, fire-and-forget |
| Sender가 받는 것 | delivery receipt + 응답(또는 timeout) | delivery receipt("확인")만 |
| 오프라인 수신자 | 무기한 durable 큐 | TTL 있는 큐, 만료 시 폐기 |

### 2.1 확정된 규칙: notification = pull 가능 · push 불가

notification은 수신자 인박스에 **적재는 되지만 턴을 강제로 발생시키지 않는다.**

- push(턴 강제) = 방해 → 하지 않는다.
- pull(자발적 조회) = 방해 아님 → 허용한다.

즉 수신자의 모델은 다음에 스스로 `inbox()` 또는 `peers()`를 호출할 때 notification을 본다.
이 규칙 덕분에 **충돌 회피 정보**("나 지금 `auth.ts` 건드리는 중")가 모델의 턴을 낭비하지 않으면서도 수신자에게 도달한다.

### 2.2 확정된 규칙: "확인"은 응답이 아니라 표시다

notification 수신 시 세션에 나오는 "확인" 줄은 **모델의 응답이 아니라 UI/hook의 프린트**다.
모델이 "확인했다"고 응답하면 그것은 턴을 쓴 것이므로 2.1 규칙에 위배된다.
따라서 확인은 모델이 모르는, 사람과 감사 로그만을 위한 출력이다.

"확인"은 두 곳에 있다.

- **Sender 쪽**: `send(kind: 'notification')` 도구가 `{ delivered: true }`를 반환한다. 보낸 세션이 전달 성공을 안다.
- **Receiver 쪽**: 수신 세션 hook이 터미널에 한 줄을 찍는다. 예: `📩 notification from codex-2: "auth.ts 리팩터링 시작"`. 모델 턴 없이 사람만 본다.

둘 다 모델 턴을 소비하지 않는다.

## 3. 메시지 봉투

```ts
interface A2AMessage {
  readonly messageId: string;
  readonly kind: MessageKind;
  readonly origin: 'human' | 'agent';  // 우선순위 판정용 (7.1)
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly contextId: string;          // 다중 턴 스레드 연결
  readonly taskId?: string;            // request일 때만 (수명주기 있는 작업)
  readonly replyToMessageId?: string;  // 응답일 때 원본 참조
  readonly parts: ReadonlyArray<MessagePart>;
  readonly idempotencyKey: string;
  readonly deadlineAt?: string;        // request일 때 응답 마감 (ISO8601)
  readonly ttlSeconds?: number;        // notification일 때 인박스 유효기간
  readonly createdAt: string;
}
```

`MessagePart`는 A2A 표준 Part(텍스트, 파일 참조, 구조화 데이터)를 따른다. 비밀정보·전체 파일 본문은 넣지 않는다(핸드오프 12절).

## 4. 턴 경계 소비 메커니즘

request만 턴을 발생시킨다. 수신 세션이 사람이 직접 쓰는 터미널이면, 외부에서 즉시 턴을 주입하지 않는다(키 입력 주입 금지). 대신:

1. request 도착 → 수신자 인박스에 durable 적재.
2. 수신 세션의 **턴 경계**(예: Claude Code `Stop` hook)에서 인박스를 확인.
3. request가 있으면 그 턴을 이어가 응답을 생성.

즉 "도착 = 즉시 턴"이 아니라 **"도착 = 다음 턴 경계에서의 턴"**이다. 세션이 켜져 능동적으로 작업 중이면 지연은 무시할 수준이다.

notification은 이 hook 소비 대상이 **아니다.** 조용히 쌓이고, 세션 UI에 "확인" 한 줄과 감사 로그만 남긴다.

## 5. 곁가지 규칙 (확정)

- **응답(reply)의 kind**: request에 대한 응답은 `request`로 보내되 `replyToMessageId`를 지정한다.
  - notification으로 보내면 요청자가 턴을 못 받아 후속 작업을 재개하지 못한다.
  - 순수 request로 보내면 "응답 의무" 때문에 무한 왕복이 생긴다.
  - 따라서 `replyToMessageId`가 있는 request는 **수신자를 깨우되 응답 의무를 면제**한다. 이것이 왕복 루프의 종단점이다.
  - 상대를 깨울 필요가 없는 단순 FYI 응답은 notification으로 보내도 된다.
- **notification 응답 승격**: 수신자가 notification을 읽고 굳이 응답하고 싶으면 허용한다. 단 의무가 아니다. 승격 시 새 `request`(또는 응답 메시지)를 스스로 생성한다.
- **request timeout**: `deadlineAt`을 넘기면 Task를 `failed(timeout)`로 전이하고 Sender에게 통보한다. 없으면 Sender가 영원히 대기한다.
- **notification TTL**: 오프라인 수신자에게 쌓인 notification은 `ttlSeconds` 만료 시 폐기한다. request는 무기한 durable.
- **멱등성**: 두 종류 모두 `idempotencyKey` 재전송은 중복 실행·중복 적재하지 않는다(핸드오프 10절).
- **신뢰 경계**: 수신 메시지는 명령이 아니라 검증되지 않은 외부 입력으로 취급한다(핸드오프 11, 12절). notification도 동일.

## 6. 상태 흐름

request는 핸드오프 10절 수명주기를 따른다.

```text
submitted → working → completed
                 ├→ input-required → working
                 ├→ auth-required  → working
                 ├→ failed / rejected / cancelled
                 └→ failed(timeout)   // deadlineAt 초과
```

notification은 수명주기가 없다. 전달 상태만 기록한다.

```text
enqueued → acked            // 세션 계층 확인
        └→ expired          // TTL 초과, pull 전에 폐기
        └→ pulled           // 수신 모델이 자발적으로 조회 (선택적)
```

## 7. 큐·우선순위·기본값 (확정)

### 7.1 동시 request 처리 순서

한 세션이 여러 request를 받고 다음 턴 경계에 도달했을 때, 인박스는 다음 순서로 정렬한다.

1. `origin === 'human'` 인 request 먼저 (사람이 요청한 작업 우선)
2. 그다음 `createdAt` 오름차순 = 선입선출(FIFO)

```ts
function orderRequests(items: ReadonlyArray<A2AMessage>): ReadonlyArray<A2AMessage> {
  const rank = (m: A2AMessage): number => (m.origin === 'human' ? 0 : 1);
  return [...items].sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
}
```

턴 경계에서는 정렬된 순서대로 request를 소비한다. 한 턴에 여러 건을 배치 처리해도 되지만, 사람 request가 항상 앞선다.

notification은 이 순서 규칙과 무관하다 — 턴을 발생시키지 않으므로 경쟁하지 않는다.

### 7.2 확정된 기본값

정책은 설정으로 덮어쓸 수 있으나, 미지정 시 기본값은 다음과 같다.

- notification 기본 `ttlSeconds`: `3600` (1시간). 조율 정보는 오래되면 무의미하므로 짧게.
- request 기본 `deadlineAt`: 생성 + `300`초 (5분). skill별 차등은 이후 확장.
- 오프라인 request는 기본 무기한 durable (deadline 도달 시에만 `failed(timeout)`).

## 8. 도구 반환 스키마 (확정)

에이전트가 호출하는 두 pull 도구. 둘 다 모델 턴을 발생시키지 않고 자발적 조회에만 쓰인다.

### 8.1 `peers()` — 살아있는 세션 + 충돌

```ts
interface PathConflict {
  readonly path: string;
  readonly kind: 'same-file' | 'same-branch' | 'overlapping-dir';
}

interface PeerSession {
  readonly sessionId: string;
  readonly provider: string;                        // 'claude' | 'codex' | ...
  readonly displayName: string;
  readonly projectId: string;
  readonly cwd: string;
  readonly status: 'active' | 'idle' | 'offline';
  readonly currentTask?: string;                    // self-report 작업 요약
  readonly touchingPaths: ReadonlyArray<string>;    // 건드리는 중인 경로 (정규화 절대경로)
  readonly branch?: string;
  readonly lastSeenAt: string;
  readonly conflictsWithMe: ReadonlyArray<PathConflict>;  // 나와 겹치는 부분
}

interface PeersResult {
  readonly selfSessionId: string;
  readonly peers: ReadonlyArray<PeerSession>;
}
```

`conflictsWithMe`가 비어 있지 않은 peer가 곧 "얘랑 상황 공유해야 하나?" 후보다.

### 8.2 `inbox()` — 대기 중인 메시지

```ts
interface InboxItem {
  readonly messageId: string;
  readonly kind: MessageKind;
  readonly origin: 'human' | 'agent';
  readonly fromSessionId: string;
  readonly contextId: string;
  readonly taskId?: string;
  readonly parts: ReadonlyArray<MessagePart>;
  readonly createdAt: string;
  readonly deadlineAt?: string;
}

interface InboxResult {
  readonly sessionId: string;
  readonly pendingRequests: ReadonlyArray<InboxItem>;  // 7.1 순서로 정렬됨
  readonly notifications: ReadonlyArray<InboxItem>;     // TTL 유효한 통보만
}
```

`pendingRequests`는 이미 7.1 규칙으로 정렬되어 반환된다. `notifications`는 TTL이 살아있는 것만 포함하고, pull 시점에 만료된 것은 빠진다.

## 9. 미결정 (다음에 정할 것)

- request `deadlineAt`의 skill별 차등 정책 (현재는 일괄 300초).
- 하나의 request를 한 턴에 몇 건까지 배치 소비할지 상한 (현재는 전부 배치 소비).

### 9.1 해소된 미결정

- **`touchingPaths` 수집** (2026-07-25 확정): `PostToolUse` hook(Write|Edit|NotebookEdit)으로 편집 이벤트를 자동 수집한다. 스파이크로 검증됨. 세션 self-report(`a2ab touch`)는 보조 수단. Git worktree 스캔은 채택하지 않음.
- **"확인" 표시 채널** (2026-07-25 확정): 2.2절 참조 — hook의 `systemMessage`(수신측) + `send` 반환값(송신측).
- **동시 request 순서** (2026-07-25 확정): 7.1절 — 사람 우선, 그다음 FIFO.
