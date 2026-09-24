#!/usr/bin/env python3
"""codebox-run-py - OpenTelemetry wrapper for Python.

The real code is never imported: it runs only via subprocess spawn, as a
child process, while this wrapper records spans + metrics with the
OpenTelemetry Python SDK and writes a ``codebox.telemetry/v1`` JSON document
to $CODEBOX_TELEMETRY_OUT.

Usage: codebox-run-py <file.py> [args...]
"""
from __future__ import annotations

import json
import os
import resource
import signal
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from importlib.metadata import version

from opentelemetry import trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import SpanKind, Status, StatusCode

RUNNER = {
    "language": "python",
    "name": "codebox-run-py",
    "sdk": "opentelemetry-python",
    "sdk_version": version("opentelemetry-sdk"),
}


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def serialize_span(span) -> dict:
    ctx = span.get_span_context()
    return {
        "name": span.name,
        "trace_id": format(ctx.trace_id, "032x"),
        "span_id": format(ctx.span_id, "016x"),
        "parent_span_id": format(span.parent.span_id, "016x") if span.parent else None,
        "kind": span.kind.name,
        "start_time_unix_nano": str(span.start_time),
        "end_time_unix_nano": str(span.end_time),
        "duration_ms": (span.end_time - span.start_time) / 1e6,
        "status": {"code": span.status.status_code.name, "message": span.status.description},
        "attributes": dict(span.attributes or {}),
        "events": [{"name": e.name, "attributes": dict(e.attributes or {})} for e in span.events],
    }


