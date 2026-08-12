import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component, CURSOR_MARKER, decodeKittyPrintable, fuzzyFilter, Key, Markdown,
  type KeybindingsManager, matchesKey, truncateToWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AskSingleSelectLayout } from "../model";
import { renderSingleSelectRows, type QuestionOption } from "./single-select-layout";
import {
  COMMENT_TOGGLE_LABEL, type ResolvedShortcut,
  SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH, SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH,
  SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH, SINGLE_SELECT_SPLIT_PANE_SEPARATOR,
  matchesSelectDown, matchesSelectUp, safeMarkdownTheme,
} from "./shared";

export class WrappedSingleSelectList implements Component {
   private options: QuestionOption[];
   private allowFreeform: boolean;
   private allowComment: boolean;
   private theme: Theme;
   private singleSelectLayout: AskSingleSelectLayout;
   private keybindings: KeybindingsManager;
   private commentToggle: ResolvedShortcut;
   private selectedIndex = 0;
   private searchQuery = "";
   private commentEnabled = false;
   private maxVisibleRows = 12;
   private cachedWidth?: number;
   private cachedLines?: string[];

   public onCancel?: () => void;
   public onSubmit?: (result: string) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      allowFreeform: boolean,
      allowComment: boolean,
      theme: Theme,
      singleSelectLayout: AskSingleSelectLayout,
      keybindings: KeybindingsManager,
      commentToggle: ResolvedShortcut,
   ) {
      this.options = options;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.theme = theme;
      this.singleSelectLayout = singleSelectLayout;
      this.keybindings = keybindings;
      this.commentToggle = commentToggle;
   }

   public isCommentEnabled(): boolean {
      return this.commentEnabled;
   }

   setMaxVisibleRows(rows: number): void {
      const next = Math.max(1, Math.floor(rows));
      if (next !== this.maxVisibleRows) {
         this.maxVisibleRows = next;
         this.invalidate();
      }
   }

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   private getFilteredOptions(): QuestionOption[] {
      return fuzzyFilter(this.options, this.searchQuery, (option) => `${option.title} ${option.description ?? ""}`);
   }

   private getItemCount(filteredOptions: QuestionOption[]): number {
      return filteredOptions.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
   }

   private isCommentToggleRow(index: number, filteredOptions: QuestionOption[]): boolean {
      return this.allowComment && index === filteredOptions.length;
   }

   private isFreeformRow(index: number, filteredOptions: QuestionOption[]): boolean {
      return this.allowFreeform && index === filteredOptions.length + (this.allowComment ? 1 : 0);
   }

   private toggleComment(): void {
      if (!this.allowComment) return;
      this.commentEnabled = !this.commentEnabled;
      this.invalidate();
   }

   private setSearchQuery(query: string): void {
      this.searchQuery = query;
      this.selectedIndex = 0;
      this.invalidate();
   }

   private popSearchCharacter(): void {
      if (!this.searchQuery) return;
      const characters = [...this.searchQuery];
      characters.pop();
      this.setSearchQuery(characters.join(""));
   }

   private getPrintableInput(data: string): string | null {
      const kittyPrintable = decodeKittyPrintable(data);
      if (kittyPrintable !== undefined) return kittyPrintable;

      const characters = [...data];
      if (characters.length !== 1) return null;

      const [character] = characters;
      if (!character) return null;

      const code = character.charCodeAt(0);
      if (code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
         return null;
      }

      return character;
   }

   private styleListLine(line: string, width: number, isSelected: boolean): string {
      const trimmed = line.trim();

      if (trimmed.startsWith("(")) {
         return truncateToWidth(this.theme.fg("dim", line), width, "");
      }

      if (isSelected) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      if (line.startsWith("      ")) {
         return truncateToWidth(this.theme.fg("muted", line), width, "");
      }

      if (line.startsWith("→")) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      return truncateToWidth(this.theme.fg("text", line), width, "");
   }

   private getSplitPaneWidths(width: number): { left: number; right: number } | null {
      if (this.singleSelectLayout === "list") return null;
      if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

      const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
      if (availableWidth < SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH + SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) {
         return null;
      }

      const preferredLeftWidth = Math.floor(availableWidth * 0.42);
      const left = Math.max(
         SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
         Math.min(preferredLeftWidth, availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH),
      );
      const right = availableWidth - left;

      if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
      return { left, right };
   }

   private buildListLines(width: number, filteredOptions: QuestionOption[], hideDescriptions = false): string[] {
      const lines: string[] = [];
      const count = this.getItemCount(filteredOptions);
      const searchValue = this.searchQuery ? this.theme.fg("text", this.searchQuery) : this.theme.fg("dim", "type to filter");
      lines.push(truncateToWidth(`${this.theme.fg("accent", "Filter:")} ${searchValue}`, width, ""));

      if (this.searchQuery && filteredOptions.length === 0) {
         lines.push(truncateToWidth(this.theme.fg("warning", "No matching options"), width, ""));
      }

      if (count === 0) {
         if (!this.searchQuery) {
            lines.push(truncateToWidth(this.theme.fg("warning", "No options"), width, ""));
         }
         return lines.slice(0, this.maxVisibleRows);
      }

      const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
      const optionRows = renderSingleSelectRows({
         options: filteredOptions,
         selectedIndex: this.selectedIndex,
         width,
         allowFreeform: this.allowFreeform,
         allowComment: this.allowComment,
         commentEnabled: this.commentEnabled,
         maxRows,
         hideDescriptions,
      });
      const optionLines = optionRows.map((row) => this.styleListLine(row.line, width, row.selected));

      lines.push(...optionLines);
      return lines.slice(0, this.maxVisibleRows);
   }

   private buildPreviewLines(width: number, filteredOptions: QuestionOption[], maxLines: number): string[] {
      if (maxLines <= 0) return [];

      const mdTheme = safeMarkdownTheme();

      let md = "";

      if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
         md += "## Additional context\n\n";
         md += `Currently: **${this.commentEnabled ? "Enabled" : "Disabled"}**\n\n`;
         md += "Turn this on when the selected option needs extra explanation before the tool submits.\n";
      } else if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
         md += "## Custom response\n\n";
         md += "Open the editor to write **any** answer.\n\n";
         md += "*Use this when none of the listed options fit.*\n";
         if (this.searchQuery) {
            md += `\n> Current filter: \`${this.searchQuery}\`\n`;
         }
      } else {
         const selected = filteredOptions[this.selectedIndex];
         if (!selected) {
            md += "*No option selected*\n";
         } else {
            md += `## ${selected.title}\n\n`;
            if (selected.description?.trim()) {
               md += `${selected.description}\n`;
            } else {
               md += "*No additional details provided for this option.*\n";
            }
            md += `\n---\n\nPress \`Enter\` to select this option.\n`;
            if (this.searchQuery) {
               md += `\n> Filter: \`${this.searchQuery}\`\n`;
            }
         }
      }

      let lines: string[];
      if (mdTheme) {
         const mdComponent = new Markdown(md.trim(), 0, 0, mdTheme);
         lines = mdComponent.render(width);
      } else {
         lines = [];
         for (const line of wrapTextWithAnsi(md.trim(), Math.max(10, width))) {
            lines.push(truncateToWidth(line, width, ""));
         }
      }

      while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
         lines.pop();
      }

      if (lines.length <= maxLines) return lines;
      if (maxLines === 1) return [truncateToWidth(this.theme.fg("dim", "…"), width, "")];

      const visibleLines = lines.slice(0, maxLines - 1);
      visibleLines.push(truncateToWidth(this.theme.fg("dim", "…"), width, ""));
      return visibleLines;
   }

   handleInput(data: string): void {
      if (this.searchQuery && matchesKey(data, Key.escape)) {
         this.setSearchQuery("");
         return;
      }

      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
         this.toggleComment();
         return;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);

      if (matchesSelectUp(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
         this.invalidate();
         return;
      }

      if (matchesSelectDown(data, this.keybindings) && count > 0) {
         this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
         this.invalidate();
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch && filteredOptions.length > 0) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < filteredOptions.length) {
            this.selectedIndex = idx;
            this.invalidate();
            return;
         }
      }

      if (matchesKey(data, Key.space) && count > 0 && this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
         this.toggleComment();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm") && count > 0) {
         if (this.isCommentToggleRow(this.selectedIndex, filteredOptions)) {
            this.toggleComment();
            return;
         }
         if (this.isFreeformRow(this.selectedIndex, filteredOptions)) {
            this.onEnterFreeform?.();
            return;
         }

         const result = filteredOptions[this.selectedIndex]?.title;
         if (result) this.onSubmit?.(result);
         else this.onCancel?.();
         return;
      }

      if (this.keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
         this.popSearchCharacter();
         return;
      }

      const printableInput = this.getPrintableInput(data);
      if (printableInput) {
         this.setSearchQuery(this.searchQuery + printableInput);
      }
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getItemCount(filteredOptions);
      this.selectedIndex = count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

      const splitPane = this.getSplitPaneWidths(width);
      let lines: string[];

      if (!splitPane) {
         lines = this.buildListLines(width, filteredOptions);
      } else {
         const listLines = this.buildListLines(splitPane.left, filteredOptions, true);
         const previewLines = this.buildPreviewLines(splitPane.right, filteredOptions, this.maxVisibleRows);
         const rowCount = Math.min(this.maxVisibleRows, Math.max(listLines.length, previewLines.length));
         const separator = this.theme.fg("dim", SINGLE_SELECT_SPLIT_PANE_SEPARATOR);
         lines = Array.from({ length: rowCount }, (_, index) => {
            const left = truncateToWidth(listLines[index] ?? "", splitPane.left, "", true);
            const right = truncateToWidth(previewLines[index] ?? "", splitPane.right, "");
            return `${left}${separator}${right}`;
         });
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}
