#!/usr/bin/env node
// a2ab 실행 셔틀: tsx 런타임을 등록하고 TypeScript CLI를 로드한다.
// hook 컨텍스트에서도 호출되므로 stdout에는 CLI 결과 JSON 외에 아무것도 쓰지 않는다.
// 배포된 패키지에는 dist/가 들어 있으므로 tsx 없이 컴파일 결과를 바로 쓴다.
// 로컬 개발(빌드 전)에서는 tsx 런타임을 등록하고 src를 로드한다.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const distCli = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

let main;
if (existsSync(distCli)) {
  ({ main } = await import(pathToFileURL(distCli).href));
} else {
  const { register } = await import('tsx/esm/api');
  register();
  ({ main } = await import('../src/cli.ts'));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`a2ab: ${message}\n`);
  process.exitCode = 1;
}
