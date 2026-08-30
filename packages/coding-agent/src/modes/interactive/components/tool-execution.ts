import {
	Box,
	type Component,
	Container,
	getCapabilities,
	hyperlink,
	Image,
	isImageLine,
	isViewportTUI,
	Spacer,
	sliceByColumn,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext } from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { CachedLineMap } from "./render-cache.ts";

const FALLBACK_PREVIEW_LINES = 10;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export const TOOL_LINK_PREFIX = "pi-tool:";

/** Reference-equality check for the per-part source arrays of a render. */
function sameArrayRefs(a: string[][] | undefined, b: string[][]): boolean {
	if (!a || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function hyperlinkContent(line: string, url: string): string {
	if (isImageLine(line)) return line;
	const trailingSpaces = stripAnsi(line).match(/ +$/)?.[0].length ?? 0;
	const linkedWidth = visibleWidth(line) - trailingSpaces;
	if (linkedWidth <= 0) return line;
	return (
		hyperlink(sliceByColumn(line, 0, linkedWidth, true), url) + sliceByColumn(line, linkedWidth, trailingSpaces, true)
	);
}

export class ToolExecutionComponent extends Container {
	/**
	 * Hyperlinking rewrites every line through grapheme-level slicing, which is
	 * the single most expensive thing the transcript does per frame. The source
	 * lines are reference-stable while nothing changed, so cache the result and
	 * only redo the pass when the underlying lines or width actually change.
	 */
	private readonly linkCache = new CachedLineMap();
	/**
	 * Per-line memo for the hyperlink pass.
	 *
	 * linkCache only hits on array *reference* equality, and Container.render
	 * returns a fresh array whenever any single child re-rendered. One animating
	 * child therefore forced every line in the block back through grapheme-level
	 * slicing, which profiling showed to be ~43% of all CPU while scrolling.
	 * Individual line strings stay reference-stable across those rebuilds, so
	 * memoising per line survives the array churn.
	 */
	private lineLinkCache = new Map<string, string>();
	private selfRenderCacheParts: string[][] | undefined;
	private selfRenderCacheWidth: number | undefined;
	private selfRenderCacheLines: string[] | undefined;
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private compact = false;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	/**
	 * Collapses the call to a single line until it is opened. Grouping already
	 * hides ungrouped detail behind a summary; without it every call printed its
	 * whole box, so the transcript read as output rather than as a conversation.
	 */
	setCompact(compact: boolean): void {
		if (this.compact === compact) return;
		this.compact = compact;
		this.clearRenderCaches();
		this.updateDisplay();
	}

	/** `bash` reads as `Bash`, `ast_grep` as `Ast Grep`. */
	private get compactLabel(): string {
		return this.toolName
			.split(/[_\s-]+/)
			.filter(Boolean)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");
	}

	/**
	 * The call flattened to one line: what was run, not what it printed. A wide
	 * render keeps a long command on a single line, and the tool's own name is
	 * dropped because the label already says it.
	 */
	private compactPreview(fallback: string[]): string {
		const source = this.callRendererComponent?.render(4096) ?? fallback;
		const joined = source
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		const withoutPrompt = joined.replace(/^[$>#]\s*/, "");
		const label = this.toolName.toLowerCase();
		return withoutPrompt.toLowerCase().startsWith(`${label} `)
			? withoutPrompt.slice(label.length + 1)
			: withoutPrompt;
	}

	private renderCompactLine(width: number, lines: string[]): string[] {
		const status = this.result?.isError ? "error" : this.isPartial ? "muted" : "toolTitle";
		const label = theme.fg(status, this.compactLabel);
		const gap = 2;
		const room = Math.max(0, width - visibleWidth(label) - gap - 1);
		const preview = this.compactPreview(lines);
		const body = room > 0 && preview ? `${" ".repeat(gap)}${truncateToWidth(theme.fg("muted", preview), room)}` : "";
		return ["", ` ${label}${body}`];
	}

	activateLink(url: string): boolean {
		if (url !== `${TOOL_LINK_PREFIX}${encodeURIComponent(this.toolCallId)}`) return false;
		this.setExpanded(!this.expanded);
		return true;
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		this.clearRenderCaches();
		super.invalidate();
		this.updateDisplay();
	}

	private clearRenderCaches(): void {
		this.linkCache.clear();
		this.lineLinkCache.clear();
		this.selfRenderCacheWidth = undefined;
		this.selfRenderCacheParts = undefined;
		this.selfRenderCacheLines = undefined;
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}

		let lines: string[];
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			if (contentLines.length === 0 && this.imageComponents.length === 0) {
				return [];
			}

			// Track the source arrays so an unchanged frame reuses the assembly.
			const parts: string[][] = [contentLines];
			lines = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) {
					const spacerLines = spacer.render(width);
					parts.push(spacerLines);
					lines.push(...spacerLines);
				}
				const imageComponent = this.imageComponents[i];
				if (imageComponent) {
					const imageLines = imageComponent.render(width);
					parts.push(imageLines);
					lines.push(...imageLines);
				}
			}
			if (
				this.selfRenderCacheLines !== undefined &&
				this.selfRenderCacheWidth === width &&
				sameArrayRefs(this.selfRenderCacheParts, parts)
			) {
				lines = this.selfRenderCacheLines;
			} else {
				this.selfRenderCacheWidth = width;
				this.selfRenderCacheParts = parts;
				this.selfRenderCacheLines = lines;
			}
		} else {
			lines = super.render(width);
		}

		if (this.compact && !this.expanded) {
			lines = this.renderCompactLine(width, lines);
		}

		if (!isViewportTUI(this.ui) || process.env.PI_DISABLE_TOOL_LINKS === "1" || process.env.TERM_PROGRAM === "Orca")
			return lines;
		const url = `${TOOL_LINK_PREFIX}${encodeURIComponent(this.toolCallId)}`;
		return this.linkCache.map(width, lines, (source) => {
			// Generational swap rather than a fixed cap: the previous pass is the
			// lookup table, this pass builds the next one. Memory stays bounded by
			// the block's own line count and a large block can never evict the very
			// entries it is about to reuse, which a size cap does.
			const prev = this.lineLinkCache;
			const next = new Map<string, string>();
			const out = source.map((line) => {
				let linked = next.get(line) ?? prev.get(line);
				if (linked === undefined) linked = hyperlinkContent(line, url);
				next.set(line, linked);
				return linked;
			});
			this.lineLinkCache = next;
			return out;
		});
	}

	private updateDisplay(): void {
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createCallFallback());
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(component);
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}
