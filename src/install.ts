// a2ab init — 에이전트 CLI의 설정 파일에 hook을 병합한다.
// 설치만으로는 세션에 아무것도 주입되지 않으므로, 이 단계를 사람이 JSON을 편집해서
// 하게 두지 않는다. npm postinstall로 자동화하지 않는 이유는 --ignore-scripts로
// 조용히 건너뛰어지고, 설치가 사용자 설정을 말없이 고치는 것이 위험하기 때문이다.
//
// 타깃은 두 가지다.
// - claude: ~/.claude/settings.json. asyncRewake watch로 idle 세션까지 깨울 수 있다.
// - codex:  ~/.codex/hooks.json. 이벤트/입출력 계약은 Claude Code와 사실상 동일하지만
//           idle 깨우기는 SessionStart/Stop 핸들러가 별도 codex queue 감시자를 띄운다.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type InstallTarget = 'claude' | 'codex';

export interface HookCommand {
  readonly type: 'command';
  readonly command: string;
  readonly timeout?: number;
  readonly asyncRewake?: boolean;
  readonly statusMessage?: string;
  // codex 전용: Windows에서 command 대신 쓰이는 오버라이드.
  readonly commandWindows?: string;
}

export interface HookEntry {
  readonly matcher?: string;
  readonly hooks: ReadonlyArray<HookCommand>;
}

export interface Settings {
  readonly hooks?: Readonly<Record<string, ReadonlyArray<HookEntry>>>;
  readonly [key: string]: unknown;
}

export interface MergeResult {
  readonly settings: Settings;
  readonly added: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

export interface InstallOptions {
  readonly settingsPath?: string;
  readonly command?: string;
  readonly print?: boolean;
  readonly target?: InstallTarget;
}

export interface InstallResult {
  readonly target: InstallTarget;
  readonly settingsPath: string;
  readonly command: string;
  readonly added: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly written: boolean;
  readonly backupPath?: string;
  readonly settings?: Settings;
  // 사람이 반드시 해야 하는 후속 조치 (codex의 hook 신뢰 승인 등).
  readonly followUp?: string;
}

const HOOK_TIMEOUT_SECONDS = 15;
// watch는 다음 턴까지 인박스를 지켜보는 장기 hook이라 별도의 긴 예산을 쓴다.
const WATCH_TIMEOUT_SECONDS = 14400;

function isOnPath(bin: string): boolean {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter((dir) => dir !== '')
    .some((dir) => extensions.some((ext) => existsSync(join(dir, `${bin}${ext}`))));
}

// 전역 설치면 `a2ab`가 PATH에 있다. 저장소에서 바로 쓰는 경우엔 절대 경로로 떨어뜨린다.
export function resolveA2abCommand(): string {
  if (isOnPath('a2ab')) {
    return 'a2ab';
  }
  const binPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'a2ab.mjs');
  return `node "${binPath}"`;
}

export function defaultSettingsPath(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
  return join(configDir, 'settings.json');
}

export function defaultCodexHooksPath(): string {
  const configDir = process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
  return join(configDir, 'hooks.json');
}

export function defaultPathFor(target: InstallTarget): string {
  return target === 'codex' ? defaultCodexHooksPath() : defaultSettingsPath();
}

// Codex를 안 쓰는 환경에 ~/.codex를 새로 만들지 않기 위해, 홈이 이미 있을 때만 대상으로 잡는다.
export function codexDetected(): boolean {
  return existsSync(dirname(defaultCodexHooksPath()));
}

// 기본 동작은 자동 감지다. 설치해두고 "codex는 왜 안 붙지"로 헤매는 것이
// 가장 흔한 실패라서, 명시하지 않으면 있는 CLI에 전부 건다.
export function resolveTargets(requested?: InstallTarget | 'both'): ReadonlyArray<InstallTarget> {
  if (requested === 'both') {
    return ['claude', 'codex'];
  }
  if (requested !== undefined) {
    return [requested];
  }
  return codexDetected() ? ['claude', 'codex'] : ['claude'];
}

export function buildHookEntries(command: string): Readonly<Record<string, HookEntry>> {
  const watch: HookCommand = {
    type: 'command',
    command: `${command} hook watch`,
    timeout: WATCH_TIMEOUT_SECONDS,
    asyncRewake: true,
  };
  const hook = (event: string): HookCommand => ({
    type: 'command',
    command: `${command} hook ${event}`,
    timeout: HOOK_TIMEOUT_SECONDS,
  });

  return {
    SessionStart: { hooks: [hook('session-start'), watch] },
    PostToolUse: { matcher: 'Write|Edit|NotebookEdit', hooks: [hook('post-tool-use')] },
    Stop: {
      hooks: [
        { ...hook('stop'), statusMessage: 'a2ab: checking inter-agent inbox' },
        watch,
      ],
    },
    SessionEnd: { hooks: [hook('session-end')] },
  };
}

// Codex CLI(>=0.145)의 hooks.json. 이벤트 이름과 입출력 계약은 Claude Code와 같지만
//  - async hook 자체는 idle 턴을 시작하지 않는다. session-start/stop 핸들러가
//    codex queue 지원을 확인하고 별도의 감시자를 띄운다. 긴 동기 hook은 필요 없다.
//  - Windows에서는 commandWindows가 우선한다.
//  - SessionEnd는 종료를 붙잡지 않으려고 codex가 timeout을 3초로 강제 clamp한다.
//    더 큰 값을 쓰면 매 세션 경고가 뜨므로 상한을 그대로 쓴다.
const CODEX_SESSION_END_TIMEOUT_SECONDS = 3;

