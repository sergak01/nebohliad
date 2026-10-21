'use strict';

// Is there a newer version? It depends on where this app came from
// (build-info.json `channel`, written by scripts/build-info.js):
// - release (built by GitHub Actions from a v* tag): compare package.json's
//   version with GitHub's latest published release; a newer one gets a dot on
//   ⋯, a block in Settings → About (download, skip this version) and one
//   Windows notification per version.
// - ci (an Actions build of any other commit), local (built on a PC), dev
//   (npm start, the project's .git): compare the commit with the newest
//   commit of main, as before; the latest release is only shown, no
//   notification.
// Public API, no account: on start, every few hours and on request.
// settings.updateCheck turns it off.

const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');
const pkg = require('./package.json');

const REPO = (pkg.repository?.url || '').match(/github\.com\/([^/]+\/[^/.]+)/)?.[1] || null;
const BRANCH = 'main';
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const NOTES_MAX = 600;

// { commit, date, dirty, source, channel, tag } or null. A build reads
// build-info.json; in development the repository's .git comes first (a
// build-info.json left over from an earlier build in the folder would be out
// of date).
function localCommit() {
  return app.isPackaged ? fromBuildInfo() || fromGit() : fromGit() || fromBuildInfo();
}

function fromBuildInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8'));
    return info.commit ? { ...info, source: 'build' } : null;
  } catch {
    return null;
  }
}

function fromGit() {
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

// 'release' | 'ci' | 'local' | 'dev'. Builds from before channels existed
// count as local.
function channelOf(local) {
  if (local?.source === 'git') return 'dev';
  return ['release', 'ci', 'local'].includes(local?.channel) ? local.channel : 'local';
}

// "v1.2.3" / "1.2.3" -> [1, 2, 3]; anything after a "-" (pre-release) is
// ignored, and pre-releases are not offered anyway.
function parseVersion(text) {
  const parts = String(text || '').replace(/^v/i, '').split('-')[0].split('.').map(Number);
  return parts.length && parts.every(Number.isInteger) ? parts : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// The release text, shortened, without Markdown decoration, for a few lines
// in the settings window.
function shortNotes(body) {
  const text = String(body || '')
    .replace(/\r/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#]+/g, '')
    .split('\n---')[0]
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > NOTES_MAX ? `${text.slice(0, NOTES_MAX).replace(/\s+\S*$/, '')}…` : text;
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

// The latest published release (no drafts, no pre-releases), or null.
async function latestRelease() {
  const release = await github('/releases/latest');
  const version = parseVersion(release?.tag_name);
  if (!release || !version) return null;
  return {
    version: version.join('.'),
    tag: release.tag_name,
    name: release.name || release.tag_name,
    date: release.published_at || null,
    url: release.html_url,
    notes: shortNotes(release.body),
  };
}

// overlay: { settings, changed(), saveSettings(), notify(title, body, onClick) }.
function setupVersionCheck(overlay) {
  const { settings } = overlay;
  const local = localCommit();
  const channel = channelOf(local);
  // status: off | checking | error | unknown (nothing to compare with), and
  // - release: current | update (a newer release) | ahead (newer than the
  //   latest release);
  // - others: current | behind | ahead | diverged | local (our commit is not
  //   on GitHub).
  let state = { status: 'checking', local, latest: null, behindBy: 0, release: null, checkedAt: null, error: null };
  let timer = null;

  function set(next) {
    state = { ...state, ...next };
    if (newRelease() && !skipped()) notifyOnce();
    overlay.changed();
  }

  // A release newer than this app (on any channel; only release builds are
  // told about it loudly).
  const newRelease = () => {
    const ours = parseVersion(pkg.version);
    const theirs = parseVersion(state.release?.version);
    return Boolean(ours && theirs && compareVersions(theirs, ours) > 0);
  };
  const skipped = () => settings.updateSkip === state.release?.version;

  function notifyOnce() {
    if (channel !== 'release' || settings.updateNotified === state.release.version) return;
    settings.updateNotified = state.release.version;
    overlay.saveSettings();
    overlay.notify(state.release.version);
  }

  async function checkRelease() {
    const release = await latestRelease();
    if (!release) return { status: 'unknown', release: null };
    const order = compareVersions(parseVersion(release.version), parseVersion(pkg.version));
    return { status: order > 0 ? 'update' : order < 0 ? 'ahead' : 'current', release };
  }

  async function checkCommits() {
    // The latest release only as information; a failure there must not hide
    // the commit check.
    const release = await latestRelease().catch(() => null);
    if (!REPO || !local) return { status: 'unknown', release };
    const head = await github(`/commits/${BRANCH}`);
    const latest = head && {
      commit: head.sha,
      date: head.commit?.committer?.date || null,
      message: (head.commit?.message || '').split('\n')[0],
    };
    if (!latest) throw new Error('no branch');
    if (latest.commit === local.commit) return { status: 'current', latest, behindBy: 0, release };
    // base = ours, head = GitHub's: "ahead" means GitHub has newer commits.
    const compare = await github(`/compare/${local.commit}...${latest.commit}`);
    const status = !compare
      ? 'local' // Our commit is not on GitHub (not pushed yet).
      : { ahead: 'behind', behind: 'ahead', diverged: 'diverged', identical: 'current' }[compare.status] || 'unknown';
    return { status, latest, behindBy: compare?.ahead_by || 0, release };
  }

  async function check() {
    if (!settings.updateCheck) {
      set({ status: 'off' });
      return;
    }
    if (!REPO) {
      set({ status: 'unknown', checkedAt: Date.now() });
      return;
    }
    set({ status: 'checking', error: null });
    try {
      const result = channel === 'release' ? await checkRelease() : await checkCommits();
      set({ ...result, checkedAt: Date.now() });
    } catch (error) {
      set({ status: 'error', error: error.message, checkedAt: Date.now() });
    }
  }

  function skip() {
    if (!state.release) return;
    settings.updateSkip = state.release.version;
    overlay.saveSettings();
    overlay.changed();
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
    skip,
    channel,
    // For the UI: plus links, whether a newer release exists (`newRelease`),
    // and whether the ⋯ dot / menu badge should show (`attention`).
    state: () => {
      const fresh = newRelease();
      return {
        ...state,
        channel,
        version: pkg.version,
        newRelease: fresh,
        skipped: fresh && skipped(),
        attention: channel === 'release' ? fresh && !skipped() : ['behind', 'diverged'].includes(state.status),
        repoUrl: REPO ? `https://github.com/${REPO}` : null,
        compareUrl: REPO && local && state.latest ? `https://github.com/${REPO}/compare/${local.commit}...${state.latest.commit}` : null,
      };
    },
  };
}

module.exports = { setupVersionCheck, localCommit, parseVersion, compareVersions, shortNotes };
