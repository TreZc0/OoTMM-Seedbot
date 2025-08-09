const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./modules/config');
const { createStateManager } = require('./modules/state');
const { listSeedTypes, listAllPresets, resolvePresetFile, buildPresetChoices, resolvePresetSelection, prettyLabelFromName, prettySeedTypeLabel } = require('./modules/presets');
const { Gate } = require('./modules/queue');
const { runGeneration } = require('./modules/generator');
const { formatDuration, getNowMs, logDebug, logInfo, logError } = require('./modules/util');

const cfg = loadConfig();
const { state, save } = createStateManager();
const semaphore = new Gate(cfg.maxParallel);

function buildCommands(seedTypes, presetChoicesInput) {
  const seedTypeChoices = seedTypes.slice(0, 25).map(n => ({ name: prettySeedTypeLabel(n), value: n }));
  const presetChoices = presetChoicesInput.slice(0, 25).map(c => ({ name: c.label, value: c.value }));

  const prepare = new SlashCommandBuilder()
    .setName('prepare')
    .setDescription('Prepare a seed for a preset without posting it')
    .addStringOption((opt) => {
      opt.setName('seedtype').setDescription('Seed type').setRequired(true);
      if (seedTypeChoices.length > 0) opt.addChoices(...seedTypeChoices);
      return opt;
    })
    .addStringOption((opt) => {
      opt.setName('preset').setDescription('Preset').setRequired(true);
      if (presetChoices.length > 0) opt.addChoices(...presetChoices);
      return opt;
    });

  const generate = new SlashCommandBuilder()
    .setName('generate')
    .setDescription('Generate a seed for a preset or use a prepared one')
    .addStringOption((opt) => {
      opt.setName('seedtype').setDescription('Seed type').setRequired(true);
      if (seedTypeChoices.length > 0) opt.addChoices(...seedTypeChoices);
      return opt;
    })
    .addStringOption((opt) => {
      opt.setName('preset').setDescription('Preset').setRequired(true);
      if (presetChoices.length > 0) opt.addChoices(...presetChoices);
      return opt;
    });

  const spoiler = new SlashCommandBuilder()
    .setName('spoiler')
    .setDescription('Get the spoiler log of your most recent seed')
    .addBooleanOption((opt) => opt.setName('public').setDescription('Post publicly in this channel'));

  return [prepare, generate, spoiler].map(c => c.toJSON());
}

async function registerCommands(client, seedTypes, presetNames) {
  const rest = new REST({ version: '10' }).setToken(cfg.token);
  const body = buildCommands(seedTypes, presetNames);
  await rest.put(Routes.applicationGuildCommands(client.user.id, cfg.guildId), { body });
}

async function handlePrepare(interaction, seedType, presetValue) {
  const presetFile = resolvePresetSelection(cfg.presetsPath, seedType, presetValue);
  if (!fs.existsSync(presetFile)) {
    return interaction.reply({ content: `Preset not found: ${presetValue}`, flags: MessageFlags.Ephemeral });
  }

  const tryRelease = semaphore.tryAcquire();
  if (!tryRelease) {
    return interaction.reply({ content: `Generation queue is full. Please wait and try again.`, flags: MessageFlags.Ephemeral });
  }
  const release = tryRelease;
  const resolvedPresetName = path.basename(presetFile, path.extname(presetFile));
  const job = {
    id: interaction.id,
    presetName: presetValue,
    seedType,
    resolvedPresetName,
    authorId: interaction.user.id,
    channelId: interaction.channelId,
    source: 'prepare',
    isPrepared: true,
    requestedAt: getNowMs(),
    startedAt: getNowMs(),
    completedAt: null,
    status: 'running',
    cliCommand: `pnpm run start:core -- --config ${presetFile}`,
    cliExitCode: null,
    error: null,
    seedHash: null,
    outDir: null,
    patchFiles: [],
    spoilerFile: null,
    durationMs: null,
    messageId: null,
  };
  state.active.push(job); save();

  await interaction.reply({ content: `Preparing seed for ${seedType} / “${presetValue}”… This can take a few minutes.`, flags: MessageFlags.Ephemeral });

  try {
    logDebug('Starting preparation generation', { seedType, preset: presetValue, authorId: interaction.user.id });
    const done = await runGeneration({ cliPath: cfg.cliPath, outPath: cfg.outPath, configPath: presetFile });
    job.seedHash = done.seedHash;
    job.outDir = done.outDir;
    job.patchFiles = done.patchFiles;
    job.spoilerFile = done.spoilerFile;
    job.durationMs = done.durationMs;
    job.cliExitCode = done.cliExitCode;
    job.completedAt = getNowMs();
    job.status = 'completed';
    logInfo('Preparation completed', { seedType, preset: presetValue, seedHash: job.seedHash, durationMs: job.durationMs });
    const backlogKey = `${seedType}:${presetValue}`;
    if (!state.backlog[backlogKey]) state.backlog[backlogKey] = [];
    state.backlog[backlogKey].push(job);
    state.history.push({ ...job });
    // keep in active for audit or remove; here we remove from active
    state.active = state.active.filter(j => j.id !== job.id);
    save();
  } catch (e) {
    job.completedAt = getNowMs();
    job.status = 'failed';
    job.error = String(e && e.message || e);
    logError('Preparation failed', { seedType, preset: presetValue, error: job.error });
    state.active = state.active.filter(j => j.id !== job.id);
    state.history.push({ ...job });
    save();
    try { await interaction.followUp({ content: `Preparation failed: ${job.error}`, flags: MessageFlags.Ephemeral }); } catch (_) {}
  } finally {
    release();
  }
}

