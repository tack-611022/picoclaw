import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Tests for the auto-memory symlink logic in entrypoint.sh.
 *
 * Claude Code writes auto-memory to $HOME/.claude/projects/<cwd-slug>/memory/
 * but the agent's cwd is /data/memory. The entrypoint replaces this directory
 * with a symlink so auto-memory writes land in the agent's working directory.
 *
 * We extract the symlink logic and run it in a temp directory to verify behavior.
 */

// The symlink logic extracted from entrypoint.sh, parameterized for testing
function autoMemoryScript(claudeHome: string, memoryDir: string): string {
  return `
set -euo pipefail
CLAUDE_HOME="${claudeHome}"
MEMORY_DIR="${memoryDir}"
PROJECT_SLUG=$(echo "\${MEMORY_DIR}" | sed 's|/|-|g')
AUTO_MEMORY_DIR="\${CLAUDE_HOME}/projects/\${PROJECT_SLUG}/memory"

# Clean up accidental self-referential symlink.
if [ -L "\${MEMORY_DIR}/memory" ]; then
  MEMORY_LINK_TARGET="$(readlink "\${MEMORY_DIR}/memory" || true)"
  if [ "\${MEMORY_LINK_TARGET}" = "\${MEMORY_DIR}" ]; then
    rm -f "\${MEMORY_DIR}/memory"
  fi
fi

# Resolve physical paths before circular check.
MEMORY_REAL="$(cd "\${MEMORY_DIR}" && pwd -P)"
AUTO_MEMORY_PARENT="$(dirname "\${AUTO_MEMORY_DIR}")"
mkdir -p "\${AUTO_MEMORY_PARENT}"
AUTO_MEMORY_PARENT_REAL="$(cd "\${AUTO_MEMORY_PARENT}" && pwd -P)"
AUTO_MEMORY_REAL="\${AUTO_MEMORY_PARENT_REAL}/$(basename "\${AUTO_MEMORY_DIR}")"

case "\${AUTO_MEMORY_REAL}" in
  "\${MEMORY_REAL}"|"\${MEMORY_REAL}"/*)
    ;;  # Skip — would be circular
  *)
    if [ -d "\${AUTO_MEMORY_DIR}" ] && [ ! -L "\${AUTO_MEMORY_DIR}" ]; then
      if [ -f "\${AUTO_MEMORY_DIR}/MEMORY.md" ]; then
        cp -n "\${AUTO_MEMORY_DIR}/MEMORY.md" "\${MEMORY_DIR}/MEMORY.md" 2>/dev/null || true
      fi
      rm -rf "\${AUTO_MEMORY_DIR}"
    fi
    ln -sf "\${MEMORY_DIR}" "\${AUTO_MEMORY_DIR}"
    ;;
esac
`;
}

function runScript(script: string): void {
  execSync(script, { shell: '/bin/bash', stdio: 'pipe' });
}

