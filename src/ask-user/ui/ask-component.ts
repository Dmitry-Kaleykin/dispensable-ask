import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container, type Component, CURSOR_MARKER, Editor, Key, type KeybindingsManager, Markdown,
  matchesKey, Spacer, Text, type TUI, truncateToWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { DISPENSABLE_ASK_VERSION } from "../../version";
import {
  type AskDisplayMode, type AskSingleSelectLayout, type AskUIResult,
  createFreeformResponse, createSelectionResponse,
} from "../model";
import { MultiSelectList } from "./multi-select-list";
import { WrappedSingleSelectList } from "./single-select-list";
import type { QuestionOption } from "./single-select-layout";
import {
  type AskMode, BOX_BORDER_LEFT, BOX_BORDER_OVERHEAD, BOX_BORDER_RIGHT,
  BoxBorderBottom, BoxBorderTop, CONTEXT_TOGGLE_KEYS,
  INLINE_CONTEXT_MAX_ROWS, PROMPT_SCROLL_END_KEY, PROMPT_SCROLL_HALF_PAGE_DOWN_KEY,
  PROMPT_SCROLL_HALF_PAGE_UP_KEY, PROMPT_SCROLL_HOME_KEY, PROMPT_SCROLL_PAGE_DOWN_KEY,
  PROMPT_SCROLL_PAGE_UP_KEY, type ResolvedAskShortcuts, createEditorTheme,
  formatKeyList, getOverlayMaxRenderLinesForRows, keybindingHint, literalHint,
  safeMarkdownTheme,
} from "./shared";

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between SelectList/MultiSelectList and an Editor (freeform mode).
 */
export class AskComponent extends Container {
   private question: string;
   private context?: string;
   private options: QuestionOption[];
   private allowMultiple: boolean;
   private allowFreeform: boolean;
   private allowComment: boolean;
   private displayMode: AskDisplayMode;
   private singleSelectLayout: AskSingleSelectLayout;
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private shortcuts: ResolvedAskShortcuts;
   private onDone: (result: AskUIResult | null) => void;

   private mode: AskMode = "select";
   private pendingSelections: string[] = [];
   private freeformDraft = "";
   private commentDraft = "";
   private promptScrollOffset = 0;
   private promptMaxScrollOffset = 0;
   private promptViewportRows = 0;
   private contextIsCollapsible = false;
   private contextExpanded = false;

   // Static layout components
   private titleText: Text;
   private questionText: Text;
   private contextComponent?: Component;
   private modeContainer: Container;
   private helpText: Text;

   // Mode components
   private singleSelectList?: WrappedSingleSelectList;
   private multiSelectList?: MultiSelectList;
   private editor?: Editor;

