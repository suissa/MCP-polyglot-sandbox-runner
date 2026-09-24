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
