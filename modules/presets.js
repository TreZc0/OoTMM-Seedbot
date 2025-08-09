const fs = require('fs');
const path = require('path');

function walkPresets(root, relDir = '') {
  const absDir = path.join(root, relDir);
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const results = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      results.push(...walkPresets(root, path.join(relDir, e.name)));
    } else if (e.isFile()) {
      const lower = e.name.toLowerCase();
      if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
        const ext = lower.endsWith('.yaml') ? '.yaml' : '.yml';
        const baseName = e.name.replace(/\.(yml|yaml)$/i, '');
        const topFolder = relDir ? relDir.split(path.sep)[0] : '';
        const label = topFolder ? `${topFolder}: ${baseName}` : baseName;
        const relPath = path.join(relDir, e.name).replace(/\\/g, '/');
        results.push({ label, relPath });
      }
    }
  }
  return results;
}

function scanPresets(presetsPath) {
  if (!fs.existsSync(presetsPath)) return [];
  const items = walkPresets(presetsPath, '')
    .sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

function listPresetNames(presetsPath) {
  return scanPresets(presetsPath).map(p => p.label);
}

module.exports = { scanPresets, listPresetNames };


