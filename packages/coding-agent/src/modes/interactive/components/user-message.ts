import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { linkPath } from "../../../core/tools/render-utils.ts";
import { collapseClipboardImagePaths } from "../../../utils/clipboard-image.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { CachedLineMap } from "./render-cache.ts";

// `;u` marks this prompt zone as a user message. Assistant messages open plain
// `133;A` zones, so the TUI needs the parameter to tell them apart.
const OSC133_ZONE_START = "\x1b]133;A;u\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Extracts the escape sequence a style function emits before its content, so it
 * can be re-applied after a nested style resets the foreground color.
 */
function stylePrefixOf(style: (text: string) => string): string {
	const sentinel = "\u0000";
	const styled = style(sentinel);
	const index = styled.indexOf(sentinel);
	return index >= 0 ? styled.slice(0, index) : "";
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private readonly zoneCache = new CachedLineMap();
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		const textColor = (content: string) => theme.fg("userMessageText", content);
		// Keep pasted-image chips accent-colored and clickable after submit, matching
		// how the editor rendered them; re-open the message color afterwards because
		// the chip resets the foreground.
		const textPrefix = stylePrefixOf(textColor);
		const cwd = process.cwd();
		const decorateImageChip = (label: string, filePath: string): string =>
			linkPath(theme.fg("accent", label), filePath, cwd) + textPrefix;
		contentBox.addChild(
			new Markdown(
				collapseClipboardImagePaths(this.text, decorateImageChip),
				0,
				0,
				this.markdownTheme,
				{
					color: textColor,
				},
				{
					preserveOrderedListMarkers: true,
					preserveBackslashEscapes: true,
					transform: createMarkdownTransform("user", false, this.markdownTransformers),
				},
			),
		);
		this.addChild(contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		// Copy: the source array is shared with Container's render cache.
		return this.zoneCache.map(width, lines, (source) => {
			const zoned = source.slice();
			zoned[0] = OSC133_ZONE_START + zoned[0];
			zoned[zoned.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + zoned[zoned.length - 1];
			return zoned;
		});
	}
}
