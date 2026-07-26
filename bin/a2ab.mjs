#!/usr/bin/env node
// a2ab 실행 셔틀: tsx 런타임을 등록하고 TypeScript CLI를 로드한다.
// hook 컨텍스트에서도 호출되므로 stdout에는 CLI 결과 JSON 외에 아무것도 쓰지 않는다.
import { register } from 'tsx/esm/api';

register();

const { main } = await import('../src/cli.ts');

try {
  await main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`a2ab: ${message}\n`);
  process.exitCode = 1;
}
