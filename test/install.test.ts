import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  buildCodexHookEntries,
  buildHookEntries,
  installAllHooks,
  installHooks,
  mergeHooks,
  resolveTargets,
} from '../src/install.js';
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

describe('buildCodexHookEntries', () => {
  const codex = buildCodexHookEntries('a2ab');

  it('Codex에는 Claude 전용 asyncRewake watch hook을 설치하지 않는다', () => {
    const commands = Object.values(codex).flatMap((e) => e.hooks.map((h) => h.command));

    assert.equal(
      commands.some((c) => c.includes('watch')),
      false,
    );
    assert.equal(
      commands.some((h) => h.includes('asyncRewake')),
      false,
    );
    assert.deepEqual([...Object.keys(codex)].sort(), ['SessionEnd', 'SessionStart', 'Stop']);
  });

  it('모든 hook에 commandWindows와 timeout을 명시한다', () => {
    for (const entry of Object.values(codex)) {
      for (const h of entry.hooks) {
        assert.equal(h.commandWindows, h.command, `commandWindows 누락: ${h.command}`);
        assert.equal(typeof h.timeout, 'number', `timeout 누락: ${h.command}`);
      }
    }
  });

  it('session-start는 provider를 codex로 넘긴다', () => {
    assert.match(codex['SessionStart']?.hooks[0]?.command ?? '', /--provider codex/);
  });
});

describe('installHooks (codex)', () => {
  let hooksPath = '';

  beforeEach(() => {
    hooksPath = join(root, 'hooks.json');
  });

  it('hooks.json을 새로 만들고 후속 조치를 알린다', () => {
    const result = installHooks({ target: 'codex', settingsPath: hooksPath, command: 'a2ab' });
    const file = JSON.parse(readFileSync(hooksPath, 'utf8')) as Settings;

    assert.equal(result.written, true);
    assert.equal(result.target, 'codex');
    assert.match(result.followUp ?? '', /\/hooks/);
    assert.equal(file.hooks?.['Stop']?.length, 1);
    assert.equal(file.hooks?.['PostToolUse'], undefined);
  });

  it('재실행해도 중복 등록하지 않는다', () => {
    installHooks({ target: 'codex', settingsPath: hooksPath, command: 'a2ab' });
    const second = installHooks({ target: 'codex', settingsPath: hooksPath, command: 'a2ab' });

    assert.deepEqual(second.added, []);
    assert.equal(second.written, false);
  });

  it('기존 hooks.json의 남의 hook은 보존한다', () => {
    writeFileSync(
      hooksPath,
      JSON.stringify({ description: 'mine', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }),
      'utf8',
    );
    installHooks({ target: 'codex', settingsPath: hooksPath, command: 'a2ab' });
    const file = JSON.parse(readFileSync(hooksPath, 'utf8')) as Settings;

    assert.equal(file['description'], 'mine');
    assert.equal(file.hooks?.['Stop']?.length, 2);
    assert.equal(file.hooks?.['Stop']?.[0]?.hooks[0]?.command, 'echo hi');
  });
});

describe('codex SessionEnd timeout', () => {
  // codex는 SessionEnd를 3초로 clamp하고 초과 시 매 세션 경고를 띄운다.
  it('상한(3초)을 넘지 않는다', () => {
    const timeout = buildCodexHookEntries('a2ab')['SessionEnd']?.hooks[0]?.timeout;

    assert.equal(timeout, 3);
  });
});

describe('resolveTargets (자동 감지)', () => {
  const savedCodexHome = process.env['CODEX_HOME'];
  const savedClaudeDir = process.env['CLAUDE_CONFIG_DIR'];

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env['CODEX_HOME'];
    else process.env['CODEX_HOME'] = savedCodexHome;
    if (savedClaudeDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = savedClaudeDir;
  });

  it('codex 홈이 있으면 둘 다 대상으로 잡는다', () => {
    process.env['CODEX_HOME'] = root;

    assert.deepEqual(resolveTargets(), ['claude', 'codex']);
  });

  it('codex 홈이 없으면 claude만 대상으로 잡는다', () => {
    process.env['CODEX_HOME'] = join(root, 'nope');

    assert.deepEqual(resolveTargets(), ['claude']);
  });

  it('명시한 대상은 감지 결과를 무시한다', () => {
    process.env['CODEX_HOME'] = root;

    assert.deepEqual(resolveTargets('claude'), ['claude']);
    assert.deepEqual(resolveTargets('codex'), ['codex']);
    assert.deepEqual(resolveTargets('both'), ['claude', 'codex']);
  });

  it('감지된 두 대상에 각각 자기 파일을 쓴다', () => {
    process.env['CODEX_HOME'] = join(root, 'codex');
    process.env['CLAUDE_CONFIG_DIR'] = join(root, 'claude');
    mkdirSync(join(root, 'codex'), { recursive: true });

    const results = installAllHooks({ command: 'a2ab' });

    assert.deepEqual(results.map((r) => r.target), ['claude', 'codex']);
    assert.equal(results.every((r) => r.written), true);
    assert.ok(readFileSync(join(root, 'claude', 'settings.json'), 'utf8').includes('watch'));
    assert.equal(readFileSync(join(root, 'codex', 'hooks.json'), 'utf8').includes('watch'), false);
  });

  // 대상이 둘인데 파일 하나를 지정하면 어느 쪽인지 알 수 없다. 조용히 고르지 않고 멈춘다.
  it('대상이 여럿일 때 --settings는 거부한다', () => {
    process.env['CODEX_HOME'] = root;

    assert.throws(() => installAllHooks({ settingsPath: join(root, 'x.json') }), /--settings/);
  });
});
