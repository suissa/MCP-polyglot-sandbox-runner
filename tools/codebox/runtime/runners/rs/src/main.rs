//! codebox-run-rs — OpenTelemetry wrapper for Rust.
//!
//! The real code is never linked in: it is compiled (`cargo build` or
//! `rustc`) and then only executed via spawn (std::process::Command), as a
//! child process, while this wrapper records spans + metrics with the
//! OpenTelemetry Rust SDK and writes a `codebox.telemetry/v1` JSON document to
//! $CODEBOX_TELEMETRY_OUT.
//!
//! Usage: codebox-run-rs <file.rs> [args...]

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use opentelemetry::metrics::MeterProvider as _;
use opentelemetry::trace::{Span as _, SpanKind, Status, TraceContextExt, Tracer as _, TracerProvider as _};
use opentelemetry::{Context, KeyValue, Value};
use opentelemetry_sdk::metrics::data::{AggregatedMetrics, MetricData, ResourceMetrics};
use opentelemetry_sdk::metrics::{InMemoryMetricExporter, PeriodicReader, SdkMeterProvider};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider, SpanData};
use opentelemetry_sdk::Resource;
use serde_json::{json, Map, Value as Json};

const RUNNER: &str = "codebox-run-rs";

fn env_or(key: &str, fallback: &str) -> String {
    env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string())
}

fn nanos(t: SystemTime) -> u128 {
    t.duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

fn iso(t: SystemTime) -> String {
    // RFC 3339 in UTC without pulling in a date crate.
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let millis = t.duration_since(UNIX_EPOCH).map(|d| d.subsec_millis()).unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil-from-days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y, m, d, rem / 3_600, (rem % 3_600) / 60, rem % 60, millis
    )
}

fn value_to_json(v: &Value) -> Json {
    match v {
        Value::Bool(b) => json!(b),
        Value::I64(i) => json!(i),
        Value::F64(f) => json!(f),
        Value::String(s) => json!(s.as_str()),
        other => json!(other.to_string()),
    }
}

fn attrs<'a>(kvs: impl Iterator<Item = &'a KeyValue>) -> Json {
    let mut map = Map::new();
    for kv in kvs {
        map.insert(kv.key.to_string(), value_to_json(&kv.value));
    }
    Json::Object(map)
}

fn serialize_span(span: &SpanData) -> Json {
    let parent = if span.parent_span_id == opentelemetry::trace::SpanId::INVALID {
        Json::Null
    } else {
        json!(span.parent_span_id.to_string())
    };
    let (code, message) = match &span.status {
        Status::Unset => ("UNSET", Json::Null),
        Status::Ok => ("OK", Json::Null),
        Status::Error { description } => ("ERROR", json!(description.to_string())),
    };
    json!({
        "name": span.name,
        "trace_id": span.span_context.trace_id().to_string(),
        "span_id": span.span_context.span_id().to_string(),
        "parent_span_id": parent,
        "kind": format!("{:?}", span.span_kind).to_uppercase(),
        "start_time_unix_nano": nanos(span.start_time).to_string(),
        "end_time_unix_nano": nanos(span.end_time).to_string(),
        "duration_ms": span.end_time.duration_since(span.start_time).map(|d| d.as_secs_f64() * 1e3).unwrap_or(0.0),
        "status": { "code": code, "message": message },
        "attributes": attrs(span.attributes.iter()),
        "events": span.events.iter().map(|e| json!({ "name": e.name, "attributes": attrs(e.attributes.iter()) })).collect::<Vec<_>>(),
    })
}

/// Uniform JSON shape for f64 / u64 / i64 data points.
trait AsF64: Copy {
    fn as_f64(self) -> f64;
}
impl AsF64 for f64 {
    fn as_f64(self) -> f64 {
        self
    }
}
impl AsF64 for u64 {
    fn as_f64(self) -> f64 {
        self as f64
    }
}
impl AsF64 for i64 {
    fn as_f64(self) -> f64 {
        self as f64
    }
}

fn metric_points<T: AsF64>(data: &MetricData<T>) -> (&'static str, Vec<Json>) {
    match data {
        MetricData::Gauge(g) => (
            "GAUGE",
            g.data_points().map(|p| json!({ "attributes": attrs(p.attributes()), "value": p.value().as_f64() })).collect(),
        ),
        MetricData::Sum(s) => (
            "SUM",
            s.data_points().map(|p| json!({ "attributes": attrs(p.attributes()), "value": p.value().as_f64() })).collect(),
        ),
        MetricData::Histogram(h) => (
            "HISTOGRAM",
            h.data_points()
                .map(|p| {
                    json!({
                        "attributes": attrs(p.attributes()),
                        "value": {
                            "count": p.count(),
                            "sum": p.sum().as_f64(),
                            "min": p.min().map(AsF64::as_f64),
                            "max": p.max().map(AsF64::as_f64),
                            "buckets": { "boundaries": p.bounds().collect::<Vec<_>>(), "counts": p.bucket_counts().collect::<Vec<_>>() },
                        }
                    })
                })
                .collect(),
        ),
        MetricData::ExponentialHistogram(_) => ("EXPONENTIAL_HISTOGRAM", vec![]),
    }
}

