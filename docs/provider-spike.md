# 단계 0 스파이크 결과 — 턴 경계 전달 검증

일자: 2026-07-25
환경: Windows 11, Node v24.11.0, Claude Code 2.1.215

## 검증 목표 (핸드오프 20절 재해석)

원래 핸드오프의 리스크 #1은 "오프라인 세션 깨우기"였으나, 실제 사용 흐름이
**"여러 세션을 켜두고 작업"**으로 확정되면서 검증 대상이 바뀌었다:

> 살아있는 세션에 대해, 키 입력 주입 없이 턴 경계에서 request를 소비시키고
> notification을 턴 소비 없이 표시할 수 있는가?

## 검증 결과: 성공 (시뮬레이션 레벨)

단위 테스트 31건 + CLI 스모크 테스트로 다음을 확인했다.

| 항목 | 방법 | 결과 |
| --- | --- | --- |
| 세션 자동 등록 | `SessionStart` hook → registry 기록 + `additionalContext`로 모델에 자기 id 주입 | ✅ |
| touchingPaths 자동 수집 | `PostToolUse` hook (Write\|Edit\|NotebookEdit) | ✅ |
| same-file 충돌 감지 | `peers()`의 `conflictsWithMe` | ✅ |
| same-branch 충돌 감지 | 등록 시 `git branch --show-current` best-effort | ✅ |
| request 턴 경계 소비 | `Stop` hook → `decision: "block"` + reason에 본문 주입 | ✅ |
| pop-once (무한 루프 방지) | 소비 시 원자적 `consumed` 마킹 → 2차 Stop은 통과 | ✅ |
| notification 비침투 표시 | `Stop` hook → `systemMessage`만, decision 없음 | ✅ |
| notification pull 유지 | acked 후에도 TTL 내 `inbox()`에 포함 | ✅ |
| 사람 우선 + FIFO 정렬 | `orderRequests` | ✅ |
| 멱등성 / TTL / deadline | 브로커 단위 테스트 | ✅ |
| 재시작 복구 | 새 Broker 인스턴스로 상태 재로드 | ✅ |

## 발견한 함정

1. **PowerShell 파이프 BOM**: stdin JSON 앞에 U+FEFF가 붙어 `JSON.parse` 실패.
   `readStdinJson`에서 BOM 제거로 해결. 실제 Claude Code hook은 BOM 없이 전달하지만 방어 유지.
2. **응답 kind 문제**: request의 응답을 notification으로 하면 요청자가 턴을 못 받고,
   request로 하면 무한 왕복. → `replyToMessageId` 있는 request는 "깨우되 응답 의무 면제"로 해결
   (프로토콜 5절에 반영).
3. **hook 기동 지연**: `node + tsx` 등록에 턴 경계마다 수백 ms. 스파이크에선 허용,
   본 구현에서 사전 컴파일 또는 단일 실행 파일로 개선.

## 남은 실측 (실제 세션 2개 필요)

- [ ] 실제 Claude Code 세션 2개에서 SessionStart 자동 등록 확인
- [ ] 실제 Stop hook의 `decision: block`으로 모델이 request를 처리하고 응답을 보내는지
- [ ] `systemMessage`가 사용자 터미널에 실제로 보이는지
- [ ] 사람이 프롬프트 입력 중일 때 턴 경계 소비가 안전한지 (리스크 #3)
- [ ] Codex 어댑터: 동일 프로토콜을 Codex CLI(hook 체계 상이)로 어떻게 잇는지

## 실행 방법 (실제 2세션 테스트)

```text
1. 터미널 2개에서 각각 이 디렉터리로 이동 후 `claude` 실행
   → SessionStart hook이 자동 등록, "🤝 a2ab: registered as ..." 표시
2. 세션 A에서: "peers 확인해봐" → 모델이 a2ab peers 호출, 상대 세션 발견
3. 세션 A에서: "B에게 request 보내봐: ..." → send 호출
4. 세션 B에서 아무 프롬프트나 입력해 턴을 돌리면, 턴이 끝나는 시점(Stop)에
   request가 주입되어 B가 이어서 처리 + 응답 전송
5. 상태 확인: node bin/a2ab.mjs status
```

상태 저장 위치: `%USERPROFILE%\.a2ab\` (OneDrive 밖, `A2AB_HOME`으로 변경 가능)
