const fs = require('fs');
const path = require('path');

function walkYml(root, relDir = '') {
  const absDir = path.join(root, relDir);
  const entries = fs.readdirSync(absDir, { withFileTypes: true });
  const results = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      results.push(...walkYml(root, path.join(relDir, e.name)));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.yml')) {
      const presetName = e.name.replace(/\.yml$/i, '');
      const parts = relDir ? [relDir, presetName] : [presetName];
      const label = parts.join(': ');
      results.push(label);
    }
  }
  return results;
}

function listPresetNames(presetsPath) {
  if (!fs.existsSync(presetsPath)) return [];
  const names = walkYml(presetsPath, '')
    .sort((a, b) => a.localeCompare(b));
  return names;
}

module.exports = { listPresetNames };


