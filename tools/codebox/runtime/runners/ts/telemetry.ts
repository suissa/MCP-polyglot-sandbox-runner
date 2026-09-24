/**
 * codebox-run-ts — OpenTelemetry wrapper for TypeScript / JavaScript.
 *
 * The real code is never imported: it only runs via spawn(), as a child
 * process, while this wrapper records spans + metrics with the OpenTelemetry
 * JS SDK (v2) and writes a `codebox.telemetry/v1` JSON document to
 * $CODEBOX_TELEMETRY_OUT.
 *
 * Usage: codebox-run-ts <file.ts|file.js> [args...]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  DataPointType,
  MeterProvider,
  MetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

const RUNNER = { language: 'typescript', name: 'codebox-run-ts', sdk: 'opentelemetry-js', sdk_version: '2.x' };

class ManualReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

type ProcSample = { maxRssKb: number | null; volCtx: number | null; involCtx: number | null; threads: number | null };

const [entryArg, ...childArgs] = process.argv.slice(2);
if (!entryArg) {
  process.stderr.write('usage: codebox-run-ts <file> [args...]\n');
  process.exit(64);
}

const entry = path.resolve(entryArg);
const outFile = process.env.CODEBOX_TELEMETRY_OUT || path.join(os.tmpdir(), `codebox-telemetry-${process.pid}.json`);
const timeoutMs = Number(process.env.CODEBOX_TIMEOUT_MS || 0);

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || `codebox-${process.env.CODEBOX_BOX || 'local'}`,
  [ATTR_SERVICE_VERSION]: '1.0.0',
  'codebox.box': process.env.CODEBOX_BOX || '',
  'codebox.run_id': process.env.CODEBOX_RUN_ID || '',
  'process.runtime.name': 'nodejs',
  'process.runtime.version': process.versions.node,
  'host.name': os.hostname(),
});

const spanExporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
const tracer = tracerProvider.getTracer(RUNNER.name, '1.0.0');

const metricReader = new ManualReader();
const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
const meter = meterProvider.getMeter(RUNNER.name, '1.0.0');
const durationHistogram = meter.createHistogram('process.duration', { unit: 'ms', description: 'Wall time of the spawned process' });
const cpuCounter = meter.createCounter('process.cpu.time', { unit: 'ms', description: 'CPU time of the spawned process' });
const rssGauge = meter.createGauge('process.memory.max_rss', { unit: 'KiBy', description: 'Peak resident set size' });
const faultsCounter = meter.createCounter('process.paging.faults', { unit: '{fault}' });

/** Children CPU/fault counters of *this* process (fields of /proc/self/stat), in clock ticks. */
function selfChildrenStat(): { cutime: number; cstime: number; cminflt: number; cmajflt: number } | null {
  try {
    const raw = fs.readFileSync('/proc/self/stat', 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    // fields[0] is field 3 (state); field N => fields[N - 3]
    return {
      cminflt: Number(fields[8]),
      cmajflt: Number(fields[10]),
      cutime: Number(fields[13]),
      cstime: Number(fields[14]),
    };
  } catch {
    return null;
  }
}

function sampleChild(pid: number, current: ProcSample): ProcSample {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const pick = (key: string) => {
      const match = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(status);
      return match ? Number(match[1]) : null;
    };
    const hwm = pick('VmHWM');
    return {
      maxRssKb: hwm !== null ? Math.max(hwm, current.maxRssKb ?? 0) : current.maxRssKb,
      volCtx: pick('voluntary_ctxt_switches') ?? current.volCtx,
      involCtx: pick('nonvoluntary_ctxt_switches') ?? current.involCtx,
      threads: pick('Threads') ?? current.threads,
    };
  } catch {
    return current;
  }
}

function commandFor(file: string, args: string[]): string[] {
  if (/\.(ts|mts|cts|tsx)$/.test(file)) {
    const tsxLoader = import.meta.resolve('tsx');
    return [process.execPath, '--import', tsxLoader, file, ...args];
  }
  return [process.execPath, file, ...args];
}

function hrToNanos([seconds, nanos]: [number, number]): string {
  return (BigInt(seconds) * 1_000_000_000n + BigInt(nanos)).toString();
}

function serializeSpan(span: ReadableSpan) {
  const ctx = span.spanContext();
  return {
    name: span.name,
    trace_id: ctx.traceId,
    span_id: ctx.spanId,
    parent_span_id: span.parentSpanContext?.spanId ?? null,
    kind: SpanKind[span.kind],
    start_time_unix_nano: hrToNanos(span.startTime),
    end_time_unix_nano: hrToNanos(span.endTime),
    duration_ms: span.duration[0] * 1e3 + span.duration[1] / 1e6,
    status: { code: SpanStatusCode[span.status.code], message: span.status.message ?? null },
    attributes: span.attributes,
    events: span.events.map((e) => ({ name: e.name, attributes: e.attributes ?? {} })),
  };
}

