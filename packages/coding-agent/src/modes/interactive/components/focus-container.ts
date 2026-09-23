import { Container, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { AssistantMessageComponent } from "./assistant-message.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";
import { UserMessageComponent } from "./user-message.ts";

/**
 * Chat container with a /focus view: after each user prompt, tool calls and
 * intermediate assistant messages collapse into one summary line, leaving the
 * prompt and the latest assistant text.
 */
export class FocusContainer extends Container {
	focus = false;

	override render(width: number): string[] {
		if (!this.focus) return super.render(width);
		const kids = this.children;
		const lines: string[] = [];
		let start = 0;
		while (start < kids.length) {
			let end = start + 1;
			while (end < kids.length && !(kids[end] instanceof UserMessageComponent)) end++;
			const segment = kids.slice(start, end);
			const answer = [...segment].reverse().find((c) => c instanceof AssistantMessageComponent && c.hasText());
			const isWork = (c: unknown) =>
				c instanceof ToolExecutionComponent || (c instanceof AssistantMessageComponent && c !== answer);
			const counts = new Map<string, number>();
			for (const c of segment)
				if (c instanceof ToolExecutionComponent) counts.set(c.toolName, (counts.get(c.toolName) ?? 0) + 1);
			let summarized = false;
			for (const c of segment) {
				if (!isWork(c)) {
					lines.push(...c.render(width));
					continue;
				}
				if (summarized || counts.size === 0) continue;
				summarized = true;
				const total = [...counts.values()].reduce((a, b) => a + b, 0);
				const detail = [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
				lines.push(
					"",
					truncateToWidth(theme.fg("dim", ` ⋯ ${total} tool call${total > 1 ? "s" : ""} · ${detail}`), width),
				);
			}
			start = end;
		}
		return lines;
	}

	override handleMouse(event: TuiMouseEvent) {
		// Row layout differs from the full view; drop clicks rather than hit the wrong child.
		return this.focus ? undefined : super.handleMouse(event);
	}
}
