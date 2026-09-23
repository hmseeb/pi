import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	hyperlink,
	Image,
	isImageLine,
	isViewportTUI,
	MouseRegion,
	Spacer,
	sliceByColumn,
	Text,
	type TUI,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { type Theme, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { CachedLineMap } from "./render-cache.ts";

const FALLBACK_PREVIEW_LINES = 10;
/** Wide enough to keep a command on one line, narrow enough to stay cheap. */
const COMPACT_PREVIEW_WIDTH = 400;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export interface ToolRenderers {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
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
	private contentTextRegion: MouseRegion;
	private selfRenderContainer: Container;
	private selfRenderHeight = 0;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	readonly toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private compact = false;
	private compactPreviewText?: string;
	private compactLabelText?: string;
	private compactCache?: string[];
	private compactCacheWidth?: number;
	private compactCacheStatus?: string;
	private toolDefinition?: ToolRenderers | ToolDefinition<any, any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<
		number,
		{ sourceData: string; sourceMimeType: string; data: string; mimeType: string }
	> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
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
		this.contentTextRegion = this.createResultRegion(this.contentText);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentTextRegion);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
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

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
	}

	updateArgs(args: any): void {
		this.args = args;
		this.compactPreviewText = undefined;
		this.compactLabelText = undefined;
		this.compactCache = undefined;
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
			const sourceData = img.data;
			const sourceMimeType = img.mimeType;
			if (sourceMimeType === "image/png") continue;
			const cached = this.convertedImages.get(i);
			if (cached?.sourceData === sourceData && cached.sourceMimeType === sourceMimeType) continue;

			const index = i;
			convertToPng(sourceData, sourceMimeType).then((converted) => {
				const currentImage = this.result?.content.filter((content) => content.type === "image")[index];
				if (!converted || currentImage?.data !== sourceData || currentImage.mimeType !== sourceMimeType) return;
				this.convertedImages.set(index, {
					sourceData,
					sourceMimeType,
					...converted,
				});
				this.updateDisplay();
				this.ui.requestRender();
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

	private static titleCase(name: string): string {
		return name
			.split(/[_\s-]+/)
			.filter(Boolean)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");
	}

	/**
	 * The tool's own verb when it renders one, so viewing an image reads `View`
	 * rather than `Read view`. A renderer styles just the verb and then switches
	 * colour for the argument, which is what distinguishes it from a command whose
	 * first word happens to be short.
	 */
	private compactLabelFor(raw: string): string {
		const verb = /^(?:\x1b\[[0-9;]*m)+([A-Za-z][\w-]*)(?:\x1b\[(?:39|0)m)/.exec(raw)?.[1];
		return ToolExecutionComponent.titleCase(verb ?? this.toolName);
	}

	/**
	 * The call flattened to one line: what was run, not what it printed. It only
	 * changes when the arguments do, so it is computed once and kept; flattening
	 * per frame made scrolling stutter.
	 */
	private compactPreview(fallback: string[]): { label: string; preview: string } {
		if (this.compactPreviewText !== undefined && this.compactLabelText !== undefined) {
			return { label: this.compactLabelText, preview: this.compactPreviewText };
		}
		const source = this.callRendererComponent?.render(COMPACT_PREVIEW_WIDTH) ?? fallback;
		const raw = source.join(" ");
		const joined = source
			.map((line) => stripAnsi(line).trim())
			.filter(Boolean)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		const withoutPrompt = joined.replace(/^[$>#]\s*/, "");
		const label = this.compactLabelFor(raw);
		const leading = withoutPrompt.split(" ")[0]?.toLowerCase() ?? "";
		// The label already says which tool ran, so its own name is redundant.
		this.compactPreviewText =
			leading === label.toLowerCase() || leading === this.toolName.toLowerCase()
				? withoutPrompt.slice(leading.length + 1)
				: withoutPrompt;
		this.compactLabelText = label;
		return { label, preview: this.compactPreviewText };
	}

	private renderCompactLine(width: number, lines: string[]): string[] {
		const status = this.result?.isError ? "error" : this.isPartial ? "muted" : "toolTitle";
		if (this.compactCache && this.compactCacheWidth === width && this.compactCacheStatus === status) {
			return this.compactCache;
		}
		const { label: labelText, preview } = this.compactPreview(lines);
		const label = theme.fg(status, labelText);
		const gap = 2;
		const room = Math.max(0, width - visibleWidth(label) - gap - 1);
		// The shared helper emits a style reset before its ellipsis, which left the
		// dots uncoloured. Slicing the plain text keeps the whole preview, ellipsis
		// included, inside one colour span.
		const clipped =
			visibleWidth(preview) > room ? `${sliceByColumn(preview, 0, Math.max(0, room - 1), true)}…` : preview;
		const body = room > 0 && preview ? `${" ".repeat(gap)}${theme.fg("muted", clipped)}` : "";
		this.compactCache = ["", ` ${label}${body}`];
		this.compactCacheWidth = width;
		this.compactCacheStatus = status;
		return this.compactCache;
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
		this.compactCache = undefined;
		this.compactCacheWidth = undefined;
		this.compactCacheStatus = undefined;
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

		// A collapsed row shows one line, so the box, result and images below it
		// never need to be laid out.
		if (this.compact && !this.expanded) {
			const lines = this.renderCompactLine(width, []);
			return this.decorateLinks(width, lines);
		}

		let lines: string[];
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			this.selfRenderHeight = contentLines.length;
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

		return this.decorateLinks(width, lines);
	}

	/** Wraps rendered lines in the tool's hyperlink so clicking one expands it. */
	private decorateLinks(width: number, lines: string[]): string[] {
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

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") return super.handleMouse(event);
		if (event.y <= 0 || event.y > this.selfRenderHeight) return undefined;
		return this.selfRenderContainer.handleMouse({
			...event,
			y: event.y - 1,
			height: this.selfRenderHeight,
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
				renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(this.createResultRegion(component));
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
					hasContent = true;
				}
			}

			if (this.result) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(this.createResultRegion(component));
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
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(this.createResultRegion(component));
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
					const cached = this.convertedImages.get(i);
					const converted =
						cached?.sourceData === img.data && cached.sourceMimeType === img.mimeType ? cached : undefined;
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
