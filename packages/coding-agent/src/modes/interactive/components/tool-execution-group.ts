import { type Component, hyperlink, isViewportTUI, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { SourceInfo } from "../../../core/source-info.ts";
import { theme } from "../theme/theme.ts";
import { TOOL_LINK_PREFIX, type ToolExecutionComponent } from "./tool-execution.ts";

export interface ToolExecutionCategory {
	key: string;
	verb: string;
	runningVerb: string;
	singular: string;
	plural: string;
}

export const TOOL_GROUP_LINK_PREFIX = `${TOOL_LINK_PREFIX}group:`;

type GroupedTool = {
	toolCallId: string;
	component: ToolExecutionComponent;
	complete: boolean;
	isError: boolean;
};

const BUILTIN_CATEGORIES: Record<string, ToolExecutionCategory> = {
	bash: {
		key: "builtin:shell",
		verb: "Ran",
		runningVerb: "Running",
		singular: "shell command",
		plural: "shell commands",
	},
	read: { key: "builtin:read", verb: "Read", runningVerb: "Reading", singular: "file", plural: "files" },
	edit: { key: "builtin:change", verb: "Changed", runningVerb: "Changing", singular: "file", plural: "files" },
	write: { key: "builtin:change", verb: "Changed", runningVerb: "Changing", singular: "file", plural: "files" },
	grep: { key: "builtin:search", verb: "Ran", runningVerb: "Running", singular: "search", plural: "searches" },
	find: { key: "builtin:search", verb: "Ran", runningVerb: "Running", singular: "search", plural: "searches" },
	ls: { key: "builtin:search", verb: "Ran", runningVerb: "Running", singular: "search", plural: "searches" },
};

function titleCasePackageName(name: string): string {
	const withoutScope = name.split("/").pop() ?? name;
	const cleaned = withoutScope
		.replace(/^pi[-_]/i, "")
		.replace(/[-_](?:pi|agents?|tools?|extensions?)$/i, "")
		.replace(/[-_]+/g, " ")
		.trim();
	if (!cleaned) return "custom";
	return cleaned.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getCustomCategoryLabel(sourceInfo: SourceInfo | undefined): string {
	const source = sourceInfo?.source ?? "custom";
	if (source === "sdk") return "SDK";
	if (source === "inline") return "extension";

	if (source.startsWith("npm:")) {
		return titleCasePackageName(source.slice("npm:".length));
	}
	if (source.startsWith("git:")) {
		return titleCasePackageName(source.split("/").pop() ?? source.slice("git:".length));
	}

	const sourcePath = sourceInfo?.path.replace(/\\/g, "/");
	const pathParts = sourcePath?.split("/").filter(Boolean) ?? [];
	const fileName = pathParts.pop()?.replace(/\.[^.]+$/, "");
	const pathLabel = fileName === "index" ? pathParts.pop() : fileName;
	return titleCasePackageName(pathLabel ?? source);
}

export function getToolExecutionCategory(toolName: string, sourceInfo: SourceInfo | undefined): ToolExecutionCategory {
	if (sourceInfo?.source === "builtin" || toolName in BUILTIN_CATEGORIES) {
		return (
			BUILTIN_CATEGORIES[toolName] ?? {
				key: "builtin:tool",
				verb: "Used",
				runningVerb: "Using",
				singular: "built-in tool",
				plural: "built-in tools",
			}
		);
	}

	const label = getCustomCategoryLabel(sourceInfo);
	const key = sourceInfo ? `${sourceInfo.source}:${sourceInfo.path}` : `custom:${label}`;
	return {
		key,
		verb: "Used",
		runningVerb: "Using",
		singular: `${label} tool`,
		plural: `${label} tools`,
	};
}

export class ToolExecutionGroupComponent implements Component {
	private readonly category: ToolExecutionCategory;
	private readonly tools: GroupedTool[] = [];
	private readonly ui: TUI;
	private expanded = false;

	constructor(category: ToolExecutionCategory, ui: TUI) {
		this.category = category;
		this.ui = ui;
	}

	matchesCategory(category: ToolExecutionCategory): boolean {
		return this.category.key === category.key;
	}

	addTool(toolCallId: string, component: ToolExecutionComponent): void {
		this.tools.push({ toolCallId, component, complete: false, isError: false });
		component.setExpanded(this.expanded);
	}

	completeTool(toolCallId: string, isError: boolean): void {
		const tool = this.tools.find((item) => item.toolCallId === toolCallId);
		if (!tool) return;
		tool.complete = true;
		tool.isError = isError;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const tool of this.tools) tool.component.setExpanded(expanded);
	}

	setShowImages(show: boolean): void {
		for (const tool of this.tools) tool.component.setShowImages(show);
	}

	setImageWidthCells(width: number): void {
		for (const tool of this.tools) tool.component.setImageWidthCells(width);
	}

	activateLink(url: string): boolean {
		const groupUrl = this.getGroupUrl();
		if (groupUrl && url === groupUrl) {
			this.setExpanded(!this.expanded);
			return true;
		}
		for (const tool of this.tools) {
			if (tool.component.activateLink(url)) return true;
		}
		return false;
	}

	private getGroupUrl(): string | undefined {
		const firstTool = this.tools[0];
		return firstTool ? `${TOOL_GROUP_LINK_PREFIX}${encodeURIComponent(firstTool.toolCallId)}` : undefined;
	}

	render(width: number): string[] {
		if (this.tools.length === 0) return [];

		const complete = this.tools.filter((tool) => tool.complete);
		const pending = this.tools.length - complete.length;
		const failed = complete.filter((tool) => tool.isError).length;
		const noun = this.tools.length === 1 ? this.category.singular : this.category.plural;
		const verb = pending > 0 ? this.category.runningVerb : this.category.verb;
		let summary = theme.fg("muted", `${verb} ${this.tools.length} ${noun}${pending > 0 ? "…" : ""}`);
		if (failed > 0) {
			summary += theme.fg("error", ` · ${failed} of ${this.tools.length} failed`);
		}
		const summaryWidth = Math.max(0, width - 1);
		const summaryText = truncateToWidth(summary, summaryWidth);
		const groupUrl = this.getGroupUrl();
		const linkedSummary =
			groupUrl && isViewportTUI(this.ui) && process.env.TERM_PROGRAM !== "Orca"
				? hyperlink(summaryText, groupUrl)
				: summaryText;
		const lines = ["", summaryWidth > 0 ? ` ${linkedSummary}` : ""];
		if (this.expanded) {
			lines.push(...this.tools.flatMap((tool) => tool.component.render(width)));
		}
		return lines;
	}

	invalidate(): void {
		for (const tool of this.tools) tool.component.invalidate();
	}
}
