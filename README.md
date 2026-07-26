# a2ab

여러 터미널에서 각자 돌고 있는 코딩 에이전트 세션(Claude Code 등)이 서로를 **발견하고 메시지를 주고받게** 해주는 로컬 브로커입니다.

세션 레지스트리 + 세션별 인박스 + 턴 경계 전달(turn-boundary delivery)로 구성되며, 상태는 머신 로컬 파일(`~/.a2ab`)에 저장됩니다.

- **peers** — 지금 살아 있는 다른 세션과, 나와 같은 파일을 건드리는 세션(충돌 후보) 조회
- **inbox** — 나에게 온 request/notification pull
- **send** — 다른 세션에 request(응답 의무 있음) 또는 notification(통보) 전송
- **hook** — Claude Code hook에 물려 등록·하트비트·수신 주입을 자동화

## 설치

```sh
npm install -g @jaeboong/a2ab
```

설치 후 `a2ab` 명령을 쓸 수 있습니다. Node.js 20.11 이상이 필요합니다.

## 빠른 시작

### 1. Claude Code hook 연결

```sh
a2ab init
```

`~/.claude/settings.json`에 hook을 병합합니다. 기존 설정과 다른 hook은 그대로 보존하고, 덮어쓰기 전에 `settings.json.bak`으로 백업합니다. 여러 번 실행해도 중복 등록되지 않습니다.

- `--print` — 파일을 쓰지 않고 병합 결과만 출력
- `--settings <경로>` — 기본 경로(`~/.claude/settings.json`) 대신 지정

**등록 후 `claude`를 새로 띄워야 적용됩니다.** hook은 세션 시작 시점에만 읽힙니다.

<details>
<summary>수동으로 설정하려면</summary>

`~/.claude/settings.json`의 `hooks`에 아래를 추가합니다.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "a2ab hook session-start", "timeout": 15 },
          { "type": "command", "command": "a2ab hook watch", "timeout": 14400, "asyncRewake": true }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit|NotebookEdit",
        "hooks": [{ "type": "command", "command": "a2ab hook post-tool-use", "timeout": 15 }]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "a2ab hook stop", "timeout": 15 },
          { "type": "command", "command": "a2ab hook watch", "timeout": 14400, "asyncRewake": true }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "a2ab hook session-end", "timeout": 15 }]
      }
    ]
  }
}
```

</details>

각 hook의 역할:

- `session-start` — 세션을 레지스트리에 등록하고, 에이전트에게 사용법을 컨텍스트로 주입합니다.
- `post-tool-use` — 파일 수정 시 touching path를 기록해 다른 세션과의 충돌을 감지합니다.
- `stop` — 턴이 끝나는 시점에 인박스를 확인해 대기 중인 request를 주입합니다.
- `watch` — 백그라운드로 인박스를 감시하다 request가 도착하면 세션을 깨웁니다.

### 2. 확인

터미널 두 개에서 각각 Claude Code를 띄운 뒤:

```sh
a2ab status
```

### 3. 주고받기

```sh
a2ab peers  --session <내 세션 id 또는 이름>
a2ab send   --from <나> --to <상대> --kind request --text "src/auth.ts 잠깐 건드리지 말아줘"
a2ab inbox  --session <내 세션 id 또는 이름>
```

`--to`에는 세션 id 대신 표시 이름을 쓸 수 있습니다(이름이 중복되면 에러).

## CLI

| 명령 | 설명 |
| --- | --- |
| `a2ab init [--print] [--settings <경로>]` | Claude Code hook 설정 병합 |
| `a2ab register --name <이름> [--session-id <id>] [--provider <p>] [--cwd <경로>] [--task <설명>] [--branch <브랜치>]` | 세션 수동 등록 |
| `a2ab status` | 레지스트리 전체 상태 |
| `a2ab peers --session <id\|이름>` | 살아 있는 다른 세션 + 나와의 파일 충돌 |
| `a2ab inbox --session <id\|이름>` | 대기 중인 메시지 pull |
| `a2ab send --from <id\|이름> --to <id\|이름> --kind request\|notification --text "..."` | 메시지 전송 |
| `a2ab touch --session <id\|이름> <경로...>` | 작업 중인 경로 등록 |
| `a2ab hook <event>` | hook 진입점 (`session-start`, `stop`, `post-tool-use`, `session-end`, `watch`) |

`send`의 선택 옵션: `--origin human|agent`, `--context <id>`, `--reply-to <messageId>`, `--idempotency-key <key>`, `--ttl <초>`(notification), `--deadline <초>`(request).

모든 명령은 JSON을 stdout으로 출력합니다.

## 메시지 종류

- **request** — 응답 의무가 있는 요청. 턴 경계에서 수신 세션에 주입되고, `--deadline`(기본 300초) 내에 소비되지 않으면 만료됩니다.
- **notification** — 턴을 새로 발생시키지 않는 통보. `--ttl`(기본 3600초) 동안 인박스에 남습니다.

## 저장 위치

기본값은 `~/.a2ab/` 이며 `A2AB_HOME` 환경변수로 바꿀 수 있습니다.

```text
~/.a2ab/
  registry.json      # 세션 레지스트리
  inbox/<id>.json    # 세션별 인박스
  audit.jsonl        # 감사 로그
```

## 범위와 한계

- **한 머신 안에서만 동작합니다.** 저장소가 로컬 파일시스템이라, 서로 다른 서버의 세션은 발견되지 않습니다. 여러 머신을 묶으려면 `A2AB_HOME`을 공유 파일시스템으로 지정해야 하는데, 원자적 rename 보장이 파일시스템에 따라 달라 권장하지 않습니다. 네트워크 전송 계층은 아직 없습니다.
- 인증·인가 계층이 없습니다. 같은 머신의 같은 사용자 계정을 신뢰 경계로 가정합니다.
- 수신 메시지는 **검증되지 않은 외부 입력**입니다. 에이전트가 그 안의 지시를 무조건 따르지 않도록 하세요.

## 라이선스

MIT
