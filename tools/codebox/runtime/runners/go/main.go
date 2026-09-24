// codebox-run-go — OpenTelemetry wrapper for Go.
//
// The real code is never linked in: it is compiled with `go build` and then
// only executed via spawn (os/exec), as a child process, while this wrapper
// records spans + metrics with the OpenTelemetry Go SDK and writes a
// `codebox.telemetry/v1` JSON document to $CODEBOX_TELEMETRY_OUT.
//
// Usage: codebox-run-go <file.go> [args...]
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	otelsdk "go.opentelemetry.io/otel/sdk"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
)

const runnerName = "codebox-run-go"

type compileInfo struct {
	Command    []string `json:"command"`
	ExitCode   int      `json:"exit_code"`
	DurationMs float64  `json:"duration_ms"`
	Output     string   `json:"output"`
}

type processInfo struct {
	PID        *int    `json:"pid"`
	ExitCode   *int    `json:"exit_code"`
	Signal     *string `json:"signal"`
	TimedOut   bool    `json:"timed_out"`
	SpawnError *string `json:"spawn_error"`
	StartedAt  string  `json:"started_at"`
	EndedAt    string  `json:"ended_at"`
	DurationMs float64 `json:"duration_ms"`
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// findGoMod walks up from dir looking for a go.mod.
func findGoMod(dir string) string {
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

func attrsToMap(kvs []attribute.KeyValue) map[string]any {
	out := make(map[string]any, len(kvs))
	for _, kv := range kvs {
		out[string(kv.Key)] = kv.Value.AsInterface()
	}
	return out
}

func serializeSpans(stubs tracetest.SpanStubs) []map[string]any {
	out := make([]map[string]any, 0, len(stubs))
	for _, s := range stubs {
		var parent any
		if s.Parent.IsValid() {
			parent = s.Parent.SpanID().String()
		}
		events := make([]map[string]any, 0, len(s.Events))
		for _, e := range s.Events {
			events = append(events, map[string]any{"name": e.Name, "attributes": attrsToMap(e.Attributes)})
		}
		out = append(out, map[string]any{
			"name":                 s.Name,
			"trace_id":             s.SpanContext.TraceID().String(),
			"span_id":              s.SpanContext.SpanID().String(),
			"parent_span_id":       parent,
			"kind":                 strings.ToUpper(s.SpanKind.String()),
			"start_time_unix_nano": strconv.FormatInt(s.StartTime.UnixNano(), 10),
			"end_time_unix_nano":   strconv.FormatInt(s.EndTime.UnixNano(), 10),
			"duration_ms":          float64(s.EndTime.Sub(s.StartTime).Nanoseconds()) / 1e6,
			"status":               map[string]any{"code": strings.ToUpper(s.Status.Code.String()), "message": s.Status.Description},
			"attributes":           attrsToMap(s.Attributes),
			"events":               events,
		})
	}
	return out
}

func serializeMetrics(rm metricdata.ResourceMetrics) []map[string]any {
	out := []map[string]any{}
	for _, sm := range rm.ScopeMetrics {
		for _, m := range sm.Metrics {
			entry := map[string]any{"name": m.Name, "unit": m.Unit}
			points := []map[string]any{}
			switch data := m.Data.(type) {
			case metricdata.Histogram[float64]:
				entry["type"] = "HISTOGRAM"
				for _, p := range data.DataPoints {
					minV, _ := p.Min.Value()
					maxV, _ := p.Max.Value()
					points = append(points, map[string]any{
						"attributes": attrsToMap(p.Attributes.ToSlice()),
						"value": map[string]any{
							"count": p.Count, "sum": p.Sum, "min": minV, "max": maxV,
							"buckets": map[string]any{"boundaries": p.Bounds, "counts": p.BucketCounts},
						},
					})
				}
			case metricdata.Sum[float64]:
				entry["type"] = "SUM"
				for _, p := range data.DataPoints {
					points = append(points, map[string]any{"attributes": attrsToMap(p.Attributes.ToSlice()), "value": p.Value})
				}
			case metricdata.Sum[int64]:
				entry["type"] = "SUM"
				for _, p := range data.DataPoints {
					points = append(points, map[string]any{"attributes": attrsToMap(p.Attributes.ToSlice()), "value": p.Value})
				}
			case metricdata.Gauge[int64]:
				entry["type"] = "GAUGE"
				for _, p := range data.DataPoints {
					points = append(points, map[string]any{"attributes": attrsToMap(p.Attributes.ToSlice()), "value": p.Value})
				}
			default:
				entry["type"] = fmt.Sprintf("%T", data)
			}
			entry["data_points"] = points
			out = append(out, entry)
		}
	}
	return out
}

func run() int {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: codebox-run-go <file.go> [args...]")
		return 64
	}
	entry, _ := filepath.Abs(os.Args[1])
	args := os.Args[2:]
	outFile := env("CODEBOX_TELEMETRY_OUT", filepath.Join(os.TempDir(), fmt.Sprintf("codebox-telemetry-%d.json", os.Getpid())))
	timeoutMs, _ := strconv.Atoi(os.Getenv("CODEBOX_TIMEOUT_MS"))
	ctx := context.Background()

	hostname, _ := os.Hostname()
	res := resource.NewSchemaless(
		attribute.String("service.name", env("OTEL_SERVICE_NAME", "codebox-"+env("CODEBOX_BOX", "local"))),
		attribute.String("service.version", "1.0.0"),
		attribute.String("codebox.box", os.Getenv("CODEBOX_BOX")),
		attribute.String("codebox.run_id", os.Getenv("CODEBOX_RUN_ID")),
		attribute.String("process.runtime.name", "go"),
		attribute.String("process.runtime.version", runtime.Version()),
		attribute.String("host.name", hostname),
	)

	spanExporter := tracetest.NewInMemoryExporter()
	tp := sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithSyncer(spanExporter))
	tracer := tp.Tracer(runnerName)
	reader := sdkmetric.NewManualReader()
	mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res), sdkmetric.WithReader(reader))
	meter := mp.Meter(runnerName)

	durationHist, _ := meter.Float64Histogram("process.duration", metric.WithUnit("ms"))
	compileHist, _ := meter.Float64Histogram("codebox.compile.duration", metric.WithUnit("ms"))
	cpuCounter, _ := meter.Float64Counter("process.cpu.time", metric.WithUnit("ms"))
	rssGauge, _ := meter.Int64Gauge("process.memory.max_rss", metric.WithUnit("KiBy"))
	faultsCounter, _ := meter.Int64Counter("process.paging.faults", metric.WithUnit("{fault}"))
	ctxCounter, _ := meter.Int64Counter("process.context_switches", metric.WithUnit("{count}"))

	fileAttr := attribute.String("code.filepath", entry)
	ctx, root := tracer.Start(ctx, "codebox.run", trace.WithAttributes(fileAttr, attribute.String("codebox.language", "go")))

	// --- compile (spawned) --------------------------------------------------
	binDir, _ := os.MkdirTemp("", "codebox-go-")
	defer os.RemoveAll(binDir)
	binary := filepath.Join(binDir, "program")
	buildCmd := []string{"go", "build", "-o", binary}
	buildDir := filepath.Dir(entry)
	if modRoot := findGoMod(buildDir); modRoot != "" {
		buildCmd = append(buildCmd, ".")
	} else {
		buildCmd = append(buildCmd, entry)
	}
	_, compileSpan := tracer.Start(ctx, "compile", trace.WithAttributes(attribute.StringSlice("process.command_args", buildCmd)))
	compileStart := time.Now()
	build := exec.Command(buildCmd[0], buildCmd[1:]...)
	build.Dir = buildDir
	output, buildErr := build.CombinedOutput()
	compileMs := float64(time.Since(compileStart).Nanoseconds()) / 1e6
	compileHist.Record(ctx, compileMs, metric.WithAttributes(fileAttr))
	comp := &compileInfo{Command: buildCmd, DurationMs: compileMs, Output: string(output)}
	if build.ProcessState != nil {
		comp.ExitCode = build.ProcessState.ExitCode()
	}
	if buildErr != nil {
		if comp.ExitCode == 0 {
			comp.ExitCode = -1
		}
		os.Stderr.Write(output)
		compileSpan.SetStatus(codes.Error, buildErr.Error())
	} else {
		compileSpan.SetStatus(codes.Ok, "")
	}
	compileSpan.End()

	// --- exec (spawned) -----------------------------------------------------
	proc := processInfo{}
	var usage *syscall.Rusage
	command := append([]string{binary}, args...)
	startedAt := time.Now()
	if buildErr == nil {
		_, execSpan := tracer.Start(ctx, "process.exec", trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(attribute.StringSlice("process.command_args", command)))
		cmd := exec.Command(binary, args...)
		cmd.Dir = filepath.Dir(entry)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		if err := cmd.Start(); err != nil {
			msg := err.Error()
			proc.SpawnError = &msg
			execSpan.SetStatus(codes.Error, msg)
		} else {
			pid := cmd.Process.Pid
			proc.PID = &pid
			execSpan.SetAttributes(attribute.Int("process.pid", pid))
			var timer *time.Timer
			if timeoutMs > 0 {
				timer = time.AfterFunc(time.Duration(timeoutMs)*time.Millisecond, func() {
					proc.TimedOut = true
					_ = cmd.Process.Kill()
				})
			}
			waitErr := cmd.Wait()
			if timer != nil {
				timer.Stop()
			}
			state := cmd.ProcessState
			usage, _ = state.SysUsage().(*syscall.Rusage)
			if ws, ok := state.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
				sig := ws.Signal().String()
				proc.Signal = &sig
			} else {
				code := state.ExitCode()
				proc.ExitCode = &code
			}
			var exitErr *exec.ExitError
			if waitErr != nil && !errors.As(waitErr, &exitErr) {
				msg := waitErr.Error()
				proc.SpawnError = &msg
			}
			execSpan.SetAttributes(attribute.Int("process.exit.code", state.ExitCode()))
			if state.ExitCode() == 0 {
				execSpan.SetStatus(codes.Ok, "")
			} else {
				execSpan.SetStatus(codes.Error, state.String())
			}
		}
		execSpan.End()
	} else {
		msg := "compile failed"
		proc.SpawnError = &msg
	}
	endedAt := time.Now()
	proc.StartedAt = startedAt.UTC().Format(time.RFC3339Nano)
	proc.EndedAt = endedAt.UTC().Format(time.RFC3339Nano)
	proc.DurationMs = float64(endedAt.Sub(startedAt).Nanoseconds()) / 1e6

	resources := map[string]any{
		"user_cpu_ms": nil, "system_cpu_ms": nil, "max_rss_kb": nil,
		"minor_page_faults": nil, "major_page_faults": nil,
		"voluntary_ctx_switches": nil, "involuntary_ctx_switches": nil,
		"fs_in_blocks": nil, "fs_out_blocks": nil, "threads": nil,
	}
	durationHist.Record(ctx, proc.DurationMs, metric.WithAttributes(fileAttr))
	if usage != nil {
		userMs := float64(usage.Utime.Nano()) / 1e6
		sysMs := float64(usage.Stime.Nano()) / 1e6
		resources["user_cpu_ms"] = userMs
		resources["system_cpu_ms"] = sysMs
		resources["max_rss_kb"] = usage.Maxrss
		resources["minor_page_faults"] = usage.Minflt
		resources["major_page_faults"] = usage.Majflt
		resources["voluntary_ctx_switches"] = usage.Nvcsw
		resources["involuntary_ctx_switches"] = usage.Nivcsw
		resources["fs_in_blocks"] = usage.Inblock
		resources["fs_out_blocks"] = usage.Oublock
		cpuCounter.Add(ctx, userMs, metric.WithAttributes(fileAttr, attribute.String("cpu.mode", "user")))
		cpuCounter.Add(ctx, sysMs, metric.WithAttributes(fileAttr, attribute.String("cpu.mode", "system")))
		rssGauge.Record(ctx, usage.Maxrss, metric.WithAttributes(fileAttr))
		faultsCounter.Add(ctx, usage.Minflt, metric.WithAttributes(fileAttr, attribute.String("process.paging.fault_type", "minor")))
		faultsCounter.Add(ctx, usage.Majflt, metric.WithAttributes(fileAttr, attribute.String("process.paging.fault_type", "major")))
		ctxCounter.Add(ctx, usage.Nvcsw, metric.WithAttributes(fileAttr, attribute.String("process.context_switch_type", "voluntary")))
		ctxCounter.Add(ctx, usage.Nivcsw, metric.WithAttributes(fileAttr, attribute.String("process.context_switch_type", "involuntary")))
	}

	exitCode := 1
	if proc.ExitCode != nil {
		exitCode = *proc.ExitCode
	} else if proc.Signal != nil {
		exitCode = 137
	} else if buildErr != nil {
		exitCode = 65
	}
	root.SetAttributes(attribute.Int("process.exit.code", exitCode))
	if exitCode == 0 {
		root.SetStatus(codes.Ok, "")
	} else {
		root.SetStatus(codes.Error, fmt.Sprintf("exit %d", exitCode))
	}
	root.End()

	var rm metricdata.ResourceMetrics
	_ = reader.Collect(context.Background(), &rm)

	document := map[string]any{
		"schema": "codebox.telemetry/v1",
		"runner": map[string]any{
			"language": "go", "name": runnerName,
			"sdk": "opentelemetry-go", "sdk_version": otelsdk.Version(),
		},
		"run_id":    nilIfEmpty(os.Getenv("CODEBOX_RUN_ID")),
		"box":       nilIfEmpty(os.Getenv("CODEBOX_BOX")),
		"entry":     entry,
		"command":   command,
		"compile":   comp,
		"process":   proc,
		"resources": resources,
		"otel": map[string]any{
			"resource": attrsToMap(res.Attributes()),
			"spans":    serializeSpans(spanExporter.GetSpans()),
			"metrics":  serializeMetrics(rm),
		},
	}
	_ = os.MkdirAll(filepath.Dir(outFile), 0o755)
	data, _ := json.MarshalIndent(document, "", "  ")
	if err := os.WriteFile(outFile, data, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "codebox-run-go:", err)
	}
	_ = tp.Shutdown(context.Background())
	_ = mp.Shutdown(context.Background())
	return exitCode
}

func nilIfEmpty(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func main() {
	os.Exit(run())
}
