# Contributing to PicoClaw

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** Features, capabilities, enhancements. These should be skills mounted via `$ORG_DIR/skills/` or `/data/memory/skills/`.

## Skills

A skill is a directory that teaches the Claude agent new capabilities at runtime. Skills are loaded via volume mount — no source code changes required.

PicoClaw uses a **three-tier skill merge**:

| Tier | Source | Behavior |
|------|--------|----------|
| Built-in | Bundled in image | Base layer |
| Org | `$ORG_DIR/skills/` | Overrides built-in skills of the same name |
| User | `/data/memory/skills/` | **Additive only** — cannot override org or built-in skills |

Each skill directory should contain:

- `SKILL.md` — instructions the agent follows to use the skill (required)
- Supporting files as needed (templates, configs, examples)

### Why?

PicoClaw's core is intentionally minimal. Skills let operators extend the agent's capabilities without modifying the runtime. Different deployments can mount different skill sets for different use cases.

### Testing

Test your skill by mounting it into a running PicoClaw container and verifying the agent can follow the instructions in `SKILL.md`.

```bash
# Mount a user skill
docker run ... -v ./my-skill:/data/memory/skills/my-skill picoclaw:latest
```

User skills can be hot-reloaded via `POST /admin/reload-skills` without restarting the container.

## Persona (CLAUDE.md)

PicoClaw uses a **two-tier persona** model:

| Tier | File | Purpose |
|------|------|---------|
| Org | `$ORG_DIR/CLAUDE.md` | Organization-wide policies (optional, read-only) |
| User | `/data/memory/CLAUDE.md` | Agent identity and user-specific rules (recommended) |

Both files are optional. Persona changes are not source code changes — they are mounted at runtime.

See `docs/SKILLS_AND_PERSONA_GUIDE.md` for authoring instructions.
