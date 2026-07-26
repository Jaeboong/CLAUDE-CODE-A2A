import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { buildHookEntries, installHooks, mergeHooks } from '../src/install.js';
import type { Settings } from '../src/install.js';

let root = '';
let settingsPath = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'a2ab-install-'));
  settingsPath = join(root, 'settings.json');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENTRIES = buildHookEntries('a2ab');

function readSettings(): Settings {
  return JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
}

describe('mergeHooks', () => {
  it('빈 설정에 4개 이벤트를 모두 추가한다', () => {
    const result = mergeHooks({}, ENTRIES);
    assert.deepEqual([...result.added].sort(), [
      'PostToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);
    assert.deepEqual(result.skipped, []);
  });

  it('두 번 병합해도 중복되지 않는다', () => {
    const once = mergeHooks({}, ENTRIES);
    const twice = mergeHooks(once.settings, ENTRIES);

    assert.deepEqual(twice.added, []);
    assert.equal(twice.skipped.length, 4);
    assert.equal(twice.settings.hooks?.['SessionStart']?.length, 1);
  });

  it('같은 이벤트에 있는 남의 hook은 보존한다', () => {
    const existing: Settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    };
    const result = mergeHooks(existing, ENTRIES);
    const entries = result.settings.hooks?.['SessionStart'] ?? [];

    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.hooks[0]?.command, 'echo hi');
  });

  it('hooks 밖의 설정은 건드리지 않는다', () => {
    const result = mergeHooks({ model: 'opus', permissions: { allow: ['Bash'] } }, ENTRIES);

    assert.equal(result.settings['model'], 'opus');
    assert.deepEqual(result.settings['permissions'], { allow: ['Bash'] });
  });

  it('입력 설정을 변형하지 않는다', () => {
    const original: Settings = { hooks: {} };
    mergeHooks(original, ENTRIES);

    assert.deepEqual(original.hooks, {});
  });

  it('watch hook은 asyncRewake로 등록된다', () => {
    const result = mergeHooks({}, ENTRIES);
    const watch = result.settings.hooks?.['SessionStart']?.[0]?.hooks.find((h) =>
      h.command.includes('watch'),
    );

    assert.equal(watch?.asyncRewake, true);
  });
});

describe('installHooks', () => {
  it('settings.json이 없으면 새로 만든다', () => {
    const result = installHooks({ settingsPath, command: 'a2ab' });

    assert.equal(result.written, true);
    assert.equal(result.backupPath, undefined);
    assert.equal(readSettings().hooks?.['Stop']?.length, 1);
  });

  it('기존 파일은 .bak으로 백업한다', () => {
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }), 'utf8');
    const result = installHooks({ settingsPath, command: 'a2ab' });

    assert.equal(result.backupPath, `${settingsPath}.bak`);
    assert.deepEqual(JSON.parse(readFileSync(`${settingsPath}.bak`, 'utf8')), { model: 'opus' });
    assert.equal(readSettings()['model'], 'opus');
  });

  it('재실행해도 중복 등록하지 않는다', () => {
    installHooks({ settingsPath, command: 'a2ab' });
    const second = installHooks({ settingsPath, command: 'a2ab' });

    assert.deepEqual(second.added, []);
    assert.equal(second.written, false);
    assert.equal(readSettings().hooks?.['SessionStart']?.length, 1);
  });

  it('print 모드는 파일을 쓰지 않는다', () => {
    const result = installHooks({ settingsPath, command: 'a2ab', print: true });

    assert.equal(result.written, false);
    assert.throws(() => readSettings());
  });

  it('BOM이 붙은 settings.json도 읽는다', () => {
    writeFileSync(settingsPath, `﻿${JSON.stringify({ model: 'opus' })}`, 'utf8');
    const result = installHooks({ settingsPath, command: 'a2ab' });

    assert.equal(result.written, true);
    assert.equal(readSettings()['model'], 'opus');
  });

  // 사용자 설정을 통째로 날리는 것이 최악이므로, 파싱 실패는 조용히 덮어쓰지 않고 중단한다.
  it('깨진 JSON은 덮어쓰지 않고 실패한다', () => {
    writeFileSync(settingsPath, '{ not json', 'utf8');

    assert.throws(() => installHooks({ settingsPath, command: 'a2ab' }), /parse/i);
    assert.equal(readFileSync(settingsPath, 'utf8'), '{ not json');
  });
});
