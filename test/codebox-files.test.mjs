import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import {
  CodeboxError,
  buildIndex,
  deriveStatus,
  createResult,
  loadBox,
  parseMetricsOutput,
  pushFiles,
  resolveEntry,
} from '../mcp/codebox.mjs';

function makeBox(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebox-files-'));
  const dir = path.join(root, 'demo');
  fs.mkdirSync(path.join(dir, 'codes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.yml'), YAML.stringify({ alias: 'demo', container: 'codebox-demo', languages: ['python', 'typescript'] }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, 'codes', rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, 'codes', rel), content);
  }
  return loadBox('demo', root);
}

const read = (box, rel) => fs.readFileSync(path.join(box.codesDir, rel), 'utf8');

test('index keeps only unique names as name → path', () => {
  const box = makeBox({ 'a/main.py': '1', 'b/main.py': '2', 'util.ts': '3', 'node_modules/x/util.ts': 'ignored' });
  const index = buildIndex(box);
  assert.deepEqual(index.unique, { 'util.ts': 'util.ts' });
  assert.deepEqual(index.duplicates, { 'main.py': ['a/main.py', 'b/main.py'] });
  assert.ok(fs.existsSync(path.join(box.dir, '.codebox', 'index.json')));
});

test('file with "path" is simply overwritten (or created) there', () => {
  const box = makeBox({ 'a/main.py': 'old', 'b/main.py': 'other' });
  const res = pushFiles(box, [
    { path: 'a/main.py', content: 'new' },
    { path: 'c/deep/new.py', content: 'fresh' },
  ]);
  assert.equal(read(box, 'a/main.py'), 'new');
  assert.equal(read(box, 'c/deep/new.py'), 'fresh');
  assert.deepEqual(res.written.map((w) => [w.path, w.action, w.resolved_by]), [
    ['a/main.py', 'overwritten', 'path'],
    ['c/deep/new.py', 'created', 'path'],
  ]);
});

test('file without "path" and a unique name overwrites the indexed file', () => {
  const box = makeBox({ 'src/lib/calc.py': 'old' });
  const res = pushFiles(box, [{ name: 'calc.py', content: 'new' }]);
  assert.equal(read(box, 'src/lib/calc.py'), 'new');
  assert.equal(res.written[0].resolved_by, 'index');
  assert.equal(res.written[0].action, 'overwritten');
});

test('file without "path" and an unknown name is created at codes/<name>', () => {
  const box = makeBox({ 'src/app.py': 'x' });
  const res = pushFiles(box, [{ name: 'brand_new.py', content: 'hi' }]);
  assert.equal(read(box, 'brand_new.py'), 'hi');
  assert.equal(res.written[0].action, 'created');
  assert.equal(res.index.unique['brand_new.py'], 'brand_new.py');
});

test('file without "path" and a duplicated name → path_required, nothing written', () => {
  const box = makeBox({ 'a/main.py': 'A', 'b/main.py': 'B', 'solo.py': 'S' });
  assert.throws(
    () => pushFiles(box, [{ name: 'solo.py', content: 'changed' }, { name: 'main.py', content: 'X' }]),
    (err) => {
      assert.ok(err instanceof CodeboxError);
      assert.equal(err.status, 'path_required');
      assert.deepEqual(err.details.rejected[0].candidates, ['a/main.py', 'b/main.py']);
      return true;
    },
  );
  assert.equal(read(box, 'solo.py'), 'S', 'all-or-nothing: the valid file was not written either');
});

test('paths escaping codes/ and names with slashes are rejected', () => {
  const box = makeBox({});
  assert.throws(() => pushFiles(box, [{ path: '../../etc/passwd', content: 'x' }]), (err) => err.status === 'rejected');
  assert.throws(() => pushFiles(box, [{ path: '/abs.py', content: 'x' }]), (err) => err.status === 'rejected');
  assert.throws(() => pushFiles(box, [{ name: 'a/b.py', content: 'x' }]), (err) => err.status === 'rejected');
  assert.throws(() => pushFiles(box, [{ content: 'x' }]), (err) => err.status === 'rejected');
});

test('two files of one request cannot target the same path', () => {
  const box = makeBox({});
  assert.throws(
    () => pushFiles(box, [{ name: 'x.py', content: '1' }, { path: 'x.py', content: '2' }]),
    (err) => err.status === 'rejected' && /same target path/.test(err.message),
  );
});

