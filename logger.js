// logger.js — Aigentik logging system
import fs from 'fs';
import path from 'path';
import config from './config.json' with { type: 'json' };

const logsDir = config.paths.logs_dir;

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

function getLogFile() {
  const date = new Date().toISOString().split('T')[0];
  return path.join(logsDir, `aigentik-${date}.log`);
}

function timestamp() {
  return new Date().toISOString();
}

function writeLog(level, category, message, data) {
  const line = JSON.stringify({ time: timestamp(), level, category, message, ...(data ? { data } : {}) });
  const display = `[${timestamp()}] [${level}] [${category}] ${message}`;
  if (level === 'ERROR') { console.error(display); } else { console.log(display); }
  try { fs.appendFileSync(getLogFile(), line + '\n'); } catch (e) {}
}

const log = {
  info:   (c, m, d) => writeLog('INFO',   c, m, d),
  warn:   (c, m, d) => writeLog('WARN',   c, m, d),
  error:  (c, m, d) => writeLog('ERROR',  c, m, d),
  debug:  (c, m, d) => writeLog('DEBUG',  c, m, d),
  action: (c, m, d) => writeLog('ACTION', c, m, d)
};

export default log;