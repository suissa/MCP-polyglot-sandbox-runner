#!/usr/bin/env node
/**
 * Local, self-contained MCP kernel for SandboxRunner module.
 *
 * Everything-as-Code: no id, name, capability, host, port or NATS subject is
 * a literal in this file — everything comes from this module's own
 * `configs/core.yml`, read exclusively via packages/Tools/UbiQonfig.
 *
 * Every dispatched JSON-RPC method ("route", e.g. `tools/call`) is also
 * emitted as a local event and published as a NATS event, with the same
 * name but "/" replaced by ".": `tools/call` -> `tools.call`.
 */
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import { loadYaml, loadJson, loadEnv } from '../../../../../Tools/UbiQonfig/src/index.js';
import { restTransport } from './transports/rest.mjs';
import { webSocketTransport } from './transports/websocket.mjs';
import { natsTransport } from './transports/nats.mjs';
import {
  checkDockerStatus,
  executeCode,
  runWithArtifacts,
  SUPPORTED_LANGUAGES,
} from './engine.mjs';

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const networkMode = process.argv.includes('--network') || process.env.MCP_NETWORK === '1';

export const events = new EventEmitter();

/* ------------------------------------------------------------------ *
 * Config: read only this module's own configs/core.yml (+ optional      *
 * core.local.json overlay / .env), via UbiQonfig only.                  *
 * ------------------------------------------------------------------ */

const module_ = loadModuleConfig(moduleDir);

function loadModuleConfig(dir) {
  const base = loadYaml('configs/core.yml', { baseDir: dir });
  if (!base || !base.module || !base.module.id) {
    throw new Error(`Invalid configs/core.yml in ${dir}: missing module.id`);
  }
  const local = loadJson('configs/core.local.json', { baseDir: dir });
  const merged = local ? deepMerge(base, local) : base;
  loadEnv('configs/.env', { baseDir: dir });
  resolveEnvPlaceholders(merged);

  const transports = merged.mcp?.transports || {};
  return {
    id: merged.module.id,
    name: merged.module.name || merged.module.id,
    capabilities: merged.module.capabilities || [],
    api: merged.module.api || { status: 'unknown' },
    transports: {
      stdio: { enabled: transports.stdio?.enabled !== false },
      rest: {
        enabled: transports.rest?.enabled === true,
        host: transports.rest?.host || '127.0.0.1',
        port: transports.rest?.port,
      },
      websocket: {
        enabled: transports.websocket?.enabled === true,
        host: transports.websocket?.host || '127.0.0.1',
        port: transports.websocket?.port,
      },
      nats: {
        enabled: transports.nats?.enabled === true,
        url: transports.nats?.url || 'nats://127.0.0.1:4222',
        subject: transports.nats?.subject || `${merged.module.id}.rpc`,
        queue: transports.nats?.queue || merged.module.id,
      },
    },
  };
}

function deepMerge(target, source) {
  if (Array.isArray(target) || Array.isArray(source) || typeof source !== 'object' || source === null) {
    return source;
  }
  const out = { ...target };
  for (const key of Object.keys(source)) {
    out[key] = key in target ? deepMerge(target[key], source[key]) : source[key];
  }
  return out;
}

function resolveEnvPlaceholders(node) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = resolveScalar(node[i]);
    return;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) node[key] = resolveScalar(node[key]);
  }
}

function resolveScalar(value) {
  if (typeof value === 'string') {
    const match = /^\$\{([A-Z0-9_]+)\}$/.exec(value);
    if (match && process.env[match[1]] !== undefined) return process.env[match[1]];
    return value;
  }
  if (value && typeof value === 'object') resolveEnvPlaceholders(value);
  return value;
}

/* ------------------------------------------------------------------ *
 * Tool definitions                                                    *
 * ------------------------------------------------------------------ */

