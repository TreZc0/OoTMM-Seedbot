const fs = require('fs');
const path = require('path');

function scanSeedTypesAndPresets(presetsPath) {
  const result = {};
  if (!fs.existsSync(presetsPath)) return result;
  const entries = fs.readdirSync(presetsPath, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const seedType = e.name;
    const dir = path.join(presetsPath, seedType);
    const files = fs.readdirSync(dir, { withFileTypes: true });
    const presetNames = [];
    for (const f of files) {
      if (!f.isFile()) continue;
      const lower = f.name.toLowerCase();
      if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
        const baseName = f.name.replace(/\.(yml|yaml)$/i, '');
        presetNames.push(baseName);
      }
    }
    presetNames.sort((a, b) => a.localeCompare(b));
    result[seedType] = presetNames;
  }
  return result;
}

function listSeedTypes(presetsPath) {
  return Object.keys(scanSeedTypesAndPresets(presetsPath)).sort((a, b) => a.localeCompare(b));
}

function listAllPresets(presetsPath) {
  const map = scanSeedTypesAndPresets(presetsPath);
  const set = new Set();
  for (const presets of Object.values(map)) {
    for (const p of presets) set.add(p);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function resolvePresetFile(presetsPath, seedType, presetName) { 
  const yml = path.join(presetsPath, seedType, `${presetName}.yml`);
  if (fs.existsSync(yml)) return yml;
  const yaml = path.join(presetsPath, seedType, `${presetName}.yaml`);
  if (fs.existsSync(yaml)) return yaml;
  return yaml; // default guess
}

function toBaseName(name) {
  const m = name.match(/^(.*?)-([a-z])$/i);
  if (m) return m[1];
  return name;
}

function prettyLabelFromName(name) {
  const m = name.match(/^(.*?)-([a-z])$/i);
  const base = m ? m[1] : name;
  const option = m ? m[2].toLowerCase() : null;
  const cap = base.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  if (option) return `${cap} (Option ${option})`;
  return cap;
}

function buildPresetChoices(presetsPath) {
  const map = scanSeedTypesAndPresets(presetsPath);
  const seedTypes = Object.keys(map).sort((a, b) => a.localeCompare(b));
  const baseToHasVariants = new Map();
  const baseSet = new Set();

  for (const presets of Object.values(map)) {
    const grouped = {};
    for (const name of presets) {
      const base = toBaseName(name);
      baseSet.add(base);
      if (!grouped[base]) grouped[base] = [];
      grouped[base].push(name);
    }
    for (const [base, arr] of Object.entries(grouped)) {
      if (arr.length > 1) baseToHasVariants.set(base, true);
    }
  }

  const presetChoices = [];
  for (const base of Array.from(baseSet).sort((a, b) => a.localeCompare(b))) {
    const label = prettyLabelFromName(base);
    presetChoices.push({ value: base, label });
    if (baseToHasVariants.get(base)) {
      presetChoices.push({ value: `random:${base}`, label: `${label} (random)` });
    }
  }
  return { seedTypes, presetChoices };
}

function resolvePresetSelection(presetsPath, seedType, presetValue) {
  const isRandom = presetValue.startsWith('random:');
  const base = isRandom ? presetValue.slice('random:'.length) : presetValue;
  const map = scanSeedTypesAndPresets(presetsPath);
  const names = map[seedType] || [];
  // exact base file
  const direct = resolvePresetFile(presetsPath, seedType, base);
  if (!isRandom && fs.existsSync(direct)) return direct;
  // find variants for base
  const variants = names.filter(n => toBaseName(n) === base);
  if (variants.length === 0) return direct;
  const pick = isRandom ? variants[Math.floor(Math.random() * variants.length)] : variants.sort()[0];
  return resolvePresetFile(presetsPath, seedType, pick);
}

module.exports = { scanSeedTypesAndPresets, listSeedTypes, listAllPresets, resolvePresetFile, buildPresetChoices, resolvePresetSelection, prettyLabelFromName };



