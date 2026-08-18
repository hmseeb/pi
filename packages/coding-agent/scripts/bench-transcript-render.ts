/**
 * Deterministic transcript render benchmark.
 *
 * Why this exists: interactive timings taken by scrolling a live TUI are not
 * comparable between runs, because each run traverses different transcript
 * content. Frame cost varies by more than an order of magnitude depending on
 * which tool blocks are on screen, so an uncontrolled before/after can show any
 * result you like. This harness fixes every input that affects cost:
 *
 *   - the transcript content (a committed fixture of real tool executions),
 *   - the component tree (real ToolExecutionComponent instances),
 *   - the scroll offsets and viewport widths (a fixed, cycled schedule),
 *   - the frame count.
 *
 * Two runs of the same build therefore execute byte-identical work, and any
 * difference between builds is attributable to the code under test.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench-transcript-render.ts [--frames N] [--json out.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Imported from source rather than the package index: renderLayoutFrame and
// VIEWPORT_TUI are internals the benchmark needs, and exporting them publicly
// just to measure them would widen the package API for no product reason.
import { ScrollView } from "../../tui/src/components/scroll-view.ts";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import type { Terminal } from "../../tui/src/terminal.ts";
import { Container, VIEWPORT_TUI } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface FixtureTool {
	name: string;
	callId: string;
	args: unknown;
	output: string;
	isError: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, "../test/fixtures/transcript-perf.json");

/** Terminal stub: renders never reach a real tty, and writes are discarded. */
function createTerminal(columns: number, rows: number): Terminal {
	return {
		columns,
		rows,
		write: () => {},
		onResize: () => () => {},
		onData: () => () => {},
		setRawMode: () => {},
		start: () => {},
		stop: () => {},
		hideCursor: () => {},
		showCursor: () => {},
		moveCursor: () => {},
		clearLine: () => {},
		clearScreen: () => {},
	} as unknown as Terminal;
}

/**
 * The hyperlink pass only runs when the TUI is a viewport TUI, which is exactly
 * the fullscreen (alt screen) case the lag was reported in. Mark the stub so the
 * benchmark exercises that path rather than silently skipping it.
 */
function createTui(columns: number, rows: number): TuiMainScreen {
	const tui = new TuiMainScreen(createTerminal(columns, rows), false);
	(tui as unknown as Record<symbol, boolean>)[VIEWPORT_TUI] = true;
	return tui;
}

function buildTranscript(tools: FixtureTool[], tui: TuiMainScreen, cwd: string, expanded: boolean): Container {
	const chat = new Container();
	for (const tool of tools) {
		const component = new ToolExecutionComponent(tool.name, tool.callId, tool.args, {}, undefined, tui, cwd);
		component.setExpanded(expanded);
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: tool.output }], isError: tool.isError }, false);
		chat.addChild(component);
	}
	return chat;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx]!;
}

