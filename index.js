const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, AttachmentBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
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
    .setDescription('Prepare a seed for a preset and store it for later')
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
    .setDescription('Generate a seed for a preset')
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

  const info = new SlashCommandBuilder()
    .setName('info')
    .setDescription('Show information about seed rolling and commands');

  return [prepare, generate, spoiler, info].map(c => c.toJSON());
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

  const isRandomPrep = typeof presetValue === 'string' && presetValue.startsWith('random:');
  const basePrep = isRandomPrep ? presetValue.slice('random:'.length) : presetValue;
  const seedTypeLabelPrep = prettySeedTypeLabel(seedType);
  const presetStartLabelPrep = isRandomPrep ? `${prettyLabelFromName(basePrep)} (random)` : prettyLabelFromName(presetValue);
  const introPrep = isRandomPrep
    ? `Sure thing! I started generating a seed with a random ${prettyLabelFromName(basePrep)} (${seedTypeLabelPrep}) preset. The full preset choice will not be visible until you open the seed. It will not be posted publicly, but available if another user runs /generate with this preset.\nThis can take a few minutes.`
    : `Sure thing! I started generating a seed with the ${presetStartLabelPrep} (${seedTypeLabelPrep}) preset. It will not be posted publicly, but available if another user runs /generate with this preset.\nThis can take a few minutes.`;
  await interaction.reply({ content: introPrep, flags: MessageFlags.Ephemeral });

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

    // Ephemeral completion notice
    const doneMsg = isRandomPrep
      ? `Preparation complete. It was rolled with a random ${prettyLabelFromName(basePrep)} (${seedTypeLabelPrep}) preset. The full preset choice will be visible once the seed is opened.\nSeed-Hash: ${job.seedHash}. Took ${formatDuration(job.durationMs)}.`
      : `Preparation complete. It was rolled with the ${presetStartLabelPrep} (${seedTypeLabelPrep}) preset.\nSeed-Hash: ${job.seedHash}. Took ${formatDuration(job.durationMs)}.`;
    try { await interaction.followUp({ content: doneMsg, flags: MessageFlags.Ephemeral }); } catch (_) {}
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
  const isRandom = typeof preparedJob.presetName === 'string' && preparedJob.presetName.startsWith('random:');
  const presetLabel = (() => {
    if (isRandom) {
      const base = preparedJob.presetName.slice('random:'.length);
      return `${prettyLabelFromName(base)} (random)`;
    }
    return preparedJob.resolvedPresetName ? prettyLabelFromName(preparedJob.resolvedPresetName) : prettyLabelFromName(preparedJob.presetName);
  })();
  const seedTypeLabel = prettySeedTypeLabel(preparedJob.seedType);
  const rolledLine = isRandom
    ? `It was rolled with a random ${presetLabel.replace(' (random)', '')} (${seedTypeLabel}) preset. The full preset choice will be visible once the seed is opened.`
    : `It was rolled with the ${presetLabel} (${seedTypeLabel}) preset.`;
  const content = `<@${interaction.user.id}> **Your seed is ready**!\n ${rolledLine}\nSeed-Hash: ${preparedJob.seedHash}.\nTook ${formatDuration(preparedJob.durationMs)}.`;
  const sent = await interaction.channel.send({ content, files });
  preparedJob.messageId = sent.id;
  state.lastPerUser[interaction.user.id] = preparedJob.id;
  save();
}