describe('entrypoint auto-memory symlink', () => {
  let tmpDir: string;

  function setup(): {
    claudeHome: string;
    memoryDir: string;
    autoMemoryDir: string;
  } {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picoclaw-entrypoint-'));
    const claudeHome = path.join(tmpDir, '.claude');
    const memoryDir = path.join(tmpDir, 'data', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true });

    // Compute the auto-memory path the same way entrypoint.sh does
    const projectSlug = memoryDir.replace(/\//g, '-');
    const autoMemoryDir = path.join(
      claudeHome,
      'projects',
      projectSlug,
      'memory',
    );

    return { claudeHome, memoryDir, autoMemoryDir };
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates symlink when auto-memory directory does not exist', () => {
    const { claudeHome, memoryDir, autoMemoryDir } = setup();

    runScript(autoMemoryScript(claudeHome, memoryDir));

    expect(fs.lstatSync(autoMemoryDir).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(autoMemoryDir)).toBe(memoryDir);
  });

  it('replaces real directory with symlink', () => {
    const { claudeHome, memoryDir, autoMemoryDir } = setup();

    // Simulate Claude Code having created a real directory
    fs.mkdirSync(autoMemoryDir, { recursive: true });
    expect(fs.lstatSync(autoMemoryDir).isDirectory()).toBe(true);
    expect(fs.lstatSync(autoMemoryDir).isSymbolicLink()).toBe(false);

    runScript(autoMemoryScript(claudeHome, memoryDir));

    expect(fs.lstatSync(autoMemoryDir).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(autoMemoryDir)).toBe(memoryDir);
  });

  it('preserves existing MEMORY.md when replacing real directory', () => {
    const { claudeHome, memoryDir, autoMemoryDir } = setup();

    // Simulate Claude Code having written auto-memory to the isolated path
    fs.mkdirSync(autoMemoryDir, { recursive: true });
    const originalContent = '# Auto Memory\n\nSome remembered facts.\n';
    fs.writeFileSync(path.join(autoMemoryDir, 'MEMORY.md'), originalContent);

    // Ensure no MEMORY.md exists in the real volume yet
    expect(fs.existsSync(path.join(memoryDir, 'MEMORY.md'))).toBe(false);

    runScript(autoMemoryScript(claudeHome, memoryDir));

    // Symlink should be created
    expect(fs.lstatSync(autoMemoryDir).isSymbolicLink()).toBe(true);

    // MEMORY.md should have been copied to the real volume
    const copied = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf-8');
    expect(copied).toBe(originalContent);
  });

  it('does not overwrite existing MEMORY.md in memory volume', () => {
    const { claudeHome, memoryDir, autoMemoryDir } = setup();

    // User already has a MEMORY.md in the real volume
    const userContent = '# My Memory\n\nUser-authored content.\n';
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), userContent);

    // Claude Code also wrote one to the isolated path
    fs.mkdirSync(autoMemoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(autoMemoryDir, 'MEMORY.md'),
      '# Stale auto-memory\n',
    );

    runScript(autoMemoryScript(claudeHome, memoryDir));

    // User's original MEMORY.md should be preserved (cp -n = no-clobber)
    const content = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf-8');
    expect(content).toBe(userContent);
  });

  it('leaves existing symlink untouched', () => {
    const { claudeHome, memoryDir, autoMemoryDir } = setup();

    // Simulate a previous run that already created the symlink
    fs.mkdirSync(path.dirname(autoMemoryDir), { recursive: true });
    fs.symlinkSync(memoryDir, autoMemoryDir);
    expect(fs.lstatSync(autoMemoryDir).isSymbolicLink()).toBe(true);

    // Run again — should not error or change anything
    runScript(autoMemoryScript(claudeHome, memoryDir));

    expect(fs.lstatSync(autoMemoryDir).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(autoMemoryDir)).toBe(memoryDir);
  });

  it('writes through symlink land in memory volume', () => {
    const { claudeHome, memoryDir, autoMemoryDir } = setup();

    runScript(autoMemoryScript(claudeHome, memoryDir));

    // Simulate Claude Code writing auto-memory through the symlink
    const testContent = '# Test Memory\n\nWritten through symlink.\n';
    fs.writeFileSync(path.join(autoMemoryDir, 'MEMORY.md'), testContent);

    // The file should be visible in the real memory volume
    const content = fs.readFileSync(path.join(memoryDir, 'MEMORY.md'), 'utf-8');
    expect(content).toBe(testContent);
  });

  it('computes project slug correctly for /data/memory', () => {
    const { claudeHome } = setup();
    // Use a path that mimics the real container path
    const containerMemoryDir = path.join(tmpDir, 'data-memory');
    fs.mkdirSync(containerMemoryDir, { recursive: true });

    runScript(autoMemoryScript(claudeHome, containerMemoryDir));

    // The slug replaces / with -, so the auto-memory dir should exist
    const slug = containerMemoryDir.replace(/\//g, '-');
    const expectedDir = path.join(claudeHome, 'projects', slug, 'memory');
    expect(fs.lstatSync(expectedDir).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(expectedDir)).toBe(containerMemoryDir);
  });

  it('skips symlink when claude home is inside memory dir (merged mode)', () => {
    const { memoryDir } = setup();
    // In merged mode, CLAUDE_HOME = MEMORY_DIR/.claude
    const mergedClaudeHome = path.join(memoryDir, '.claude');
    fs.mkdirSync(mergedClaudeHome, { recursive: true });

    runScript(autoMemoryScript(mergedClaudeHome, memoryDir));

    // AUTO_MEMORY_DIR would be inside MEMORY_DIR — symlink should be skipped
    const projectSlug = memoryDir.replace(/\//g, '-');
    const autoMemoryDir = path.join(
      mergedClaudeHome,
      'projects',
      projectSlug,
      'memory',
    );
    expect(fs.existsSync(autoMemoryDir)).toBe(false);
  });

  it('skips symlink when claude home is a symlink to memory/.claude', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picoclaw-entrypoint-'));
    const memoryDir = path.join(tmpDir, 'data', 'memory');
    const realClaudeHome = path.join(memoryDir, '.claude');
    const linkedClaudeHome = path.join(tmpDir, 'home', 'node', '.claude');
    fs.mkdirSync(realClaudeHome, { recursive: true });
    fs.mkdirSync(path.dirname(linkedClaudeHome), { recursive: true });
    fs.symlinkSync(realClaudeHome, linkedClaudeHome);

    runScript(autoMemoryScript(linkedClaudeHome, memoryDir));

    const projectSlug = memoryDir.replace(/\//g, '-');
    const autoMemoryDir = path.join(
      realClaudeHome,
      'projects',
      projectSlug,
      'memory',
    );
    expect(fs.existsSync(autoMemoryDir)).toBe(false);
  });

  it('removes self-referential memory symlink', () => {
    const { claudeHome, memoryDir } = setup();
    fs.symlinkSync(memoryDir, path.join(memoryDir, 'memory'));
    expect(fs.lstatSync(path.join(memoryDir, 'memory')).isSymbolicLink()).toBe(
      true,
    );

    runScript(autoMemoryScript(claudeHome, memoryDir));

    expect(fs.existsSync(path.join(memoryDir, 'memory'))).toBe(false);
  });
});
