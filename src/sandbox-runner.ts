import { spawn } from "node:child_process";

export interface SandboxOptions {
  image?: string;
  memoryLimit?: string;
  cpuLimit?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  command?: string[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export async function executeInSandbox(
  code: string,
  options: SandboxOptions = {}
): Promise<SandboxResult> {
  const {
    image = "node:22-alpine",
    memoryLimit = "256m",
    cpuLimit = "1.0",
    timeoutMs = 10_000,
    maxBufferBytes = 1024 * 1024 * 5, // 5 MB para evitar OOM no host por loops infinitos de log
    command = ["node", "-"] // Lê o código diretamente de stdin
  } = options;

  const dockerArgs: string[] = [
    "run",
    "--rm",
    "-i",
    "--runtime=runsc",
    "--network=none",                        // Isolamento total de rede
    `--memory=${memoryLimit}`,                // Teto de RAM
    `--cpus=${cpuLimit}`,                     // Limite de CPU
    "--pids-limit=100",                       // Proteção contra fork bombs
    "--read-only",                            // Root filesystem imutável
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m", // Workspace temporário estritamente isolado
    "--cap-drop=ALL",                         // Descarta todas as Linux capabilities
    "--security-opt=no-new-privileges",
    image,
    ...command
  ];

  return new Promise<SandboxResult>((resolve) => {
    const startTime = Date.now();
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;

    const child = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBuffer.length < maxBufferBytes) {
        stdoutBuffer += chunk.toString("utf-8");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBuffer.length < maxBufferBytes) {
        stderrBuffer += chunk.toString("utf-8");
      }
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode,
        timedOut,
        durationMs: Date.now() - startTime
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        stdout: stdoutBuffer,
        stderr: `${stderrBuffer}\nDocker spawn error: ${err.message}`.trim(),
        exitCode: 1,
        timedOut: false,
        durationMs: Date.now() - startTime
      });
    });

    // Injeta o código do agente no stdin do interpretador dentro da sandbox
    child.stdin.write(code);
    child.stdin.end();
  });
}