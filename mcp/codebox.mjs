/**
 * Codebox engine for the MCP server: file index + push, setup, telemetry
 * runs and metric collection for boxes rendered by `./codebox up`.
 *
 * Every operation returns a document following schemas/codebox-result.schema.json
 * (`codebox.result/v1`).
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { REPO_ROOT, boxesRoot, languageForFile, safeRelativePath } from '../tools/codebox/lib/boxes.mjs';

export const RESULT_SCHEMA = 'codebox.result/v1';
const IGNORED_DIRS = new Set(['node_modules', 'target', '.zig-cache', 'zig-cache', 'zig-out', '__pycache__', '.venv', 'venv', '.git', '.pytest_cache', 'dist']);
const MAX_OUTPUT_BYTES = 1024 * 1024;

export class CodeboxError extends Error {
  constructor(message, status = 'error', details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ *
 * Box lookup                                                          *
 * ------------------------------------------------------------------ */

export function boxDir(alias, root) {
  if (typeof alias !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(alias)) {
    throw new CodeboxError(`invalid box alias: ${alias}`, 'invalid_request');
  }
  return path.join(boxesRoot(root), alias);
}

export function loadBox(alias, root) {
  const dir = boxDir(alias, root);
  const configFile = path.join(dir, 'config.yml');
  if (!fs.existsSync(configFile)) {
    throw new CodeboxError(`box "${alias}" is not rendered (missing ${configFile}); run ./codebox up ${alias}`, 'not_found');
  }
  const config = YAML.parse(fs.readFileSync(configFile, 'utf8'));
  return { alias, dir, codesDir: path.join(dir, 'codes'), config, container: config.container || `codebox-${alias}` };
}

export function listBoxes(root) {
  const base = boxesRoot(root);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, 'config.yml')))
    .map((d) => {
      const box = loadBox(d.name, root);
      return { alias: d.name, container: box.container, languages: box.config.languages, dir: box.dir };
    });
}

/* ------------------------------------------------------------------ *
 * File index: name → path, only for names that are unique in codes/   *
 * ------------------------------------------------------------------ */

function walk(dir, rel = '', out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name, out);
    } else if (entry.isFile()) {
      out.push(rel ? `${rel}/${entry.name}` : entry.name);
    }
  }
  return out;
}

/**
 * Builds { unique: { name: path }, duplicates: { name: [paths] } } and
 * persists it to boxes/<alias>/.codebox/index.json.
 */
export function buildIndex(box) {
  const byName = new Map();
  for (const rel of walk(box.codesDir).sort()) {
    const name = path.posix.basename(rel);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(rel);
  }
  const unique = {};
  const duplicates = {};
  for (const [name, paths] of byName) {
    if (paths.length === 1) unique[name] = paths[0];
    else duplicates[name] = paths;
  }
  const index = { box: box.alias, generated_at: new Date().toISOString(), unique, duplicates };
  fs.mkdirSync(path.join(box.dir, '.codebox'), { recursive: true });
  fs.writeFileSync(path.join(box.dir, '.codebox', 'index.json'), JSON.stringify(index, null, 2));
  return index;
}

/**
 * Resolves where each incoming file goes:
 *   - `path` present          → overwrite/create exactly there
 *   - only `name`, unique     → overwrite the indexed path
 *   - only `name`, duplicated → rejected: the request must send `path`
 *   - only `name`, unknown    → created at codes/<name>
 */
