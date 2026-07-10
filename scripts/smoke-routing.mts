import { loadConfig } from '../src/lib/config.ts';
import { chooseRuntimeProfile } from '../src/runtime/router.ts';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const simple = await chooseRuntimeProfile(cfg, { prompt: '帮我总结这段话' });
  const complex = await chooseRuntimeProfile(cfg, {
    prompt: '请在 monorepo 里做跨模块重构，先分析架构，再修改多个文件，最后 review',
  });
  console.log(
    JSON.stringify(
      {
        simple: {
          profileName: simple.profileName,
          reason: simple.reason,
          runtimeKind: simple.profile.kind,
          model: simple.profile.model,
        },
        complex: {
          profileName: complex.profileName,
          reason: complex.reason,
          runtimeKind: complex.profile.kind,
          model: complex.profile.model,
        },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
