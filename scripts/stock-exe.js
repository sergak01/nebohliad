'use strict';

// For running the build on a PC with Smart App Control (Windows 11): put the
// unmodified electron.exe from node_modules in place of dist\win-unpacked\
// Nebohliad.exe.
//
// electron-builder edits the exe on every build (icon, version info, the
// app.asar hash), so each build is a file Microsoft has never seen, and Smart
// App Control may block it. The stock electron.exe is a known file that runs;
// it loads resources\app.asar next to it just the same. Only the exe's own
// icon and file details are Electron's (windows still show ours).
//
// Usage: npm run dist:local (= dist:dir, then this).

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const stock = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const target = path.join(root, 'dist', 'win-unpacked', 'Nebohliad.exe');

const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const wanted = require(path.join(root, 'package.json')).devDependencies.electron.replace(/^[^\d]*/, '');
if (!fs.existsSync(target)) throw new Error(`No build at ${target}: run "npm run dist:dir" first.`);
if (electronVersion.split('.')[0] !== wanted.split('.')[0]) {
  throw new Error(`node_modules has Electron ${electronVersion}, the build expects ${wanted}`);
}
if (require(path.join(root, 'package.json')).build.electronFuses) {
  throw new Error('Electron fuses are configured: the stock exe would not carry them.');
}
fs.copyFileSync(stock, target);
console.log(`stock-exe: dist\\win-unpacked\\Nebohliad.exe is now the unmodified electron.exe ${electronVersion}`);
