# Codex CLI idle 수신 검증

검증일: 2026-09-15. macOS arm64, Codex CLI 0.154.0, Node 24.14.0.

## 확인된 동작

`codex queue --thread <UUID> --message <text>`는 동일한 `CODEX_HOME`의 열린
Codex CLI에 메시지를 넣는다. idle TUI에서 새 턴이 시작되고 응답이 출력되는 것을 확인했다.
단독 stdio App Server에 대해서는 큐 제출만 성공하고 자동으로 새 턴이 시작되지 않았다.
따라서 이 어댑터는 열린 로컬 Codex CLI를 대상으로 한다.

일반 비동기 hook 완료는 idle 상태의 새 턴을 만들지 않는다.
[공식 hook 문서](https://learn.chatgpt.com/docs/hooks#how-background-hooks-run)를 참고한다.
`codex queue`의 구체적인 계약은 설치된 CLI의 `codex queue --help`로 확인했다.

## 실측 절차와 결과

실제 계정과 분리한 임시 `CODEX_HOME`/`A2AB_HOME`을 사용했다. 모델 공급자는
127.0.0.1의 고정 응답 SSE 서버로 설정하여 외부 모델 요청과 실제 작업을 수행하지 않았다.

1. 실제 `codex --no-alt-screen` TUI에서 초기 응답 완료 후 idle 상태 확인.
2. 별도 프로세스의 `codex queue` 호출 → TUI의 새 턴 시작과 고정 응답 확인.
3. 새 a2ab의 `hook session-start --provider codex` 호출 → detached watcher와
   `status.codexWake.running=true` 확인.
4. 격리된 A2A inbox에 request 적재 → watcher의 큐 신호 접수 기록, TUI의 새 턴과 응답 확인.
5. `receive`로 원문 한 번 반환, 두 번째 호출은 빈 결과 확인.
6. `hook session-end` → 감시자가 `stopped`, `running=false`로 종료됨을 확인.

실측의 모델 응답은 stub이다. 실제 모델의 요청 해석·답변 품질을 검증한 것은 아니다.
기존 Stop 소비와의 경합, 전송 실패, 재시작 시 신호 중복 방지, notification/만료 제외,
부모 종료, 다중 프로세스의 120건 동시 전송·소비는 자동 테스트로 검증한다.

## 전달 보장

큐에는 본문 대신 `receive`를 안내하는 신호만 보낸다. 큐 접수 오류/timeout 시
실제 request는 pending 상태로 남는다. 성공한 신호의 ID를 저장하고 재기동 시 재사용한다.
큐 접수와 로컬 기록 사이의 충돌/응답 유실은 신호를 중복시킬 수 있다.
본문 소비는 `Stop`/`receive`의 공통 파일 잠금으로 직렬화하며, 모델 처리 완료 보장과는 다르다.