fn serialize_metrics(batches: &[ResourceMetrics]) -> Vec<Json> {
    // Cumulative temporality: the last export holds the final state.
    let Some(last) = batches.last() else { return vec![] };
    let mut out = vec![];
    for scope in last.scope_metrics() {
        for metric in scope.metrics() {
            let (kind, points) = match metric.data() {
                AggregatedMetrics::F64(d) => metric_points(d),
                AggregatedMetrics::U64(d) => metric_points(d),
                AggregatedMetrics::I64(d) => metric_points(d),
            };
            out.push(json!({ "name": metric.name(), "unit": metric.unit(), "type": kind, "data_points": points }));
        }
    }
    out
}

fn find_upwards(start: &Path, file: &str) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(file).is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

struct Compiled {
    binary: Option<PathBuf>,
    command: Vec<String>,
    exit_code: i32,
    duration_ms: f64,
    output: String,
}

fn compile(entry: &Path, out_dir: &Path) -> Compiled {
    let start = Instant::now();
    let entry_dir = entry.parent().unwrap_or(Path::new("."));
    if let Some(crate_dir) = find_upwards(entry_dir, "Cargo.toml") {
        let command = vec![
            "cargo".to_string(),
            "build".into(),
            "--release".into(),
            "--message-format=json-render-diagnostics".into(),
        ];
        let result = Command::new(&command[0]).args(&command[1..]).current_dir(&crate_dir).stderr(Stdio::piped()).output();
        let duration_ms = start.elapsed().as_secs_f64() * 1e3;
        return match result {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let mut binary = None;
                for line in stdout.lines() {
                    let Ok(msg) = serde_json::from_str::<Json>(line) else { continue };
                    if msg["reason"] != "compiler-artifact" {
                        continue;
                    }
                    if let Some(exe) = msg["executable"].as_str() {
                        let is_entry = msg["target"]["src_path"].as_str().map(Path::new) == Some(entry);
                        if is_entry || binary.is_none() {
                            binary = Some(PathBuf::from(exe));
                        }
                    }
                }
                Compiled {
                    binary: if out.status.success() { binary } else { None },
                    command,
                    exit_code: out.status.code().unwrap_or(-1),
                    duration_ms,
                    output: String::from_utf8_lossy(&out.stderr).into_owned(),
                }
            }
            Err(e) => Compiled { binary: None, command, exit_code: -1, duration_ms, output: e.to_string() },
        };
    }
    let binary = out_dir.join("program");
    let command = vec![
        "rustc".to_string(),
        "--edition".into(),
        "2021".into(),
        "-O".into(),
        "-o".into(),
        binary.to_string_lossy().into_owned(),
        entry.to_string_lossy().into_owned(),
    ];
    let result = Command::new(&command[0]).args(&command[1..]).output();
    let duration_ms = start.elapsed().as_secs_f64() * 1e3;
    match result {
        Ok(out) => Compiled {
            binary: if out.status.success() { Some(binary) } else { None },
            command,
            exit_code: out.status.code().unwrap_or(-1),
            duration_ms,
            output: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
        Err(e) => Compiled { binary: None, command, exit_code: -1, duration_ms, output: e.to_string() },
    }
}

fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGABRT => "SIGABRT".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGBUS => "SIGBUS".into(),
        libc::SIGFPE => "SIGFPE".into(),
        other => format!("SIG{other}"),
    }
}

