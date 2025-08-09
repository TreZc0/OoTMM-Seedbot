const fs = require('fs');
const path = require('path');

const STATE_PATH = path.resolve(process.cwd(), 'state.json');

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return {
      version: 1,
      active: [],
      backlog: {},
      history: [],
      lastPerUser: {},
    };
  }
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const state = JSON.parse(raw);
    state.active = Array.isArray(state.active) ? state.active : [];
    state.backlog = state.backlog && typeof state.backlog === 'object' ? state.backlog : {};
    state.history = Array.isArray(state.history) ? state.history : [];
    state.lastPerUser = state.lastPerUser && typeof state.lastPerUser === 'object' ? state.lastPerUser : {};
    return state;
  } catch (e) {
    console.error('Failed to load state.json, starting fresh', e);
    return {
      version: 1,
      active: [],
      backlog: {},
      history: [],
      lastPerUser: {},
    };
  }
}

function persistState(state) {
  const tmpPath = STATE_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpPath, STATE_PATH);
}

function createStateManager() {
  const state = loadState();

  function save() {
    persistState(state);
  }

  function onShutdown() {
    try {
      save();
    } catch (e) {
      console.error('Failed to persist state on shutdown', e);
    }
  }

  process.on('SIGINT', () => { onShutdown(); process.exit(0); });
  process.on('SIGTERM', () => { onShutdown(); process.exit(0); });
  process.on('beforeExit', () => { onShutdown(); });

  return { state, save };
}

module.exports = { createStateManager };
