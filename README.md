# @allascode/sandbox-runner (SandboxRunner MCP Server)

Servidor MCP padronizado e motor de execução isolada de código para agentes de IA, utilizando **Docker** e sandbox de kernel **gVisor (`runsc`)**.

Em conformidade rigorosa com a arquitetura `docs/MCP-STANDARD.md` do ecossistema AllasCode, suportando múltiplos transportes simultâneos (stdio, REST, WebSocket e NATS), desacoplamento total via Everything-as-Code (`configs/core.yml`) e camada de compatibilidade nativa com `@modelcontextprotocol/sdk`.

---

## 1. Arquitetura de Isolamento e Segurança

Todo código executado por agentes de IA é submetido a múltiplas barreiras de contenção no host:

- **Isolamento de Kernel (gVisor `runsc`)**: Virtualização de chamadas de sistema no espaço do usuário via gVisor, impedindo explorações de vulnerabilidades no kernel do host (com fallback seguro para runc isolado quando em ambientes sem suporte a gVisor).
- **Isolamento de Rede Total**: Execução sob `--network=none` — o container não possui interfaces de rede ativas nem acesso à internet/intranet.
- **Root Filesystem Imutável**: Flag `--read-only`, impedindo qualquer modificação no sistema de arquivos da imagem.
- **Privilégios Mínimos**: Flag `--cap-drop=ALL` (descarta todas as Linux capabilities) e `--security-opt=no-new-privileges`.
- **Prevenção contra Fork Bombs**: Limite restrito de processos (`--pids-limit=100`).
- **Workspace Temporário Controlado**: `--tmpfs=/tmp:rw,noexec,nosuid,size=64m`.
- **Quotas de Recursos Estritas**: Limites padrão de memória (RAM) e CPU (ex: 256MB e 1.0 CPU), com timeout agressivo de contenção (default 10s).

---

## 2. Padrão de Transportes MCP

Conforme `docs/MCP-STANDARD.md`:

| Transporte | Como ativar | Porta / Endereço | Descrição |
|---|---|---|---|
| **stdio** | Sempre ativo (padrão) | `stdin` / `stdout` | Usado pelo `.mcp.json` para Claude Desktop, Cursor e Antigravity. |
| **REST HTTP** | `node mcp/server.mjs --network` | `http://127.0.0.1:7631` | `POST /rpc` (JSON-RPC 2.0) e `GET /healthz`. |
| **WebSocket** | `node mcp/server.mjs --network` | `ws://127.0.0.1:7632/` | Canal bidirecional RFC 6455 puro para controle em tempo real. |
| **NATS** | `node mcp/server.mjs --network` | `nats://127.0.0.1:60001` | Request/Reply em `sandboxrunner.rpc` e publicação de eventos `sandboxrunner.<rota>`. |

---

## 3. Ferramentas (Tools)

### Descoberta e Contrato
- **`sandboxrunner_status`**: Retorna status do módulo (`ready`), evidência de implementação, versão do Docker e disponibilidade do runtime `runsc` (gVisor).
- **`sandboxrunner_capabilities`**: Lista as capacidades declaradas do módulo.
- **`sandboxrunner_api_contract`**: Metadados estáveis do contrato MCP e linguagens suportadas.
- **`sandboxrunner_check_gvisor`**: Verifica se o runtime gVisor está ativo no daemon Docker local.

### Execução de Código e Artefatos
- **`sandboxrunner_execute_code`** (alias: **`sandbox_execute_code`**):
  Executa código diretamente na sandbox isolada.
  - Parâmetros:
    - `code`: string (obrigatório)
    - `language`: `javascript`, `typescript`, `python`, `bash`, `sh` (opcional, default `javascript`)
    - `memoryLimit`: string (opcional, default `256m`)
    - `cpuLimit`: string (opcional, default `1.0`)
    - `timeoutMs`: number (opcional, default `10000`)
- **`sandboxrunner_run_with_artifacts`** (alias: **`sandbox_run_with_artifacts`**):
  Executa um comando com encadeamento de arquivos (staging de entrada em `input/` e coleta de artefatos gerados em `output/`).
  - Parâmetros:
    - `command`: array de strings (obrigatório, ex: `["node", "script.js"]`)
    - `inputFiles`: array de `{ relativePath, content, encoding }`
    - `maxOutputSizeBytes`: quota de tamanho para coleta de arquivos de saída (default 50MB)

---

## 4. Recursos (Resources)

- **`lucy-mae://modules/sandboxrunner`**: Perfil canônico do módulo.
- **`sandbox://runtimes`**: Runtimes disponíveis, imagens base e matriz de políticas de segurança ativas.
- **`sandbox://config`**: Quotas ativas, limites padrão de hardware e configuração de portas.

---

## 5. Prompts

- **`secure_eval`**: Template de instrução para agentes avaliarem código dentro da sandbox.
- **`data_processing`**: Template de instrução para processamento em lote com extração de artefatos.

---

## 6. Configuração (`configs/core.yml`)

