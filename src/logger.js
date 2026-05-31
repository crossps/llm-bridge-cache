'use strict';

// Tiny leveled logger. Zero dependencies. Warn/error go to stderr.

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, silent: 99 };
const COLORS = { trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

let currentLevel = LEVELS.info;
const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;

function setLevel(name) {
  const lvl = LEVELS[String(name || '').toLowerCase()];
  if (lvl !== undefined) currentLevel = lvl;
}

function stamp() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function log(level, args) {
  if (LEVELS[level] < currentLevel) return;
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLORS[level] || ''}${tag}${RESET}` : tag;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${stamp()} ${head} ${args.map(fmt).join(' ')}\n`);
}

module.exports = {
  LEVELS,
  setLevel,
  trace: (...a) => log('trace', a),
  debug: (...a) => log('debug', a),
  info: (...a) => log('info', a),
  warn: (...a) => log('warn', a),
  error: (...a) => log('error', a),
};
