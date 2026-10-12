'use strict';
// Spike C (Task 5.1) - THROWAWAY. Windows only. Node built-ins only.
// Tests spawn(command, { shell: true, cwd, windowsHide: true }) for:
//   A. stdout/stderr/exit code capture
//   B. process-tree kill with `taskkill /PID <root> /T /F` and orphan check
//   C. missing-executable behavior and the did_not_execute distinction
const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.error('Spike C is Windows-only (process.platform !== "win32"). Stopping.');
  process.exit(2);
}

const FIXTURES = path.join(__dirname, 'fixtures');
const MISSING = 'kirosight_definitely_missing_executable_5_1';
const knownPids = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spike-only runner: collects everything the real runner would need to know. */
function run(command, { timeoutMs, onOutput } = {}) {
  return new Promise((resolve) => {
    const result = {
      command, rootPid: undefined, stdout: '', stderr: '', spawnError: null,
      exitCode: undefined, signal: undefined, closeFired: false, exitFired: false, timedOut: false,
    };
    const options = { shell: true, cwd: FIXTURES, windowsHide: true };
    const child = spawn(command, options);
    result.child = child;
    result.rootPid = child.pid;
    if (child.pid !== undefined) knownPids.add(child.pid);
    child.stdout.on('data', (d) => { result.stdout += d; onOutput?.(result); });
    child.stderr.on('data', (d) => { result.stderr += d; });
    child.on('error', (e) => { result.spawnError = { code: e.code, message: e.message }; });
    child.on('exit', (code, signal) => { result.exitFired = true; result.exitCode = code; result.signal = signal; });
    child.on('close', (code, signal) => {
      result.closeFired = true;
      result.exitCode = code;
      result.signal = signal;
      clearTimeout(timer);
      resolve(result);
    });
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      result.timedOut = true;
      result.killed = taskkillTree(child.pid);
    }, timeoutMs);
    // A spawn error may never produce 'close'; do not hang.
    child.on('error', () => setTimeout(() => { if (!result.closeFired) resolve(result); }, 500));
  });
}

