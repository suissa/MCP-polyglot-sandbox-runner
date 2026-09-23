import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export const SUPPORTED_LANGUAGES = {
  javascript: { image: 'node:22-alpine', command: ['node', '-'] },
  node: { image: 'node:22-alpine', command: ['node', '-'] },
  python: { image: 'python:3.12-alpine', command: ['python', '-'] },
  python3: { image: 'python:3.12-alpine', command: ['python', '-'] },
  bash: { image: 'alpine:latest', command: ['sh', '-s'] },
  sh: { image: 'alpine:latest', command: ['sh', '-s'] },
};

/**
 * Checks whether docker and gVisor (runsc) are available.
 */
export async function checkDockerStatus() {
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
  } catch (err) {
    return {
      dockerAvailable: false,
      runscAvailable: false,
      serverVersion: 'unknown',
      runtimes: [],
      error: err.message,
    };
  }
}

/**
 * Executes a code snippet inside a strictly isolated sandbox container.
 */
export async function executeCode(code, options = {}) {
  const langKey = (options.language || 'javascript').toLowerCase();
  const langConfig = SUPPORTED_LANGUAGES[langKey] || SUPPORTED_LANGUAGES.javascript;

  const image = options.image || langConfig.image;
  const memoryLimit = options.memoryLimit || '256m';
  const cpuLimit = options.cpuLimit || '1.0';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBufferBytes = options.maxBufferBytes ?? 5 * 1024 * 1024;
  const command = options.command || langConfig.command;

  // Check if runsc is available to avoid hard-failing if testing without gvisor
  const status = await checkDockerStatus();
  const useGvisor = status.runscAvailable;

  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    ...(useGvisor ? ['--runtime=runsc'] : []),
    '--network=none',
    `--memory=${memoryLimit}`,
    `--cpus=${cpuLimit}`,
    '--pids-limit=100',
    '--read-only',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    image,
    ...command,
  ];

  return new Promise((resolve) => {
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn('docker', dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxBufferBytes) stdout += chunk.toString('utf-8');
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxBufferBytes) stderr += chunk.toString('utf-8');
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        durationMs: Date.now() - startTime,
        isolation: useGvisor ? 'gvisor (runsc)' : 'standard-runc-isolated',
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: `${stderr}\nDocker spawn error: ${err.message}`.trim(),
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - startTime,
        isolation: 'error',
      });
    });

    try {
      child.stdin.write(code);
      child.stdin.end();
    } catch {
      // Stream could already be closed
    }
  });
}

/**
 * Runs a command inside the sandbox staging input files and returning generated artifacts.
 */
export async function runWithArtifacts(command, inputFiles = [], options = {}) {
  const {
    image = 'node:22-alpine',
    memoryLimit = '512m',
    cpuLimit = '1.0',
    timeoutMs = 20_000,
    maxOutputSizeBytes = 50 * 1024 * 1024,
  } = options;

  const status = await checkDockerStatus();
  const useGvisor = status.runscAvailable;

  const baseTmp = path.join(process.cwd(), '.sandbox_tmp');
  await fs.mkdir(baseTmp, { recursive: true });
  const tempHostDir = await fs.mkdtemp(path.join(baseTmp, 'mcp-run-'));

  const inputDir = path.join(tempHostDir, 'input');
  const outputDir = path.join(tempHostDir, 'output');

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  await fs.chmod(tempHostDir, 0o777).catch(() => {});
  await fs.chmod(inputDir, 0o777).catch(() => {});
  await fs.chmod(outputDir, 0o777).catch(() => {});

  // Write input files
  for (const file of inputFiles) {
    const safeTarget = path.join(
      inputDir,
      path.normalize(file.relativePath || 'file').replace(/^(\.\.[/\\])+/, '')
    );
    await fs.mkdir(path.dirname(safeTarget), { recursive: true });
    const content = Buffer.isBuffer(file.content)
      ? file.content
      : Buffer.from(file.content || '', file.encoding === 'base64' ? 'base64' : 'utf-8');
    await fs.writeFile(safeTarget, content);
    await fs.chmod(safeTarget, 0o666).catch(() => {});
  }

  const dockerArgs = [
    'run',
    '--rm',
    '-i',
    ...(useGvisor ? ['--runtime=runsc'] : []),
    '--network=none',
    `--memory=${memoryLimit}`,
    `--cpus=${cpuLimit}`,
    '--pids-limit=100',
    '--read-only',
    `--volume=${tempHostDir}:/workspace:rw`,
    '--workdir=/workspace',
    '--tmpfs=/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    image,
    ...command,
  ];

  try {
    const execution = await new Promise((resolve, reject) => {
      const child = spawn('docker', dockerArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => {
        stdout += d.toString('utf-8');
      });

      child.stderr.on('data', (d) => {
        stderr += d.toString('utf-8');
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Timeout de execução atingido (${timeoutMs}ms)`));
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const collectedArtifacts = await collectArtifacts(outputDir, maxOutputSizeBytes);

    return {
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
      artifacts: collectedArtifacts,
      isolation: useGvisor ? 'gvisor (runsc)' : 'standard-runc-isolated',
    };
  } finally {
    await fs.rm(tempHostDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function collectArtifacts(dir, maxBytes) {
  const artifacts = [];
  let totalBytes = 0;

  async function scan(currentDir, baseDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await scan(fullPath, baseDir);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        totalBytes += stat.size;

        if (totalBytes > maxBytes) {
          throw new Error(`Cota de artefatos excedida: limite de ${maxBytes} bytes`);
        }

        const buf = await fs.readFile(fullPath);
        artifacts.push({
          relativePath,
          sizeBytes: stat.size,
          contentBase64: buf.toString('base64'),
          isText: isUtf8(buf),
          textSnippet: isUtf8(buf) ? buf.toString('utf-8').slice(0, 1000) : null,
        });
      }
    }
  }

  await scan(dir, dir);
  return artifacts;
}

function isUtf8(buf) {
  try {
    const str = buf.toString('utf-8');
    return !str.includes('\uFFFD');
  } catch {
    return false;
  }
}
