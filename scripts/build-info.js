'use strict';

// Writes build-info.json before a build: the commit the app is built from
// (and whether there were uncommitted changes), and the channel: 'release'
// (GitHub Actions, from a v* tag), 'ci' (GitHub Actions, any other ref) or
// 'local' (built on a PC). The app checks for updates by channel
// (version-check.js): a release against GitHub's latest release, the others
// against the newest commit; a packaged app has no .git to read it from.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const git = (args) => execSync(`git ${args}`, { encoding: 'utf8' }).trim();

const ci = process.env.GITHUB_ACTIONS === 'true';
const refName = process.env.GITHUB_REF_NAME || '';
const tag = ci && process.env.GITHUB_REF_TYPE === 'tag' && /^v\d/.test(refName) ? refName : null;
const channel = tag ? 'release' : ci ? 'ci' : 'local';

let info = { commit: null, date: null, dirty: false };
try {
  info = {
    commit: git('rev-parse HEAD'),
    date: git('log -1 --format=%cI'),
    dirty: git('status --porcelain --untracked-files=no') !== '',
  };
} catch (error) {
  console.warn('build-info: git is not available, building without a commit:', error.message);
}
info = { ...info, channel, tag };
fs.writeFileSync(path.join(__dirname, '..', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: ${channel}${tag ? ` ${tag}` : ''} ${info.commit ? info.commit.slice(0, 7) : 'unknown'}${info.dirty ? ' + local changes' : ''}`);