function main(): void {
	const argv = process.argv.slice(2);
	const cycleArg = argv.indexOf("--cycles");
	const cycles = cycleArg === -1 ? 3 : Number.parseInt(argv[cycleArg + 1] ?? "3", 10);
	const jsonArg = argv.indexOf("--json");
	const jsonOut = jsonArg === -1 ? undefined : argv[jsonArg + 1];
	const label = argv.includes("--label") ? argv[argv.indexOf("--label") + 1] : "run";

	// A fixed theme matters: theme colours are the ANSI codes that make transcript
	// lines expensive to slice, so the palette must be identical across runs.
	initTheme("dark", false);

	const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as { tools: FixtureTool[] };

	const HEIGHT = 40;
	const WIDTHS = argv.includes("--single-width") ? [100] : [100, 120];
	const tui = createTui(WIDTHS[0]!, HEIGHT);
	const expanded = !argv.includes("--collapsed");
	const chat = buildTranscript(fixture.tools, tui, "/tmp", expanded);
	const scroll = new ScrollView(chat, { follow: "none", primary: true });

	// Establish content height so the scroll schedule addresses real offsets.
	renderLayoutFrame(scroll, WIDTHS[0]!, HEIGHT, () => {});
	const totalLines = chat.render(WIDTHS[0]!).length;
	const maxScroll = Math.max(0, totalLines - HEIGHT);

	// The schedule is enumerated explicitly as (offset, width) pairs rather than
	// cycling two independent counters. Independent cycles have a combined period
	// of lcm(offsets, widths); sampling a frame count that is not a whole multiple
	// of that period measures a different subset of pairs each time, which makes
	// runs incomparable even though the workload looks fixed. Frame cost here spans
	// two orders of magnitude across offsets, so that sampling error alone produced
	// p50 swings from 5ms to 70ms on identical code.
	const STEPS = 24;
	const schedule: Array<{ offset: number; width: number }> = [];
	for (const width of WIDTHS) {
		for (let i = 0; i < STEPS; i++) {
			schedule.push({ offset: Math.round((maxScroll * i) / (STEPS - 1)), width });
		}
		for (let i = STEPS - 2; i > 0; i--) {
			schedule.push({ offset: Math.round((maxScroll * i) / (STEPS - 1)), width });
		}
	}

	// Warmup runs whole cycles so measurement always begins from the same state.
	for (const step of schedule) {
		scroll.scrollTo(step.offset);
		renderLayoutFrame(scroll, step.width, HEIGHT, () => {});
	}

	const samples: number[] = [];
	for (let c = 0; c < cycles; c++) {
		for (const step of schedule) {
			scroll.scrollTo(step.offset);
			const t0 = performance.now();
			renderLayoutFrame(scroll, step.width, HEIGHT, () => {});
			samples.push(performance.now() - t0);
		}
	}
	const frames = samples.length;

	if (argv.includes("--worst")) {
		const per = schedule.length;
		const ranked = samples
			.map((ms, i) => ({ ms, i, step: schedule[i % per]! }))
			.sort((a, b) => b.ms - a.ms)
			.slice(0, 8);
		for (const r of ranked) {
			console.log(`  frame ${String(r.i).padStart(4)} cycle=${Math.floor(r.i / per)} offset=${String(r.step.offset).padStart(5)} width=${r.step.width}  ${r.ms.toFixed(1)}ms`);
		}
	}
	if (argv.includes("--percycle")) {
		const per = schedule.length;
		for (let c = 0; c < cycles; c++) {
			const seg = samples.slice(c * per, (c + 1) * per);
			const tot = seg.reduce((n, v) => n + v, 0);
			const mx = Math.max(...seg);
			console.log(`  cycle ${c}: total=${tot.toFixed(0)}ms max=${mx.toFixed(1)}ms avg=${(tot / seg.length).toFixed(2)}ms`);
		}
	}
	if (argv.includes("--trace")) {
		const bucket = Math.max(1, Math.floor(samples.length / 12));
		for (let i = 0; i < samples.length; i += bucket) {
			const seg = samples.slice(i, i + bucket);
			const avg = seg.reduce((n, v) => n + v, 0) / seg.length;
			console.log(`  frames ${String(i).padStart(4)}-${String(i + seg.length - 1).padStart(4)}  avg=${avg.toFixed(1)}ms  heap=${(process.memoryUsage().heapUsed / 1048576).toFixed(0)}MB`);
		}
	}
	const sorted = [...samples].sort((a, b) => a - b);
	const total = samples.reduce((n, ms) => n + ms, 0);
	const result = {
		label,
		frames,
		tools: fixture.tools.length,
		transcriptLines: totalLines,
		maxScroll,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		max: sorted[sorted.length - 1] ?? 0,
		totalMs: total,
	};

	console.log(
		`${label.padEnd(14)} frames=${frames} lines=${totalLines} ` +
			`p50=${result.p50.toFixed(2)}ms p95=${result.p95.toFixed(2)}ms ` +
			`max=${result.max.toFixed(2)}ms total=${total.toFixed(0)}ms`,
	);
	if (jsonOut) {
		writeFileSync(jsonOut, `${JSON.stringify(result, null, "\t")}\n`);
		console.log(`  wrote ${jsonOut}`);
	}

	// The TUI schedules render frames on a timer; without stopping it a stray
	// frame fires after the benchmark finishes.
	tui.stop({ preserveScreen: true });
}

main();