export function buildCodexHookEntries(command: string): Readonly<Record<string, HookEntry>> {
  const hook = (event: string, timeout: number, statusMessage?: string): HookCommand => {
    const line = `${command} hook ${event}`;
    return {
      type: 'command',
      command: line,
      commandWindows: line,
      timeout,
      ...(statusMessage === undefined ? {} : { statusMessage }),
    };
  };

  return {
    SessionStart: {
      hooks: [hook('session-start --provider codex', HOOK_TIMEOUT_SECONDS)],
    },
    Stop: {
      hooks: [hook('stop', HOOK_TIMEOUT_SECONDS, 'a2ab: checking inter-agent inbox')],
    },
    SessionEnd: {
      hooks: [hook('session-end', CODEX_SESSION_END_TIMEOUT_SECONDS)],
    },
  };
}

export function buildEntriesFor(
  target: InstallTarget,
  command: string,
): Readonly<Record<string, HookEntry>> {
  return target === 'codex' ? buildCodexHookEntries(command) : buildHookEntries(command);
}

function hasA2abHook(entry: HookEntry): boolean {
  return entry.hooks.some((h) => h.command.includes('a2ab') && h.command.includes('hook'));
}

export function mergeHooks(
  settings: Settings,
  entries: Readonly<Record<string, HookEntry>>,
): MergeResult {
  const nextHooks: Record<string, ReadonlyArray<HookEntry>> = {};
  for (const [event, list] of Object.entries(settings.hooks ?? {})) {
    nextHooks[event] = [...list];
  }

  const added: string[] = [];
  const skipped: string[] = [];
  for (const [event, entry] of Object.entries(entries)) {
    const current = nextHooks[event] ?? [];
    if (current.some(hasA2abHook)) {
      skipped.push(event);
      continue;
    }
    nextHooks[event] = [...current, entry];
    added.push(event);
  }

  return { settings: { ...settings, hooks: nextHooks }, added, skipped };
}

function readSettings(settingsPath: string): Settings {
  if (!existsSync(settingsPath)) {
    return {};
  }
  // Windows 편집기가 붙이는 BOM은 JSON.parse가 거부하므로 제거한다 (cli.ts의 stdin 처리와 동일).
  const raw = readFileSync(settingsPath, 'utf8').replace(/^﻿/, '');
  if (raw.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(raw) as Settings;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse ${settingsPath}: ${detail}`);
  }
}

// Codex는 관리형이 아닌 command hook을 신뢰 승인 전까지 조용히 건너뛴다.
// 파일만 써두고 "설치됐다"고 말하면 사용자는 안 되는 이유를 영원히 못 찾는다.
const CODEX_FOLLOW_UP =
  'codex를 다시 시작한 뒤 /hooks 에서 a2ab hook을 승인해야 실행된다 ' +
  '(승인 전에는 조용히 건너뛴다). codex queue를 지원하는 CLI에서는 별도 inbox watcher가 ' +
  'idle 세션을 깨운다. 미지원 버전 또는 A2AB_CODEX_WAKE=0이면 기존 Stop 전달만 사용한다. ' +
  'a2ab status의 codexWake로 감시 상태를 확인할 수 있다.';

export function installHooks(options: InstallOptions = {}): InstallResult {
  const target = options.target ?? 'claude';
  const settingsPath = options.settingsPath ?? defaultPathFor(target);
  const command = options.command ?? resolveA2abCommand();
  const settings = readSettings(settingsPath);
  const merged = mergeHooks(settings, buildEntriesFor(target, command));

  const base = {
    target,
    settingsPath,
    command,
    added: merged.added,
    skipped: merged.skipped,
    ...(target === 'codex' ? { followUp: CODEX_FOLLOW_UP } : {}),
  };

  if (options.print === true) {
    return { ...base, written: false, settings: merged.settings };
  }
  if (merged.added.length === 0) {
    return { ...base, written: false };
  }

  const existed = existsSync(settingsPath);
  if (existed) {
    copyFileSync(settingsPath, `${settingsPath}.bak`);
  } else {
    mkdirSync(dirname(settingsPath), { recursive: true });
  }
  writeFileSync(settingsPath, `${JSON.stringify(merged.settings, null, 2)}\n`, 'utf8');

  return {
    ...base,
    written: true,
    ...(existed ? { backupPath: `${settingsPath}.bak` } : {}),
  };
}

export interface InstallAllOptions {
  readonly target?: InstallTarget | 'both';
  readonly settingsPath?: string;
  readonly command?: string;
  readonly print?: boolean;
}

// 대상이 여러 개일 수 있으므로 결과는 항상 배열이다.
// 한 대상이 실패해도(예: 깨진 settings.json) 나머지를 조용히 건너뛰지 않고 그대로 던진다.
export function installAllHooks(options: InstallAllOptions = {}): ReadonlyArray<InstallResult> {
  const targets = resolveTargets(options.target);
  if (options.settingsPath !== undefined && targets.length > 1) {
    throw new Error('--settings는 대상이 하나일 때만 쓸 수 있다. --target claude 또는 --target codex를 함께 지정한다.');
  }
  return targets.map((target) =>
    installHooks({
      target,
      ...(options.settingsPath === undefined ? {} : { settingsPath: options.settingsPath }),
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(options.print === true ? { print: true } : {}),
    }),
  );
}
