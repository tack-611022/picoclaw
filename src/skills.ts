import fs from 'fs';
import path from 'path';

import { BUILT_IN_SKILLS_DIR, MEMORY_DIR, SKILLS_DIR } from './config.js';
import { logger } from './logger.js';

/** User skills directory: always under MEMORY_DIR for volume consolidation. */
const USER_SKILLS_DIR = path.join(MEMORY_DIR, 'skills');

function syncDirectory(sourceDir: string, destination: string): number {
  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  let count = 0;
  for (const entry of fs.readdirSync(sourceDir)) {
    const sourcePath = path.join(sourceDir, entry);
    if (!fs.statSync(sourcePath).isDirectory()) {
      continue;
    }

    const destinationPath = path.join(destination, entry);
    fs.rmSync(destinationPath, { recursive: true, force: true });
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
    count++;
  }
  return count;
}

/**
 * Copy skill directories that do NOT already exist at the destination.
 * Used for user skills: they supplement but never override org or built-in skills.
 */
function syncDirectoryAdditive(sourceDir: string, destination: string): number {
  if (!fs.existsSync(sourceDir)) {
    return 0;
  }

  let count = 0;
  for (const entry of fs.readdirSync(sourceDir)) {
    const sourcePath = path.join(sourceDir, entry);
    if (!fs.statSync(sourcePath).isDirectory()) {
      continue;
    }

    const destinationPath = path.join(destination, entry);
    // Skip if skill already exists (from built-in or org tier).
    if (fs.existsSync(destinationPath)) {
      continue;
    }

    fs.cpSync(sourcePath, destinationPath, { recursive: true });
    count++;
  }
  return count;
}

/**
 * Collect the names of all skills that come from the three managed sources
 * (built-in, org, user). Used to identify runtime-created skills that are
 * NOT in any managed source and need to be persisted.
 */
function managedSkillNames(): Set<string> {
  const names = new Set<string>();
  for (const dir of [BUILT_IN_SKILLS_DIR, SKILLS_DIR, USER_SKILLS_DIR]) {
    for (const name of listSkillNames(dir)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Save runtime-created skills back to USER_SKILLS_DIR before a sync wipes
 * the destination.  Skills created during a chat session (e.g. via Claude
 * Code) are written to .claude/skills/ inside MEMORY_DIR.  Without this
 * step they would be lost on reload/restart because syncSkills() clears
 * the destination directory first.
 *
 * Only skills whose name does NOT already exist in any managed source are
 * persisted — we never overwrite org/built-in/user-authored originals.
 */
function persistRuntimeSkills(destination: string): number {
  if (!fs.existsSync(destination)) return 0;

  const managed = managedSkillNames();
  fs.mkdirSync(USER_SKILLS_DIR, { recursive: true });

  let count = 0;
  for (const entry of fs.readdirSync(destination)) {
    const entryPath = path.join(destination, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;
    if (managed.has(entry)) continue;

    // This is a runtime-created skill — copy to the persistent user dir.
    const targetPath = path.join(USER_SKILLS_DIR, entry);
    if (!fs.existsSync(targetPath)) {
      fs.cpSync(entryPath, targetPath, { recursive: true });
      count++;
    }
  }

  return count;
}

/**
 * Sync skills from three tiers to .claude/skills/.
 *
 * Before clearing the destination, runtime-created skills (those not in
 * any managed source) are persisted back to USER_SKILLS_DIR so they
 * survive across container restarts and reload-skills calls.
 *
 * Load order:
 *   1. BUILT_IN_SKILLS_DIR (bundled in image)
 *   2. SKILLS_DIR (org skills — authoritative, overrides built-in)
 *   3. USER_SKILLS_DIR (user skills — additive only, does NOT override org or built-in)
 */
export function syncSkills(): void {
  const destination = path.join(MEMORY_DIR, '.claude', 'skills');
  fs.mkdirSync(destination, { recursive: true });

  // Persist runtime-created skills before clearing.
  const persistedCount = persistRuntimeSkills(destination);
  if (persistedCount > 0) {
    logger.info(
      { count: persistedCount },
      'Persisted runtime-created skills to user skills directory',
    );
  }

  // Clear destination so removed skills do not persist across reloads.
  for (const entry of fs.readdirSync(destination)) {
    const entryPath = path.join(destination, entry);
    if (fs.statSync(entryPath).isDirectory()) {
      fs.rmSync(entryPath, { recursive: true, force: true });
    }
  }

  const builtInCount = syncDirectory(BUILT_IN_SKILLS_DIR, destination);
  const orgCount = syncDirectory(SKILLS_DIR, destination);
  const userCount = syncDirectoryAdditive(USER_SKILLS_DIR, destination);

  logger.info(
    { builtIn: builtInCount, org: orgCount, user: userCount },
    'Skills synced to .claude/skills/',
  );
}

export function getSkillsSummary(): {
  builtIn: string[];
  org: string[];
  user: string[];
  effective: string[];
} {
  const builtIn = listSkillNames(BUILT_IN_SKILLS_DIR);
  const org = listSkillNames(SKILLS_DIR);
  const user = listSkillNames(USER_SKILLS_DIR);
  const effective = [...new Set([...builtIn, ...org, ...user])].sort();
  return { builtIn, org, user, effective };
}

function listSkillNames(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((entry) => fs.statSync(path.join(dir, entry)).isDirectory())
    .sort();
}

export function ensureClaudeSettings(): void {
  const claudeDir = path.join(MEMORY_DIR, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    return;
  }

  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
        },
      },
      null,
      2,
    ),
  );
}