async function deliverPrepared(interaction, preparedJob) {
  const files = preparedJob.patchFiles.map(fp => ({ attachment: fp, name: path.basename(fp) }));
  const presetLabel = preparedJob.resolvedPresetName ? prettyLabelFromName(preparedJob.resolvedPresetName) : preparedJob.presetName;
  const content = `<@${interaction.user.id}> Seed ready for ${preparedJob.seedType} / “${presetLabel}”. Seed: ${preparedJob.seedHash}. Took ${formatDuration(preparedJob.durationMs)}.`;
  const sent = await interaction.channel.send({ content, files });
  preparedJob.messageId = sent.id;
  state.lastPerUser[interaction.user.id] = preparedJob.id;
  save();
}

async function handleGenerate(interaction, seedType, presetValue) {
  const presetFile = resolvePresetSelection(cfg.presetsPath, seedType, presetValue);
  if (!fs.existsSync(presetFile)) {
    return interaction.reply({ content: `Preset not found: ${presetValue}`, ephemeral: true });
  }

  // Use backlog if available
  const backlogKey = `${seedType}:${presetValue}`;
  const backlogArr = state.backlog[backlogKey] || [];
  if (backlogArr.length > 0) {
    const prepared = backlogArr.shift();
    save();
    if (interaction.replied || interaction.deferred) {
      await deliverPrepared(interaction, prepared);
    } else {
      await interaction.reply({ content: 'Using a prepared seed…' , flags: MessageFlags.Ephemeral });
      await deliverPrepared(interaction, prepared);
    }
    return;
  }

  // Otherwise run full generation
  const tryRelease = semaphore.tryAcquire();
  if (!tryRelease) {
    return interaction.reply({ content: `Generation queue is full. Please wait and try again.`, flags: MessageFlags.Ephemeral });
  }
  const release = tryRelease;
  const resolvedPresetName = path.basename(presetFile, path.extname(presetFile));
  const job = {
    id: interaction.id,
    presetName: presetValue,
    seedType,
    resolvedPresetName,
    authorId: interaction.user.id,
    channelId: interaction.channelId,
    source: 'generate',
    isPrepared: false,
    requestedAt: getNowMs(),
    startedAt: getNowMs(),
    completedAt: null,
    status: 'running',
    cliCommand: `pnpm run start:core -- --config ${presetName}.yml`,
    cliExitCode: null,
    error: null,
    seedHash: null,
    outDir: null,
    patchFiles: [],
    spoilerFile: null,
    durationMs: null,
    messageId: null,
  };
  state.active.push(job); save();

  const isRandom = typeof presetValue === 'string' && presetValue.startsWith('random:');
  const base = isRandom ? presetValue.slice('random:'.length) : presetValue;
  const header = isRandom ? `I will pick a random ${prettyLabelFromName(base)} preset. Good luck!` : '';
  const body = `Generating seed for ${seedType} / “${presetValue}”… This can take several minutes.`;
  await interaction.reply({ content: header ? `${header}\n${body}` : body });

  try {
    logDebug('Starting generation', { seedType, preset: presetValue, authorId: interaction.user.id });
    const done = await runGeneration({ cliPath: cfg.cliPath, outPath: cfg.outPath, configPath: presetFile });
    job.seedHash = done.seedHash;
    job.outDir = done.outDir;
    job.patchFiles = done.patchFiles;
    job.spoilerFile = done.spoilerFile;
    job.durationMs = done.durationMs;
    job.cliExitCode = done.cliExitCode;
    job.completedAt = getNowMs();
    job.status = 'completed';
    logInfo('Generation completed', { seedType, preset: presetValue, seedHash: job.seedHash, durationMs: job.durationMs });
    state.history.push({ ...job });
    state.active = state.active.filter(j => j.id !== job.id);
    save();

    const files = job.patchFiles.map(fp => ({ attachment: fp, name: path.basename(fp) }));
    const presetLabel = job.resolvedPresetName ? prettyLabelFromName(job.resolvedPresetName) : presetValue;
    const content = `<@${interaction.user.id}> Seed ready for ${seedType} / “${presetLabel}”. Seed: ${job.seedHash}. Took ${formatDuration(job.durationMs)}.`;
    const sent = await interaction.channel.send({ content, files });
    job.messageId = sent.id;
    state.lastPerUser[interaction.user.id] = job.id;
    save();
  } catch (e) {
    job.completedAt = getNowMs();
    job.status = 'failed';
    job.error = String(e && e.message || e);
    logError('Generation failed', { presetName, error: job.error });
    state.active = state.active.filter(j => j.id !== job.id);
    state.history.push({ ...job });
    save();
    try { await interaction.followUp({ content: `Generation failed: ${job.error}`, flags: MessageFlags.Ephemeral }); } catch (_) {}
  } finally {
    release();
  }
}

