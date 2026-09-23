import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(moduleDir, 'mcp', 'server.mjs');

test('MCP Server: responds to HTTP REST in network mode', async () => {
  const child = spawn('node', [serverScript, '--network'], {
    cwd: moduleDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Wait for server to bind port
  await new Promise((r) => setTimeout(r, 1200));

  try {
    // 1. GET /healthz
    const healthRes = await fetch('http://127.0.0.1:7631/healthz');
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.deepEqual(healthJson, { ok: true, module: 'sandboxrunner' });

    // 2. POST /rpc - tools/list
    const listRes = await fetch('http://127.0.0.1:7631/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list' }),
    });
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.id, 101);
    assert.ok(Array.isArray(listJson.result.tools));

    // 3. POST /rpc - tools/call sandboxrunner_capabilities
    const callRes = await fetch('http://127.0.0.1:7631/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: { name: 'sandboxrunner_capabilities', arguments: {} },
      }),
    });
    assert.equal(callRes.status, 200);
    const callJson = await callRes.json();
    assert.equal(callJson.id, 102);
    assert.ok(callJson.result.structuredContent.capabilities.includes('sandbox-execution'));
  } finally {
    child.kill();
  }
});
