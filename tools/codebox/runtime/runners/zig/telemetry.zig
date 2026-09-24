//! codebox-run-zig — telemetry wrapper for Zig (targets Zig 0.16).
//!
//! Zig has no official OpenTelemetry SDK yet, so this runner implements the
//! OpenTelemetry data model itself (128-bit trace ids, 64-bit span ids,
//! parent/child spans, span kinds/status, histogram/sum/gauge data points)
//! and emits the same `codebox.telemetry/v1` JSON document as the TS, Python,
//! Go and Rust runners.
//!
//! The real code is never linked in: it is compiled (`zig build-exe`, or
//! `zig build` when a build.zig exists) and then only executed via spawn
//! (std.process.spawn) as a child process, with wait4() rusage.
//!
//! Usage: codebox-run-zig <file.zig> [args...]
const std = @import("std");
const builtin = @import("builtin");
const linux = std.os.linux;
const Io = std.Io;
const Allocator = std.mem.Allocator;

const runner_name = "codebox-run-zig";

var timed_out = std.atomic.Value(bool).init(false);

fn nowNs() u64 {
    var ts: linux.timespec = undefined;
    _ = linux.clock_gettime(.REALTIME, &ts);
    return @as(u64, @intCast(ts.sec)) * std.time.ns_per_s + @as(u64, @intCast(ts.nsec));
}

fn monoNs() u64 {
    var ts: linux.timespec = undefined;
    _ = linux.clock_gettime(.MONOTONIC, &ts);
    return @as(u64, @intCast(ts.sec)) * std.time.ns_per_s + @as(u64, @intCast(ts.nsec));
}

fn randomHex(comptime n: usize) [n * 2]u8 {
    var buf: [n]u8 = undefined;
    _ = linux.getrandom(&buf, n, 0);
    return std.fmt.bytesToHex(buf, .lower);
}

fn isoTime(gpa: Allocator, ns: u64) ![]u8 {
    const secs = ns / std.time.ns_per_s;
    const millis = (ns % std.time.ns_per_s) / std.time.ns_per_ms;
    const es = std.time.epoch.EpochSeconds{ .secs = secs };
    const yd = es.getEpochDay().calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = es.getDaySeconds();
    return std.fmt.allocPrint(gpa, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z", .{
        yd.year, md.month.numeric(), md.day_index + 1, ds.getHoursIntoDay(), ds.getMinutesIntoHour(), ds.getSecondsIntoMinute(), millis,
    });
}

/// Appends `s` as a JSON string literal.
fn jsonString(out: *std.ArrayList(u8), gpa: Allocator, s: []const u8) !void {
    try out.append(gpa, '"');
    for (s) |c| {
        switch (c) {
            '"' => try out.appendSlice(gpa, "\\\""),
            '\\' => try out.appendSlice(gpa, "\\\\"),
            '\n' => try out.appendSlice(gpa, "\\n"),
            '\r' => try out.appendSlice(gpa, "\\r"),
            '\t' => try out.appendSlice(gpa, "\\t"),
            0...8, 11, 12, 14...0x1f => try out.print(gpa, "\\u{x:0>4}", .{c}),
            else => try out.append(gpa, c),
        }
    }
    try out.append(gpa, '"');
}

const Span = struct {
    name: []const u8,
    span_id: [16]u8,
    parent: ?[16]u8,
    kind: []const u8,
    start_ns: u64,
    end_ns: u64 = 0,
    ok: bool = true,
    message: []const u8 = "",
    attributes: []const u8 = "{}", // pre-rendered JSON object

    fn start(name: []const u8, parent: ?[16]u8, kind: []const u8) Span {
        return .{ .name = name, .span_id = randomHex(8), .parent = parent, .kind = kind, .start_ns = nowNs() };
    }

    fn end(self: *Span, ok: bool, message: []const u8) void {
        self.end_ns = nowNs();
        self.ok = ok;
        self.message = message;
    }

    fn write(self: Span, out: *std.ArrayList(u8), gpa: Allocator, trace_id: []const u8) !void {
        try out.print(gpa, "{{\"name\":", .{});
        try jsonString(out, gpa, self.name);
        try out.print(gpa, ",\"trace_id\":\"{s}\",\"span_id\":\"{s}\",\"parent_span_id\":", .{ trace_id, self.span_id });
        if (self.parent) |p| try out.print(gpa, "\"{s}\"", .{p}) else try out.appendSlice(gpa, "null");
        try out.print(gpa, ",\"kind\":\"{s}\",\"start_time_unix_nano\":\"{d}\",\"end_time_unix_nano\":\"{d}\",\"duration_ms\":{d:.3}", .{
            self.kind, self.start_ns, self.end_ns, @as(f64, @floatFromInt(self.end_ns - self.start_ns)) / 1e6,
        });
        try out.print(gpa, ",\"status\":{{\"code\":\"{s}\",\"message\":", .{if (self.ok) "OK" else "ERROR"});
        if (self.message.len > 0) try jsonString(out, gpa, self.message) else try out.appendSlice(gpa, "null");
        try out.print(gpa, "}},\"attributes\":{s},\"events\":[]}}", .{self.attributes});
    }
};

