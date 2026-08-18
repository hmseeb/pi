/**
 * Per-frame reuse for components that post-process their rendered lines.
 *
 * `Container.render()` returns the same array reference while no child has
 * re-rendered, so identity comparison tells us a frame is a repeat. Components
 * that transform those lines (prompt zone markers, hyperlinking) can then skip
 * the transform entirely instead of redoing grapheme-level work for the whole
 * transcript on every animation frame.
 *
 * The transform must not mutate its input: the source array is shared.
 */
export class CachedLineMap {
	private width: number | undefined;
	private source: string[] | undefined;
	private result: string[] | undefined;

	map(width: number, source: string[], transform: (lines: string[]) => string[]): string[] {
		if (this.result !== undefined && this.width === width && this.source === source) {
			return this.result;
		}
		const result = transform(source);
		this.width = width;
		this.source = source;
		this.result = result;
		return result;
	}

	clear(): void {
		this.width = undefined;
		this.source = undefined;
		this.result = undefined;
	}
}
