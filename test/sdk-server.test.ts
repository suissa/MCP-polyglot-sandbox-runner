import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandboxMcpServer } from '../src/mcp/server.ts';

test('MCP SDK Server: initializes and registers all tools, resources and prompts', async () => {
  const server = createSandboxMcpServer();
  assert.ok(server);

  // Access registered components
  const tools = (server as any)._registeredTools;
  assert.ok(tools);
  assert.ok('sandboxrunner_status' in tools);
  assert.ok('sandboxrunner_capabilities' in tools);
  assert.ok('sandboxrunner_check_gvisor' in tools);
  assert.ok('sandboxrunner_execute_code' in tools);
  assert.ok('sandboxrunner_run_with_artifacts' in tools);
  assert.ok('sandbox_execute_code' in tools);
  assert.ok('sandbox_run_with_artifacts' in tools);

  const resources = (server as any)._registeredResources;
  assert.ok(resources);
  assert.ok('sandbox://runtimes' in resources);
  assert.ok('sandbox://config' in resources);

  const prompts = (server as any)._registeredPrompts;
  assert.ok(prompts);
  assert.ok('secure_eval' in prompts);
  assert.ok('data_processing' in prompts);
});
