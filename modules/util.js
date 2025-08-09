const path = require('path');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function getNowMs() {
  return Date.now();
}

function safeJoin(...parts) {
  return path.join(...parts);
}

function logDebug(...args) {
  console.log('[DEBUG]', ...args);
}

function logInfo(...args) {
  console.log('[INFO]', ...args);
}

function logError(...args) {
  console.error('[ERROR]', ...args);
}

module.exports = { delay, formatDuration, getNowMs, safeJoin, logDebug, logInfo, logError };
