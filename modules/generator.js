const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { delay } = require('./util');

function extractSeedHashFromOutput(outputLine) {
  const line = String(outputLine || '');
  // Prefer explicit OoTMM line: "Hash: <value>"
  const mHash = line.match(/\bHash:\s*([^\r\n]+)/i);
  if (mHash && mHash[1]) {
    return mHash[1].trim();
  }

  return null;
}

// 2 Hour timeout, check every 5 seconds
async function waitForOutputs(outPath, seedHash, timeoutMs = 120 * 60 * 1000) {
  const startedAt = Date.now();
  const targetDir = path.join(outPath, seedHash);

  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(targetDir) && fs.statSync(targetDir).isDirectory()) {
      const files = fs.readdirSync(targetDir).map(f => path.join(targetDir, f));
      const patchFiles = files.filter(f => f.toLowerCase().endsWith('.ootmm'));
      const txtFiles = files.filter(f => f.toLowerCase().endsWith('.txt'));
      const spoilerFile =
        txtFiles.find(f => /spoiler/i.test(path.basename(f))) || txtFiles[0] || null;
      if (patchFiles.length > 0 && spoilerFile) {
        return { outDir: targetDir, patchFiles, spoilerFile };
      }
    }
    await delay(5000);
  }
  throw new Error('Timed out waiting for output files');
}

async function runGeneration({ cliPath, outPath, configPath }) {
  const startedAt = Date.now();
  const args = ['run', 'start:core', '--', '--config', configPath];
  const child = spawn('pnpm', args, { cwd: cliPath, shell: true });

  let seedHash = null;
  let stdoutBuf = '';
  let stderrBuf = '';

  child.stdout.on('data', (data) => {
    const text = data.toString();
    stdoutBuf += text;
    const maybe = extractSeedHashFromOutput(text);
    if (maybe) seedHash = seedHash || maybe;
  });

  child.stderr.on('data', (data) => {
    const text = data.toString();
    stderrBuf += text;
    const maybe = extractSeedHashFromOutput(text);
    if (maybe) seedHash = seedHash || maybe;
  });

  const exitCode = await new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(1));
  });

  // If no seed hash found yet but process succeeded, try to infer the newest folder
  if (!seedHash) {
    try {
      const entries = fs.readdirSync(outPath, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({ name: e.name, time: fs.statSync(path.join(outPath, e.name)).mtimeMs }))
        .sort((a, b) => b.time - a.time);
      if (entries.length > 0) {
        seedHash = entries[0].name;
      }
    } catch (_) {
      // ignore
    }
  }

  if (exitCode !== 0 && !seedHash) {
    const err = new Error(`Generator exited with code ${exitCode}`);
    err.stdout = stdoutBuf;
    err.stderr = stderrBuf;
    err.exitCode = exitCode;
    throw err;
  }

  if (!seedHash) {
    const err = new Error('Seed hash not detected from CLI output');
    err.stdout = stdoutBuf;
    err.stderr = stderrBuf;
    err.exitCode = exitCode;
    throw err;
  }

  const outputs = await waitForOutputs(outPath, seedHash);
  const completedAt = Date.now();
  return {
    seedHash,
    outDir: outputs.outDir,
    patchFiles: outputs.patchFiles,
    spoilerFile: outputs.spoilerFile,
    durationMs: completedAt - startedAt,
    cliExitCode: exitCode,
    stdout: stdoutBuf,
    stderr: stderrBuf,
  };
}

module.exports = { runGeneration };