async function handleInfo(interaction) {
  const embed = new EmbedBuilder()
    .setTitle('OoTMM Seedbot')
    .setDescription('Generate OoTMM seeds using presets and seed types, and fetch spoiler logs.')
    .setColor(0x5B2D82)
    .setThumbnail('https://ootmm.com/assets/logo-CeNcdzMo.png')
    .addFields(
      { name: 'How it works', value: 'OoTMM Randomizer seeds are rolled based on your selected seed type (Solo, Solo Multiworld (3 Players), Race Multiworld (2 Teams of 3 players)) and preset. If the queue is full, please wait and try again. Random presets pick one of the available variant options.' },
      { name: 'Commands', value: '**/generate** – generates a new seed rolled with a preset of choice\n**/spoiler** – gets the spoiler log for your most recent seed' },
      { name: 'Concurrency', value: `Up to ${cfg.maxParallel} seed(s) can be rolled at the same time.` },
      { name: 'Outputs', value: 'When ready, the bot posts .ootmm patch file(s) and the seed hash which you can compare to your patch file name. Spoilers are never posted automatically; use /spoiler to retrieve them (DM by default).' }
    )
    .setFooter({ text: 'OoTMM Seedbot created by TreZ' });

  await interaction.reply({ embeds: [embed] });
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
    const fluff = "No need to generate a seed! I found something ready in TreZ's basement. Here's an old seed he had lying around for some reason.";
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: fluff });
    } else {
      await interaction.reply({ content: fluff });
    }
    await deliverPrepared(interaction, prepared);
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

  const isRandom = typeof presetValue === 'string' && presetValue.startsWith('random:');
  const base = isRandom ? presetValue.slice('random:'.length) : presetValue;
  const seedTypeLabel = prettySeedTypeLabel(seedType);
  const prettyPreset = isRandom ? `${prettyLabelFromName(base)} (random)` : prettyLabelFromName(presetValue);
  const header = isRandom ? `I will pick a random ${prettyLabelFromName(base)} preset. Good luck!` : '';
  const body = isRandom
    ? `Sure thing! I started generating your seed with a random ${prettyLabelFromName(base)} (${seedTypeLabel}) preset. The full preset choice will not be visible until you open the seed.\n Please be patient. This might take a while.`
    : `Sure thing! I started generating your seed with the ${prettyPreset} (${seedTypeLabel}) preset.\n Please be patient. This might take a while.`;
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
    const random = typeof presetValue === 'string' && presetValue.startsWith('random:');
    const presetLabel = (() => {
      if (random) {
        const base = presetValue.slice('random:'.length);
        return `${prettyLabelFromName(base)} (random)`;
      }
      return job.resolvedPresetName ? prettyLabelFromName(job.resolvedPresetName) : prettyLabelFromName(presetValue);
    })();
    const seedTypeLabel2 = prettySeedTypeLabel(seedType);
    const rolledLine2 = random
      ? `It was rolled with a random ${presetLabel.replace(' (random)', '')} (${seedTypeLabel2}) preset. The full preset choice will be visible when you open the seed.`
      : `It was rolled with the ${presetLabel} (${seedTypeLabel2}) preset.`;
    const content = `<@${interaction.user.id}> **Your seed is ready**!\n ${rolledLine2}\nSeed-Hash: ${job.seedHash}.\nTook ${formatDuration(job.durationMs)}.`;
    const sent = await interaction.channel.send({ content, files });
    job.messageId = sent.id;
    state.lastPerUser[interaction.user.id] = job.id;
    save();
  } catch (e) {
    job.completedAt = getNowMs();
    job.status = 'failed';
    job.error = String(e && e.message || e);
    logError('Generation failed', { seedType, preset: presetValue, error: job.error });
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
    return interaction.reply({ content: 'I cannot find any recently generated seeds for you.', flags: MessageFlags.Ephemeral });
  }
  const job = state.history.find(j => j.id === lastId) || state.active.find(j => j.id === lastId);
  if (!job || !job.spoilerFile || !fs.existsSync(job.spoilerFile)) {
    return interaction.reply({ content: 'Spoiler file not found for your recent seed.', flags: MessageFlags.Ephemeral });
  }

  if (makePublic) {
    await interaction.reply({ content: `Spoiler for seed ${job.seedHash}`, files: [{ attachment: job.spoilerFile, name: path.basename(job.spoilerFile) }] });
  } else {
    try {
      await interaction.user.send({ content: `Hey, here is the spoiler log for your seed ${job.seedHash}`, files: [{ attachment: job.spoilerFile, name: path.basename(job.spoilerFile) }] });
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
      } else if (name === 'info') {
        await handleInfo(interaction);
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