async function collectMetrics() {
  const { resourceMetrics } = await metricReader.collect();
  return resourceMetrics.scopeMetrics.flatMap((scope) =>
    scope.metrics.map((metric) => ({
      name: metric.descriptor.name,
      unit: metric.descriptor.unit,
      type: DataPointType[metric.dataPointType],
      data_points: metric.dataPoints.map((point) => ({ attributes: point.attributes, value: point.value })),
    })),
  );
}

async function main() {
  const command = commandFor(entry, childArgs);
  const root = tracer.startSpan('codebox.run', {
    kind: SpanKind.INTERNAL,
    attributes: { 'code.filepath': entry, 'codebox.language': RUNNER.language },
  });

  const before = selfChildrenStat();
  const ticks = 100; // USER_HZ on Linux
  const startedAt = new Date();
  const t0 = process.hrtime.bigint();

  const rootContext = trace.setSpan(context.active(), root);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; pid: number | null; sample: ProcSample; error?: string }>((resolve) => {
      const execSpan = tracer.startSpan(
        'process.exec',
        { kind: SpanKind.CLIENT, attributes: { 'process.command': command[0], 'process.command_args': command } },
        rootContext,
      );
      const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
      let sample: ProcSample = { maxRssKb: null, volCtx: null, involCtx: null, threads: null };
      let timedOut = false;
      const sampler = setInterval(() => {
        if (child.pid) sample = sampleChild(child.pid, sample);
      }, 10);
      const killer = timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, timeoutMs)
        : null;
      if (child.pid) sample = sampleChild(child.pid, sample);
      execSpan.setAttribute('process.pid', child.pid ?? -1);

      const finish = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
        clearInterval(sampler);
        if (killer) clearTimeout(killer);
        execSpan.setAttribute('process.exit.code', code ?? -1);
        if (signal) execSpan.setAttribute('process.exit.signal', signal);
        if (error || code !== 0) {
          execSpan.setStatus({ code: SpanStatusCode.ERROR, message: error || (timedOut ? 'timeout' : `exit ${code ?? signal}`) });
        } else {
          execSpan.setStatus({ code: SpanStatusCode.OK });
        }
        execSpan.end();
        resolve({ code, signal, timedOut, pid: child.pid ?? null, sample, error });
      };
      child.on('error', (err) => finish(null, null, err.message));
      child.on('exit', (code, signal) => finish(code, signal));
    });

  const t1 = process.hrtime.bigint();
  const endedAt = new Date();
  const after = selfChildrenStat();
  const durationMs = Number(t1 - t0) / 1e6;
  const delta = (key: 'cutime' | 'cstime' | 'cminflt' | 'cmajflt') =>
    before && after ? after[key] - before[key] : null;
  const userMs = delta('cutime') !== null ? (delta('cutime') as number) * (1000 / ticks) : null;
  const sysMs = delta('cstime') !== null ? (delta('cstime') as number) * (1000 / ticks) : null;

  const attrs = { 'code.filepath': entry };
  durationHistogram.record(durationMs, attrs);
  if (userMs !== null) cpuCounter.add(userMs, { ...attrs, 'cpu.mode': 'user' });
  if (sysMs !== null) cpuCounter.add(sysMs, { ...attrs, 'cpu.mode': 'system' });
  if (result.sample.maxRssKb !== null) rssGauge.record(result.sample.maxRssKb, attrs);
  if (delta('cminflt') !== null) faultsCounter.add(delta('cminflt') as number, { ...attrs, 'process.paging.fault_type': 'minor' });
  if (delta('cmajflt') !== null) faultsCounter.add(delta('cmajflt') as number, { ...attrs, 'process.paging.fault_type': 'major' });

  root.setAttribute('process.exit.code', result.code ?? -1);
  root.setStatus(result.code === 0 ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.ERROR, message: result.error || `exit ${result.code ?? result.signal}` });
  root.end();

  const document = {
    schema: 'codebox.telemetry/v1',
    runner: RUNNER,
    run_id: process.env.CODEBOX_RUN_ID || null,
    box: process.env.CODEBOX_BOX || null,
    entry,
    command,
    compile: null,
    process: {
      pid: result.pid,
      exit_code: result.code,
      signal: result.signal,
      timed_out: result.timedOut,
      spawn_error: result.error ?? null,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: durationMs,
    },
    resources: {
      user_cpu_ms: userMs,
      system_cpu_ms: sysMs,
      max_rss_kb: result.sample.maxRssKb,
      minor_page_faults: delta('cminflt'),
      major_page_faults: delta('cmajflt'),
      voluntary_ctx_switches: result.sample.volCtx,
      involuntary_ctx_switches: result.sample.involCtx,
      fs_in_blocks: null,
      fs_out_blocks: null,
      threads: result.sample.threads,
    },
    otel: {
      resource: resource.attributes,
      spans: spanExporter.getFinishedSpans().map(serializeSpan),
      metrics: await collectMetrics(),
    },
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(document, null, 2));
  await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  process.exitCode = result.code ?? (result.signal ? 128 : 1);
}

main().catch((err) => {
  process.stderr.write(`codebox-run-ts: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(70);
});