fn histogramJson(out: *std.ArrayList(u8), gpa: Allocator, name: []const u8, value: f64, file: []const u8) !void {
    const bounds = [_]f64{ 0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000 };
    var counts = [_]u64{0} ** (bounds.len + 1);
    var idx: usize = bounds.len;
    for (bounds, 0..) |b, i| {
        if (value <= b) {
            idx = i;
            break;
        }
    }
    counts[idx] = 1;
    try out.print(gpa, "{{\"name\":\"{s}\",\"unit\":\"ms\",\"type\":\"HISTOGRAM\",\"data_points\":[{{\"attributes\":{{\"code.filepath\":", .{name});
    try jsonString(out, gpa, file);
    try out.print(gpa, "}},\"value\":{{\"count\":1,\"sum\":{d:.3},\"min\":{d:.3},\"max\":{d:.3},\"buckets\":{{\"boundaries\":[", .{ value, value, value });
    for (bounds, 0..) |b, i| try out.print(gpa, "{s}{d}", .{ if (i == 0) "" else ",", b });
    try out.appendSlice(gpa, "],\"counts\":[");
    for (counts, 0..) |c, i| try out.print(gpa, "{s}{d}", .{ if (i == 0) "" else ",", c });
    try out.appendSlice(gpa, "]}}}]}");
}

fn pointJson(out: *std.ArrayList(u8), gpa: Allocator, file: []const u8, extra_key: []const u8, extra_val: []const u8, value: f64) !void {
    try out.appendSlice(gpa, "{\"attributes\":{\"code.filepath\":");
    try jsonString(out, gpa, file);
    if (extra_key.len > 0) try out.print(gpa, ",\"{s}\":\"{s}\"", .{ extra_key, extra_val });
    try out.print(gpa, "}},\"value\":{d:.3}}}", .{value});
}

