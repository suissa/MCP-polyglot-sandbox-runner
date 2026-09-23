import { runSandboxWithIO } from "../sandbox-io.js";

async function main() {
  const startTime = Date.now();

  // Script executado dentro da sandbox gVisor
  const inputScript = `
    const fs = require('fs');

    console.log("[SANDBOX] Inicializado com sucesso sob gVisor.");
    console.log("[SANDBOX] Conteúdo de /workspace:", fs.readdirSync('/workspace'));

    const inputDir = '/workspace/input';
    if (!fs.existsSync(inputDir)) {
      throw new Error("Diretório /workspace/input não existe.");
    }
    console.log("[SANDBOX] Conteúdo de /workspace/input:", fs.readdirSync(inputDir));

    const datasetPath = '/workspace/input/dataset.json';
    if (!fs.existsSync(datasetPath)) {
      throw new Error("Arquivo /workspace/input/dataset.json não encontrado.");
    }

    const rawData = fs.readFileSync(datasetPath, 'utf-8');
    const data = JSON.parse(rawData);
    console.log("[SANDBOX] Dados lidos com sucesso:", JSON.stringify(data));

    // Garante que o diretório de saída existe
    fs.mkdirSync('/workspace/output', { recursive: true });

    // Gera o arquivo de resultado processado
    fs.writeFileSync(
      '/workspace/output/result.json',
      JSON.stringify(
        {
          processedAt: new Date().toISOString(),
          count: data.numbers.reduce((acc, n) => acc + n, 0)
        },
        null,
        2
      )
    );

    // Gera arquivo de confirmação
    fs.writeFileSync('/workspace/output/done.txt', 'Job completed successfully.');
    console.log("[SANDBOX] Artefatos gerados em /workspace/output.");
  `;

  console.log("Disparando execução na sandbox...");

  const result = await runSandboxWithIO(
    ["node", "-e", inputScript],
    [
      {
        relativePath: "dataset.json",
        content: Buffer.from(JSON.stringify({ numbers: [10, 20, 30, 40] }))
      }
    ],
    {
      timeoutMs: 15_000,
      memoryLimit: "256m"
    }
  );

  const duration = Date.now() - startTime;

  console.log("\n================ RESULTADO ================");
  console.log(`Status:    ${result.exitCode === 0 ? "SUCESSO (0)" : `FALHA (${result.exitCode})`}`);
  console.log(`Duração:   ${duration}ms`);

  if (result.stdout.trim()) {
    console.log("\n--- STDOUT ---");
    console.log(result.stdout.trim());
  }

  if (result.stderr.trim()) {
    console.error("\n--- STDERR ---");
    console.error(result.stderr.trim());
  }

  console.log(`\nArtefatos coletados (${result.artifacts.length}):`);
  for (const artifact of result.artifacts) {
    console.log(`\n• Arquivo: ${artifact.relativePath} (${artifact.content.length} bytes)`);
    console.log("-----------------------------------------");
    console.log(artifact.content.toString("utf-8").trim());
    console.log("-----------------------------------------");
  }
}

main().catch((err) => {
  console.error("\n[ERRO CRÍTICO NO HOST]:", err.message);
});