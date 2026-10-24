import { Renderable, type BaseRenderable, type RenderableOptions } from "../Renderable.js";
import { OptimizedBuffer } from "../buffer.js";
import type { RenderContext, LineInfoProvider } from "../types.js";
import { RGBA } from "../lib/RGBA.js";
export interface LineSign {
    before?: string;
    beforeColor?: string | RGBA;
    after?: string;
    afterColor?: string | RGBA;
}
export interface LineColorConfig {
    gutter?: string | RGBA;
    content?: string | RGBA;
}
export interface LineNumberOptions extends RenderableOptions<LineNumberRenderable> {
    target?: Renderable & LineInfoProvider;
    fg?: string | RGBA;
    bg?: string | RGBA;
    minWidth?: number;
    paddingRight?: number;
    lineColors?: Map<number, string | RGBA | LineColorConfig>;
    lineSigns?: Map<number, LineSign>;
    lineNumberOffset?: number;
    hideLineNumbers?: Set<number>;
    lineNumbers?: Map<number, number>;
    showLineNumbers?: boolean;
}
export interface GutterLayout {
    minWidth: number;
    /** Columns before the line numbers, painted in each line's gutter color. Defaults to 1. */
    paddingLeft: number;
    paddingRight: number;
    /** Reserve room for at least this many line-number digits. */
    minDigits: number;
    /** Reserve at least this many columns for `after` signs, even when no line has one. */
    minAfterWidth: number;
}
export declare class LineNumberRenderable extends Renderable {
    private gutter;
    private target;
    private _lineColorsGutter;
    private _lineColorsContent;
    private _lineSigns;
    private _fg;
    private _bg;
    private _layout;
    private _lineNumberOffset;
    private _hideLineNumbers;
    private _lineNumbers;
    private _isDestroying;
    private handleLineInfoChange;
    private parseLineColor;
    constructor(ctx: RenderContext, options: LineNumberOptions);
    private setTarget;
    add(child: Renderable): number;
    remove(child: BaseRenderable): void;
    destroy(): void;
    destroyRecursively(): void;
    protected destroySelf(): void;
    clearTarget(): void;
    protected renderSelf(buffer: OptimizedBuffer): void;
    set showLineNumbers(value: boolean);
    get showLineNumbers(): boolean;
    get fg(): RGBA;
    set fg(value: string | RGBA | undefined);
    get bg(): RGBA;
    set bg(value: string | RGBA | undefined);
    setLineColor(line: number, color: string | RGBA | LineColorConfig): void;
    clearLineColor(line: number): void;
    clearAllLineColors(): void;
    setLineColors(lineColors: Map<number, string | RGBA | LineColorConfig>): void;
    getLineColors(): {
        gutter: Map<number, RGBA>;
        content: Map<number, RGBA>;
    };
    setLineSign(line: number, sign: LineSign): void;
    clearLineSign(line: number): void;
    clearAllLineSigns(): void;
    setLineSigns(lineSigns: Map<number, LineSign>): void;
    getLineSigns(): Map<number, LineSign>;
    getGutterLayout(): GutterLayout;
    setGutterLayout(layout: GutterLayout): void;
    set lineNumberOffset(value: number);
    get lineNumberOffset(): number;
    setHideLineNumbers(hideLineNumbers: Set<number>): void;
    getHideLineNumbers(): Set<number>;
    setLineNumbers(lineNumbers: Map<number, number>): void;
    getLineNumbers(): Map<number, number>;
    highlightLines(startLine: number, endLine: number, color: string | RGBA | LineColorConfig): void;
    clearHighlightLines(startLine: number, endLine: number): void;
}
