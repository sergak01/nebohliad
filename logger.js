'use strict';

// Event log for the main process: userData/logs/nebohliad.log, rotated at
// 1 MB (three older files kept). One line per event:
//   2026-10-20T08:12:18.123Z WARN [stream] video reset {"reason":"resume"}
// An identical line again within a minute is not written again; when it next
// comes after that, a note says how often it came in between. Never log
// target positions or location coordinates (README: no target history).

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_BYTES = 1_000_000;
const KEEP = 3;
const REPEAT_WINDOW_MS = 60_000;

let file = null;
const recent = new Map(); // "scope message" -> { at, repeats }

function logFile() {
  if (!file) {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'nebohliad.log');
  }
  return file;
}

function rotate(target) {
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    return; // No file yet.
  }
  if (size < MAX_BYTES) return;
  for (let i = KEEP - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${target}.${i}`, `${target}.${i + 1}`);
    } catch {
      // That one does not exist yet.
    }
  }
  try {
    fs.renameSync(target, `${target}.1`);
  } catch {
    // Locked or gone: keep appending.
  }
}

function append(line) {
  try {
    const target = logFile();
    rotate(target);
    fs.appendFileSync(target, `${line}\n`);
  } catch {
    // A log that cannot be written must never break the app.
  }
}

function write(level, scope, message, details) {
  const extra = details === undefined ? '' : ` ${typeof details === 'string' ? details : JSON.stringify(details)}`;
  // Only identical lines are collapsed: the same message with other details
  // (a viewer count, a reason) is news.
  const key = `${level} ${scope} ${message}${extra}`;
  const now = Date.now();
  const seen = recent.get(key);
  if (seen && now - seen.at < REPEAT_WINDOW_MS) {
    seen.repeats++;
    return;
  }
  if (seen?.repeats) append(`${new Date(now).toISOString()} ${level} [${scope}] ("${message}${extra}" also came ${seen.repeats} more times in the last minute)`);
  recent.set(key, { at: now, repeats: 0 });
  if (recent.size > 500) recent.clear();
  const line = `${new Date(now).toISOString()} ${level} [${scope}] ${message}${extra}`;
  (level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log)(line);
  append(line);
}

module.exports = {
  info: (scope, message, details) => write('INFO', scope, message, details),
  warn: (scope, message, details) => write('WARN', scope, message, details),
  error: (scope, message, details) => write('ERROR', scope, message, details),
  dir: () => path.dirname(logFile()),
};