def serialize_metrics(reader: InMemoryMetricReader) -> list[dict]:
    data = reader.get_metrics_data()
    out: list[dict] = []
    if data is None:
        return out
    for rm in data.resource_metrics:
        for sm in rm.scope_metrics:
            for metric in sm.metrics:
                points = []
                for point in metric.data.data_points:
                    value = getattr(point, "value", None)
                    if value is None:  # histogram
                        value = {
                            "count": point.count,
                            "sum": point.sum,
                            "min": point.min,
                            "max": point.max,
                            "buckets": {"boundaries": list(point.explicit_bounds), "counts": list(point.bucket_counts)},
                        }
                    points.append({"attributes": dict(point.attributes or {}), "value": value})
                out.append({
                    "name": metric.name,
                    "unit": metric.unit,
                    "type": type(metric.data).__name__.upper(),
                    "data_points": points,
                })
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: codebox-run-py <file.py> [args...]", file=sys.stderr)
        return 64

    entry = os.path.abspath(sys.argv[1])
    args = sys.argv[2:]
    out_file = os.environ.get("CODEBOX_TELEMETRY_OUT") or os.path.join(
        tempfile.gettempdir(), f"codebox-telemetry-{os.getpid()}.json"
    )
    timeout_ms = int(os.environ.get("CODEBOX_TIMEOUT_MS") or 0)
    python = os.environ.get("CODEBOX_PYTHON") or sys.executable
    command = [python, entry, *args]

    otel_resource = Resource.create({
        "service.name": os.environ.get("OTEL_SERVICE_NAME") or f"codebox-{os.environ.get('CODEBOX_BOX', 'local')}",
        "service.version": "1.0.0",
        "codebox.box": os.environ.get("CODEBOX_BOX", ""),
        "codebox.run_id": os.environ.get("CODEBOX_RUN_ID", ""),
        "process.runtime.name": sys.implementation.name,
        "process.runtime.version": sys.version.split()[0],
        "host.name": socket.gethostname(),
    })

    exporter = InMemorySpanExporter()
    tracer_provider = TracerProvider(resource=otel_resource)
    tracer_provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = tracer_provider.get_tracer(RUNNER["name"], "1.0.0")

    reader = InMemoryMetricReader()
    meter_provider = MeterProvider(resource=otel_resource, metric_readers=[reader])
    meter = meter_provider.get_meter(RUNNER["name"], "1.0.0")
    duration_hist = meter.create_histogram("process.duration", unit="ms", description="Wall time of the spawned process")
    cpu_counter = meter.create_counter("process.cpu.time", unit="ms", description="CPU time of the spawned process")
    rss_gauge = meter.create_gauge("process.memory.max_rss", unit="KiBy", description="Peak resident set size")
    faults_counter = meter.create_counter("process.paging.faults", unit="{fault}")
    ctx_counter = meter.create_counter("process.context_switches", unit="{count}")

    attrs = {"code.filepath": entry}
    exit_code: int | None = None
    signal_name: str | None = None
    timed_out = False
    spawn_error: str | None = None
    pid: int | None = None

    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    started = time.time()
    t0 = time.perf_counter_ns()

    with tracer.start_as_current_span("codebox.run", kind=SpanKind.INTERNAL,
                                      attributes={**attrs, "codebox.language": "python"}) as root:
        with tracer.start_as_current_span("process.exec", kind=SpanKind.CLIENT,
                                          attributes={"process.command": command[0],
                                                      "process.command_args": command}) as exec_span:
            try:
                child = subprocess.Popen(command)
                pid = child.pid
                exec_span.set_attribute("process.pid", pid)
                try:
                    returncode = child.wait(timeout=timeout_ms / 1000 if timeout_ms > 0 else None)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    child.kill()
                    returncode = child.wait()
                if returncode < 0:
                    signal_name = signal.Signals(-returncode).name
                else:
                    exit_code = returncode
            except OSError as err:
                spawn_error = str(err)

            exec_span.set_attribute("process.exit.code", exit_code if exit_code is not None else -1)
            if signal_name:
                exec_span.set_attribute("process.exit.signal", signal_name)
            if exit_code == 0:
                exec_span.set_status(Status(StatusCode.OK))
            else:
                exec_span.set_status(Status(StatusCode.ERROR,
                                            spawn_error or ("timeout" if timed_out else f"exit {exit_code or signal_name}")))
        root.set_attribute("process.exit.code", exit_code if exit_code is not None else -1)
        root.set_status(Status(StatusCode.OK) if exit_code == 0 else Status(StatusCode.ERROR))

    duration_ms = (time.perf_counter_ns() - t0) / 1e6
    ended = time.time()
    after = resource.getrusage(resource.RUSAGE_CHILDREN)

    usage = {
        "user_cpu_ms": (after.ru_utime - before.ru_utime) * 1000,
        "system_cpu_ms": (after.ru_stime - before.ru_stime) * 1000,
        "max_rss_kb": after.ru_maxrss,
        "minor_page_faults": after.ru_minflt - before.ru_minflt,
        "major_page_faults": after.ru_majflt - before.ru_majflt,
        "voluntary_ctx_switches": after.ru_nvcsw - before.ru_nvcsw,
        "involuntary_ctx_switches": after.ru_nivcsw - before.ru_nivcsw,
        "fs_in_blocks": after.ru_inblock - before.ru_inblock,
        "fs_out_blocks": after.ru_oublock - before.ru_oublock,
        "threads": None,
    }

    duration_hist.record(duration_ms, attrs)
    cpu_counter.add(usage["user_cpu_ms"], {**attrs, "cpu.mode": "user"})
    cpu_counter.add(usage["system_cpu_ms"], {**attrs, "cpu.mode": "system"})
    rss_gauge.set(usage["max_rss_kb"], attrs)
    faults_counter.add(usage["minor_page_faults"], {**attrs, "process.paging.fault_type": "minor"})
    faults_counter.add(usage["major_page_faults"], {**attrs, "process.paging.fault_type": "major"})
    ctx_counter.add(usage["voluntary_ctx_switches"], {**attrs, "process.context_switch_type": "voluntary"})
    ctx_counter.add(usage["involuntary_ctx_switches"], {**attrs, "process.context_switch_type": "involuntary"})

    document = {
        "schema": "codebox.telemetry/v1",
        "runner": RUNNER,
        "run_id": os.environ.get("CODEBOX_RUN_ID"),
        "box": os.environ.get("CODEBOX_BOX"),
        "entry": entry,
        "command": command,
        "compile": None,
        "process": {
            "pid": pid,
            "exit_code": exit_code,
            "signal": signal_name,
            "timed_out": timed_out,
            "spawn_error": spawn_error,
            "started_at": iso(started),
            "ended_at": iso(ended),
            "duration_ms": duration_ms,
        },
        "resources": usage,
        "otel": {
            "resource": dict(otel_resource.attributes),
            "spans": [serialize_span(s) for s in exporter.get_finished_spans()],
            "metrics": serialize_metrics(reader),
        },
    }

    os.makedirs(os.path.dirname(os.path.abspath(out_file)), exist_ok=True)
    with open(out_file, "w", encoding="utf-8") as fh:
        json.dump(document, fh, indent=2, default=str)
    tracer_provider.shutdown()
    meter_provider.shutdown()

    if exit_code is not None:
        return exit_code
    return 128 + signal.Signals[signal_name].value if signal_name else 1


if __name__ == "__main__":
    sys.exit(main())
