import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverScript = path.join(moduleDir, 'mcp', 'server.mjs');

test('MCP Server: responds to JSON-RPC over stdio', async () => {
  const child = spawn('node', [serverScript], {
    cwd: moduleDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const sendRpc = (req: Record<string, unknown>): Promise<any> => {
    return new Promise((resolve, reject) => {
      const onData = (data: Buffer) => {
        child.stdout.off('data', onData);
        try {
          const res = JSON.parse(data.toString('utf8').trim());
          resolve(res);
        } catch (e) {
          reject(e);
        }
      };
      child.stdout.on('data', onData);
      child.stdin.write(JSON.stringify(req) + '\n');
    });
  };

  try {
    // 1. initialize
    const initRes = await sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.equal(initRes.result.serverInfo.name, 'sandboxrunner');
    assert.equal(initRes.result.serverInfo.version, '1.0.0');
    assert.ok(initRes.result.capabilities.tools);
    assert.ok(initRes.result.capabilities.resources);
    assert.ok(initRes.result.capabilities.prompts);

    // 2. tools/list
    const toolsRes = await sendRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    const toolNames = toolsRes.result.tools.map((t: any) => t.name);
    assert.ok(toolNames.includes('sandboxrunner_status'));
    assert.ok(toolNames.includes('sandboxrunner_capabilities'));
    assert.ok(toolNames.includes('sandboxrunner_api_contract'));
    assert.ok(toolNames.includes('sandboxrunner_check_gvisor'));
    assert.ok(toolNames.includes('sandboxrunner_execute_code'));
    assert.ok(toolNames.includes('sandboxrunner_run_with_artifacts'));
    assert.ok(toolNames.includes('sandbox_execute_code'));
    assert.ok(toolNames.includes('sandbox_run_with_artifacts'));

    // 3. resources/list
    const resList = await sendRpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/list',
    });
    const uris = resList.result.resources.map((r: any) => r.uri);
    assert.ok(uris.includes('lucy-mae://modules/sandboxrunner'));
    assert.ok(uris.includes('sandbox://runtimes'));
    assert.ok(uris.includes('sandbox://config'));

    // 4. resources/read
    const resRead = await sendRpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: { uri: 'sandbox://config' },
    });
    assert.ok(resRead.result.contents[0].text.includes('defaultMemoryLimit'));

    // 5. prompts/list
    const promptsRes = await sendRpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'prompts/list',
    });
    const promptNames = promptsRes.result.prompts.map((p: any) => p.name);
    assert.ok(promptNames.includes('secure_eval'));
    assert.ok(promptNames.includes('data_processing'));

    // 6. prompts/get
    const promptGet = await sendRpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'prompts/get',
      params: { name: 'secure_eval', arguments: { code: 'console.log(1)', language: 'javascript' } },
    });
    assert.ok(promptGet.result.messages[0].content.text.includes('console.log(1)'));

    // 7. tools/call sandboxrunner_status
    const statusRes = await sendRpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'sandboxrunner_status', arguments: {} },
    });
    assert.equal(statusRes.result.structuredContent.module, 'sandboxrunner');
    assert.equal(statusRes.result.structuredContent.status, 'ready');

    // 8. tools/call sandboxrunner_check_gvisor
    const gvisorRes = await sendRpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'sandboxrunner_check_gvisor', arguments: {} },
    });
    assert.ok('runscAvailable' in gvisorRes.result.structuredContent);

    // 9. tools/call invalid tool returns error
    const errRes = await sendRpc({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'non_existent_tool', arguments: {} },
    });
    assert.equal(errRes.error.code, -32602);

    // 10. tools/call execute code inside sandbox
    const execRes = await sendRpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: {
        name: 'sandboxrunner_execute_code',
        arguments: {
          code: 'console.log("MCP_SANDBOX_SUCCESS_" + (10 + 20));',
        },
      },
    });
    assert.equal(execRes.result.structuredContent.exitCode, 0);
    assert.ok(execRes.result.structuredContent.stdout.includes('MCP_SANDBOX_SUCCESS_30'));
  } finally {
    child.kill();
  }
});
