import type { TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { CustomMessage } from "../src/core/messages.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createViewportTui(): TUI {
	return {
		[Symbol.for("@earendil-works/pi-tui/viewport")]: true,
		requestRender: () => {},
	} as unknown as TUI;
}

function createNotification(): CustomMessage {
	return {
		role: "custom",
		customType: "background-task-notification",
		display: true,
		timestamp: 1234,
		content:
			'<background-task-notification task-id="709440c6a639">\nBackground task "iPhone Build And Install" completed, exit 0.\nOutput: /Users/haseeb/herdr-ios/.pi/tasks/709440c6a639.output (40B)\n</background-task-notification>',
	};
}

describe("compact custom messages", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("collapses a notification to one titled line", () => {
		const component = new CustomMessageComponent(createNotification());
		component.setCompact(true);

		const lines = component
			.render(100)
			.map(stripAnsi)
			.filter((line) => line.trim().length > 0);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Background Task Notification");
		expect(lines[0]).toContain('Background task "iPhone Build And Install" completed');
		expect(lines[0]).not.toContain("<background-task-notification");
	});

	test("clicking the line opens the full notification", () => {
		const component = new CustomMessageComponent(createNotification());
		component.setCompact(true, createViewportTui());

		const collapsed = component.render(100);
		expect(collapsed.some((line) => line.includes("pi-custom:background-task-notification:1234"))).toBe(true);

		expect(component.activateLink("pi-custom:background-task-notification:1234")).toBe(true);
		const expanded = component.render(100).map(stripAnsi).join("\n");
		expect(expanded).toContain("[background-task-notification]");
		expect(expanded).toContain("709440c6a639.output");
	});

	test("stays boxed when compact is off", () => {
		const component = new CustomMessageComponent(createNotification());

		const text = component.render(100).map(stripAnsi).join("\n");

		expect(text).toContain("[background-task-notification]");
	});
});