fn fileExists(io: Io, path: []const u8) bool {
    Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

/// Walks up from `dir` looking for `name`; returns the directory holding it.
fn findUpwards(gpa: Allocator, io: Io, dir: []const u8, name: []const u8) !?[]const u8 {
    var current: []const u8 = dir;
    while (true) {
        const candidate = try std.fs.path.join(gpa, &.{ current, name });
        if (fileExists(io, candidate)) return current;
        const parent = std.fs.path.dirname(current) orelse return null;
        if (std.mem.eql(u8, parent, current)) return null;
        current = parent;
    }
}

fn killAfter(pid: linux.pid_t, ms: u64) void {
    const req = linux.timespec{ .sec = @intCast(ms / 1000), .nsec = @intCast((ms % 1000) * std.time.ns_per_ms) };
    _ = linux.nanosleep(&req, null);
    timed_out.store(true, .seq_cst);
    _ = linux.kill(pid, .KILL);
}

const Compiled = struct {
    binary: ?[]const u8,
    argv: []const []const u8,
    exit_code: i64,
    duration_ms: f64,
    output: []const u8,
};

fn compile(gpa: Allocator, io: Io, entry: []const u8, tmp_dir: []const u8) !Compiled {
    const entry_dir = std.fs.path.dirname(entry) orelse ".";
    const t0 = monoNs();
    if (try findUpwards(gpa, io, entry_dir, "build.zig")) |project_dir| {
        const argv: []const []const u8 = &.{ "zig", "build", "--prefix", tmp_dir };
        const result = std.process.run(gpa, io, .{ .argv = argv, .cwd = .{ .path = project_dir } }) catch |err| {
            return .{ .binary = null, .argv = argv, .exit_code = -1, .duration_ms = 0, .output = @errorName(err) };
        };
        const ms = @as(f64, @floatFromInt(monoNs() - t0)) / 1e6;
        const code: i64 = switch (result.term) {
            .exited => |c| c,
            else => -1,
        };
        var binary: ?[]const u8 = null;
        if (code == 0) {
            // First executable installed into <prefix>/bin.
            const bin_dir = try std.fs.path.join(gpa, &.{ tmp_dir, "bin" });
            var dir = Io.Dir.cwd().openDir(io, bin_dir, .{ .iterate = true }) catch null;
            if (dir) |*d| {
                defer d.close(io);
                var it = d.iterate();
                while (try it.next(io)) |item| {
                    if (item.kind == .file) {
                        binary = try std.fs.path.join(gpa, &.{ bin_dir, item.name });
                        break;
                    }
                }
            }
        }
        return .{ .binary = binary, .argv = argv, .exit_code = code, .duration_ms = ms, .output = result.stderr };
    }

    const bin_path = try std.fs.path.join(gpa, &.{ tmp_dir, "program" });
    const emit = try std.fmt.allocPrint(gpa, "-femit-bin={s}", .{bin_path});
    const argv = try gpa.dupe([]const u8, &.{ "zig", "build-exe", entry, "-O", "ReleaseSafe", emit });
    const result = std.process.run(gpa, io, .{ .argv = argv, .cwd = .{ .path = entry_dir } }) catch |err| {
        return .{ .binary = null, .argv = argv, .exit_code = -1, .duration_ms = 0, .output = @errorName(err) };
    };
    const ms = @as(f64, @floatFromInt(monoNs() - t0)) / 1e6;
    const code: i64 = switch (result.term) {
        .exited => |c| c,
        else => -1,
    };
    return .{ .binary = if (code == 0) bin_path else null, .argv = argv, .exit_code = code, .duration_ms = ms, .output = result.stderr };
}

pub fn main(init: std.process.Init) !u8 {
    const gpa = init.arena.allocator();
    const io = init.io;
    const env = init.environ_map;

    const argv_all = try init.minimal.args.toSlice(gpa);
    if (argv_all.len < 2) {
        std.debug.print("usage: codebox-run-zig <file.zig> [args...]\n", .{});
        return 64;
    }
    const user_args = argv_all[2..];

    var cwd_buf: [4096]u8 = undefined;
    const cwd_len = try std.process.currentPath(io, &cwd_buf);
    const entry = try std.fs.path.resolve(gpa, &.{ cwd_buf[0..cwd_len], argv_all[1] });
    const entry_dir = std.fs.path.dirname(entry) orelse ".";

    const box = env.get("CODEBOX_BOX") orelse "";
    const run_id = env.get("CODEBOX_RUN_ID") orelse "";
    const timeout_ms = std.fmt.parseInt(u64, env.get("CODEBOX_TIMEOUT_MS") orelse "0", 10) catch 0;
    const out_file = env.get("CODEBOX_TELEMETRY_OUT") orelse
        try std.fmt.allocPrint(gpa, "/tmp/codebox-telemetry-{d}.json", .{linux.getpid()});

    const trace_id = randomHex(16);
    const file_attrs = blk: {
        var a: std.ArrayList(u8) = .empty;
        try a.appendSlice(gpa, "{\"code.filepath\":");
        try jsonString(&a, gpa, entry);
        try a.appendSlice(gpa, ",\"codebox.language\":\"zig\"}");
        break :blk a.items;
    };
    var root = Span.start("codebox.run", null, "INTERNAL");
    root.attributes = file_attrs;

    // --- compile (spawned) --------------------------------------------------
    const tmp_dir = try std.fmt.allocPrint(gpa, "/tmp/codebox-zig-{d}", .{linux.getpid()});
    try Io.Dir.cwd().createDirPath(io, tmp_dir);
    defer Io.Dir.cwd().deleteTree(io, tmp_dir) catch {};

    var compile_span = Span.start("compile", root.span_id, "INTERNAL");
    const compiled = try compile(gpa, io, entry, tmp_dir);
    compile_span.end(compiled.binary != null, if (compiled.binary == null) "compile failed" else "");
    if (compiled.binary == null) std.debug.print("{s}", .{compiled.output});

    // --- exec (spawned) -----------------------------------------------------
    var command: std.ArrayList([]const u8) = .empty;
    var pid: ?linux.pid_t = null;
    var exit_code: ?u8 = null;
    var signal: ?[]const u8 = null;
    var spawn_error: ?[]const u8 = null;
    var usage: ?linux.rusage = null;
    const started_ns = nowNs();
    const t0 = monoNs();

    var exec_span = Span.start("process.exec", root.span_id, "CLIENT");
    if (compiled.binary) |binary| {
        try command.append(gpa, binary);
        try command.appendSlice(gpa, user_args);
        if (std.process.spawn(io, .{
            .argv = command.items,
            .cwd = .{ .path = entry_dir },
            .request_resource_usage_statistics = true,
        })) |spawned| {
            var child = spawned;
            pid = child.id;
            if (timeout_ms > 0) {
                const thread = try std.Thread.spawn(.{}, killAfter, .{ child.id.?, timeout_ms });
                thread.detach();
            }
            const term = try child.wait(io);
            usage = child.resource_usage_statistics.rusage;
            switch (term) {
                .exited => |c| exit_code = c,
                .signal => |s| signal = try std.fmt.allocPrint(gpa, "SIG{s}", .{@tagName(s)}),
                .stopped => |s| signal = try std.fmt.allocPrint(gpa, "SIG{s}", .{@tagName(s)}),
                .unknown => spawn_error = "unknown termination",
            }
        } else |err| {
            spawn_error = @errorName(err);
        }
    } else {
        spawn_error = "compile failed";
    }
    const ok = exit_code != null and exit_code.? == 0;
    exec_span.attributes = try std.fmt.allocPrint(gpa, "{{\"process.pid\":{d},\"process.exit.code\":{d}}}", .{ pid orelse -1, @as(i64, exit_code orelse 255) });
    exec_span.end(ok, if (ok) "" else (signal orelse spawn_error orelse "non-zero exit"));
    const duration_ms = @as(f64, @floatFromInt(monoNs() - t0)) / 1e6;
    const ended_ns = nowNs();

    const final_code: u8 = if (exit_code) |c| c else if (signal != null) 137 else if (compiled.binary == null) 65 else 1;
    root.end(final_code == 0, if (final_code == 0) "" else "non-zero exit");

    // --- document ----------------------------------------------------------
    var out: std.ArrayList(u8) = .empty;
    try out.appendSlice(gpa, "{\n  \"schema\": \"codebox.telemetry/v1\",\n");
    try out.print(gpa, "  \"runner\": {{\"language\":\"zig\",\"name\":\"{s}\",\"sdk\":\"codebox-otel-zig (OTel data model)\",\"sdk_version\":\"{s}\"}},\n", .{ runner_name, builtin.zig_version_string });
    try out.appendSlice(gpa, "  \"run_id\": ");
    if (run_id.len > 0) try jsonString(&out, gpa, run_id) else try out.appendSlice(gpa, "null");
    try out.appendSlice(gpa, ",\n  \"box\": ");
    if (box.len > 0) try jsonString(&out, gpa, box) else try out.appendSlice(gpa, "null");
    try out.appendSlice(gpa, ",\n  \"entry\": ");
    try jsonString(&out, gpa, entry);
    try out.appendSlice(gpa, ",\n  \"command\": [");
    for (command.items, 0..) |arg, i| {
        if (i > 0) try out.append(gpa, ',');
        try jsonString(&out, gpa, arg);
    }
    try out.appendSlice(gpa, "],\n  \"compile\": {\"command\":[");
    for (compiled.argv, 0..) |arg, i| {
        if (i > 0) try out.append(gpa, ',');
        try jsonString(&out, gpa, arg);
    }
    try out.print(gpa, "],\"exit_code\":{d},\"duration_ms\":{d:.3},\"output\":", .{ compiled.exit_code, compiled.duration_ms });
    try jsonString(&out, gpa, compiled.output);
    try out.appendSlice(gpa, "},\n  \"process\": {\"pid\":");
    if (pid) |p| try out.print(gpa, "{d}", .{p}) else try out.appendSlice(gpa, "null");
    try out.appendSlice(gpa, ",\"exit_code\":");
    if (exit_code) |c| try out.print(gpa, "{d}", .{c}) else try out.appendSlice(gpa, "null");
    try out.appendSlice(gpa, ",\"signal\":");
    if (signal) |s| try jsonString(&out, gpa, s) else try out.appendSlice(gpa, "null");
    try out.print(gpa, ",\"timed_out\":{},\"spawn_error\":", .{timed_out.load(.seq_cst)});
    if (spawn_error) |e| try jsonString(&out, gpa, e) else try out.appendSlice(gpa, "null");
    try out.print(gpa, ",\"started_at\":\"{s}\",\"ended_at\":\"{s}\",\"duration_ms\":{d:.3}}},\n", .{ try isoTime(gpa, started_ns), try isoTime(gpa, ended_ns), duration_ms });

    var user_ms: f64 = 0;
    var sys_ms: f64 = 0;
    if (usage) |ru| {
        user_ms = @as(f64, @floatFromInt(ru.utime.sec)) * 1e3 + @as(f64, @floatFromInt(ru.utime.usec)) / 1e3;
        sys_ms = @as(f64, @floatFromInt(ru.stime.sec)) * 1e3 + @as(f64, @floatFromInt(ru.stime.usec)) / 1e3;
        try out.print(gpa, "  \"resources\": {{\"user_cpu_ms\":{d:.3},\"system_cpu_ms\":{d:.3},\"max_rss_kb\":{d},\"minor_page_faults\":{d},\"major_page_faults\":{d},\"voluntary_ctx_switches\":{d},\"involuntary_ctx_switches\":{d},\"fs_in_blocks\":{d},\"fs_out_blocks\":{d},\"threads\":null}},\n", .{
            user_ms, sys_ms, ru.maxrss, ru.minflt, ru.majflt, ru.nvcsw, ru.nivcsw, ru.inblock, ru.oublock,
        });
    } else {
        try out.appendSlice(gpa, "  \"resources\": {\"user_cpu_ms\":null,\"system_cpu_ms\":null,\"max_rss_kb\":null,\"minor_page_faults\":null,\"major_page_faults\":null,\"voluntary_ctx_switches\":null,\"involuntary_ctx_switches\":null,\"fs_in_blocks\":null,\"fs_out_blocks\":null,\"threads\":null},\n");
    }

    try out.appendSlice(gpa, "  \"otel\": {\"resource\":{\"service.name\":");
    const service = env.get("OTEL_SERVICE_NAME") orelse try std.fmt.allocPrint(gpa, "codebox-{s}", .{if (box.len > 0) box else "local"});
    try jsonString(&out, gpa, service);
    try out.appendSlice(gpa, ",\"service.version\":\"1.0.0\",\"codebox.box\":");
    try jsonString(&out, gpa, box);
    try out.appendSlice(gpa, ",\"codebox.run_id\":");
    try jsonString(&out, gpa, run_id);
    try out.print(gpa, ",\"process.runtime.name\":\"zig\",\"process.runtime.version\":\"{s}\"}},\n    \"spans\": [", .{builtin.zig_version_string});
    try compile_span.write(&out, gpa, &trace_id);
    try out.append(gpa, ',');
    try exec_span.write(&out, gpa, &trace_id);
    try out.append(gpa, ',');
    try root.write(&out, gpa, &trace_id);
    try out.appendSlice(gpa, "],\n    \"metrics\": [");
    try histogramJson(&out, gpa, "process.duration", duration_ms, entry);
    try out.append(gpa, ',');
    try histogramJson(&out, gpa, "codebox.compile.duration", compiled.duration_ms, entry);
    if (usage) |ru| {
        try out.appendSlice(gpa, ",{\"name\":\"process.cpu.time\",\"unit\":\"ms\",\"type\":\"SUM\",\"data_points\":[");
        try pointJson(&out, gpa, entry, "cpu.mode", "user", user_ms);
        try out.append(gpa, ',');
        try pointJson(&out, gpa, entry, "cpu.mode", "system", sys_ms);
        try out.appendSlice(gpa, "]},{\"name\":\"process.memory.max_rss\",\"unit\":\"KiBy\",\"type\":\"GAUGE\",\"data_points\":[");
        try pointJson(&out, gpa, entry, "", "", @floatFromInt(ru.maxrss));
        try out.appendSlice(gpa, "]},{\"name\":\"process.paging.faults\",\"unit\":\"{fault}\",\"type\":\"SUM\",\"data_points\":[");
        try pointJson(&out, gpa, entry, "process.paging.fault_type", "minor", @floatFromInt(ru.minflt));
        try out.append(gpa, ',');
        try pointJson(&out, gpa, entry, "process.paging.fault_type", "major", @floatFromInt(ru.majflt));
        try out.appendSlice(gpa, "]},{\"name\":\"process.context_switches\",\"unit\":\"{count}\",\"type\":\"SUM\",\"data_points\":[");
        try pointJson(&out, gpa, entry, "process.context_switch_type", "voluntary", @floatFromInt(ru.nvcsw));
        try out.append(gpa, ',');
        try pointJson(&out, gpa, entry, "process.context_switch_type", "involuntary", @floatFromInt(ru.nivcsw));
        try out.appendSlice(gpa, "]}");
    }
    try out.appendSlice(gpa, "]}\n}\n");

    if (std.fs.path.dirname(out_file)) |parent| Io.Dir.cwd().createDirPath(io, parent) catch {};
    Io.Dir.cwd().writeFile(io, .{ .sub_path = out_file, .data = out.items }) catch |err| {
        std.debug.print("{s}: cannot write {s}: {s}\n", .{ runner_name, out_file, @errorName(err) });
    };
    return final_code;
}