async function handleSpoiler(interaction, makePublic) {
  const lastId = state.lastPerUser[interaction.user.id];
  if (!lastId) {
    return interaction.reply({ content: 'No recent seed found for you.', flags: MessageFlags.Ephemeral });
  }
  const job = state.history.find(j => j.id === lastId) || state.active.find(j => j.id === lastId);
  if (!job || !job.spoilerFile || !fs.existsSync(job.spoilerFile)) {
    return interaction.reply({ content: 'Spoiler file not found for your recent seed.', flags: MessageFlags.Ephemeral });
  }

  if (makePublic) {
    await interaction.reply({ content: `Spoiler for seed ${job.seedHash}`, files: [{ attachment: job.spoilerFile, name: path.basename(job.spoilerFile) }] });
  } else {
    try {
      await interaction.user.send({ content: `Spoiler for seed ${job.seedHash}`, files: [{ attachment: job.spoilerFile, name: path.basename(job.spoilerFile) }] });
      await interaction.reply({ content: `<@${interaction.user.id}> requested the spoiler for seed ${job.seedHash}. Sent via DM.` });
    } catch (e) {
      await interaction.reply({ content: 'Could not DM you. Please enable DMs from server members or use /spoiler public:true.', flags: MessageFlags.Ephemeral });
    }
  }
}

async function main() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });

  const seedTypes = listSeedTypes(cfg.presetsPath);
  const { presetChoices } = buildPresetChoices(cfg.presetsPath);

  client.once('ready', async () => {
    try {
      await registerCommands(client, seedTypes, presetChoices);
      logInfo(`Bot ready as ${client.user.tag}. Registered ${presetChoices.length} presets. Guild: ${cfg.guildId}`);
    } catch (e) {
      logError('Failed to register commands', e);
      process.exitCode = 1;
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      const name = interaction.commandName;
      if (name === 'prepare') {
        const seedType = interaction.options.getString('seedtype', true);
        const preset = interaction.options.getString('preset', true);
        await handlePrepare(interaction, seedType, preset);
      } else if (name === 'generate') {
        const seedType = interaction.options.getString('seedtype', true);
        const preset = interaction.options.getString('preset', true);
        await handleGenerate(interaction, seedType, preset);
      } else if (name === 'spoiler') {
        const makePublic = interaction.options.getBoolean('public') || false;
        await handleSpoiler(interaction, makePublic);
      }
    } catch (e) {
      console.error('Command handling error', e);
      if (!interaction.replied) {
        await interaction.reply({ content: 'An error occurred while handling your command.', flags: MessageFlags.Ephemeral });
      }
    }
  });

  await client.login(cfg.token);
}

main();
