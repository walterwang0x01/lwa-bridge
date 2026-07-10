import { loadConfig } from '../src/lib/config.ts';
import { resolveRuntimeProfile } from '../src/runtime/config.ts';
import { runAgentTurn } from '../src/runtime/runner.ts';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const profile = resolveRuntimeProfile(cfg, process.argv[2] ?? 'openai-fast');
  const result = await runAgentTurn(profile, {
    prompt: '请只回复“OPENAI网关联通成功”。不要添加任何别的内容。',
    cwd: process.cwd(),
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
