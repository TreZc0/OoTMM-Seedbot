const fs = require('fs');
const path = require('path');

function listPresetNames(presetsPath) {
  if (!fs.existsSync(presetsPath)) return [];
  const entries = fs.readdirSync(presetsPath, { withFileTypes: true });
  const names = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.yml'))
    .map(e => e.name.replace(/\.yml$/i, ''))
    .sort((a, b) => a.localeCompare(b));
  return names;
}

module.exports = { listPresetNames };


