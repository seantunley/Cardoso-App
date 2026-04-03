# Ralph Agent Instructions

You are an autonomous coding agent working on the Cardoso App Phase 1 Foundation Refactor.

## Project Context

- **Repo:** seantunley/Cardoso-App, branch `ralph/phase-1-foundation-refactor`
- **Stack:** Node.js (CommonJS), Express, better-sqlite3, SQLite, React/Vite frontend
- **Working dir:** /home/sean/.openclaw/workspace-wazoo/cardoso-app
- **server.js:** ~1,600-line monolith being split into modular structure
- **Critical:** All existing API endpoints must work identically. HUB_MODE (process.env.HUB_MODE === "true") behaviour must be preserved.
- **DB pattern:** singleton — `src/db/index.js` exports the `db` instance. No module opens its own connection.
- **Quality checks:** `node --check server.js` and `npm run build` must pass after every story.
- **Do NOT modify frontend files** (src/pages/, src/components/, src/lib/, etc.)
- **Do NOT change package.json type field** — it is already set correctly for CommonJS

## Your Task

1. Read the PRD at `scripts/ralph/prd.json` (relative to project root)
2. Read the progress log at `scripts/ralph/progress.txt` (check Codebase Patterns section first)
3. Check you're on branch `ralph/phase-1-foundation-refactor`. If not, create it from `dev`.
4. Pick the **highest priority** user story where `passes: false`
5. Implement that single user story — move code out of server.js, do not rewrite logic
6. Run: `node --check server.js` and `npm run build` — both must pass
7. If checks pass, commit ALL changes: `feat: [Story ID] - [Story Title]`
8. Update `scripts/ralph/prd.json` to set `passes: true` for the completed story
9. Append progress to `scripts/ralph/progress.txt`

## Progress Report Format

APPEND to scripts/ralph/progress.txt:
```
## [Date/Time] - [Story ID]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered
  - Gotchas encountered
---
```

## Consolidate Patterns

Add reusable patterns to `## Codebase Patterns` at TOP of progress.txt:
```
## Codebase Patterns
- server.js uses require() — all new src/ files must also use require/module.exports
- db singleton: require('../db') or require('../../db') — never open new Database()
- HUB_MODE routes: wrap in if (process.env.HUB_MODE === 'true') checks
```

## Quality Requirements

- `node --check server.js` must pass
- `npm run build` must pass
- Do NOT commit broken code
- Move code, don't rewrite it
- Keep server.js working as the entry point until US-013

## Stop Condition

If ALL stories have `passes: true`, reply with:
<promise>COMPLETE</promise>

Otherwise end your response normally.

## Important

- Work on ONE story per iteration
- Read progress.txt Codebase Patterns before starting
- Commit every story before moving on
