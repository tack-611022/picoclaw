import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import { BUILT_IN_SKILLS_DIR, MEMORY_DIR, SKILLS_DIR } from './config.js';
import { logger } from './logger.js';

/** User skills directory: always under MEMORY_DIR for volume consolidation. */
const USER_SKILLS_DIR = path.join(MEMORY_DIR, 'skills');
const PICOCLAW_META_DIR = path.join(MEMORY_DIR, '.picoclaw');
const SKILLS_SYNC_STATE_PATH = path.join(
  PICOCLAW_META_DIR,
  'skills-sync-state.json',
);
const ORG_SKILLS_TOKEN_FILE = '.picoclaw-skills-token';

interface SkillEntry {
  name: string;
  sourcePath: string;
  signature: string;
}

interface SourceFingerprint {
  path: string;
  kind: 'snapshot' | 'external-token';
  token: string;
}

interface SkillSyncState {
  version: 1;
  updatedAt: string;
  destination: { path: string };
  sources: {
    builtIn: SourceFingerprint;
    org: SourceFingerprint;
    user: SourceFingerprint;
  };
}

function listSkillEntries(sourceDir: string): SkillEntry[] {
  if (!fs.existsSync(sourceDir)) {
    return [];
  }

  const entries: SkillEntry[] = [];
  for (const entry of fs.readdirSync(sourceDir)) {
    const sourcePath = path.join(sourceDir, entry);
    if (!fs.statSync(sourcePath).isDirectory()) {
      continue;
    }
    entries.push({
      name: entry,
      sourcePath,
      signature: buildSkillSignature(sourcePath),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

/**
 * Fast, deterministic skill signature for change detection.
 * We only inspect one level inside the skill directory to keep I/O lightweight.
 */
function buildSkillSignature(skillDir: string): string {
  const parts: string[] = [];

  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMdPath)) {
    const content = fs.readFileSync(skillMdPath);
    const hash = createHash('sha1').update(content).digest('hex');
    parts.push(`skillmd:${hash}`);
  } else {
    parts.push('skillmd:none');
  }

  const children = fs.readdirSync(skillDir).sort();
  for (const child of children) {
    if (child === 'SKILL.md') continue;
    const childPath = path.join(skillDir, child);
    const childStat = fs.statSync(childPath);
    const kind = childStat.isDirectory() ? 'd' : 'f';
    if (kind === 'd') {
      parts.push(`${kind}:${child}`);
      continue;
    }
    const content = fs.readFileSync(childPath);
    const hash = createHash('sha1').update(content).digest('hex');
    parts.push(`${kind}:${child}:${hash}`);
  }
  return parts.join('|');
}

function listDestinationEntries(destination: string): Map<string, SkillEntry> {
  const entries = new Map<string, SkillEntry>();
  if (!fs.existsSync(destination)) {
    return entries;
  }

  for (const entry of fs.readdirSync(destination)) {
    const destinationPath = path.join(destination, entry);
    if (!fs.statSync(destinationPath).isDirectory()) {
      continue;
    }
    entries.set(entry, {
      name: entry,
      sourcePath: destinationPath,
      signature: buildSkillSignature(destinationPath),
    });
  }
  return entries;
}

function mapEntries(entries: SkillEntry[]): Map<string, SkillEntry> {
  const mapped = new Map<string, SkillEntry>();
  for (const entry of entries) {
    mapped.set(entry.name, entry);
  }
  return mapped;
}

function mapsEqualBySignature(
  left: Map<string, SkillEntry>,
  right: Map<string, SkillEntry>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [name, l] of left) {
    const r = right.get(name);
    if (!r || r.signature !== l.signature) {
      return false;
    }
  }
  return true;
}

function fingerprintSnapshot(sourceDir: string): SourceFingerprint {
  if (!fs.existsSync(sourceDir)) {
    return { path: sourceDir, kind: 'snapshot', token: 'missing' };
  }
  let fileCount = 0;
  let totalSkillMdSize = 0;
  let newestMtimeMs = 0;

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    fileCount++;
    const skillMdPath = path.join(sourceDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;
    const stat = fs.statSync(skillMdPath);
    totalSkillMdSize += stat.size;
    const mtime = Math.floor(stat.mtimeMs);
    if (mtime > newestMtimeMs) newestMtimeMs = mtime;
  }

  return {
    path: sourceDir,
    kind: 'snapshot',
    token: `${fileCount}:${totalSkillMdSize}:${newestMtimeMs}`,
  };
}

function fingerprintOrgSource(sourceDir: string): SourceFingerprint {
  const tokenPath = path.join(sourceDir, ORG_SKILLS_TOKEN_FILE);
  if (!fs.existsSync(sourceDir)) {
    return { path: sourceDir, kind: 'snapshot', token: 'missing' };
  }
  if (!fs.existsSync(tokenPath)) {
    logger.warn(
      { tokenPath },
      'Org skills token file not found; falling back to snapshot fingerprint',
    );
    return fingerprintSnapshot(sourceDir);
  }
  const token = fs.readFileSync(tokenPath, 'utf-8').trim();
  return {
    path: sourceDir,
    kind: 'external-token',
    token: token || '(empty)',
  };
}

function buildCurrentState(destination: string): SkillSyncState {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    destination: { path: destination },
    sources: {
      builtIn: fingerprintSnapshot(BUILT_IN_SKILLS_DIR),
      org: fingerprintOrgSource(SKILLS_DIR),
      user: fingerprintSnapshot(USER_SKILLS_DIR),
    },
  };
}