const toolDefinitions = [
  {
    name: `${module_.id}_status`,
    description: `Health, container runtime and implementation status for ${module_.name}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const dockerInfo = await checkDockerStatus();
      return {
        module: module_.id,
        name: module_.name,
        status: 'ready',
        api: module_.api,
        mcp: 'ready',
        docker: dockerInfo,
        isolationEngine: dockerInfo.runscAvailable ? 'gVisor (runsc)' : 'isolated runc fallback',
      };
    },
  },
  {
    name: `${module_.id}_capabilities`,
    description: `Declared domain capabilities for ${module_.name}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({ module: module_.id, capabilities: module_.capabilities }),
  },
  {
    name: `${module_.id}_api_contract`,
    description: `Stable MCP/API contract metadata for ${module_.name}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({
      module: module_.id,
      transport: 'MCP stdio / REST / WebSocket / NATS, JSON-RPC 2.0',
      toolNamespace: `${module_.id}_*`,
      legacyApi: module_.api,
      supportedLanguages: Object.keys(SUPPORTED_LANGUAGES),
    }),
  },
  {
    name: `${module_.id}_check_gvisor`,
    description: 'Verify gVisor (runsc) availability in local Docker daemon.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      const dockerInfo = await checkDockerStatus();
      return {
        runscAvailable: dockerInfo.runscAvailable,
        dockerAvailable: dockerInfo.dockerAvailable,
        runtimes: dockerInfo.runtimes,
        status: dockerInfo.runscAvailable ? 'active' : 'inactive',
      };
    },
  },
  {
    name: `${module_.id}_execute_code`,
    description: 'Execute code safely inside a sandboxed gVisor container without network access.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The source code to execute' },
        language: {
          type: 'string',
          description: 'Language runtime: javascript, typescript, python, bash, sh (default: javascript)',
        },
        image: { type: 'string', description: 'Custom docker image (optional)' },
        memoryLimit: { type: 'string', description: 'RAM limit e.g. 256m, 512m (default: 256m)' },
        cpuLimit: { type: 'string', description: 'CPU limit e.g. 1.0 (default: 1.0)' },
        timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds (default: 10000)' },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Override interpreter command (optional)',
        },
      },
      required: ['code'],
    },
    handler: async (args) => {
      if (!args.code || typeof args.code !== 'string') {
        throw new Error('Param "code" is required and must be a string');
      }
      return executeCode(args.code, args);
    },
  },
  {
    name: `${module_.id}_run_with_artifacts`,
    description: 'Execute a batch command in an isolated sandbox with input files staged and output artifacts collected.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command and arguments to run inside workspace',
        },
        inputFiles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              relativePath: { type: 'string' },
              content: { type: 'string' },
              encoding: { type: 'string', enum: ['utf-8', 'base64'] },
            },
            required: ['relativePath', 'content'],
          },
          description: 'Files to stage in the workspace before execution',
        },
        image: { type: 'string', description: 'Container image to run (default: node:22-alpine)' },
        memoryLimit: { type: 'string', description: 'RAM limit (default: 512m)' },
        cpuLimit: { type: 'string', description: 'CPU quota (default: 1.0)' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default: 20000)' },
        maxOutputSizeBytes: { type: 'number', description: 'Max total size of collected output files (default: 50MB)' },
      },
      required: ['command'],
    },
    handler: async (args) => {
      if (!Array.isArray(args.command) || args.command.length === 0) {
        throw new Error('Param "command" must be a non-empty array of strings');
      }
      return runWithArtifacts(args.command, args.inputFiles || [], args);
    },
  },
  // Aliases for standard AI agent tool calls
  {
    name: 'sandbox_execute_code',
    description: 'Alias for sandboxrunner_execute_code: execute code safely inside gVisor sandbox container.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'The source code to execute' },
        language: { type: 'string', description: 'Language runtime (default: javascript)' },
        image: { type: 'string' },
        memoryLimit: { type: 'string' },
        cpuLimit: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['code'],
    },
    handler: async (args) => executeCode(args.code, args),
  },
  {
    name: 'sandbox_run_with_artifacts',
    description: 'Alias for sandboxrunner_run_with_artifacts: execute with input staging and artifact extraction.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'array', items: { type: 'string' } },
        inputFiles: { type: 'array' },
        image: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
    },
    handler: async (args) => runWithArtifacts(args.command, args.inputFiles || [], args),
  },
];

/* ------------------------------------------------------------------ *
 * Resource definitions                                                *
 * ------------------------------------------------------------------ */

const resourceDefinitions = [
  {
    uri: `lucy-mae://modules/${module_.id}`,
    name: module_.name,
    mimeType: 'application/json',
    reader: () => JSON.stringify(module_),
  },
  {
    uri: 'sandbox://runtimes',
    name: 'Sandbox Runtimes and Isolation Engine',
    mimeType: 'application/json',
    reader: async () => {
      const docker = await checkDockerStatus();
      return JSON.stringify({
        runtimes: SUPPORTED_LANGUAGES,
        isolationEngine: docker.runscAvailable ? 'gVisor (runsc)' : 'runc',
        docker,
        security: {
          network: 'none',
          readOnlyRoot: true,
          capDrop: 'ALL',
          noNewPrivileges: true,
          tmpfs: '64m',
          pidsLimit: 100,
        },
      });
    },
  },
  {
    uri: 'sandbox://config',
    name: 'Sandbox Execution Policy and Quotas',
    mimeType: 'application/json',
    reader: () =>
      JSON.stringify({
        defaultMemoryLimit: '256m',
        defaultCpuLimit: '1.0',
        defaultTimeoutMs: 10000,
        maxBufferSize: 5242880,
        maxArtifactSize: 52428800,
      }),
  },
];

/* ------------------------------------------------------------------ *
 * Prompt definitions                                                  *
 * ------------------------------------------------------------------ */

