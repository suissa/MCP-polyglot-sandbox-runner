import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { createSandboxMcpServer } from './mcp/server.ts';

export * from './sandbox-runner.ts';
export * from './sandbox-io.ts';
export * from './mcp/server.ts';
export * from './mcp/tools.ts';
export * from './mcp/resources.ts';
export * from './mcp/prompts.ts';

export async function runStdioServer() {
  const server = createSandboxMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[SandboxRunner MCP] Stdio server connected and ready.\n');
}

// Auto-start if invoked directly via tsx/node
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdioServer().catch((err) => {
    process.stderr.write(`[SandboxRunner MCP] Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}