```yaml
module:
  id: sandboxrunner
  name: SandboxRunner
  capabilities:
    - sandbox-execution
    - gvisor-isolation
    - code-runner
    - artifact-processing
    - multi-language-runtime
    - resource-limits
  api:
    status: implemented
    evidence: src/sandbox-runner.ts

mcp:
  transports:
    stdio:
      enabled: true
    rest:
      enabled: true
      host: 127.0.0.1
      port: 7631
    websocket:
      enabled: true
      host: 127.0.0.1
      port: 7632
    nats:
      enabled: true
      url: "nats://127.0.0.1:60001"
      subject: sandboxrunner.rpc
      queue: sandboxrunner
```

---

## 7. Como Executar

### Modo Stdio (Padrão para Agentes Locais / `.mcp.json`)
```bash
node mcp/server.mjs
```

### Modo de Rede (Stdio + REST + WebSocket + NATS)
```bash
node mcp/server.mjs --network
```

### Modo TypeScript SDK Oficial
```bash
npm run start:sdk
```

### Executar Testes Automatizados
```bash
npm test
```

### Validação de Tipos (Typecheck)
```bash
npm run typecheck
```

---

## 8. Codebox — boxes poliglotas com telemetria

Boxes de desenvolvimento (TypeScript, Python, Go, Rust e Zig) declaradas em `configs/codebox.yml`, operadas pelo CLI `./codebox` e pelas tools `codebox_*` do MCP.

### 8.1 Config (`configs/codebox.yml`)

```yaml
defaults:
  runtime: auto          # auto = gVisor (runsc) se o daemon tiver, senão runc
  network: bridge        # network_mode do container (setup precisa de rede p/ instalar pacotes)
  proxy: none            # inherit = repassa HTTP(S)_PROXY/NO_PROXY para build e container
  resources: { cpus: "2.0", memory: 2g, pids: 512 }
  timeout_ms: 60000

boxes:
  poly:
    languages: [typescript, python, go, rust, zig]   # 1 ou mais (aliases: ts, py, rs, golang)
    env: { APP_ENV: sandbox }
    init:                                           # 1 ou mais códigos de inicialização
      - path: ts/main.ts
        content: |
          console.log("hello")
      - path: py/main.py
        source: seeds/main.py                       # ou copia um arquivo (relativo à config)
```

A config é validada antes de qualquer coisa: linguagem desconhecida, box sem `init`, `path` fora de `codes/` ou arquivo de init de uma linguagem não declarada geram erro.

Opções extras por box/defaults: `build_network` (rede do `docker build`), `ca_cert` (CA extra para proxy corporativo; também via `CODEBOX_CA_CERT`), `images.*` (imagens base) e `zig_version`.

### 8.2 `./codebox up <alias>`

```bash
npm install                 # uma vez (o CLI usa node para ler o YAML)
./codebox up poly           # renderiza e sobe
./codebox up poly --setup   # ... e roda o setup em seguida
```

Gera `boxes/<alias>/` e roda `docker compose up -d` nessa pasta:

| Arquivo | Conteúdo |
|---|---|
| `Dockerfile` | um estágio de toolchain por linguagem configurada + runners de telemetria compilados |
| `docker-compose.yml` | serviço `box`, container `codebox-<alias>`, limites de CPU/memória/PIDs, `no-new-privileges`, `runsc` quando disponível |
| `config.yml` | config resolvida do box (lida pelo MCP) |
| `.env` | variáveis do box (`CODEBOX_BOX`, `OTEL_SERVICE_NAME`, `env:` da config…) |
| `codes/` | códigos de inicialização (arquivos existentes são preservados; `--force` sobrescreve) |
| `logs/` | `monitoramento.log` e `top_snapshot.log` |
| `runs/<run_id>/` | `telemetry.json`, `setup.json`, `stdout.log`, `stderr.log`, `top_*.log` |

Outros comandos: `./codebox render|down|ps|setup|run|metrics <alias>` e `./codebox ls`.

### 8.3 `setup`

`setup [dir] [--no-test] [--no-install]` (dentro do box, ou `./codebox setup <alias>`):

1. **scan** — lê a extensão de todos os arquivos (`ts/tsx/mts/cts/js`, `py`, `go`, `rs`, `zig`) e detecta as linguagens;
2. **preflight** — barra os "erros idiotas" antes de gastar tempo: toolchain presente, manifests válidos (`package.json`, `go.mod`, `Cargo.toml`) e checagem só de sintaxe de cada arquivo (parser do TypeScript, `py_compile`, `gofmt -e`, `rustfmt`, `zig ast-check`). **Se falhar, nada mais roda**;
3. **install** — `npm ci`/`npm install`, `pip install -r requirements.txt`/`-e .`, `go mod tidy`, `cargo fetch`, `zig build --fetch`;
4. **build** — `npm run build`/`tsc --noEmit`, `compileall`, `go build`, `cargo build`/`rustc`, `zig build`/`zig build-exe`;
5. **test** — `npm test`/`node --test` (`*.test.ts`), `pytest`, `go test`, `cargo test`/`rustc --test`, `zig build test`/`zig test`.

