import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  ExecuteCodeInputSchema,
  RunWithArtifactsInputSchema,
  handleExecuteCode,
  handleRunWithArtifacts,
  checkDockerAndGvisor,
} from './tools.ts';
import { getRuntimesResourceContent, getConfigResourceContent } from './resources.ts';
import { getSecureEvalPrompt, getDataProcessingPrompt } from './prompts.ts';

export function createSandboxMcpServer(): McpServer {
  const server = new McpServer({
    name: 'sandboxrunner',
    version: '1.0.0',
  });

  // 1. Discovery & Status Tools
  server.tool(
    'sandboxrunner_status',
    'Get SandboxRunner health, status, and Docker/gVisor environment details',
    {},
    async () => {
      const docker = await checkDockerAndGvisor();
      const statusData = {
        module: 'sandboxrunner',
        status: 'ready',
        docker,
        isolationEngine: docker.runscAvailable ? 'gVisor (runsc)' : 'standard-runc-isolated',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(statusData, null, 2) }],
      };
    }
  );

  server.tool(
    'sandboxrunner_capabilities',
    'List declared capabilities of SandboxRunner',
    {},
    async () => {
      const caps = [
        'sandbox-execution',
        'gvisor-isolation',
        'code-runner',
        'artifact-processing',
        'multi-language-runtime',
        'resource-limits',
      ];
      return {
        content: [{ type: 'text', text: JSON.stringify({ capabilities: caps }, null, 2) }],
      };
    }
  );

  server.tool(
    'sandboxrunner_check_gvisor',
    'Verify if gVisor (runsc) runtime is available in the local Docker daemon',
    {},
    async () => {
      const docker = await checkDockerAndGvisor();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                runscAvailable: docker.runscAvailable,
                dockerAvailable: docker.dockerAvailable,
                runtimes: docker.runtimes,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 2. Execution Tools
  server.tool(
    'sandboxrunner_execute_code',
    'Execute code safely inside a sandboxed gVisor container without network access',
    ExecuteCodeInputSchema.shape,
    async (args) => {
      try {
        const result = await handleExecuteCode(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Execution failed: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  server.tool(
    'sandboxrunner_run_with_artifacts',
    'Execute a batch command in an isolated sandbox with input files staged and output artifacts collected',
    RunWithArtifactsInputSchema.shape,
    async (args) => {
      try {
        const result = await handleRunWithArtifacts(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Artifact execution failed: ${err?.message || String(err)}` }],
        };
      }
    }
  );

  // Aliases for standard AI agent tool calls
  server.tool(
    'sandbox_execute_code',
    'Alias for sandboxrunner_execute_code',
    ExecuteCodeInputSchema.shape,
    async (args) => {
      const result = await handleExecuteCode(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    'sandbox_run_with_artifacts',
    'Alias for sandboxrunner_run_with_artifacts',
    RunWithArtifactsInputSchema.shape,
    async (args) => {
      const result = await handleRunWithArtifacts(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // 3. Resources
  server.resource('runtimes', 'sandbox://runtimes', async (uri) => {
    const text = await getRuntimesResourceContent();
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text }],
    };
  });

  server.resource('config', 'sandbox://config', async (uri) => {
    const text = getConfigResourceContent();
    return {
      contents: [{ uri: uri.href, mimeType: 'application/json', text }],
    };
  });

  // 4. Prompts
  server.prompt(
    'secure_eval',
    'Prompt template to run and verify a code snippet in the secure gVisor sandbox',
    {
      code: z.string().describe('Source code to evaluate'),
      language: z.string().default('javascript').describe('Language'),
    },
    (args) => getSecureEvalPrompt(args as any)
  );

  server.prompt(
    'data_processing',
    'Prompt template to process staged files and produce output artifacts',
    {
      task: z.string().describe('Task description'),
      script: z.string().describe('Batch script to run'),
    },
    (args) => getDataProcessingPrompt(args)
  );

  return server;
}