export function planFiles(box, files, index = buildIndex(box)) {
  if (!Array.isArray(files) || files.length === 0) throw new CodeboxError('"files" must be a non-empty array', 'invalid_request');
  const plan = [];
  const rejected = [];
  files.forEach((file, i) => {
    const label = file?.path || file?.name || `files[${i}]`;
    if (!file || typeof file !== 'object') return rejected.push({ index: i, name: label, reason: 'file must be an object' });
    if (typeof file.content !== 'string') return rejected.push({ index: i, name: label, reason: '"content" (string) is required' });
    const encoding = file.encoding || 'utf-8';
    if (!['utf-8', 'utf8', 'base64'].includes(encoding)) return rejected.push({ index: i, name: label, reason: `unsupported encoding ${encoding}` });

    if (file.path !== undefined && file.path !== null && file.path !== '') {
      let rel;
      try {
        rel = safeRelativePath(file.path);
      } catch (err) {
        return rejected.push({ index: i, name: label, reason: err.message });
      }
      return plan.push({ index: i, name: path.posix.basename(rel), path: rel, resolved_by: 'path', content: file.content, encoding });
    }

    const name = file.name;
    if (typeof name !== 'string' || !name.trim()) return rejected.push({ index: i, name: label, reason: 'either "path" or "name" is required' });
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      return rejected.push({ index: i, name, reason: '"name" must be a bare file name; send "path" for nested files' });
    }
    if (index.duplicates[name]) {
      return rejected.push({ index: i, name, reason: 'path_required', candidates: index.duplicates[name] });
    }
    if (index.unique[name]) {
      return plan.push({ index: i, name, path: index.unique[name], resolved_by: 'index', content: file.content, encoding });
    }
    plan.push({ index: i, name, path: name, resolved_by: 'new', content: file.content, encoding });
  });

  // Two entries of the same request can't target the same path.
  const seen = new Map();
  for (const item of plan) {
    if (seen.has(item.path)) {
      rejected.push({ index: item.index, name: item.name, reason: `same target path as files[${seen.get(item.path)}]: ${item.path}` });
    } else seen.set(item.path, item.index);
  }
  return { plan: plan.filter((item) => !rejected.some((r) => r.index === item.index)), rejected };
}

/** All-or-nothing write: if anything is rejected nothing is written. */
export function pushFiles(box, files) {
  const index = buildIndex(box);
  const { plan, rejected } = planFiles(box, files, index);
  if (rejected.length) {
    const needsPath = rejected.filter((r) => r.reason === 'path_required');
    const status = needsPath.length === rejected.length ? 'path_required' : 'rejected';
    const message = needsPath.length
      ? `ambiguous file name(s) without "path": ${needsPath.map((r) => `${r.name} → [${r.candidates.join(', ')}]`).join('; ')}. Resend with "path".`
      : `invalid file(s): ${rejected.map((r) => `${r.name}: ${r.reason}`).join('; ')}`;
    throw new CodeboxError(message, status, { rejected });
  }
  const written = plan.map((item) => {
    const target = path.join(box.codesDir, item.path);
    const existed = fs.existsSync(target);
    const data = item.encoding === 'base64' ? Buffer.from(item.content, 'base64') : Buffer.from(item.content, 'utf8');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return {
      name: item.name,
      path: item.path,
      action: existed ? 'overwritten' : 'created',
      resolved_by: item.resolved_by,
      language: languageForFile(item.path),
      bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
    };
  });
  return { written, rejected: [], index: buildIndex(box) };
}

