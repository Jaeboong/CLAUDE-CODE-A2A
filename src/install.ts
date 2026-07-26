// a2ab init — Claude Code settings.json에 hook을 병합한다.
// 설치만으로는 세션에 아무것도 주입되지 않으므로, 이 단계를 사람이 JSON을 편집해서
// 하게 두지 않는다. npm postinstall로 자동화하지 않는 이유는 --ignore-scripts로
// 조용히 건너뛰어지고, 설치가 사용자 설정을 말없이 고치는 것이 위험하기 때문이다.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HookCommand {
  readonly type: 'command';
  readonly command: string;
  readonly timeout?: number;
  readonly asyncRewake?: boolean;
  readonly statusMessage?: string;
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
}

export interface InstallResult {
  readonly settingsPath: string;
  readonly command: string;
  readonly added: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
  readonly written: boolean;
  readonly backupPath?: string;
  readonly settings?: Settings;
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

export function installHooks(options: InstallOptions = {}): InstallResult {
  const settingsPath = options.settingsPath ?? defaultSettingsPath();
  const command = options.command ?? resolveA2abCommand();
  const settings = readSettings(settingsPath);
  const merged = mergeHooks(settings, buildHookEntries(command));

  const base = {
    settingsPath,
    command,
    added: merged.added,
    skipped: merged.skipped,
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