   // Focusable - propagate to Editor for IME cursor positioning
   private _focused = false;
   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      if (this.editor && (this.mode === "freeform" || this.mode === "comment")) {
         (this.editor as any).focused = value;
      }
   }

   constructor(
      question: string,
      context: string | undefined,
      options: QuestionOption[],
      allowMultiple: boolean,
      allowFreeform: boolean,
      allowComment: boolean,
      displayMode: AskDisplayMode,
      singleSelectLayout: AskSingleSelectLayout,
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      shortcuts: ResolvedAskShortcuts,
      onDone: (result: AskUIResult | null) => void,
   ) {
      super();

      this.question = question;
      this.context = context;
      this.options = options;
      this.allowMultiple = allowMultiple;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.displayMode = displayMode;
      this.singleSelectLayout = singleSelectLayout;
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.shortcuts = shortcuts;
      this.onDone = onDone;

      // Layout skeleton
      this.addChild(new BoxBorderTop(
         (s: string) => theme.fg("accent", s),
         "ask_user",
         (s: string) => theme.fg("dim", theme.bold(s)),
      ));
      this.addChild(new Spacer(1));

      this.titleText = new Text("", 1, 0);
      this.addChild(this.titleText);
      this.addChild(new Spacer(1));

      this.questionText = new Text("", 1, 0);
      this.addChild(this.questionText);

      if (this.context) {
         this.addChild(new Spacer(1));
         const mdTheme = safeMarkdownTheme();
         if (mdTheme) {
            this.contextComponent = new Markdown("", 1, 0, mdTheme);
         } else {
            this.contextComponent = new Text("", 1, 0);
         }
         this.addChild(this.contextComponent);
      }

      this.addChild(new Spacer(1));

      this.modeContainer = new Container();
      this.addChild(this.modeContainer);

      this.addChild(new Spacer(1));
      this.helpText = new Text("", 1, 0);
      this.addChild(this.helpText);

      this.addChild(new Spacer(1));
      this.addChild(new BoxBorderBottom(
         (s: string) => theme.fg("accent", s),
         `v${DISPENSABLE_ASK_VERSION}`,
         (s: string) => theme.fg("dim", s),
      ));

      this.updateStaticText();
      this.showSelectMode();
   }

   override invalidate(): void {
      super.invalidate();
      this.updateStaticText();
      this.updateHelpText();
   }

   override render(width: number): string[] {
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);

      if (this.displayMode === "overlay") {
         return this.renderOverlayLayout(width, innerWidth);
      }

      if (this.mode === "select" && !this.allowMultiple) {
         this.ensureSingleSelectList().setMaxVisibleRows(12);
      }

      return this.renderInlineLayout(width, innerWidth);
   }

   private renderInlineLayout(width: number, innerWidth: number): string[] {
      const fullContextLines = this.buildFullContextLines(innerWidth);
      this.setContextIsCollapsible(fullContextLines.length > INLINE_CONTEXT_MAX_ROWS);
      if (this.contextExpanded) {
         return this.renderOverlayLayout(width, innerWidth);
      }
      const bodyLines = [
         ...this.buildPromptLines(innerWidth, fullContextLines),
         "",
         ...this.modeContainer.render(innerWidth),
         "",
         ...this.helpText.render(innerWidth),
      ];
      return this.frameBodyLines(bodyLines, width, innerWidth);
   }

   private getOverlayMaxRenderLines(): number {
      const rows = Number.isFinite(this.tui.terminal.rows) ? Math.floor(this.tui.terminal.rows) : 24;
      return getOverlayMaxRenderLinesForRows(rows);
   }

   private renderOverlayLayout(width: number, innerWidth: number): string[] {
      const maxLines = this.getOverlayMaxRenderLines();
      if (maxLines <= 1) return [this.renderTopBorder(width)];
      if (maxLines === 2) return [this.renderTopBorder(width), this.renderBottomBorder(width)];

      const bodyCapacity = Math.max(0, maxLines - 2);
      let helpFullLines = this.helpText.render(innerWidth);
      const questionLines = this.buildQuestionLines(innerWidth);
      const fullContextLines = this.buildFullContextLines(innerWidth);
      const shouldCollapse = this.displayMode === "inline"
         ? this.contextIsCollapsible
         : this.mode === "select"
            ? this.shouldCollapseContextForOverlay(
               questionLines.length,
               fullContextLines.length,
               bodyCapacity,
               helpFullLines.length,
            )
            : this.contextIsCollapsible;
      this.setContextIsCollapsible(shouldCollapse);
      helpFullLines = this.helpText.render(innerWidth);
      const promptLines = this.buildPromptLines(innerWidth, fullContextLines);
      const helpBudget = this.getOverlayHelpBudget(bodyCapacity, helpFullLines.length);
      const contentRows = Math.max(0, bodyCapacity - helpBudget);

      let promptBudget = 0;
      let modeBudget = 0;
      let separatorRows = 0;

      if (this.mode === "select") {
         separatorRows = contentRows >= 4 ? 1 : 0;
         const promptAndModeRows = Math.max(0, contentRows - separatorRows);
         promptBudget = promptAndModeRows;

         if (promptAndModeRows > 0) {
            const promptMinRows = promptLines.length > 0 ? 1 : 0;
            const maximumModeRows = Math.max(0, promptAndModeRows - promptMinRows);
            const modeMinRows = Math.min(this.getMinimumModeRows(), maximumModeRows);
            modeBudget = Math.min(this.getPreferredModeRows(), maximumModeRows);
            modeBudget = Math.max(modeMinRows, modeBudget);
            promptBudget = promptAndModeRows - modeBudget;

            const usefulPromptTarget = this.contextIsCollapsible && !this.contextExpanded ? 3 : 2;
            const usefulPromptRows = Math.min(
               promptLines.length,
               promptAndModeRows >= modeMinRows + usefulPromptTarget ? usefulPromptTarget : promptMinRows,
            );
            if (promptBudget < usefulPromptRows && modeBudget > modeMinRows) {
               const shiftedRows = Math.min(usefulPromptRows - promptBudget, modeBudget - modeMinRows);
               modeBudget -= shiftedRows;
               promptBudget += shiftedRows;
            }
         }
      } else {
         modeBudget = Math.min(this.getPreferredModeRows(), contentRows);
         modeBudget = Math.max(Math.min(this.getMinimumModeRows(), contentRows), modeBudget);
         promptBudget = Math.max(0, contentRows - modeBudget);
         if (promptBudget > 0 && modeBudget > 0) {
            separatorRows = 1;
            promptBudget = Math.max(0, promptBudget - separatorRows);
         }
      }

      const modeLines = this.renderModeLines(innerWidth, modeBudget);
      if (modeLines.length < modeBudget) {
         promptBudget += modeBudget - modeLines.length;
      }

      const promptPaneLines = this.renderPromptPane(promptLines, promptBudget, innerWidth);
      const helpLines = this.limitLines(helpFullLines, helpBudget, innerWidth, false);
      const bodyLines = [
         ...promptPaneLines,
         ...(separatorRows > 0 && promptPaneLines.length > 0 && modeLines.length > 0 ? [""] : []),
         ...modeLines,
         ...helpLines,
      ];

      return this.frameBodyLines(bodyLines.slice(0, bodyCapacity), width, innerWidth);
   }

   private buildQuestionLines(width: number): string[] {
      return this.questionText.render(width);
   }

   private buildFullContextLines(width: number): string[] {
      if (!this.contextComponent) return [];
      return this.contextComponent.render(width);
   }

   private setContextIsCollapsible(value: boolean): void {
      if (this.contextIsCollapsible === value) return;
      this.contextIsCollapsible = value;
      if (!value) this.contextExpanded = false;
      this.updateHelpText();
   }

   private getContextToggleKey(): string {
      const reserved = new Set(
         [this.shortcuts.overlayToggle, this.shortcuts.commentToggle]
            .filter((shortcut) => !shortcut.disabled)
            .map((shortcut) => shortcut.spec),
      );
      return CONTEXT_TOGGLE_KEYS.find((key) => !reserved.has(key)) ?? CONTEXT_TOGGLE_KEYS[0]!;
   }

   private buildContextDisplayLines(fullContextLines: string[], width: number): string[] {
      if (fullContextLines.length === 0) return [];
      if (!this.contextIsCollapsible || this.contextExpanded) return fullContextLines;
      const label = `Context (${fullContextLines.length} lines) — ${this.getContextToggleKey()} expand`;
      return [truncateToWidth(this.theme.fg("dim", label), width, "")];
   }

   private buildPromptLines(width: number, fullContextLines: string[]): string[] {
      const questionLines = this.buildQuestionLines(width);
      const contextLines = this.buildContextDisplayLines(fullContextLines, width);
      const contextSeparator = this.contextIsCollapsible && !this.contextExpanded ? [] : [""];
      return [
         ...questionLines,
         ...(contextLines.length > 0 ? [...contextSeparator, ...contextLines] : []),
      ];
   }

   private shouldCollapseContextForOverlay(
      questionRows: number,
      contextRows: number,
      bodyCapacity: number,
      helpRows: number,
   ): boolean {
      if (contextRows === 0) return false;
      const helpBudget = this.getOverlayHelpBudget(bodyCapacity, helpRows);
      const contentRows = Math.max(0, bodyCapacity - helpBudget);
      const separatorRows = contentRows >= 4 ? 1 : 0;
      const promptCapacity = Math.max(
         0,
         contentRows - separatorRows - this.getMinimumModeRows(),
      );
      return questionRows + 1 + contextRows > promptCapacity;
   }

   private getOverlayHelpBudget(bodyCapacity: number, renderedHelpRows: number): number {
      if (renderedHelpRows <= 0 || bodyCapacity <= 0) return 0;
      if (bodyCapacity >= 12) return Math.min(2, renderedHelpRows);
      return 1;
   }

   private getMinimumModeRows(): number {
      if (this.mode === "freeform") return 5;
      if (this.mode === "comment") return 6;
      return 3;
   }

   private getPreferredModeRows(): number {
      if (this.mode === "freeform") return 10;
      if (this.mode === "comment") return 11;
      return 8;
   }

   private renderModeLines(width: number, budget: number): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];

      if (this.mode === "select") {
         if (this.allowMultiple) {
            this.ensureMultiSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
         } else {
            this.ensureSingleSelectList().setMaxVisibleRows(Math.max(1, safeBudget));
         }
         return this.limitLines(this.modeContainer.render(width), safeBudget, width, true);
      }

      return this.renderEditorModeLines(width, safeBudget);
   }

   private renderEditorModeLines(width: number, budget: number): string[] {
      const headerLines = this.buildEditorModeHeaderLines(width);
      const minimumEditorRows = Math.min(3, budget);
      const headerBudget = Math.max(0, budget - minimumEditorRows);
      const visibleHeaderLines = this.limitLines(headerLines, headerBudget, width, true);
      const editorBudget = Math.max(0, budget - visibleHeaderLines.length);

      return [
         ...visibleHeaderLines,
         ...this.limitEditorLines(this.ensureEditor().render(width), editorBudget, width),
      ];
   }

   private buildEditorModeHeaderLines(width: number): string[] {
      if (this.mode === "comment") {
         const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
         return [
            ...new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0).render(width),
            ...new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0).render(width),
            "",
         ];
      }

      return [
         ...new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0).render(width),
         "",
      ];
   }

   private limitEditorLines(lines: string[], budget: number, width: number): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];
      if (lines.length <= safeBudget) {
         return lines.map((line) => truncateToWidth(line, width, "", true));
      }
      if (safeBudget === 1) return [this.theme.fg("dim", "…")];

      const topBorder = truncateToWidth(lines[0] ?? "", width, "", true);
      const bottomBorder = truncateToWidth(lines[lines.length - 1] ?? "", width, "", true);
      if (safeBudget === 2) return [topBorder, bottomBorder];

      const contentLines = lines.slice(1, -1);
      const contentBudget = safeBudget - 2;
      // Locate the cursor row: prefer the zero-width CURSOR_MARKER the editor
      // emits while focused (the same mechanism pi-tui core uses for hardware
      // cursor placement), falling back to the inverse-video fake cursor.
      const cursorLineIndex = contentLines.findIndex(
         (line) => line.includes(CURSOR_MARKER) || line.includes("\x1b[7m"),
      );
      const maxStart = Math.max(0, contentLines.length - contentBudget);
      const start = cursorLineIndex >= 0
         ? Math.max(0, Math.min(cursorLineIndex - contentBudget + 1, maxStart))
         : maxStart;
      const visibleContentLines = contentLines.slice(start, start + contentBudget);
      const markedContentLines = this.applyPromptOverflowMarkers(
         visibleContentLines,
         width,
         start > 0,
         start + contentBudget < contentLines.length,
      );

      return [topBorder, ...markedContentLines, bottomBorder];
   }

   private renderPromptPane(promptLines: string[], budget: number, width: number): string[] {
      const viewportRows = Math.max(0, Math.floor(budget));
      this.promptViewportRows = viewportRows;

      if (viewportRows <= 0 || promptLines.length === 0) {
         this.promptMaxScrollOffset = 0;
         this.promptScrollOffset = 0;
         return [];
      }

      this.promptMaxScrollOffset = Math.max(0, promptLines.length - viewportRows);
      this.promptScrollOffset = Math.max(0, Math.min(this.promptScrollOffset, this.promptMaxScrollOffset));

      const visibleLines = promptLines.slice(this.promptScrollOffset, this.promptScrollOffset + viewportRows);
      const hasHiddenAbove = this.promptScrollOffset > 0;
      const hasHiddenBelow = this.promptScrollOffset + viewportRows < promptLines.length;
      return this.applyPromptOverflowMarkers(visibleLines, width, hasHiddenAbove, hasHiddenBelow);
   }

   private applyPromptOverflowMarkers(
      lines: string[],
      width: number,
      hasHiddenAbove: boolean,
      hasHiddenBelow: boolean,
   ): string[] {
      if (lines.length === 0) return lines;

      const marked = [...lines];
      if (hasHiddenAbove && hasHiddenBelow && marked.length === 1) {
         marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↕", width);
         return marked;
      }

      if (hasHiddenAbove) {
         marked[0] = this.addPromptOverflowMarker(marked[0] ?? "", "↑", width);
      }
      if (hasHiddenBelow) {
         const lastIndex = marked.length - 1;
         marked[lastIndex] = this.addPromptOverflowMarker(marked[lastIndex] ?? "", "↓", width);
      }
      return marked;
   }

   private addPromptOverflowMarker(line: string, marker: string, width: number): string {
      return truncateToWidth(`${this.theme.fg("dim", marker)} ${line}`, width, "", true);
   }

   private limitLines(lines: string[], budget: number, width: number, showOverflowMarker: boolean): string[] {
      const safeBudget = Math.max(0, Math.floor(budget));
      if (safeBudget <= 0) return [];
      if (lines.length <= safeBudget) {
         return lines.map((line) => truncateToWidth(line, width, "", true));
      }
      if (!showOverflowMarker) {
         return lines.slice(0, safeBudget).map((line) => truncateToWidth(line, width, "", true));
      }
      if (safeBudget === 1) return [this.theme.fg("dim", "…")];
      return [
         ...lines.slice(0, safeBudget - 1).map((line) => truncateToWidth(line, width, "", true)),
         this.theme.fg("dim", "…"),
      ];
   }

   private renderTopBorder(width: number): string {
      return new BoxBorderTop(
         (s: string) => this.theme.fg("accent", s),
         "ask_user",
         (s: string) => this.theme.fg("dim", this.theme.bold(s)),
      ).render(width)[0] ?? "";
   }

   private renderBottomBorder(width: number): string {
      return new BoxBorderBottom(
         (s: string) => this.theme.fg("accent", s),
         `v${DISPENSABLE_ASK_VERSION}`,
         (s: string) => this.theme.fg("dim", s),
      ).render(width)[0] ?? "";
   }

   private frameBodyLines(bodyLines: string[], width: number, innerWidth: number): string[] {
      const borderColor = (s: string) => this.theme.fg("accent", s);
      return [
         this.renderTopBorder(width),
         ...bodyLines.map((line) => {
            const padded = truncateToWidth(line, innerWidth, "", true);
            return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
         }),
         this.renderBottomBorder(width),
      ];
   }

   private frameRawLines(rawLines: string[], width: number, innerWidth: number): string[] {
      const borderColor = (s: string) => this.theme.fg("accent", s);
      return rawLines.map((line, index) => {
         if (index === 0) return this.renderTopBorder(width);
         if (index === rawLines.length - 1) return this.renderBottomBorder(width);
         const padded = truncateToWidth(line, innerWidth, "", true);
         return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
      });
   }

   private updateStaticText(): void {
      const theme = this.theme;
      const title = this.mode === "comment" ? "Optional comment" : "Question";
      this.titleText.setText(theme.fg("accent", theme.bold(title)));
      this.questionText.setText(theme.fg("text", theme.bold(this.question)));
      if (this.contextComponent && this.context) {
         if (this.contextComponent instanceof Markdown) {
            (this.contextComponent as Markdown).setText(
               `**Context:**\n${this.context}`,
            );
         } else {
            (this.contextComponent as Text).setText(
               `${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", this.context)}`,
            );
         }
      }
   }

   private updateHelpText(): void {
      const theme = this.theme;
      const overlayHint = this.displayMode === "overlay" && !this.shortcuts.overlayToggle.disabled
         ? literalHint(theme, this.shortcuts.overlayToggle.spec, "hide")
         : null;
      const promptScrollHint = this.displayMode === "overlay" || this.contextExpanded
         ? literalHint(theme, "PgUp/PgDn", "prompt")
         : null;
      const commentHint = this.allowComment && !this.shortcuts.commentToggle.disabled
         ? literalHint(theme, this.shortcuts.commentToggle.spec, "toggle context")
         : null;
      const contextHint = this.contextIsCollapsible
         ? literalHint(
            theme,
            this.getContextToggleKey(),
            this.contextExpanded ? "collapse context" : "expand context",
         )
         : null;
      if (this.mode === "freeform" || this.mode === "comment") {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            keybindingHint(theme, this.keybindings, "tui.input.submit", this.mode === "comment" ? "submit/skip" : "submit"),
            keybindingHint(theme, this.keybindings, "tui.input.newLine", "newline"),
            literalHint(theme, "esc", "back"),
            overlayHint,
            alternateCancelKeys.length > 0 ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel") : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
         return;
      }

      if (this.allowMultiple) {
         const hints = [
            literalHint(theme, "↑↓", "navigate"),
            literalHint(theme, "space", "toggle"),
            commentHint,
            contextHint,
            promptScrollHint,
            overlayHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "submit"),
            keybindingHint(theme, this.keybindings, "tui.select.cancel", "cancel"),
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      } else {
         const alternateCancelKeys = this.keybindings
            .getKeys("tui.select.cancel")
            .filter((key) => key !== "escape" && key !== "esc");
         const hints = [
            literalHint(theme, "type", "filter"),
            commentHint,
            contextHint,
            promptScrollHint,
            keybindingHint(theme, this.keybindings, "tui.editor.deleteCharBackward", "erase"),
            literalHint(theme, "↑↓", "navigate"),
            overlayHint,
            keybindingHint(theme, this.keybindings, "tui.select.confirm", "select"),
            literalHint(theme, "esc", "clear/cancel"),
            alternateCancelKeys.length > 0
               ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
               : null,
         ]
            .filter((hint): hint is string => !!hint)
            .join(" • ");
         this.helpText.setText(theme.fg("dim", hints));
      }
   }

   private ensureSingleSelectList(): WrappedSingleSelectList {
      if (this.singleSelectList) return this.singleSelectList;

      const list = new WrappedSingleSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.singleSelectLayout,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.onSubmit = (result) => this.handleSelectionSubmit([result], list.isCommentEnabled());
      list.onCancel = () => this.onDone(null);
      list.onEnterFreeform = () => this.showFreeformMode();

      this.singleSelectList = list;
      return list;
   }

   private ensureMultiSelectList(): MultiSelectList {
      if (this.multiSelectList) return this.multiSelectList;

      const list = new MultiSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.onCancel = () => this.onDone(null);
      list.onSubmit = (result) => this.handleSelectionSubmit(result, list.isCommentEnabled());
      list.onEnterFreeform = () => this.showFreeformMode();

      this.multiSelectList = list;
      return list;
   }

   private ensureEditor(): Editor {
      if (this.editor) return this.editor;
      const editor = new Editor(this.tui, createEditorTheme(this.theme));
      editor.disableSubmit = false;
      editor.onSubmit = (text: string) => {
         this.handleEditorSubmit(text);
      };
      this.editor = editor;
      return editor;
   }

   private saveEditorDraft(): void {
      if (!this.editor) return;
      const getText = (this.editor as any).getText;
      if (typeof getText !== "function") return;

      const currentText = String(getText.call(this.editor) ?? "");
      if (this.mode === "freeform") {
         this.freeformDraft = currentText;
      } else if (this.mode === "comment") {
         this.commentDraft = currentText;
      }
   }

   private setEditorText(text: string): void {
      const editor = this.ensureEditor();
      const setText = (editor as any).setText;
      if (typeof setText === "function") {
         setText.call(editor, text);
      }
   }

   private handleSelectionSubmit(selections: string[], wantsComment: boolean): void {
      if (this.allowComment && wantsComment) {
         this.pendingSelections = selections;
         this.commentDraft = "";
         this.showCommentMode();
         return;
      }

      this.onDone(createSelectionResponse(selections));
   }

   private handleEditorSubmit(text: string): void {
      if (this.mode === "freeform") {
         this.onDone(createFreeformResponse(text));
         return;
      }

      if (this.mode === "comment") {
         this.commentDraft = text;
         this.onDone(createSelectionResponse(this.pendingSelections, text));
      }
   }

   private showSelectMode(): void {
      if (this.mode === "freeform" || this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "select";
      this.pendingSelections = [];
      this.modeContainer.clear();

      if (this.allowMultiple) {
         this.modeContainer.addChild(this.ensureMultiSelectList());
      } else {
         this.modeContainer.addChild(this.ensureSingleSelectList());
      }

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showFreeformMode(): void {
      if (this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "freeform";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.freeformDraft);
      (editor as any).focused = this._focused;

      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showCommentMode(): void {
      if (this.mode === "freeform") {
         this.saveEditorDraft();
      }

      this.mode = "comment";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.commentDraft);
      (editor as any).focused = this._focused;

      const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0));
      this.modeContainer.addChild(new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private toggleContext(): boolean {
      if (this.mode !== "select" || !this.contextIsCollapsible) return false;
      this.contextExpanded = !this.contextExpanded;
      this.promptScrollOffset = 0;
      this.invalidate();
      this.tui.requestRender();
      return true;
   }

   private setPromptScrollOffset(nextOffset: number): boolean {
      if (this.displayMode !== "overlay" && !this.contextExpanded) return false;
      if (this.promptMaxScrollOffset <= 0) return false;
      const clamped = Math.max(0, Math.min(Math.floor(nextOffset), this.promptMaxScrollOffset));
      const changed = clamped !== this.promptScrollOffset;
      this.promptScrollOffset = clamped;
      return changed;
   }

   private handlePromptScrollInput(data: string): boolean {
      if (this.displayMode !== "overlay" && !this.contextExpanded) return false;
      if (this.promptMaxScrollOffset <= 0) return false;
      // Prompt scrolling is select-mode only: in freeform/comment modes the
      // editor owns PageUp/PageDown (tui.editor.pageUp/pageDown) for paging
      // through long input, so intercepting them here would steal editor keys.
      if (this.mode !== "select") return false;

      const pageRows = Math.max(1, this.promptViewportRows - 1);
      const halfPageRows = Math.max(1, Math.floor(this.promptViewportRows / 2));
      let handled = false;

      if (matchesKey(data, PROMPT_SCROLL_PAGE_UP_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset - pageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_PAGE_DOWN_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset + pageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_HOME_KEY)) {
         handled = true;
         this.setPromptScrollOffset(0);
      } else if (matchesKey(data, PROMPT_SCROLL_END_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptMaxScrollOffset);
      } else if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_UP_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset - halfPageRows);
      } else if (matchesKey(data, PROMPT_SCROLL_HALF_PAGE_DOWN_KEY)) {
         handled = true;
         this.setPromptScrollOffset(this.promptScrollOffset + halfPageRows);
      }

      return handled;
   }

   handleInput(data: string): void {
      if (matchesKey(data, this.getContextToggleKey() as any) && this.toggleContext()) {
         return;
      }
      if (this.handlePromptScrollInput(data)) {
         this.tui.requestRender();
         return;
      }
      if (this.mode === "freeform" || this.mode === "comment") {
         if (matchesKey(data, Key.escape)) {
            this.showSelectMode();
            return;
         }

         if (this.keybindings.matches(data, "tui.select.cancel")) {
            this.onDone(null);
            return;
         }

         this.ensureEditor().handleInput(data);
         this.tui.requestRender();
         return;
      }

      if (this.allowMultiple) {
         this.ensureMultiSelectList().handleInput?.(data);
         this.tui.requestRender();
         return;
      }

      this.ensureSingleSelectList().handleInput?.(data);
      this.tui.requestRender();
   }
}
