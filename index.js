const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, AttachmentBuilder, InteractionContextType } = require('discord.js');
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('./modules/config');
const { createStateManager } = require('./modules/state');
const { listPresetNames } = require('./modules/presets');
const { Gate } = require('./modules/queue');
const { runGeneration } = require('./modules/generator');
const { formatDuration, getNowMs } = require('./modules/util');

const cfg = loadConfig();
const { state, save } = createStateManager();
const semaphore = new Gate(cfg.maxParallel);

function buildCommands(presetNames) {
  const presetChoices = presetNames.slice(0, 25).map(n => ({ name: n, value: n }));

  const prepare = new SlashCommandBuilder()
    .setName('prepare')
    .setDescription('Prepare a seed for a preset without posting it')
    .addStringOption((opt) => {
      opt.setName('preset').setDescription('Preset to prepare').setRequired(true);
      if (presetChoices.length > 0) opt.addChoices(...presetChoices);
      return opt;
    });

  const generate = new SlashCommandBuilder()
    .setName('generate')
    .setDescription('Generate a seed for a preset or use a prepared one')
    .addStringOption((opt) => {
      opt.setName('preset').setDescription('Preset to generate').setRequired(true);
      if (presetChoices.length > 0) opt.addChoices(...presetChoices);
      return opt;
    });

  const spoiler = new SlashCommandBuilder()
    .setName('spoiler')
    .setDescription('Get the spoiler log of your most recent seed')
    .addBooleanOption((opt) => opt.setName('public').setDescription('Post publicly in this channel'));

  return [prepare, generate, spoiler].map(c => c.toJSON());
}

async function registerCommands(client, presetNames) {
  const rest = new REST({ version: '10' }).setToken(cfg.token);
  const body = buildCommands(presetNames);
  await rest.put(Routes.applicationGuildCommands(client.user.id, cfg.guildId), { body });
}