function readSyncState(): SkillSyncState | null {
  if (!fs.existsSync(SKILLS_SYNC_STATE_PATH)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(SKILLS_SYNC_STATE_PATH, 'utf-8'),
    ) as SkillSyncState;
    if (parsed?.version !== 1 || !parsed.sources || !parsed.destination) {
      return null;
    }
    return parsed;
  } catch {
    logger.warn(
      { statePath: SKILLS_SYNC_STATE_PATH },
      'Failed to parse skills sync state; falling back to full sync',
    );
    return null;
  }
}

function writeSyncState(state: SkillSyncState): void {
  fs.mkdirSync(PICOCLAW_META_DIR, { recursive: true });
  fs.writeFileSync(SKILLS_SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

function fingerprintsMatch(
  previous: SkillSyncState,
  current: SkillSyncState,
): boolean {
  return (
    previous.destination.path === current.destination.path &&
    previous.sources.builtIn.path === current.sources.builtIn.path &&
    previous.sources.builtIn.kind === current.sources.builtIn.kind &&
    previous.sources.builtIn.token === current.sources.builtIn.token &&
    previous.sources.org.path === current.sources.org.path &&
    previous.sources.org.kind === current.sources.org.kind &&
    previous.sources.org.token === current.sources.org.token &&
    previous.sources.user.path === current.sources.user.path &&
    previous.sources.user.kind === current.sources.user.kind &&
    previous.sources.user.token === current.sources.user.token
  );
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
export function syncSkills(force = false): void {
  const destination = path.join(MEMORY_DIR, '.claude', 'skills');
  fs.mkdirSync(destination, { recursive: true });

  const currentState = buildCurrentState(destination);
  if (!force && fs.existsSync(destination)) {
    const previousState = readSyncState();
    if (previousState && fingerprintsMatch(previousState, currentState)) {
      logger.info(
        {
          statePath: SKILLS_SYNC_STATE_PATH,
          skipped: true,
          force,
        },
        'Skills sync skipped (state unchanged)',
      );
      return;
    }
  }

  // Persist runtime-created skills before clearing.
  const persistedCount = persistRuntimeSkills(destination);
  if (persistedCount > 0) {
    logger.info(
      { count: persistedCount },
      'Persisted runtime-created skills to user skills directory',
    );
  }

  const builtInEntries = listSkillEntries(BUILT_IN_SKILLS_DIR);
  const orgEntries = listSkillEntries(SKILLS_DIR);
  const userEntries = listSkillEntries(USER_SKILLS_DIR);

  // Effective precedence: built-in < org, user is additive only.
  const desired = mapEntries(builtInEntries);
  for (const entry of orgEntries) {
    desired.set(entry.name, entry);
  }
  for (const entry of userEntries) {
    if (!desired.has(entry.name)) {
      desired.set(entry.name, entry);
    }
  }

  const current = listDestinationEntries(destination);
  if (mapsEqualBySignature(desired, current)) {
    logger.info(
      {
        builtIn: builtInEntries.length,
        org: orgEntries.length,
        user: userEntries.length,
        skipped: true,
      },
      'Skills synced to .claude/skills/',
    );
    writeSyncState(buildCurrentState(destination));
    return;
  }

  let removedCount = 0;
  for (const [name] of current) {
    if (!desired.has(name)) {
      fs.rmSync(path.join(destination, name), { recursive: true, force: true });
      removedCount++;
    }
  }

  let updatedCount = 0;
  for (const [name, desiredEntry] of desired) {
    const existing = current.get(name);
    if (existing && existing.signature === desiredEntry.signature) {
      continue;
    }
    const destinationPath = path.join(destination, name);
    fs.rmSync(destinationPath, { recursive: true, force: true });
    fs.cpSync(desiredEntry.sourcePath, destinationPath, { recursive: true });
    updatedCount++;
  }

  logger.info(
    {
      builtIn: builtInEntries.length,
      org: orgEntries.length,
      user: userEntries.length,
      updated: updatedCount,
      removed: removedCount,
      skipped: false,
    },
    'Skills synced to .claude/skills/',
  );

  writeSyncState(buildCurrentState(destination));
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
