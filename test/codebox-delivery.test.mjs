import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { deliver, resolveTarget } from '../mcp/delivery.mjs';
import { webSocketTransport } from '../mcp/transports/websocket.mjs';

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function httpSink() {
  return new Promise((resolve) => {
    const received = [];
    let notify = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        received.push({ url: req.url, body: JSON.parse(body) });
        res.end('ok');
        notify?.();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        received,
        next: () => new Promise((r) => { notify = r; }),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Minimal NATS server: INFO, then records PUB payloads and answers PING. */
function fakeNats() {
  return new Promise((resolve) => {
    const published = [];
    const server = net.createServer((socket) => {
      socket.write('INFO {"server_id":"fake","max_payload":1048576}\r\n');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let nl;
        while ((nl = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, nl);
          if (line.startsWith('PUB ')) {
            const [, subject, bytes] = line.split(' ');
            if (buffer.length < nl + 2 + Number(bytes) + 2) return;
            published.push({ subject, payload: JSON.parse(buffer.slice(nl + 2, nl + 2 + Number(bytes))) });
            buffer = buffer.slice(nl + 2 + Number(bytes) + 2);
            continue;
          }
          if (line === 'PING') socket.write('PONG\r\n');
          buffer = buffer.slice(nl + 2);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, published, close: () => new Promise((r) => server.close(r)) }));
  });
}

test('resolveTarget validates channels and applies defaults', () => {
  assert.equal(resolveTarget({ channel: undefined }), null);
  assert.deepEqual(resolveTarget({ channel: 'http', path: 'http://x/y' }), { channel: 'rest', path: 'http://x/y' });
  assert.deepEqual(resolveTarget({ channel: 'nats' }), { channel: 'nats', path: 'codebox.results' });
  assert.deepEqual(resolveTarget({ channel: 'stdio' }), { channel: 'stdio', path: 'notifications/codebox/result' });
  assert.throws(() => resolveTarget({ channel: 'rest' }), /response_path is required/);
  assert.throws(() => resolveTarget({ channel: 'websocket', path: 'http://x' }), /ws\(s\):\/\//);
  assert.throws(() => resolveTarget({ channel: 'smtp', path: 'x' }), /unsupported response_channel/);
});

test('deliver over rest POSTs the document', async () => {
  const sink = await httpSink();
  try {
    await deliver({ channel: 'rest', path: `${sink.url}/hook`, payload: { schema: 'codebox.result/v1', n: 1 } });
    assert.deepEqual(sink.received, [{ url: '/hook', body: { schema: 'codebox.result/v1', n: 1 } }]);
  } finally {
    await sink.close();
  }
});

test('deliver over websocket sends one frame', async () => {
  const frames = [];
  const port = 20000 + Math.floor(Math.random() * 20000);
  const ws = webSocketTransport({ host: '127.0.0.1', port });
  let got;
  const received = new Promise((r) => { got = r; });
  await ws.start(async (message) => {
    frames.push(message);
    got();
    return null;
  });
  try {
    await deliver({ channel: 'websocket', path: `ws://127.0.0.1:${port}/`, payload: { schema: 'codebox.result/v1', ws: true } });
    await received;
    assert.deepEqual(frames, [{ schema: 'codebox.result/v1', ws: true }]);
  } finally {
    await ws.stop();
  }
});

test('deliver over nats publishes on the subject (plain subject and nats:// URL)', async () => {
  const nats = await fakeNats();
  try {
    await deliver({ channel: 'nats', path: 'agents.results', natsUrl: `nats://127.0.0.1:${nats.port}`, payload: { a: 1 } });
    await deliver({ channel: 'nats', path: `nats://127.0.0.1:${nats.port}/other.subject`, payload: { b: 2 } });
    assert.deepEqual(nats.published, [
      { subject: 'agents.results', payload: { a: 1 } },
      { subject: 'other.subject', payload: { b: 2 } },
    ]);
  } finally {
    await nats.close();
  }
});

test('deliver over stdio writes a JSON-RPC notification', async () => {
  const lines = [];
  await deliver({ channel: 'stdio', path: 'notifications/codebox/result', payload: { x: 1 }, stdioWrite: (m) => lines.push(m) });
  assert.deepEqual(lines, [{ jsonrpc: '2.0', method: 'notifications/codebox/result', params: { x: 1 } }]);
});

test('MCP server: codebox tools answer on the incoming channel or deliver to response_channel', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codebox-mcp-'));
  fs.mkdirSync(path.join(root, 'demo', 'codes', 'a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'demo', 'codes', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'demo', 'config.yml'), YAML.stringify({ alias: 'demo', container: 'codebox-demo', languages: ['python'] }));
  fs.writeFileSync(path.join(root, 'demo', 'codes', 'a', 'main.py'), 'A');
  fs.writeFileSync(path.join(root, 'demo', 'codes', 'b', 'main.py'), 'B');

  const sink = await httpSink();
  const child = spawn('node', [path.join(moduleDir, 'mcp', 'server.mjs')], {
    cwd: moduleDir,
    env: { ...process.env, CODEBOX_BOXES_DIR: root },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    messages.push(msg);
    waiters.splice(0).forEach((w) => w());
  });
  const waitFor = async (predicate) => {
    for (;;) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((r) => waiters.push(r));
    }
  };
  const call = (id, name, args) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);

  try {
    // Ambiguous name without path → path_required on the same channel.
    call(1, 'codebox_push', { box: 'demo', files: [{ name: 'main.py', content: 'X' }] });
    const ambiguous = await waitFor((m) => m.id === 1);
    assert.equal(ambiguous.result.isError, true);
    const doc = ambiguous.result.structuredContent;
    assert.equal(doc.schema, 'codebox.result/v1');
    assert.equal(doc.status, 'path_required');
    assert.equal(doc.channel.received_via, 'stdio');
    assert.deepEqual(doc.files.rejected[0].candidates, ['a/main.py', 'b/main.py']);

    // With path → overwritten.
    call(2, 'codebox_push', { box: 'demo', files: [{ path: 'b/main.py', content: 'NEW' }] });
    const ok = await waitFor((m) => m.id === 2);
    assert.equal(ok.result.structuredContent.status, 'ok');
    assert.equal(fs.readFileSync(path.join(root, 'demo', 'codes', 'b', 'main.py'), 'utf8'), 'NEW');

    // response_channel=rest → "accepted" now, full document POSTed later.
    const posted = sink.next();
    call(3, 'codebox_index', { box: 'demo', response_channel: 'rest', response_path: `${sink.url}/results`, request_id: 'req-3' });
    const accepted = await waitFor((m) => m.id === 3);
    assert.equal(accepted.result.structuredContent.status, 'accepted');
    await posted;
    const delivered = sink.received[0];
    assert.equal(delivered.url, '/results');
    assert.equal(delivered.body.request_id, 'req-3');
    assert.equal(delivered.body.status, 'ok');
    assert.equal(delivered.body.channel.response_channel, 'rest');
    assert.equal(delivered.body.channel.delivered, true);
    assert.deepEqual(delivered.body.index.duplicates, { 'main.py': ['a/main.py', 'b/main.py'] });

    // response_channel=stdio with a path → JSON-RPC notification on stdout.
    call(4, 'codebox_index', { box: 'demo', response_channel: 'stdio', response_path: 'notifications/demo' });
    const note = await waitFor((m) => m.method === 'notifications/demo');
    assert.equal(note.params.tool, 'codebox_index');
  } finally {
    child.kill();
    await sink.close();
  }
});
