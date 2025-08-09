const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  maxParallel: 2,
};

function loadConfig() {
  const configPath = path.resolve(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error('Missing config.json in project root');
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const cfg = JSON.parse(raw);

  const token = cfg.token;
  const guildId = cfg.guildId;
  const cliPath = cfg.cliPath;
  const presetsPath = cfg.presetsPath || path.join(cliPath, 'packages', 'core', 'config');
  const outPath = cfg.outPath || path.join(cliPath, 'packages', 'core', 'out');
  const maxParallel = cfg.maxParallel ?? DEFAULTS.maxParallel;

  if (!token || !guildId || !cliPath) {
    throw new Error('config.json must include token, guildId, cliPath');
  }

  return { token, guildId, cliPath, presetsPath, outPath, maxParallel };
}

module.exports = { loadConfig };
