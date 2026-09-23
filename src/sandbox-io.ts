import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface ArtifactFile {
  relativePath: string;
  content: Buffer;
}

export interface SandboxIOOptions {
  image?: string;
  memoryLimit?: string;
  cpuLimit?: string;
  timeoutMs?: number;
  maxOutputSizeBytes?: number;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  artifacts: ArtifactFile[];
}

/**
 * Garante que o gVisor (runsc com ptrace) esteja registrado no dockerd.
 * Injeta a configuração usando Base64 para evitar bloqueio de stdin entre WSL e Windows.
 */
async function ensureGvisorRuntime(): Promise<void> {
  try {
    const { stdout } = await execFileAsync("docker", ["info"]);
    if (stdout.includes("runsc")) {
      return; // Runtime já ativo
    }
  } catch {
    // Continua para a injeção
  }

  console.log("[SANDBOX] Runtime runsc ausente no daemon. Auto-injetando gVisor...");

  // 1. Extrai a configuração ativa do dockerd na VM
  const { stdout: rawJson } = await execFileAsync("wsl.exe", [
    "-d",
    "docker-desktop",
    "-u",
    "root",
    "sh",
    "-c",
    "cat /proc/$(pidof dockerd)/root/run/config/docker/daemon.json"
  ]);

  const config = JSON.parse(rawJson);
  config.runtimes = config.runtimes || {};
  config.runtimes.runsc = {
    path: "/mnt/docker-desktop-disk/bin/runsc",
    runtimeArgs: ["--platform=ptrace"]
  };

  // 2. Codifica em Base64 para injeção atômica sem dependência de pipes/EOF
  const b64Config = Buffer.from(JSON.stringify(config, null, 2)).toString("base64");

  const injectCmd = `echo "${b64Config}" | base64 -d > /proc/$(pidof dockerd)/root/run/config/docker/daemon.json && kill -HUP $(pidof dockerd)`;

  await execFileAsync("wsl.exe", [
    "-d",
    "docker-desktop",
    "-u",
    "root",
    "sh",
    "-c",
    injectCmd
  ]);

  // 3. Aguarda a confirmação do dockerd via SIGHUP
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 400));
    try {
      const { stdout } = await execFileAsync("docker", ["info"]);
      if (stdout.includes("runsc")) {
        console.log("[SANDBOX] gVisor (runsc) injetado e pronto.");
        return;
      }
    } catch {}
  }

  throw new Error("Falha ao recarregar dockerd com o runtime runsc.");
}

export async function runSandboxWithIO(
  command: string[],
  inputFiles: ArtifactFile[],
  options: SandboxIOOptions = {}
): Promise<ExecutionResult> {
  const {
    image = "node:22-alpine",
    memoryLimit = "512m",
    cpuLimit = "1.0",
    timeoutMs = 20_000,
    maxOutputSizeBytes = 50 * 1024 * 1024
  } = options;

  // Garante a presença do gVisor
  await ensureGvisorRuntime();

  // Cria pasta temporária acessível pelo Docker Desktop
  const baseTmp = path.join(process.cwd(), ".sandbox_tmp");
  await fs.mkdir(baseTmp, { recursive: true });
  const tempHostDir = await fs.mkdtemp(path.join(baseTmp, "run-"));

  const inputDir = path.join(tempHostDir, "input");
  const outputDir = path.join(tempHostDir, "output");

  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });

  await fs.chmod(tempHostDir, 0o777);
  await fs.chmod(inputDir, 0o777);
  await fs.chmod(outputDir, 0o777);

  // 1. Grava os arquivos de entrada
  for (const file of inputFiles) {
    const safeTarget = path.join(
      inputDir,
      path.normalize(file.relativePath).replace(/^(\.\.[/\\])+/, "")
    );
    await fs.mkdir(path.dirname(safeTarget), { recursive: true });
    await fs.writeFile(safeTarget, file.content);
    await fs.chmod(safeTarget, 0o666);
  }

  const dockerArgs: string[] = [
    "run",
    "--rm",
    "-i",
    "--runtime=runsc",
    "--network=none",
    `--memory=${memoryLimit}`,
    `--cpus=${cpuLimit}`,
    "--pids-limit=100",
    "--read-only",
    `--volume=${tempHostDir}:/workspace:rw`,
    "--workdir=/workspace",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    image,
    ...command
  ];

  try {
    // 2. Executa a sandbox com gVisor
    const execution = await new Promise<{ stdout: string; stderr: string; exitCode: number }>(
      (resolve, reject) => {
        const child = spawn("docker", dockerArgs, {
          stdio: ["ignore", "pipe", "pipe"]
        }) as ChildProcess;

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (d: Buffer) => {
          stdout += d.toString("utf-8");
        });

        child.stderr?.on("data", (d: Buffer) => {
          stderr += d.toString("utf-8");
        });

        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Timeout de execução atingido (${timeoutMs}ms)`));
        }, timeoutMs);

        child.on("close", (code: number | null) => {
          clearTimeout(timer);
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });

        child.on("error", (err: Error) => {
          clearTimeout(timer);
          reject(err);
        });
      }
    );

    // 3. Coleta os artefatos gerados
    const collectedArtifacts = await collectAndSanitizeArtifacts(outputDir, maxOutputSizeBytes);

    return {
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
      artifacts: collectedArtifacts
    };
  } finally {
    // 4. Limpeza da pasta temporária
    await fs.rm(tempHostDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function collectAndSanitizeArtifacts(dir: string, maxBytes: number): Promise<ArtifactFile[]> {
  const artifacts: ArtifactFile[] = [];
  let totalBytes = 0;

  async function scan(currentDir: string, baseDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(baseDir, fullPath);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        await scan(fullPath, baseDir);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        totalBytes += stat.size;

        if (totalBytes > maxBytes) {
          throw new Error(`Cota de artefatos excedida: limite de ${maxBytes} bytes`);
        }

        const content = await fs.readFile(fullPath);
        artifacts.push({ relativePath, content });
      }
    }
  }

  await scan(dir, dir);
  return artifacts;
}