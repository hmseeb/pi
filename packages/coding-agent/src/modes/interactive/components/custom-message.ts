import type { TextContent } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import {
	Box,
	Container,
	hyperlink,
	isViewportTUI,
	Markdown,
	type MarkdownTheme,
	Spacer,
	sliceByColumn,
	Text,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

export const CUSTOM_MESSAGE_LINK_PREFIX = "pi-custom:";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;
	private compact = false;
	private ui?: TUI;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	/**
	 * Notifications arrive between tool calls and read as part of the same work,
	 * so they collapse to the same single line until opened.
	 */
	setCompact(compact: boolean, ui?: TUI): void {
		this.ui = ui ?? this.ui;
		if (this.compact === compact) return;
		this.compact = compact;
		this.rebuild();
	}

	private get linkUrl(): string {
		return `${CUSTOM_MESSAGE_LINK_PREFIX}${this.message.customType}:${this.message.timestamp}`;
	}

	activateLink(url: string): boolean {
		if (url !== this.linkUrl) return false;
		this.setExpanded(!this._expanded);
		return true;
	}

	/** `background-task-notification` reads as `Background Task Notification`. */
	private get compactLabel(): string {
		return this.message.customType
			.split(/[_\s-]+/)
			.filter(Boolean)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ");
	}

	private messageText(): string {
		if (typeof this.message.content === "string") return this.message.content;
		return this.message.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("\n");
	}

	/** The notification without its wrapper tags, flattened to one line. */
	private compactPreview(): string {
		return stripAnsi(this.messageText())
			.replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	private renderCompactLine(width: number): string[] {
		const label = theme.fg("customMessageLabel", this.compactLabel);
		const gap = 2;
		const room = Math.max(0, width - visibleWidth(label) - gap - 1);
		const preview = this.compactPreview();
		const clipped =
			visibleWidth(preview) > room ? `${sliceByColumn(preview, 0, Math.max(0, room - 1), true)}…` : preview;
		const body = room > 0 && preview ? `${" ".repeat(gap)}${theme.fg("muted", clipped)}` : "";
		const line = ` ${label}${body}`;
		const linkable = this.ui && isViewportTUI(this.ui) && process.env.PI_DISABLE_TOOL_LINKS !== "1";
		return ["", linkable ? hyperlink(line, this.linkUrl) : line];
	}

	override render(width: number): string[] {
		if (this.compact && !this._expanded && !this.customComponent) {
			return this.renderCompactLine(width);
		}
		const lines = super.render(width);
		const linkable = this.compact && this.ui && isViewportTUI(this.ui) && process.env.PI_DISABLE_TOOL_LINKS !== "1";
		return linkable ? lines.map((line) => hyperlink(line, this.linkUrl)) : lines;
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad },
					theme,
				);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		const text = this.messageText();

		this.box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