const promptDefinitions = [
  {
    name: 'secure_eval',
    description: 'Prompt template to run and verify a code snippet in the secure gVisor sandbox',
    arguments: [
      { name: 'code', description: 'The snippet to evaluate', required: true },
      { name: 'language', description: 'Language of the code (javascript, python, etc.)', required: false },
    ],
    generate: (args) => ({
      description: 'Execute code in secure sandbox',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Execute the following ${args.language || 'javascript'} code inside the secure sandbox runner and report stdout, stderr and exit status:\n\n\`\`\`${args.language || 'javascript'}\n${args.code}\n\`\`\``,
          },
        },
      ],
    }),
  },
  {
    name: 'data_processing',
    description: 'Prompt template to process staged files and produce output artifacts',
    arguments: [
      { name: 'task', description: 'Description of the data processing task', required: true },
      { name: 'script', description: 'Processing script to execute', required: true },
    ],
    generate: (args) => ({
      description: 'Batch data processing in sandbox',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Run the following task in the sandbox with artifact collection:\nTask: ${args.task}\n\nScript to run:\n${args.script}`,
          },
        },
      ],
    }),
  },
];

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0 dispatcher — shared by every transport.               *
 * ------------------------------------------------------------------ */

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

let natsHandle = null;

async function dispatch(request) {
  const response = await route(request);
  if (request?.method) {
    const eventName = request.method.replace(/\//g, '.');
    const payload = { module: module_.id, method: request.method, request, response };
    events.emit(eventName, payload);
    natsHandle?.publish(`${module_.id}.${eventName}`, payload);
  }
  return response;
}

async function route(request) {
  if (request.method === 'initialize') {
    return result(request.id, {
      protocolVersion: request.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: module_.id, version: '1.0.0' },
    });
  }
  if (request.method === 'notifications/initialized' || request.method === 'ping') return null;

  if (request.method === 'tools/list') {
    return result(request.id, { tools: toolDefinitions.map(({ handler, ...tool }) => tool) });
  }

  if (request.method === 'resources/list') {
    return result(request.id, {
      resources: resourceDefinitions.map(({ reader, ...res }) => res),
    });
  }

  if (request.method === 'resources/read') {
    const uri = String(request.params?.uri || '');
    const resource = resourceDefinitions.find((r) => r.uri === uri);
    if (!resource) return error(request.id, -32602, `Unknown resource: ${uri}`);
    const text = await resource.reader();
    return result(request.id, { contents: [{ uri, mimeType: resource.mimeType, text }] });
  }

  if (request.method === 'prompts/list') {
    return result(request.id, {
      prompts: promptDefinitions.map(({ generate, ...p }) => p),
    });
  }

  if (request.method === 'prompts/get') {
    const prompt = promptDefinitions.find((p) => p.name === request.params?.name);
    if (!prompt) return error(request.id, -32602, `Unknown prompt: ${request.params?.name}`);
    return result(request.id, prompt.generate(request.params?.arguments || {}));
  }

  if (request.method === 'tools/call') {
    const tool = toolDefinitions.find((item) => item.name === request.params?.name);
    if (!tool) return error(request.id, -32602, `Unknown tool: ${request.params?.name}`);
    try {
      const data = await tool.handler(request.params?.arguments || {});
      const text = JSON.stringify(data);
      return result(request.id, { content: [{ type: 'text', text }], structuredContent: data });
    } catch (err) {
      return result(request.id, {
        isError: true,
        content: [{ type: 'text', text: `Execution error: ${err.message}` }],
        structuredContent: { error: err.message },
      });
    }
  }

  return error(request.id, -32601, `Method not found: ${request.method}`);
}

/* ------------------------------------------------------------------ *
 * Transports                                                         *
 * ------------------------------------------------------------------ */

const runningTransports = [];

if (networkMode) {
  if (module_.transports.rest.enabled) {
    if (!module_.transports.rest.port) {
      process.stderr.write(`${module_.id}: rest.enabled but no rest.port configured, skipping\n`);
    } else {
      const transport = restTransport({
        host: module_.transports.rest.host,
        port: module_.transports.rest.port,
        moduleId: module_.id,
      });
      await transport.start(dispatch);
      runningTransports.push(transport);
      process.stderr.write(`${module_.id}: ${transport.name} ready\n`);
    }
  }
  if (module_.transports.websocket.enabled) {
    if (!module_.transports.websocket.port) {
      process.stderr.write(`${module_.id}: websocket.enabled but no websocket.port configured, skipping\n`);
    } else {
      const transport = webSocketTransport({
        host: module_.transports.websocket.host,
        port: module_.transports.websocket.port,
      });
      await transport.start(dispatch);
      runningTransports.push(transport);
      process.stderr.write(`${module_.id}: ${transport.name} ready\n`);
    }
  }
  if (module_.transports.nats.enabled) {
    const transport = natsTransport({
      url: module_.transports.nats.url,
      rpcSubject: module_.transports.nats.subject,
      queue: module_.transports.nats.queue,
    });
    await transport.start(dispatch);
    natsHandle = transport;
    runningTransports.push(transport);
    process.stderr.write(`${module_.id}: ${transport.name} connecting...\n`);
  }
}

async function shutdown() {
  await Promise.all(runningTransports.map((t) => t.stop()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// stdio: always on by default
if (module_.transports.stdio.enabled) {
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const response = await dispatch(JSON.parse(line));
      if (response) write(response);
    } catch (cause) {
      write(error(null, -32700, cause instanceof Error ? cause.message : String(cause)));
    }
  }
}
