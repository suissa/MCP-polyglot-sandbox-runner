import { executeInSandbox } from "./sandbox-runner.js";

async function main() {
  // Teste 1: Código Node.js do agente executando normalmente com gVisor
  const userCode = `
    const os = require('os');
    console.log("Executando dentro do gVisor!");
    console.log("Kernel OS reportado:", os.type(), os.release());
    console.log("Cálculo:", Array.from({ length: 5 }, (_, i) => i * 2));
  `;

  console.log("Executando sandbox com gVisor...");
  const result = await executeInSandbox(userCode);

  console.log("Status:", result.exitCode === 0 ? "SUCESSO" : "FALHA");
  console.log("Duração:", `${result.durationMs}ms`);
  console.log("Stdout:\n" + result.stdout);

  if (result.stderr) {
    console.error("Stderr:\n" + result.stderr);
  }

  // Teste 2: Proteção contra loop infinito e timeout
  console.log("\nTestando contenção de timeout (while true)...");
  const infiniteLoop = `while (true) {}`;
  const timeoutResult = await executeInSandbox(infiniteLoop, { timeoutMs: 2000 });
  console.log("Timeout atingido com sucesso?", timeoutResult.timedOut);
  console.log("Exit Code:", timeoutResult.exitCode);

  // Teste 3: Executar Python em vez de Node.js
  console.log("\nExecutando script Python...");
  const pythonCode = `
import sys
import platform
print(f"Python em sandbox: {platform.system()} {platform.release()}")
print("Saída de erro intencional", file=sys.stderr)
`;
  const pythonResult = await executeInSandbox(pythonCode, {
    image: "python:3.12-alpine",
    command: ["python", "-"]
  });
  console.log("Python stdout:", pythonResult.stdout.trim());
  console.log("Python stderr:", pythonResult.stderr.trim());
}

main().catch(console.error);