Cada etapa só roda se a anterior passou. Saída: log legível + relatório JSON `codebox.setup/v1`. Exit codes: `0` ok · `2` preflight · `3` install · `4` build · `5` test.

### 8.4 Runners de telemetria (`tools/codebox/runtime/runners/`)

Um script por linguagem que importa o SDK de telemetria mais recente da linguagem e **executa o código real somente via spawn** (processo filho):

| Linguagem | Runner | Telemetria | Recursos do filho |
|---|---|---|---|
| TypeScript/JS | `ts/telemetry.ts` | OpenTelemetry JS SDK 2.x (`sdk-trace-base`, `sdk-metrics`) | `/proc/self/stat` (cutime/cstime, faults) + amostragem de `/proc/<pid>/status` (VmHWM, ctx switches) |
| Python | `py/telemetry.py` | `opentelemetry-sdk` 1.4x | `getrusage(RUSAGE_CHILDREN)` |
| Go | `go/main.go` | `go.opentelemetry.io/otel` 1.4x (`tracetest`, `ManualReader`) | `ProcessState.SysUsage()` |
| Rust | `rs/src/main.rs` | `opentelemetry` / `opentelemetry_sdk` 0.33 | `wait4()` |
| Zig | `zig/telemetry.zig` | modelo de dados OTel implementado no runner (Zig não tem SDK oficial) | `wait4()` via `std.process` |

Go, Rust e Zig compilam antes (span `compile`) e depois executam o binário (span `process.exec`, filho de `codebox.run`). Todos gravam o mesmo documento `codebox.telemetry/v1` (`schemas/codebox-telemetry.schema.json`) em `$CODEBOX_TELEMETRY_OUT`, com spans, métricas (`process.duration`, `process.cpu.time`, `process.memory.max_rss`, `process.paging.faults`, `process.context_switches`, `codebox.compile.duration`) e rusage. `CODEBOX_TIMEOUT_MS` mata o filho com SIGKILL.

Dentro do box: `codebox-run <arquivo> [args]` escolhe o runner pela extensão.

### 8.5 Tools MCP

| Tool | O que faz |
|---|---|
| `codebox_boxes` | lista os boxes renderizados |
| `codebox_up` | roda `./codebox up <box>` |
| `codebox_index` | índice `nome → path` dos arquivos com nome **único** + nomes duplicados |
| `codebox_push` | envia arquivos novos/alterados; opcionalmente `setup: true` e `run: { entry, args, timeout_ms }` |
| `codebox_setup` | roda o `setup` no box |
| `codebox_run` | executa um arquivo pelo runner de telemetria e coleta métricas |

Regras do `codebox_push` para cada arquivo `{ path?, name?, content, encoding? }`:

- **com `path`** → sobrescreve (ou cria) exatamente ali;
- **sem `path`, `name` único no índice** → sobrescreve o arquivo indexado;
- **sem `path`, `name` inexistente** → cria em `codes/<name>`;
- **sem `path`, `name` presente em mais de um lugar** → a requisição volta com `status: "path_required"` e os `candidates`, pedindo o `path`. Nada é gravado (tudo-ou-nada).

Após a execução, o resultado agrega: stdout/stderr, exit code/sinal/timeout, o documento de telemetria do runner (spans + métricas OTel + rusage), amostras `ps`/`top`/cgroup (v1 e v2)/loadavg/meminfo **durante** e **depois** da execução, `docker stats` (durante e depois) e métricas do host. Cada amostra também grava, dentro do box:

```bash
echo "--- Captura em: $(date '+%Y-%m-%d %H:%M:%S') ---" >> monitoramento.log
ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -n 6 >> monitoramento.log
echo "" >> monitoramento.log
top -b -n 1 > top_snapshot.log
```

### 8.6 Schema padrão e canal de resposta

Toda tool `codebox_*` devolve um documento `codebox.result/v1` (`schemas/codebox-result.schema.json`). Por padrão a resposta volta **pelo canal que recebeu a requisição**. Se o payload trouxer `{ response_channel, response_path }`, a chamada responde `status: "accepted"` na hora e o documento completo é entregue no destino quando terminar — usando um dos 4 canais do MCP:

| `response_channel` | `response_path` | Entrega |
|---|---|---|
| `stdio` | método JSON-RPC (default `notifications/codebox/result`) | notificação JSON-RPC no stdout |
| `rest` | URL `http(s)://…` | `POST` com o JSON |
| `websocket` | URL `ws(s)://…` | um frame de texto |
| `nats` | subject (default `sandboxrunner.codebox.results`) ou `nats://host:port/subject` | `PUB` no subject |

Exemplo (requisição via NATS em `sandboxrunner.rpc`, resultado entregue em outro subject):

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "codebox_push",
    "arguments": {
      "box": "poly",
      "files": [{ "name": "main.py", "content": "print('oi')\n" }],
      "run": {},
      "response_channel": "nats",
      "response_path": "agents.results"
    }
  }
}
```
