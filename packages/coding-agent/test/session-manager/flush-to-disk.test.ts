import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

// `_persist` defers file creation until the first assistant message, so a session
// that never got a reply stays in memory. Interactive shutdown calls
// `flushToDisk()` so the "To resume this session" hint is not silently skipped.
describe("SessionManager.flushToDisk", () => {
	let tempDir: string;
	let cwd: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-flush-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes a session that has messages but no assistant reply", () => {
		const session = SessionManager.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file path");
		expect(existsSync(sessionFile)).toBe(false);

		expect(session.flushToDisk()).toBe(true);

		expect(existsSync(sessionFile)).toBe(true);
		const lines = readFileSync(sessionFile, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(2); // header + user message
		expect(JSON.parse(lines[0]).type).toBe("session");
		expect(JSON.parse(lines[1]).message.content).toBe("hello");
	});

	it("does not create a file for a session with no messages", () => {
		const session = SessionManager.create(cwd, tempDir);
		session.appendThinkingLevelChange("high");
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file path");

		expect(session.flushToDisk()).toBe(false);
		expect(existsSync(sessionFile)).toBe(false);
	});

	it("is a no-op for an already flushed session", () => {
		const session = SessionManager.create(cwd, tempDir);
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file path");
		const before = readFileSync(sessionFile, "utf-8");

		expect(session.flushToDisk()).toBe(true);
		expect(readFileSync(sessionFile, "utf-8")).toBe(before);
	});

	it("returns false for in-memory sessions", () => {
		const session = SessionManager.inMemory(cwd);
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		expect(session.flushToDisk()).toBe(false);
	});
});
