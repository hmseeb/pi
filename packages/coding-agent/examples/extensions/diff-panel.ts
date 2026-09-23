// /diff — toggles a live right-side panel showing uncommitted changes (git diff HEAD + untracked).
// Refreshes after every tool result and at agent end. The last file Pi touched is shown first.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		return (await run("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 })).stdout;
	} catch {
		return "";
	}
}

export async function readDiff(cwd: string, lastPath?: string): Promise<string[] | undefined> {
	if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") return undefined;
	const diff = (await git(cwd, ["diff", "--no-color", "HEAD"])) || (await git(cwd, ["diff", "--no-color"]));
	const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
	let chunks = diff.split(/^(?=diff --git )/m).filter((c) => c.trim());
	if (lastPath) {
		const rel = lastPath.startsWith(cwd) ? lastPath.slice(cwd.length + 1) : lastPath;
		chunks = [
			...chunks.filter((c) => c.includes(` b/${rel}\n`)),
			...chunks.filter((c) => !c.includes(` b/${rel}\n`)),
		];
	}
	const lines = chunks.flatMap((c) => c.replace(/\n$/, "").split("\n"));
	if (untracked.length) lines.push("", "Untracked:", ...untracked.map((f) => `?? ${f}`));
	return lines;
}

class DiffPanel {
	lines: string[] | undefined = [];
	tui: TUI;
	private theme: Theme;
	constructor(tui: TUI, theme: Theme) {
		this.tui = tui;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const t = this.theme;
		const inner = Math.max(10, width - 2);
		const max = Math.max(5, Math.floor(this.tui.terminal.rows * 0.7));
		const src = this.lines;
		const files = src?.filter((l) => l.startsWith("diff --git ")).length ?? 0;
		const add = src?.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length ?? 0;
		const del = src?.filter((l) => l.startsWith("-") && !l.startsWith("---")).length ?? 0;
		const title =
			src === undefined
				? "not a git repo"
				: src.length === 0
					? "no uncommitted changes"
					: `${files} files +${add} −${del}`;
		const body = (src ?? [])
			.filter((l) => !/^(index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l))
			.map((l) => {
				if (l.startsWith("diff --git "))
					return t.bold(t.fg("accent", l.replace(/^diff --git a\/(.*) b\/.*/, "$1")));
				if (l.startsWith("@@")) return t.fg("muted", l);
				if (l.startsWith("+")) return t.fg("toolDiffAdded", l);
				if (l.startsWith("-")) return t.fg("toolDiffRemoved", l);
				if (l.startsWith("??") || l === "Untracked:") return t.fg("warning", l);
				return t.fg("toolDiffContext", l);
			});
		const out = [t.bold(` Diff · ${title}`), ...body].slice(0, max);
		if (body.length + 1 > max) out[max - 1] = t.fg("dim", ` … ${body.length + 2 - max} more lines`);
		const bar = t.fg("border", "│");
		return out.map((l) => {
			const cut = truncateToWidth(l.replace(/\t/g, "  "), inner);
			return `${bar} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))}`;
		});
	}
}

export default function (pi: ExtensionAPI) {
	let panel: DiffPanel | undefined;
	let close: (() => void) | undefined;
	let lastPath: string | undefined;
	let cwd = process.cwd();
	let pending: Promise<void> | undefined;

	const refresh = async () => {
		if (!panel) return;
		if (pending) return pending; // ponytail: coalesce overlapping refreshes; next event catches later edits
		pending = (async () => {
			const lines = await readDiff(cwd, lastPath);
			if (panel) {
				panel.lines = lines;
				panel.tui.requestRender();
			}
		})().finally(() => {
			pending = undefined;
		});
		return pending;
	};

	pi.registerCommand("diff", {
		description: "Toggle live panel of uncommitted changes",
		handler: async (_args, ctx) => {
			if (close) return close();
			cwd = ctx.cwd;
			void ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					panel = new DiffPanel(tui, theme);
					close = () => {
						panel = undefined;
						close = undefined;
						done();
					};
					void refresh();
					return panel;
				},
				{
					overlay: true,
					overlayOptions: {
						nonCapturing: true,
						anchor: "top-right",
						width: "45%",
						minWidth: 40,
						margin: { top: 1 },
					},
				},
			);
		},
	});

	pi.on("tool_result", async (event) => {
		const p = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof p === "string" && (event.toolName === "edit" || event.toolName === "write")) lastPath = p;
		await refresh();
	});
	pi.on("agent_end", async () => refresh());
	pi.on("session_shutdown", async () => close?.());
}