/** Resolves a run entry given as a path or as a (unique) file name. */
export function resolveEntry(box, entry) {
  if (typeof entry !== 'string' || !entry.trim()) throw new CodeboxError('"entry" is required', 'invalid_request');
  const index = buildIndex(box);
  if (entry.includes('/')) {
    const rel = safeRelativePath(entry.replace(/^\/workspace\/codes\//, ''));
    if (!fs.existsSync(path.join(box.codesDir, rel))) throw new CodeboxError(`entry not found: ${rel}`, 'not_found');
    return rel;
  }
  if (index.duplicates[entry]) {
    throw new CodeboxError(`ambiguous entry "${entry}": send its path`, 'path_required', {
      rejected: [{ name: entry, reason: 'path_required', candidates: index.duplicates[entry] }],
    });
  }
  if (!index.unique[entry]) throw new CodeboxError(`entry not found: ${entry}`, 'not_found');
  return index.unique[entry];
}

/* ------------------------------------------------------------------ *
 * Process helpers                                                     *
 * ------------------------------------------------------------------ */

export function exec(command, args, { timeoutMs = 0, cwd, input, maxBytes = MAX_OUTPUT_BYTES } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = { stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0 };
    let timedOut = false;
    const collect = (key) => (chunk) => {
      out[`${key}Bytes`] += chunk.length;
      if (out[key].length < maxBytes) out[key] += chunk.toString('utf8').slice(0, maxBytes - out[key].length);
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ ...out, exitCode: null, signal: null, timedOut, error: err.message, durationMs: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ ...out, exitCode: code, signal, timedOut, error: null, durationMs: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function newRunId() {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Metrics: ps / top / cgroup inside the box + docker stats + host     *
 * ------------------------------------------------------------------ */

export function parseMetricsOutput(text) {
  const sections = {};
  let current = null;
  for (const line of text.split('\n')) {
    const header = /^### (\w+)$/.exec(line);
    if (header) {
      current = header[1].toLowerCase();
      sections[current] = [];
    } else if (current) sections[current].push(line);
  }
  const trimmed = (key) => (sections[key] || []).filter((l) => l.trim() !== '');

  const psLines = trimmed('ps');
  const ps = psLines.slice(1).map((line) => {
    const cols = line.trim().split(/\s+/);
    return {
      pid: Number(cols[0]), ppid: Number(cols[1]), user: cols[2], cpu_percent: Number(cols[3]), mem_percent: Number(cols[4]),
      rss_kb: Number(cols[5]), vsz_kb: Number(cols[6]), threads: Number(cols[7]), elapsed_s: Number(cols[8]), state: cols[9],
      command: cols.slice(10).join(' '),
    };
  });

  const topRaw = (sections.top || []).join('\n').trimEnd();
  const top = parseTop(topRaw);

  const cgroup = {};
  for (const line of trimmed('cgroup')) {
    const [file, ...rest] = line.split(' ');
    const value = rest.join(' ');
    if (file.endsWith('.stat') && file !== 'io.stat') {
      const [k, v] = value.split(' ');
      cgroup[file] = { ...(cgroup[file] || {}), [k]: Number(v) };
    } else if (file === 'io.stat') {
      cgroup[file] = [...(cgroup[file] || []), value];
    } else {
      cgroup[file] = /^\d+$/.test(value) ? Number(value) : value;
    }
  }

  const [l1, l5, l15, procs] = (trimmed('loadavg')[0] || '').split(/\s+/);
  const meminfo = Object.fromEntries(
    trimmed('meminfo').map((line) => {
      const m = /^(\w+):\s+(\d+)/.exec(line);
      return m ? [m[1], Number(m[2])] : [line, null];
    }),
  );
  return {
    label: trimmed('label')[0] || null,
    captured_at: trimmed('date')[0] || null,
    ps,
    top,
    top_raw: topRaw,
    cgroup,
    loadavg: l1 ? { '1m': Number(l1), '5m': Number(l5), '15m': Number(l15), running_total: procs } : null,
    meminfo_kb: meminfo,
    uptime_s: Number(trimmed('uptime')[0]) || null,
  };
}

function parseTop(raw) {
  const lines = raw.split('\n');
  const summary = {};
  const load = /load average:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(lines[0] || '');
  if (load) summary.load_average = [Number(load[1]), Number(load[2]), Number(load[3])];
  const pairs = (line) =>
    Object.fromEntries([...line.matchAll(/([\d.]+)\s+([a-zA-Z/.-]+)/g)].map((m) => [m[2].replace(/[.,]$/, ''), Number(m[1])]));
  for (const line of lines.slice(1, 6)) {
    if (line.startsWith('Tasks:')) summary.tasks = pairs(line.slice(6));
    else if (line.startsWith('%Cpu')) summary.cpu_percent = pairs(line.slice(line.indexOf(':') + 1));
    else if (/Mem\s*:/.test(line)) summary.memory = { unit: line.split(' ')[0], ...pairs(line.slice(line.indexOf(':') + 1)) };
    else if (/Swap\s*:/.test(line)) summary.swap = { unit: line.split(' ')[0], ...pairs(line.slice(line.indexOf(':') + 1)) };
  }
  const headerIdx = lines.findIndex((l) => /^\s*PID\s+USER/.test(l));
  const processes = [];
  if (headerIdx >= 0) {
    const cols = lines[headerIdx].trim().split(/\s+/);
    for (const line of lines.slice(headerIdx + 1)) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      const row = {};
      cols.forEach((col, i) => {
        row[col] = i === cols.length - 1 ? parts.slice(i).join(' ') : parts[i];
      });
      processes.push(row);
    }
  }
  return { ...summary, processes };
}

async function dockerStats(container) {
  const res = await exec('docker', ['stats', '--no-stream', '--format', '{{json .}}', container], { timeoutMs: 15000 });
  if (res.exitCode !== 0) return { error: (res.stderr || res.error || '').trim() || 'docker stats failed' };
  try {
    return JSON.parse(res.stdout.trim().split('\n')[0]);
  } catch {
    return { raw: res.stdout.trim() };
  }
}

export async function snapshot(box, label, runDirInBox) {
  const args = ['exec', box.container, 'codebox-metrics', label];
  if (runDirInBox) args.push(runDirInBox);
  const res = await exec('docker', args, { timeoutMs: 15000 });
  if (res.exitCode !== 0) return { label, error: (res.stderr || res.error || '').trim() || `exit ${res.exitCode}` };
  return parseMetricsOutput(res.stdout);
}

function hostMetrics() {
  const mem = { total_bytes: os.totalmem(), free_bytes: os.freemem() };
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpus: os.cpus().length,
    loadavg: os.loadavg(),
    memory: mem,
    server_process: { pid: process.pid, rss_bytes: process.memoryUsage().rss, uptime_s: process.uptime() },
  };
}

/* ------------------------------------------------------------------ *
 * setup / run                                                         *
 * ------------------------------------------------------------------ */

export async function runSetup(box, { runId = newRunId(), timeoutMs = 30 * 60 * 1000, args = [] } = {}) {
  const inBox = `/workspace/runs/${runId}/setup.json`;
  const res = await exec(
    'docker',
    ['exec', '-e', `CODEBOX_SETUP_REPORT=${inBox}`, box.container, 'setup', '/workspace/codes', ...args],
    { timeoutMs },
  );
  const report = readJson(path.join(box.dir, 'runs', runId, 'setup.json'));
  return {
    run_id: runId,
    status: report?.status || (res.timedOut ? 'timeout' : res.exitCode === 0 ? 'ok' : 'error'),
    exit_code: res.exitCode,
    timed_out: res.timedOut,
    duration_ms: res.durationMs,
    report,
    stdout: res.stdout,
    stderr: res.stderr || res.error || '',
  };
}

export async function runEntry(box, entry, { args = [], timeoutMs, runId = newRunId(), sampleIntervalMs = 1000, maxSamples = 10, compileBudgetMs = 10 * 60 * 1000 } = {}) {
  const rel = resolveEntry(box, entry);
  const language = languageForFile(rel);
  if (!language) throw new CodeboxError(`no telemetry runner for ${rel} (supported: ts, py, go, rs, zig)`, 'invalid_request');
  const programTimeout = Number(timeoutMs || box.config.timeout_ms || 60000);
  const runDirInBox = `/workspace/runs/${runId}`;
  const cwdInBox = path.posix.dirname(`/workspace/codes/${rel}`);
  const command = [
    'exec', '-i', '-w', cwdInBox,
    '-e', `CODEBOX_RUN_ID=${runId}`,
    '-e', `CODEBOX_TELEMETRY_OUT=${runDirInBox}/telemetry.json`,
    '-e', `CODEBOX_TIMEOUT_MS=${programTimeout}`,
    box.container, 'codebox-run', `/workspace/codes/${rel}`, ...args.map(String),
  ];

  const during = [];
  let finished = false;
  const running = exec('docker', command, { timeoutMs: programTimeout + compileBudgetMs }).finally(() => {
    finished = true;
  });
  const pause = (ms) => Promise.race([running, new Promise((r) => setTimeout(r, ms))]);
  // docker stats is slow (~1-2s): one sample in parallel, never blocking ps/top.
  const statsDuring = pause(Math.min(250, sampleIntervalMs)).then(() => (finished ? null : dockerStats(box.container)));
  // ps/top while the code is still running.
  const sampler = (async () => {
    for (let i = 0; i < maxSamples; i += 1) {
      await pause(i === 0 ? Math.min(250, sampleIntervalMs) : sampleIntervalMs);
      if (finished) break;
      during.push(await snapshot(box, `during-${i + 1}`, runDirInBox));
    }
  })();

  const res = await running;
  await sampler;
  const [after, statsAfter, statsDuringValue] = await Promise.all([
    snapshot(box, 'after', runDirInBox),
    dockerStats(box.container),
    statsDuring,
  ]);
  const telemetry = readJson(path.join(box.dir, 'runs', runId, 'telemetry.json'));

  fs.mkdirSync(path.join(box.dir, 'runs', runId), { recursive: true });
  fs.writeFileSync(path.join(box.dir, 'runs', runId, 'stdout.log'), res.stdout);
  fs.writeFileSync(path.join(box.dir, 'runs', runId, 'stderr.log'), res.stderr);

  return {
    execution: {
      run_id: runId,
      entry: rel,
      language,
      command: ['docker', ...command],
      exit_code: res.exitCode,
      signal: res.signal,
      timed_out: res.timedOut || Boolean(telemetry?.process?.timed_out),
      wall_ms: res.durationMs,
      stdout: res.stdout,
      stderr: res.stderr || res.error || '',
      stdout_bytes: res.stdoutBytes,
      stderr_bytes: res.stderrBytes,
      stdout_truncated: res.stdoutBytes > res.stdout.length,
      stderr_truncated: res.stderrBytes > res.stderr.length,
    },
    telemetry,
    metrics: {
      samples: { during, after },
      docker_stats: { during: statsDuringValue, after: statsAfter },
      host: hostMetrics(),
    },
    logs: {
      monitoramento: path.relative(REPO_ROOT, path.join(box.dir, 'logs', 'monitoramento.log')),
      top_snapshot: path.relative(REPO_ROOT, path.join(box.dir, 'logs', 'top_snapshot.log')),
      run_dir: path.relative(REPO_ROOT, path.join(box.dir, 'runs', runId)),
    },
  };
}

/* ------------------------------------------------------------------ *
 * Result document                                                     *
 * ------------------------------------------------------------------ */

export function createResult({ tool, box, requestId, receivedVia, responseChannel, responsePath }) {
  return {
    schema: RESULT_SCHEMA,
    request_id: requestId || crypto.randomUUID(),
    tool,
    box: box || null,
    status: 'ok',
    received_at: new Date().toISOString(),
    finished_at: null,
    duration_ms: null,
    channel: {
      received_via: receivedVia || 'stdio',
      response_channel: responseChannel || receivedVia || 'stdio',
      response_path: responsePath || null,
      delivered: null,
      delivery_error: null,
    },
    files: { written: [], rejected: [] },
    index: null,
    setup: null,
    execution: null,
    telemetry: null,
    metrics: null,
    logs: null,
    errors: [],
  };
}

export function finishResult(result, startedAt = Date.parse(result.received_at)) {
  result.finished_at = new Date().toISOString();
  result.duration_ms = Date.now() - startedAt;
  return result;
}

/** Derives the final status from the collected parts. */
export function deriveStatus(result) {
  if (result.errors.length && result.status === 'ok') return 'error';
  if (result.setup && result.setup.status !== 'ok') return 'setup_failed';
  if (result.execution) {
    if (result.execution.timed_out) return 'timeout';
    if (result.execution.exit_code !== 0) return 'failed';
  }
  return result.status;
}
