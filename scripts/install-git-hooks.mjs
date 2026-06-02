// Copies scripts/hooks/* into .git/hooks/ on every `npm install` so the
// pre-commit lint guard stays in sync with whatever the source tree has
// checked in. No-op when run outside a git checkout (CI / npx).
//
// We use a copy rather than `core.hooksPath = scripts/hooks` because some
// teammates run git from environments where hooksPath isn't honoured
// (older portable git, certain GUIs). Copying into the canonical
// .git/hooks/ works everywhere.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = process.cwd();
const GIT_DIR = path.join(REPO_ROOT, '.git');

if (!fs.existsSync(GIT_DIR)) {
  // Not a git checkout — happens during `npm install` of the published
  // package from npm registry or inside Docker COPY-of-dist images.
  // Silently no-op so install doesn't fail.
  process.exit(0);
}

const HOOKS_DIR = path.join(GIT_DIR, 'hooks');
const SRC_DIR = path.join(REPO_ROOT, 'scripts', 'hooks');

if (!fs.existsSync(SRC_DIR)) {
  console.warn('[install-git-hooks] scripts/hooks/ missing — nothing to install');
  process.exit(0);
}

fs.mkdirSync(HOOKS_DIR, { recursive: true });

const hooks = fs.readdirSync(SRC_DIR).filter((n) => !n.startsWith('.'));
let installed = 0;
for (const name of hooks) {
  const src = path.join(SRC_DIR, name);
  const dst = path.join(HOOKS_DIR, name);
  try {
    fs.copyFileSync(src, dst);
    // 0o755 — owner rwx, group/other rx. Required on Unix; harmless on
    // Windows. Git on Windows doesn't enforce the bit, but it does
    // execute the shebang via the bundled Bash, which needs the file
    // to be readable.
    fs.chmodSync(dst, 0o755);
    installed += 1;
  } catch (err) {
    console.error(`[install-git-hooks] failed to install ${name}: ${err.message}`);
    // Exit non-zero so the operator sees the failure during npm install
    // rather than discovering a missing hook on first commit.
    process.exit(1);
  }
}

console.log(`[install-git-hooks] installed ${installed} hook${installed === 1 ? '' : 's'} into .git/hooks/`);
