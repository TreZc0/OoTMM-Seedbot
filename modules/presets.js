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
  const presetChoices = [];
  // Build choices across all seed types, but labels are independent of seed type
  const globalGrouped = {};
  for (const presets of Object.values(map)) {
    for (const name of presets) {
      const base = toBaseName(name);
      if (!globalGrouped[base]) globalGrouped[base] = new Set();
      globalGrouped[base].add(name);
    }
  }

  const bases = Object.keys(globalGrouped).sort((a, b) => a.localeCompare(b));
  for (const base of bases) {
    const variants = Array.from(globalGrouped[base]).sort((a, b) => a.localeCompare(b));
    if (variants.length > 1) {
      // Add each concrete variant as its own choice
      for (const variant of variants) {
        presetChoices.push({ value: variant, label: prettyLabelFromName(variant) });
      }
      // Add random choice for this base
      presetChoices.push({ value: `random:${base}`, label: `${prettyLabelFromName(base)} (random)` });
    } else {
      // Only one preset, present as a single choice
      const only = variants[0];
      presetChoices.push({ value: only, label: prettyLabelFromName(only) });
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

function prettySeedTypeLabel(name) {
  const spaced = String(name || '').replace(/[-_]+/g, ' ').trim();
  if (!spaced) return '';
  return spaced.split(/\s+/).map(part => {
    if (part.toLowerCase() === 'mw') return 'MW';
    return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
  }).join(' ');
}

module.exports = { scanSeedTypesAndPresets, listSeedTypes, listAllPresets, resolvePresetFile, buildPresetChoices, resolvePresetSelection, prettyLabelFromName, prettySeedTypeLabel };



