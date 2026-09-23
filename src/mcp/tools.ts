import { z } from 'zod';
import { executeInSandbox, type SandboxOptions } from '../sandbox-runner.ts';
import { runSandboxWithIO, type ArtifactFile } from '../sandbox-io.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ExecuteCodeInputSchema = z.object({
  code: z.string().min(1, 'Code snippet cannot be empty'),
  language: z
    .enum(['javascript', 'node', 'python', 'python3', 'bash', 'sh'])
    .default('javascript')
    .describe('Execution language runtime'),
  image: z.string().optional().describe('Custom Docker image (optional)'),
  memoryLimit: z.string().default('256m').describe('RAM ceiling e.g. 256m, 512m'),
  cpuLimit: z.string().default('1.0').describe('CPU quota e.g. 1.0'),
  timeoutMs: z.number().int().positive().default(10_000).describe('Timeout in milliseconds'),
  command: z.array(z.string()).optional().describe('Interpreter command override'),
});

export const RunWithArtifactsInputSchema = z.object({
  command: z.array(z.string()).min(1, 'Command must not be empty'),
  inputFiles: z
    .array(
      z.object({
        relativePath: z.string(),
        content: z.string(),
        encoding: z.enum(['utf-8', 'base64']).default('utf-8'),
      })
    )
    .default([])
    .describe('Input files to stage before execution'),
  image: z.string().default('node:22-alpine').describe('Container image to run'),
  memoryLimit: z.string().default('512m').describe('RAM limit'),
  cpuLimit: z.string().default('1.0').describe('CPU quota'),
  timeoutMs: z.number().int().positive().default(20_000).describe('Timeout in milliseconds'),
  maxOutputSizeBytes: z.number().int().positive().default(50 * 1024 * 1024),
});

export const EmptySchema = z.object({});

export async function checkDockerAndGvisor() {
  try {
    const { stdout } = await execFileAsync('docker', ['info', '--format', '{{json .}}']);
    const info = JSON.parse(stdout);
    const runtimes = Object.keys(info.Runtimes || {});
    return {
      dockerAvailable: true,
      runscAvailable: runtimes.includes('runsc'),
      serverVersion: info.ServerVersion || 'unknown',
      runtimes,
    };
  } catch (err: any) {
    return {
      dockerAvailable: false,
      runscAvailable: false,
      serverVersion: 'unknown',
      runtimes: [],
      error: err?.message || String(err),
    };
  }
}

export async function handleExecuteCode(args: z.infer<typeof ExecuteCodeInputSchema>) {
  const lang = (args.language || 'javascript').toLowerCase();
  let defaultImage = 'node:22-alpine';
  let defaultCommand = ['node', '-'];

  if (lang === 'python' || lang === 'python3') {
    defaultImage = 'python:3.12-alpine';
    defaultCommand = ['python', '-'];
  } else if (lang === 'bash' || lang === 'sh') {
    defaultImage = 'alpine:latest';
    defaultCommand = ['sh', '-s'];
  }

  const options: SandboxOptions = {
    image: args.image || defaultImage,
    command: args.command || defaultCommand,
    memoryLimit: args.memoryLimit,
    cpuLimit: args.cpuLimit,
    timeoutMs: args.timeoutMs,
  };

  const result = await executeInSandbox(args.code, options);
  return result;
}

export async function handleRunWithArtifacts(args: z.infer<typeof RunWithArtifactsInputSchema>) {
  const artifactsInput: ArtifactFile[] = (args.inputFiles || []).map((f) => ({
    relativePath: f.relativePath,
    content: Buffer.from(f.content, f.encoding === 'base64' ? 'base64' : 'utf-8'),
  }));

  const result = await runSandboxWithIO(args.command, artifactsInput, {
    image: args.image,
    memoryLimit: args.memoryLimit,
    cpuLimit: args.cpuLimit,
    timeoutMs: args.timeoutMs,
    maxOutputSizeBytes: args.maxOutputSizeBytes,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    artifactsCount: result.artifacts.length,
    artifacts: result.artifacts.map((a) => ({
      relativePath: a.relativePath,
      sizeBytes: a.content.length,
      contentBase64: a.content.toString('base64'),
      textSnippet: a.content.toString('utf-8').slice(0, 1000),
    })),
  };
}
