# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-08-25] Treat the working tree as user-owned**
   Do instead: review existing modifications in place and avoid destructive cleanup.
2. **[2026-08-25] Treat tracked runtime config as potentially sensitive**
   Do instead: scan tracked config files for credentials before any release and use `config.example.json` plus ignored local state.
3. **[2026-08-25] Keep frontend settings responses credential-free**
   Do instead: return configured booleans, accept blank keys as "keep existing", and never reconstruct a secret from UI state.

## Shell & Command Reliability
1. **[2026-08-25] Prefer bounded repository searches**
   Do instead: use `rg` with explicit excludes for generated assets and large vendored code.

## Domain Behavior Guardrails
1. **[2026-08-25] Assess local-agent security at trust boundaries**
   Do instead: inspect API exposure, Electron IPC, tool policy, filesystem scope, and secret handling together.
2. **[2026-08-25] Treat voice visual state and interaction state as separate contracts**
   Do instead: emit versioned `bailongma:voice-state` events for lifecycle consumers and leave point-cloud states as rendering details.

## User Directives
1. **[2026-08-25] Voice Operator is the product direction**
   Do instead: treat voice as the primary interaction channel for memory, tasks, reminders, and permitted execution; avoid unrestricted listening or companionship-first scope.
