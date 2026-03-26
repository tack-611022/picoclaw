import fs from 'fs';
import path from 'path';

import {
  ANTHROPIC_BASE_URL,
  API_TOKEN,
  APP_VERSION,
  BUILD_COMMIT,
  BUILD_TIME,
  CLAUDE_MODEL,
  MEMORY_DIR,
  ORG_DIR,
  PORT,
  SDK_LOG_LEVEL,
  SKILLS_DIR,
  STORE_DIR,
  SYSTEM_PROMPT_OVERRIDE,
} from './config.js';
import { closeDatabase, initDatabase, syncDatabaseToVolume } from './db.js';
import { logger } from './logger.js';
import { getManagedMcpNames, loadManagedMcpServers } from './managed-mcp.js';
import { createServer } from './server.js';
import { ensureClaudeSettings, syncSkills } from './skills.js';

function ensureDataDirectories(): void {
  const directories = [MEMORY_DIR, STORE_DIR, path.join(MEMORY_DIR, '.claude')];

  for (const directory of directories) {
    fs.mkdirSync(path.resolve(directory), { recursive: true });
  }

  // SKILLS_DIR may point inside a read-only ORG_DIR mount.
  // Only create it if it does not already exist — mkdir on a
  // read-only filesystem would throw.
  const resolvedSkillsDir = path.resolve(SKILLS_DIR);
  if (!fs.existsSync(resolvedSkillsDir)) {
    try {
      fs.mkdirSync(resolvedSkillsDir, { recursive: true });
    } catch {
      // Expected when SKILLS_DIR is inside a read-only mount (ORG_DIR).
    }
  }
}

async function main(): Promise<void> {
  ensureDataDirectories();
  initDatabase();
  ensureClaudeSettings();
  syncSkills();

  const orgClaudeMdExists = ORG_DIR
    ? fs.existsSync(path.join(ORG_DIR, 'CLAUDE.md'))
    : false;
  const userClaudeMdExists = fs.existsSync(path.join(MEMORY_DIR, 'CLAUDE.md'));

  // Load org-managed MCP servers from managed-mcp.json into memory.
  // These are merged programmatically into query() mcpServers option
  // instead of relying on CLI auto-discovery from /etc/claude-code/,
  // which conflicts with --mcp-config (enterprise MCP exclusion).
  loadManagedMcpServers();
  const managedMcpNames = getManagedMcpNames();

  logger.info(
    {
      paths: {
        memoryDir: MEMORY_DIR,
        storeDir: STORE_DIR,
        orgDir: ORG_DIR || '(not set)',
        skillsDir: SKILLS_DIR,
      },
      persona: {
        orgClaudeMd: orgClaudeMdExists,
        userClaudeMd: userClaudeMdExists,
        systemPromptOverride: Boolean(SYSTEM_PROMPT_OVERRIDE),
      },
      mcp: {
        builtIn: ['picoclaw'],
        orgManaged: managedMcpNames,
      },
      model: CLAUDE_MODEL || '(cli default)',
      sdkLogLevel: SDK_LOG_LEVEL,
    },
    'Startup diagnostics',
  );

  let isShuttingDown = false;
  let server: ReturnType<ReturnType<typeof createServer>['listen']>;

  const shutdown = (signal: string) => {
    if (isShuttingDown) {
      logger.info({ signal }, 'Shutdown already in progress');
      return;
    }

    isShuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    try {
      syncDatabaseToVolume();
      closeDatabase();
    } catch (err) {
      logger.error({ err }, 'Failed to sync database on shutdown');
    }

    server.close(() => process.exit(0));
  };

  const app = createServer(undefined, {
    onStop: (reason: string) => shutdown(`API_STOP:${reason}`),
  });
  server = app.listen(PORT, () => {
    if (ANTHROPIC_BASE_URL) {
      logger.info(
        { baseUrl: ANTHROPIC_BASE_URL },
        'Using custom Anthropic base URL',
      );
    }
    if (!API_TOKEN) {
      logger.warn(
        'API_TOKEN is not set — authentication disabled. All endpoints are publicly accessible.',
      );
    }
    logger.info(
      {
        port: PORT,
        version: APP_VERSION,
        commit: BUILD_COMMIT,
        buildTime: BUILD_TIME,
      },
      'PicoClaw ready',
    );
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start PicoClaw');
  process.exit(1);
});