test('base64 content is decoded', () => {
  const box = makeBox({});
  pushFiles(box, [{ path: 'data.bin', content: Buffer.from('bytes!').toString('base64'), encoding: 'base64' }]);
  assert.equal(read(box, 'data.bin'), 'bytes!');
});

test('resolveEntry accepts a path or a unique name', () => {
  const box = makeBox({ 'a/main.py': '', 'b/main.py': '', 'tools/run.ts': '' });
  assert.equal(resolveEntry(box, 'run.ts'), 'tools/run.ts');
  assert.equal(resolveEntry(box, 'a/main.py'), 'a/main.py');
  assert.equal(resolveEntry(box, '/workspace/codes/b/main.py'), 'b/main.py');
  assert.throws(() => resolveEntry(box, 'main.py'), (err) => err.status === 'path_required');
  assert.throws(() => resolveEntry(box, 'nope.py'), (err) => err.status === 'not_found');
});

test('parseMetricsOutput parses ps, top, cgroup, loadavg and meminfo', () => {
  const text = [
    '### LABEL', 'after', '### DATE', '2026-01-01T00:00:00.000Z',
    '### PS',
    '  PID  PPID USER     %CPU %MEM   RSS    VSZ NLWP ELAPSED STAT COMMAND',
    '   42     1 root     99.0  1.5 12345  67890    3      10 R    python3 main.py',
    '### TOP',
    'top - 10:00:00 up 1 min,  0 user,  load average: 0.50, 0.25, 0.10',
    'Tasks:   3 total,   1 running,   2 sleeping,   0 stopped,   0 zombie',
    '%Cpu(s): 12.5 us,  2.5 sy,  0.0 ni, 85.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st',
    'MiB Mem :  16095.7 total,   7883.5 free,   1003.4 used,   7533.6 buff/cache',
    'MiB Swap:      0.0 total,      0.0 free,      0.0 used.  15092.3 avail Mem',
    '',
    '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    '     42 root      20   0   67890  12345   1000 R  99.0   1.5   0:01.00 python3',
    '### CGROUP',
    'cgroup.version 2', 'cpu.stat usage_usec 1500', 'cpu.stat user_usec 1000', 'memory.peak 4096', 'pids.max max',
    '### LOADAVG', '0.50 0.25 0.10 1/99 42',
    '### MEMINFO', 'MemTotal:       16482008 kB', 'MemAvailable:   15000000 kB',
    '### UPTIME', '60.5',
  ].join('\n');
  const m = parseMetricsOutput(text);
  assert.equal(m.label, 'after');
  assert.deepEqual(m.ps[0], {
    pid: 42, ppid: 1, user: 'root', cpu_percent: 99, mem_percent: 1.5, rss_kb: 12345, vsz_kb: 67890,
    threads: 3, elapsed_s: 10, state: 'R', command: 'python3 main.py',
  });
  assert.deepEqual(m.top.load_average, [0.5, 0.25, 0.1]);
  assert.equal(m.top.tasks.total, 3);
  assert.equal(m.top.cpu_percent.us, 12.5);
  assert.equal(m.top.memory.total, 16095.7);
  assert.equal(m.top.processes[0].COMMAND, 'python3');
  assert.deepEqual(m.cgroup['cpu.stat'], { usage_usec: 1500, user_usec: 1000 });
  assert.equal(m.cgroup['memory.peak'], 4096);
  assert.equal(m.cgroup['pids.max'], 'max');
  assert.equal(m.loadavg['1m'], 0.5);
  assert.equal(m.meminfo_kb.MemTotal, 16482008);
  assert.equal(m.uptime_s, 60.5);
});

test('deriveStatus maps setup/execution outcomes', () => {
  const base = () => createResult({ tool: 'codebox_run', box: 'demo', receivedVia: 'nats' });
  assert.equal(base().channel.received_via, 'nats');
  assert.equal(deriveStatus(base()), 'ok');
  assert.equal(deriveStatus({ ...base(), setup: { status: 'build_failed' } }), 'setup_failed');
  assert.equal(deriveStatus({ ...base(), execution: { exit_code: 1, timed_out: false } }), 'failed');
  assert.equal(deriveStatus({ ...base(), execution: { exit_code: null, timed_out: true } }), 'timeout');
});
