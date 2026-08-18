/**
 * Extract a compact, deterministic transcript fixture from a real session file.
 *
 * The perf benchmark needs realistic tool output (long lines, ANSI styling, wide
 * graphemes) without committing a 12MB session or depending on a developer's
 * home directory. This walks a session JSONL and emits the tool calls and their
 * results, capped so the fixture stays small but still reproduces the pathology.
 *
 * Usage:
 *   node scripts/extract-transcript-fixture.mjs <session.jsonl> <out.json> [maxTools]
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , sessionPath, outPath, maxToolsArg] = process.argv;
if (!sessionPath || !outPath) {
	console.error("usage: extract-transcript-fixture.mjs <session.jsonl> <out.json> [maxTools]");
	process.exit(1);
}
const maxTools = Number.parseInt(maxToolsArg ?? "60", 10);

const lines = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean);

/** @type {Map<string, {name: string, args: unknown}>} */
const calls = new Map();
/** @type {Array<{name: string, callId: string, args: unknown, output: string, isError: boolean}>} */
const tools = [];

for (const raw of lines) {
	let rec;
	try {
		rec = JSON.parse(raw);
	} catch {
		continue;
	}
	if (rec.type !== "message") continue;
	const msg = rec.message;
	if (!msg) continue;

	// Assistant messages carry toolCall parts; tool output arrives later as a
	// separate message with role "toolResult" keyed by toolCallId.
	if (msg.role === "assistant" && Array.isArray(msg.content)) {
		for (const part of msg.content) {
			if (part?.type === "toolCall" && typeof part.id === "string") {
				calls.set(part.id, { name: part.name ?? "unknown", args: part.arguments ?? {} });
			}
		}
		continue;
	}

	if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string") continue;
	const call = calls.get(msg.toolCallId);
	const parts = Array.isArray(msg.content) ? msg.content : [];
	const text = parts
		.filter((c) => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
	if (!text) continue;
	tools.push({
		name: msg.toolName ?? call?.name ?? "unknown",
		callId: msg.toolCallId,
		args: call?.args ?? {},
		// Cap any single output so one giant blob cannot dominate the fixture.
		output: text.length > 20000 ? text.slice(0, 20000) : text,
		isError: msg.isError === true,
	});
	calls.delete(msg.toolCallId);
	if (tools.length >= maxTools) break;
}

const stats = {
	tools: tools.length,
	totalOutputChars: tools.reduce((n, t) => n + t.output.length, 0),
	totalOutputLines: tools.reduce((n, t) => n + t.output.split("\n").length, 0),
	maxOutputLines: tools.reduce((n, t) => Math.max(n, t.output.split("\n").length), 0),
	names: [...new Set(tools.map((t) => t.name))].sort(),
};

writeFileSync(outPath, `${JSON.stringify({ stats, tools }, null, "\t")}\n`);
console.log(JSON.stringify(stats, null, 2));
