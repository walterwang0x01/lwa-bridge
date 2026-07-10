import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('migrateLegacyDataDir', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lwa-paths-'));
    process.env['LWA_HOME'] = home;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env['LWA_HOME'];
    rmSync(home, { recursive: true, force: true });
  });

  async function loadPaths() {
    const mod = await import('./paths.js');
    mod._resetMigrationForTests();
    return mod;
  }

  it('renames legacy directory when ~/.lwa is missing', async () => {
    const legacy = join(home, '.lark-kiro-bridge');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'config.json'), '{}');

    const { migrateLegacyDataDir, DATA_DIR } = await loadPaths();
    expect(migrateLegacyDataDir()).toBe('renamed');
    expect(existsSync(DATA_DIR)).toBe(true);
    expect(existsSync(join(DATA_DIR, 'config.json'))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it('uses ~/.lwa when both directories exist', async () => {
    mkdirSync(join(home, '.lark-kiro-bridge'), { recursive: true });
    mkdirSync(join(home, '.lwa'), { recursive: true });
    writeFileSync(join(home, '.lwa', 'config.json'), '{"new":true}');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { migrateLegacyDataDir } = await loadPaths();
    expect(migrateLegacyDataDir()).toBe('both_exist');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does nothing when only ~/.lwa exists', async () => {
    mkdirSync(join(home, '.lwa'), { recursive: true });
    const { migrateLegacyDataDir } = await loadPaths();
    expect(migrateLegacyDataDir()).toBe('none');
  });
});