function taskkillTree(pid) {
  const args = ['/PID', String(pid), '/T', '/F'];
  const r = spawnSync('taskkill', args, { encoding: 'utf8', windowsHide: true });
  return { args, status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function imageName(pid) {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const line = r.stdout.trim();
  return line.startsWith('"') ? line.split('","')[0].replace(/^"/, '') : null;
}

function aliveByTasklist(pid) {
  return imageName(pid) !== null;
}

function aliveByKill0(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function waitGone(pids, maxMs) {
  const start = Date.now();
  for (;;) {
    const alive = pids.filter(aliveByTasklist);
    if (alive.length === 0 || Date.now() - start > maxMs) return { alive, waitedMs: Date.now() - start };
    await sleep(100);
  }
}

function pidOf(text, key) {
  const m = new RegExp(`${key}=(\\d+)`).exec(text);
  return m ? Number(m[1]) : undefined;
}

async function scenarioNormal() {
  const r = await run('node normal.js');
  const out = {
    command: 'node normal.js',
    stdoutCaptured: r.stdout.includes('KIROSIGHT_STDOUT_OK'),
    stderrCaptured: r.stderr.includes('KIROSIGHT_STDERR_OK'),
    stdoutOnlyInStdout: !r.stderr.includes('KIROSIGHT_STDOUT_OK'),
    stderrOnlyInStderr: !r.stdout.includes('KIROSIGHT_STDERR_OK'),
    exitCode: r.exitCode, signal: r.signal, spawnError: r.spawnError, closeFired: r.closeFired,
    stdout: r.stdout, stderr: r.stderr,
  };
  out.pass = out.stdoutCaptured && out.stderrCaptured && out.exitCode === 7 && out.spawnError === null;
  console.log(`SPIKE_C_NORMAL=${JSON.stringify(out)}`);
  return out;
}

async function scenarioTreeKill() {
  const command = 'node tree-parent.js';
  const info = { command, timeoutMs: 6000 };
  const r = await new Promise((resolve) => {
    const result = {
      stdout: '', stderr: '', exitCode: undefined, signal: undefined, closeFired: false,
      spawnError: null, rootPid: undefined, closeMsAfterKill: undefined,
    };
    const child = spawn(command, { shell: true, cwd: FIXTURES, windowsHide: true });
    result.rootPid = child.pid;
    knownPids.add(child.pid);
    let killedAt;
    child.stdout.on('data', (d) => { result.stdout += d; });
    child.stderr.on('data', (d) => { result.stderr += d; });
    child.on('error', (e) => { result.spawnError = { code: e.code, message: e.message }; });
    child.on('close', (code, signal) => {
      result.closeFired = true; result.exitCode = code; result.signal = signal;
      if (killedAt !== undefined) result.closeMsAfterKill = Date.now() - killedAt;
      clearTimeout(timer);
      resolve(result);
    });
    // Short spike timeout: when it expires, kill the whole tree.
    const timer = setTimeout(() => {
      info.preKill = {
        rootPid: child.pid, rootImage: imageName(child.pid),
        parentPid: pidOf(result.stdout, 'PARENT_PID'), nestedPid: pidOf(result.stdout, 'NESTED_CHILD_PID'),
      };
      info.preKill.parentImage = info.preKill.parentPid && imageName(info.preKill.parentPid);
      info.preKill.nestedImage = info.preKill.nestedPid && imageName(info.preKill.nestedPid);
      for (const p of [info.preKill.parentPid, info.preKill.nestedPid]) if (p) knownPids.add(p);
      info.kill = taskkillTree(child.pid);
      killedAt = Date.now();
      // Safety net so the harness cannot hang if close never fires.
      setTimeout(() => { if (!result.closeFired) resolve(result); }, 5000);
    }, info.timeoutMs);
  });
  info.rootPid = r.rootPid;
  info.closeFired = r.closeFired;
  info.closeMsAfterKill = r.closeMsAfterKill;
  info.exitCode = r.exitCode;
  info.signal = r.signal;
  info.spawnError = r.spawnError;
  info.stdout = r.stdout.trim().split(/\r?\n/);
  const { parentPid, nestedPid, rootPid } = info.preKill;
  const watched = [rootPid, parentPid, nestedPid].filter(Boolean);
  const settled = await waitGone(watched, 3000);
  info.settleWaitedMs = settled.waitedMs;
  info.aliveAfterByTasklist = settled.alive;
  info.aliveAfterByKill0 = watched.filter(aliveByKill0);
  info.treeStructureNote = 'root image / parent image / nested image are in preKill';
  info.pass = info.kill.status === 0 && settled.alive.length === 0 && info.aliveAfterByKill0.length === 0
    && parentPid !== undefined && nestedPid !== undefined;
  console.log(`SPIKE_C_TREE=${JSON.stringify(info)}`);
  return info;
}

async function scenarioMissing() {
  const out = {};
  for (const [label, command] of [
    ['missing_bare', MISSING],
    ['missing_with_args', `${MISSING} --run --ci`],
    ['executed_nonzero_exit_1', 'node decoy.js'],
    ['executed_nonzero_exit_7', 'node normal.js'],
    ['executed_missing_script', 'node definitely_missing_script_5_1.js'],
  ]) {
    const r = await run(command);
    out[label] = {
      command,
      spawnErrorEmitted: r.spawnError !== null,
      spawnError: r.spawnError,
      exitFired: r.exitFired, closeFired: r.closeFired,
      exitCode: r.exitCode, signal: r.signal,
      stdout: r.stdout.trim(), stderr: r.stderr.trim().split(/\r?\n/).slice(0, 2),
      hasNotRecognizedSignature: /is not recognized as an internal or external command/i.test(r.stderr),
    };
  }
  console.log(`SPIKE_C_MISSING=${JSON.stringify(out)}`);
  return out;
}

/** Fallback candidate: pre-flight `where <first token>` instead of parsing cmd.exe's message. */
function scenarioPreflight() {
  const out = {};
  for (const token of ['node', 'npm', 'npx', MISSING, 'echo', 'dir']) {
    const r = spawnSync('where', [token], { encoding: 'utf8', windowsHide: true, cwd: FIXTURES });
    out[token] = { status: r.status, firstHit: (r.stdout || '').split(/\r?\n/)[0] || null };
  }
  console.log(`SPIKE_C_PREFLIGHT=${JSON.stringify(out)}`);
  return out;
}

async function main() {
  console.log(`SPIKE_C_ENV=${JSON.stringify({
    platform: process.platform, release: os.release(), version: os.version?.(), arch: os.arch(),
    node: process.version, comSpec: process.env.ComSpec,
  })}`);
  let normal; let tree; let missing;
  try {
    normal = await scenarioNormal();
    tree = await scenarioTreeKill();
    missing = await scenarioMissing();
    scenarioPreflight();
  } finally {
    // Cleanup safety: kill only PIDs this spike created, never by image name.
    const leftovers = [...knownPids].filter(aliveByTasklist);
    for (const pid of leftovers) taskkillTree(pid);
    console.log(`SPIKE_C_CLEANUP=${JSON.stringify({ leftoversKilled: leftovers })}`);
  }
  console.log(`SPIKE_C_SUMMARY=${JSON.stringify({ normalPass: normal?.pass, treePass: tree?.pass, missingMeasured: !!missing })}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
