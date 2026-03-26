import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Tests for skill sync logic.
 *
 * Config is read at import time (ESM imports are hoisted above module-scope
 * code), so we use vi.hoisted() to set env vars BEFORE config.ts evaluates.
 */

// vi.hoisted() runs before all imports — set env vars so config.ts and
// skills.ts read the correct temp paths when they evaluate at import time.
const dirs = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const tmpDir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'picoclaw-skills-'));
  const builtInDir = _path.join(tmpDir, 'built-in-skills');
  const orgDir = _path.join(tmpDir, 'org-skills');
  const memoryDir = _path.join(tmpDir, 'memory');
  // USER_SKILLS_DIR is hardcoded to $MEMORY_DIR/skills (no env var override).
  const userDir = _path.join(memoryDir, 'skills');
  const destination = _path.join(memoryDir, '.claude', 'skills');

  process.env.BUILT_IN_SKILLS_DIR = builtInDir;
  process.env.SKILLS_DIR = orgDir;
  process.env.MEMORY_DIR = memoryDir;

  return { tmpDir, builtInDir, orgDir, userDir, memoryDir, destination };
});

import fs from 'fs';
import path from 'path';

import { syncSkills } from './skills.js';

function createSkill(baseDir: string, name: string, content?: string): void {
  const skillDir = path.join(baseDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content || `# ${name}\n`);
}

function listEffective(): string[] {
  if (!fs.existsSync(dirs.destination)) return [];
  return fs
    .readdirSync(dirs.destination)
    .filter((e) => fs.statSync(path.join(dirs.destination, e)).isDirectory())
    .sort();
}

function clearAllSources(): void {
  for (const dir of [dirs.builtInDir, dirs.orgDir, dirs.userDir]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
  }
  // Also clear the destination to prevent cross-test leaking via persist step.
  if (fs.existsSync(dirs.destination)) {
    for (const entry of fs.readdirSync(dirs.destination)) {
      const p = path.join(dirs.destination, entry);
      if (fs.statSync(p).isDirectory()) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  }
}

describe('syncSkills', () => {
  beforeAll(() => {
    fs.mkdirSync(dirs.builtInDir, { recursive: true });
    fs.mkdirSync(dirs.orgDir, { recursive: true });
    fs.mkdirSync(dirs.userDir, { recursive: true });
    fs.mkdirSync(dirs.destination, { recursive: true });
  });

  afterAll(() => {
    if (dirs.tmpDir) {
      fs.rmSync(dirs.tmpDir, { recursive: true, force: true });
    }
    delete process.env.BUILT_IN_SKILLS_DIR;
    delete process.env.SKILLS_DIR;
    delete process.env.MEMORY_DIR;
  });

  it('syncs built-in, org, and user skills to destination', () => {
    clearAllSources();
    createSkill(dirs.builtInDir, 'builtin-a');
    createSkill(dirs.orgDir, 'org-b');
    createSkill(dirs.userDir, 'user-c');

    syncSkills();

    expect(listEffective()).toEqual(['builtin-a', 'org-b', 'user-c']);
  });

  it('org skills override built-in skills of the same name', () => {
    clearAllSources();
    createSkill(dirs.builtInDir, 'shared-skill', '# built-in version\n');
    createSkill(dirs.orgDir, 'shared-skill', '# org version\n');

    syncSkills();

    const content = fs.readFileSync(
      path.join(dirs.destination, 'shared-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toBe('# org version\n');
  });

  it('user skills do not override org or built-in skills', () => {
    clearAllSources();
    createSkill(dirs.orgDir, 'shared-skill', '# org version\n');
    createSkill(dirs.userDir, 'shared-skill', '# user version\n');

    syncSkills();

    const content = fs.readFileSync(
      path.join(dirs.destination, 'shared-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toBe('# org version\n');
  });

  it('removes skills deleted from both user dir and destination', () => {
    clearAllSources();
    createSkill(dirs.userDir, 'temp-skill');
    syncSkills();
    expect(listEffective()).toContain('temp-skill');

    // To fully remove a user skill, delete from BOTH the persistent source
    // AND the destination before syncing.  If only user dir is deleted, the
    // persist step will copy the destination copy back to user dir.
    fs.rmSync(path.join(dirs.userDir, 'temp-skill'), { recursive: true });
    fs.rmSync(path.join(dirs.destination, 'temp-skill'), { recursive: true });
    syncSkills();

    expect(listEffective()).not.toContain('temp-skill');
  });

  it('persists runtime-created skills to user dir on reload', () => {
    clearAllSources();
    createSkill(dirs.builtInDir, 'alpha');
    syncSkills();

    // Simulate a skill created during chat (written to destination directly).
    createSkill(dirs.destination, 'runtime-created');
    expect(listEffective()).toContain('runtime-created');

    // Reload should persist the runtime skill to userDir and keep it.
    syncSkills();
    expect(listEffective()).toContain('alpha');
    expect(listEffective()).toContain('runtime-created');
    // Verify it was copied to the persistent user skills directory.
    expect(
      fs.existsSync(path.join(dirs.userDir, 'runtime-created', 'SKILL.md')),
    ).toBe(true);
  });

  it('does not persist runtime skills that shadow managed sources', () => {
    clearAllSources();
    createSkill(dirs.builtInDir, 'builtin-skill');
    createSkill(dirs.orgDir, 'org-skill');
    syncSkills();

    // Inject skills with same names as managed sources into destination.
    // These should NOT be persisted (they are managed copies, not runtime-created).
    fs.writeFileSync(
      path.join(dirs.destination, 'builtin-skill', 'SKILL.md'),
      '# tampered\n',
    );
    syncSkills();

    // User dir should NOT contain the managed skill names.
    expect(fs.existsSync(path.join(dirs.userDir, 'builtin-skill'))).toBe(false);
    expect(fs.existsSync(path.join(dirs.userDir, 'org-skill'))).toBe(false);
  });

  it('handles missing source directories gracefully', () => {
    // Remove all source dirs entirely
    for (const dir of [dirs.builtInDir, dirs.orgDir, dirs.userDir]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Clear the destination too — previous tests may have left skills that
    // the persist step would otherwise copy back to userDir.
    if (fs.existsSync(dirs.destination)) {
      fs.rmSync(dirs.destination, { recursive: true, force: true });
    }

    syncSkills();

    expect(listEffective()).toEqual([]);

    // Recreate for subsequent tests
    fs.mkdirSync(dirs.builtInDir, { recursive: true });
    fs.mkdirSync(dirs.orgDir, { recursive: true });
    fs.mkdirSync(dirs.userDir, { recursive: true });
  });
});