async function handlePrepare(interaction, presetName) {
  const presetFile = path.join(cfg.presetsPath, `${presetName}.yml`);
  if (!fs.existsSync(presetFile)) {
    return interaction.reply({ content: `Preset not found: ${presetName}`, ephemeral: true });
  }

  const tryRelease = semaphore.tryAcquire();
  if (!tryRelease) {
    return interaction.reply({ content: `Generation queue is full. Please wait and try again.`, ephemeral: true });
  }
  const release = tryRelease;
  const job = {
    id: interaction.id,
    presetName,
    authorId: interaction.user.id,
    channelId: interaction.channelId,
    source: 'prepare',
    isPrepared: true,
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

  await interaction.reply({ content: `Preparing seed for preset “${presetName}”… This can take a few minutes.`, ephemeral: true });

  try {
    const done = await runGeneration({ cliPath: cfg.cliPath, outPath: cfg.outPath, presetName });
    job.seedHash = done.seedHash;
    job.outDir = done.outDir;
    job.patchFiles = done.patchFiles;
    job.spoilerFile = done.spoilerFile;
    job.durationMs = done.durationMs;
    job.cliExitCode = done.cliExitCode;
    job.completedAt = getNowMs();
    job.status = 'completed';
    if (!state.backlog[presetName]) state.backlog[presetName] = [];
    state.backlog[presetName].push(job);
    state.history.push({ ...job });
    // keep in active for audit or remove; here we remove from active
    state.active = state.active.filter(j => j.id !== job.id);
    save();
  } catch (e) {
    job.completedAt = getNowMs();
    job.status = 'failed';
    job.error = String(e && e.message || e);
    state.active = state.active.filter(j => j.id !== job.id);
    state.history.push({ ...job });
    save();
    try { await interaction.followUp({ content: `Preparation failed: ${job.error}`, ephemeral: true }); } catch (_) {}
  } finally {
    release();
  }
}

async function deliverPrepared(interaction, preparedJob) {
  const files = preparedJob.patchFiles.map(fp => ({ attachment: fp, name: path.basename(fp) }));
  const content = `<@${interaction.user.id}> Seed ready for preset “${preparedJob.presetName}”. Seed: ${preparedJob.seedHash}. Took ${formatDuration(preparedJob.durationMs)}.`;
  const sent = await interaction.channel.send({ content, files });
  preparedJob.messageId = sent.id;
  state.lastPerUser[interaction.user.id] = preparedJob.id;
  save();
}

async function handleGenerate(interaction, presetName) {
  const presetFile = path.join(cfg.presetsPath, `${presetName}.yml`);
  if (!fs.existsSync(presetFile)) {
    return interaction.reply({ content: `Preset not found: ${presetName}`, ephemeral: true });
  }

  // Use backlog if available
  const backlogArr = state.backlog[presetName] || [];
  if (backlogArr.length > 0) {
    const prepared = backlogArr.shift();
    save();
    if (interaction.replied || interaction.deferred) {
      await deliverPrepared(interaction, prepared);
    } else {
      await interaction.reply({ content: 'Using a prepared seed…' , ephemeral: true });
      await deliverPrepared(interaction, prepared);
    }
    return;
  }

  // Otherwise run full generation
  const tryRelease = semaphore.tryAcquire();
  if (!tryRelease) {
    return interaction.reply({ content: `Generation queue is full. Please wait and try again.`, ephemeral: true });
  }
  const release = tryRelease;
  const job = {
    id: interaction.id,
    presetName,
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

  await interaction.reply({ content: `Generating seed for preset “${presetName}”… This can take several minutes.`, ephemeral: true });

  try {
    const done = await runGeneration({ cliPath: cfg.cliPath, outPath: cfg.outPath, presetName });
    job.seedHash = done.seedHash;
    job.outDir = done.outDir;
    job.patchFiles = done.patchFiles;
    job.spoilerFile = done.spoilerFile;
    job.durationMs = done.durationMs;
    job.cliExitCode = done.cliExitCode;
    job.completedAt = getNowMs();
    job.status = 'completed';
    state.history.push({ ...job });
    state.active = state.active.filter(j => j.id !== job.id);
    save();

    const files = job.patchFiles.map(fp => ({ attachment: fp, name: path.basename(fp) }));
    const content = `<@${interaction.user.id}> Seed ready for preset “${presetName}”. Seed: ${job.seedHash}. Took ${formatDuration(job.durationMs)}.`;
    const sent = await interaction.channel.send({ content, files });
    job.messageId = sent.id;
    state.lastPerUser[interaction.user.id] = job.id;
    save();
  } catch (e) {
    job.completedAt = getNowMs();
    job.status = 'failed';
    job.error = String(e && e.message || e);
    state.active = state.active.filter(j => j.id !== job.id);
    state.history.push({ ...job });
    save();
    try { await interaction.followUp({ content: `Generation failed: ${job.error}`, ephemeral: true }); } catch (_) {}
  } finally {
    release();
  }
}

async function handleSpoiler(interaction, makePublic) {
  const lastId = state.lastPerUser[interaction.user.id];
  if (!lastId) {
    return interaction.reply({ content: 'No recent seed found for you.', ephemeral: true });
  }
  const job = state.history.find(j => j.id === lastId) || state.active.find(j => j.id === lastId);
  if (!job || !job.spoilerFile || !fs.existsSync(job.spoilerFile)) {
    return interaction.reply({ content: 'Spoiler file not found for your recent seed.', ephemeral: true });
  }

  if (makePublic) {
    await interaction.reply({ content: `Spoiler for seed ${job.seedHash}`, files: [{ attachment: job.spoilerFile, name: path.basename(job.spoilerFile) }] });
  } else {
    try {
      await interaction.user.send({ content: `Spoiler for seed ${job.seedHash}`, files: [{ attachment: job.spoilerFile, name: path.basename(job.spoilerFile) }] });
      await interaction.reply({ content: 'Sent you the spoiler via DM.', ephemeral: true });
    } catch (e) {
      await interaction.reply({ content: 'Could not DM you. Please enable DMs from server members or use /spoiler public:true.', ephemeral: true });
    }
  }
}

async function main() {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });

  const presetNames = listPresetNames(cfg.presetsPath);

  client.once('ready', async () => {
    try {
      await registerCommands(client, presetNames);
      console.log(`Logged in as ${client.user.tag}. Registered ${presetNames.length} presets.`);
    } catch (e) {
      console.error('Failed to register commands', e);
      process.exitCode = 1;
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      const name = interaction.commandName;
      if (name === 'prepare') {
        const preset = interaction.options.getString('preset', true);
        await handlePrepare(interaction, preset);
      } else if (name === 'generate') {
        const preset = interaction.options.getString('preset', true);
        await handleGenerate(interaction, preset);
      } else if (name === 'spoiler') {
        const makePublic = interaction.options.getBoolean('public') || false;
        await handleSpoiler(interaction, makePublic);
      }
    } catch (e) {
      console.error('Command handling error', e);
      if (!interaction.replied) {
        await interaction.reply({ content: 'An error occurred while handling your command.', ephemeral: true });
      }
    }
  });

  await client.login(cfg.token);
}

main();
