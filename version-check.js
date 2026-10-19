'use strict';

// Is this the latest code? There are no releases, so the check compares the
// commit the app runs from with the newest commit of the repository's main
// branch on GitHub (public API, no account): on start, every few hours and
// on request. settings.updateCheck turns it off.
//
// The app's commit: build-info.json in a build (scripts/build-info.js), the
// project's .git in development.

const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const pkg = require('./package.json');

const REPO = (pkg.repository?.url || '').match(/github\.com\/([^/]+\/[^/.]+)/)?.[1] || null;
const BRANCH = 'main';
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;

// { commit, date, dirty, source } or null.
function localCommit() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
    if (info.commit) return { ...info, source: 'build' };
  } catch {
    // Not a build: try the repository.
  }
  try {
    const gitDir = path.join(__dirname, '.git');
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref: (.+)$/)?.[1];
    let commit = ref ? null : head;
    if (ref) {
      const refFile = path.join(gitDir, ...ref.split('/'));
      if (fs.existsSync(refFile)) commit = fs.readFileSync(refFile, 'utf8').trim();
      else {
        const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
        commit = packed.split('\n').find((line) => line.endsWith(` ${ref}`))?.split(' ')[0] || null;
      }
    }
    return /^[0-9a-f]{40}$/.test(commit || '') ? { commit, date: null, dirty: null, source: 'git' } : null;
  } catch {
    return null;
  }
}

async function github(apiPath) {
  const response = await net.fetch(`https://api.github.com/repos/${REPO}${apiPath}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Nebohliad/${pkg.version}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  return response.json();
}

// overlay: { settings, changed() }.
function setupVersionCheck(overlay) {
  const local = localCommit();
  // status: off | checking | current | behind | ahead | diverged | local
  // (our commit is not on GitHub) | unknown (no commit known) | error
  let state = { status: 'checking', local, latest: null, behindBy: 0, checkedAt: null, error: null };
  let timer = null;

  function set(next) {
    state = { ...state, ...next };
    overlay.changed();
  }

  async function check() {
    if (!overlay.settings.updateCheck) {
      set({ status: 'off' });
      return;
    }
    if (!REPO || !local) {
      set({ status: 'unknown', checkedAt: Date.now() });
      return;
    }
    set({ status: 'checking', error: null });
    try {
      const head = await github(`/commits/${BRANCH}`);
      const latest = head && {
        commit: head.sha,
        date: head.commit?.committer?.date || null,
        message: (head.commit?.message || '').split('\n')[0],
      };
      if (!latest) throw new Error('no branch');
      if (latest.commit === local.commit) {
        set({ status: 'current', latest, behindBy: 0, checkedAt: Date.now() });
        return;
      }
      // base = ours, head = GitHub's: "ahead" means GitHub has newer commits.
      const compare = await github(`/compare/${local.commit}...${latest.commit}`);
      const status = !compare
        ? 'local' // Our commit is not on GitHub (not pushed yet).
        : { ahead: 'behind', behind: 'ahead', diverged: 'diverged', identical: 'current' }[compare.status] || 'unknown';
      set({ status, latest, behindBy: compare?.ahead_by || 0, checkedAt: Date.now() });
    } catch (error) {
      set({ status: 'error', error: error.message, checkedAt: Date.now() });
    }
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(check, CHECK_EVERY_MS);
    timer.unref?.();
  }

  setTimeout(check, FIRST_CHECK_MS).unref?.();
  schedule();

  return {
    check,
    // For the UI: plus links to the repository and to what changed.
    state: () => ({
      ...state,
      repoUrl: REPO ? `https://github.com/${REPO}` : null,
      compareUrl: REPO && local && state.latest ? `https://github.com/${REPO}/compare/${local.commit}...${state.latest.commit}` : null,
    }),
  };
}

module.exports = { setupVersionCheck, localCommit };