fn run() -> i32 {
    let mut argv = env::args().skip(1);
    let Some(entry_arg) = argv.next() else {
        eprintln!("usage: codebox-run-rs <file.rs> [args...]");
        return 64;
    };
    let args: Vec<String> = argv.collect();
    let entry = fs::canonicalize(&entry_arg).unwrap_or_else(|_| PathBuf::from(&entry_arg));
    let out_file = env_or(
        "CODEBOX_TELEMETRY_OUT",
        &env::temp_dir().join(format!("codebox-telemetry-{}.json", std::process::id())).to_string_lossy(),
    );
    let timeout_ms: u64 = env::var("CODEBOX_TIMEOUT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(0);

    let resource = Resource::builder_empty()
        .with_attributes([
            KeyValue::new("service.name", env_or("OTEL_SERVICE_NAME", &format!("codebox-{}", env_or("CODEBOX_BOX", "local")))),
            KeyValue::new("service.version", "1.0.0"),
            KeyValue::new("codebox.box", env_or("CODEBOX_BOX", "")),
            KeyValue::new("codebox.run_id", env_or("CODEBOX_RUN_ID", "")),
            KeyValue::new("process.runtime.name", "rust"),
            KeyValue::new("host.name", fs::read_to_string("/etc/hostname").unwrap_or_default().trim().to_string()),
        ])
        .build();

    let span_exporter = InMemorySpanExporter::default();
    let tracer_provider = SdkTracerProvider::builder()
        .with_resource(resource.clone())
        .with_simple_exporter(span_exporter.clone())
        .build();
    let tracer = tracer_provider.tracer(RUNNER);

    let metric_exporter = InMemoryMetricExporter::default();
    let meter_provider = SdkMeterProvider::builder()
        .with_resource(resource.clone())
        .with_reader(PeriodicReader::builder(metric_exporter.clone()).with_interval(Duration::from_secs(3600)).build())
        .build();
    let meter = meter_provider.meter(RUNNER);
    let duration_hist = meter.f64_histogram("process.duration").with_unit("ms").build();
    let compile_hist = meter.f64_histogram("codebox.compile.duration").with_unit("ms").build();
    let cpu_counter = meter.f64_counter("process.cpu.time").with_unit("ms").build();
    let rss_gauge = meter.f64_gauge("process.memory.max_rss").with_unit("KiBy").build();
    let faults_counter = meter.f64_counter("process.paging.faults").with_unit("{fault}").build();
    let ctx_counter = meter.f64_counter("process.context_switches").with_unit("{count}").build();

    let file_attr = KeyValue::new("code.filepath", entry.to_string_lossy().into_owned());
    let mut root = tracer
        .span_builder("codebox.run")
        .with_attributes([file_attr.clone(), KeyValue::new("codebox.language", "rust")])
        .start(&tracer);
    let root_cx = Context::current().with_remote_span_context(root.span_context().clone());

    // --- compile (spawned) --------------------------------------------------
    let tmp = env::temp_dir().join(format!("codebox-rs-{}", std::process::id()));
    let _ = fs::create_dir_all(&tmp);
    let mut compile_span = tracer.start_with_context("compile", &root_cx);
    let compiled = compile(&entry, &tmp);
    compile_span.set_attribute(KeyValue::new("process.command_args", compiled.command.join(" ")));
    compile_hist.record(compiled.duration_ms, &[file_attr.clone()]);
    if compiled.binary.is_some() {
        compile_span.set_status(Status::Ok);
    } else {
        eprint!("{}", compiled.output);
        compile_span.set_status(Status::error(format!("compile exit {}", compiled.exit_code)));
    }
    compile_span.end();

    // --- exec (spawned) -----------------------------------------------------
    let started_at = SystemTime::now();
    let t0 = Instant::now();
    let mut pid: Option<i32> = None;
    let mut exit_code: Option<i32> = None;
    let mut signal: Option<String> = None;
    let mut spawn_error: Option<String> = None;
    let timed_out = Arc::new(AtomicBool::new(false));
    let mut usage: Option<libc::rusage> = None;
    let mut command = vec![];

    if let Some(binary) = &compiled.binary {
        command.push(binary.to_string_lossy().into_owned());
        command.extend(args.iter().cloned());
        let mut exec_span = tracer
            .span_builder("process.exec")
            .with_kind(SpanKind::Client)
            .with_attributes([KeyValue::new("process.command_args", command.join(" "))])
            .start_with_context(&tracer, &root_cx);
        match Command::new(binary).args(&args).current_dir(entry.parent().unwrap_or(Path::new("."))).spawn() {
            Ok(child) => {
                let child_pid = child.id() as i32;
                pid = Some(child_pid);
                exec_span.set_attribute(KeyValue::new("process.pid", child_pid as i64));
                if timeout_ms > 0 {
                    let flag = timed_out.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(timeout_ms));
                        flag.store(true, Ordering::SeqCst);
                        unsafe { libc::kill(child_pid, libc::SIGKILL) };
                    });
                }
                // wait4 gives the exact rusage of this child.
                let mut status: libc::c_int = 0;
                let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
                let waited = unsafe { libc::wait4(child_pid, &mut status, 0, &mut ru) };
                if waited == child_pid {
                    usage = Some(ru);
                    if libc::WIFSIGNALED(status) {
                        signal = Some(signal_name(libc::WTERMSIG(status)));
                    } else {
                        exit_code = Some(libc::WEXITSTATUS(status));
                    }
                } else {
                    spawn_error = Some(std::io::Error::last_os_error().to_string());
                }
                std::mem::forget(child); // already reaped by wait4
            }
            Err(e) => spawn_error = Some(e.to_string()),
        }
        exec_span.set_attribute(KeyValue::new("process.exit.code", exit_code.unwrap_or(-1) as i64));
        if exit_code == Some(0) {
            exec_span.set_status(Status::Ok);
        } else {
            exec_span.set_status(Status::error(signal.clone().or(spawn_error.clone()).unwrap_or_else(|| format!("exit {:?}", exit_code))));
        }
        exec_span.end();
    } else {
        spawn_error = Some("compile failed".into());
    }
    let duration_ms = t0.elapsed().as_secs_f64() * 1e3;
    let ended_at = SystemTime::now();

    duration_hist.record(duration_ms, &[file_attr.clone()]);
    let resources = match usage {
        Some(ru) => {
            let user_ms = ru.ru_utime.tv_sec as f64 * 1e3 + ru.ru_utime.tv_usec as f64 / 1e3;
            let sys_ms = ru.ru_stime.tv_sec as f64 * 1e3 + ru.ru_stime.tv_usec as f64 / 1e3;
            cpu_counter.add(user_ms, &[file_attr.clone(), KeyValue::new("cpu.mode", "user")]);
            cpu_counter.add(sys_ms, &[file_attr.clone(), KeyValue::new("cpu.mode", "system")]);
            rss_gauge.record(ru.ru_maxrss as f64, &[file_attr.clone()]);
            faults_counter.add(ru.ru_minflt as f64, &[file_attr.clone(), KeyValue::new("process.paging.fault_type", "minor")]);
            faults_counter.add(ru.ru_majflt as f64, &[file_attr.clone(), KeyValue::new("process.paging.fault_type", "major")]);
            ctx_counter.add(ru.ru_nvcsw as f64, &[file_attr.clone(), KeyValue::new("process.context_switch_type", "voluntary")]);
            ctx_counter.add(ru.ru_nivcsw as f64, &[file_attr.clone(), KeyValue::new("process.context_switch_type", "involuntary")]);
            json!({
                "user_cpu_ms": user_ms, "system_cpu_ms": sys_ms, "max_rss_kb": ru.ru_maxrss,
                "minor_page_faults": ru.ru_minflt, "major_page_faults": ru.ru_majflt,
                "voluntary_ctx_switches": ru.ru_nvcsw, "involuntary_ctx_switches": ru.ru_nivcsw,
                "fs_in_blocks": ru.ru_inblock, "fs_out_blocks": ru.ru_oublock, "threads": null,
            })
        }
        None => json!({
            "user_cpu_ms": null, "system_cpu_ms": null, "max_rss_kb": null,
            "minor_page_faults": null, "major_page_faults": null,
            "voluntary_ctx_switches": null, "involuntary_ctx_switches": null,
            "fs_in_blocks": null, "fs_out_blocks": null, "threads": null,
        }),
    };

    let final_code = match (exit_code, &signal) {
        (Some(c), _) => c,
        (None, Some(_)) => 137,
        (None, None) if compiled.binary.is_none() => 65,
        _ => 1,
    };
    root.set_attribute(KeyValue::new("process.exit.code", final_code as i64));
    root.set_status(if final_code == 0 { Status::Ok } else { Status::error(format!("exit {final_code}")) });
    root.end();

    let _ = tracer_provider.force_flush();
    let _ = meter_provider.force_flush();
    let spans: Vec<Json> = span_exporter.get_finished_spans().unwrap_or_default().iter().map(serialize_span).collect();
    let metrics = serialize_metrics(&metric_exporter.get_finished_metrics().unwrap_or_default());

    let document = json!({
        "schema": "codebox.telemetry/v1",
        "runner": { "language": "rust", "name": RUNNER, "sdk": "opentelemetry-rust", "sdk_version": "0.33" },
        "run_id": env::var("CODEBOX_RUN_ID").ok(),
        "box": env::var("CODEBOX_BOX").ok(),
        "entry": entry,
        "command": command,
        "compile": {
            "command": compiled.command, "exit_code": compiled.exit_code,
            "duration_ms": compiled.duration_ms, "output": compiled.output,
        },
        "process": {
            "pid": pid, "exit_code": exit_code, "signal": signal,
            "timed_out": timed_out.load(Ordering::SeqCst), "spawn_error": spawn_error,
            "started_at": iso(started_at), "ended_at": iso(ended_at), "duration_ms": duration_ms,
        },
        "resources": resources,
        "otel": {
            "resource": attrs(resource.iter().map(|(k, v)| KeyValue::new(k.clone(), v.clone())).collect::<Vec<_>>().iter()),
            "spans": spans,
            "metrics": metrics,
        },
    });
    if let Some(parent) = Path::new(&out_file).parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(e) = fs::write(&out_file, serde_json::to_string_pretty(&document).unwrap_or_default()) {
        eprintln!("{RUNNER}: {e}");
    }
    let _ = fs::remove_dir_all(&tmp);
    let _ = tracer_provider.shutdown();
    let _ = meter_provider.shutdown();
    final_code
}

fn main() {
    std::process::exit(run());
}
