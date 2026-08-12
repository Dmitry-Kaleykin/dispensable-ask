import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component, Key, type KeybindingsManager, matchesKey,
  truncateToWidth, wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { QuestionOption } from "./single-select-layout";
import {
  COMMENT_TOGGLE_LABEL, type ResolvedShortcut, matchesSelectDown, matchesSelectUp,
} from "./shared";

export class MultiSelectList implements Component {
   private options: QuestionOption[];
   private allowFreeform: boolean;
   private allowComment: boolean;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private commentToggle: ResolvedShortcut;
   private selectedIndex = 0;
   private checked = new Set<number>();
   private commentEnabled = false;
   private maxVisibleRows = 10;
   private cachedWidth?: number;
   private cachedLines?: string[];

   public onCancel?: () => void;
   public onSubmit?: (result: string[]) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      allowFreeform: boolean,
      allowComment: boolean,
      theme: Theme,
      keybindings: KeybindingsManager,
      commentToggle: ResolvedShortcut,
   ) {
      this.options = options;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.theme = theme;
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

   private getItemCount(): number {
      return this.options.length + (this.allowComment ? 1 : 0) + (this.allowFreeform ? 1 : 0);
   }

   private getCommentToggleIndex(): number | null {
      return this.allowComment ? this.options.length : null;
   }

   private getFreeformIndex(): number {
      return this.options.length + (this.allowComment ? 1 : 0);
   }

   private isCommentToggleRow(index: number): boolean {
      const toggleIndex = this.getCommentToggleIndex();
      return toggleIndex !== null && index === toggleIndex;
   }

   private isFreeformRow(index: number): boolean {
      return this.allowFreeform && index === this.getFreeformIndex();
   }

   private toggle(index: number): void {
      if (index < 0 || index >= this.options.length) return;
      if (this.checked.has(index)) this.checked.delete(index);
      else this.checked.add(index);
   }

   private toggleComment(): void {
      if (!this.allowComment) return;
      this.commentEnabled = !this.commentEnabled;
      this.invalidate();
   }

   handleInput(data: string): void {
      if (this.keybindings.matches(data, "tui.select.cancel")) {
         this.onCancel?.();
         return;
      }

      const count = this.getItemCount();
      if (count === 0) {
         this.onCancel?.();
         return;
      }

      if (this.allowComment && !this.commentToggle.disabled && this.commentToggle.matches(data)) {
         this.toggleComment();
         return;
      }

      if (matchesSelectUp(data, this.keybindings)) {
         this.selectedIndex = this.selectedIndex === 0 ? count - 1 : this.selectedIndex - 1;
         this.invalidate();
         return;
      }

      if (matchesSelectDown(data, this.keybindings)) {
         this.selectedIndex = this.selectedIndex === count - 1 ? 0 : this.selectedIndex + 1;
         this.invalidate();
         return;
      }

      const numMatch = data.match(/^[1-9]$/);
      if (numMatch) {
         const idx = Number.parseInt(numMatch[0], 10) - 1;
         if (idx >= 0 && idx < this.options.length) {
            this.toggle(idx);
            this.selectedIndex = Math.min(idx, count - 1);
            this.invalidate();
         }
         return;
      }

      if (matchesKey(data, Key.space)) {
         if (this.isCommentToggleRow(this.selectedIndex)) {
            this.toggleComment();
            return;
         }
         if (this.isFreeformRow(this.selectedIndex)) {
            this.onEnterFreeform?.();
            return;
         }
         this.toggle(this.selectedIndex);
         this.invalidate();
         return;
      }

      if (this.keybindings.matches(data, "tui.select.confirm")) {
         if (this.isCommentToggleRow(this.selectedIndex)) {
            this.toggleComment();
            return;
         }
         if (this.isFreeformRow(this.selectedIndex)) {
            this.onEnterFreeform?.();
            return;
         }

         const selectedTitles = Array.from(this.checked)
            .sort((a, b) => a - b)
            .map((i) => this.options[i]?.title)
            .filter((t): t is string => !!t);

         const fallback = this.options[this.selectedIndex]?.title;
         const result = selectedTitles.length > 0 ? selectedTitles : fallback ? [fallback] : [];

         if (result.length > 0) this.onSubmit?.(result);
         else this.onCancel?.();
      }
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const theme = this.theme;
      const count = this.getItemCount();

      if (count === 0) {
         this.cachedLines = [theme.fg("warning", "No options")];
         this.cachedWidth = width;
         return this.cachedLines;
      }

      const blocks: string[][] = [];

      for (let i = 0; i < count; i++) {
         const isSelected = i === this.selectedIndex;
         const prefix = isSelected ? theme.fg("accent", "→") : " ";
         const block: string[] = [];

         if (this.isCommentToggleRow(i)) {
            const checkbox = this.commentEnabled ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
            const label = isSelected
               ? theme.fg("accent", theme.bold(COMMENT_TOGGLE_LABEL))
               : theme.fg("text", theme.bold(COMMENT_TOGGLE_LABEL));
            block.push(truncateToWidth(`${prefix}   ${checkbox} ${label}`, width, ""));
            blocks.push(block);
            continue;
         }

         if (this.isFreeformRow(i)) {
            const label = theme.fg("text", theme.bold("Type something."));
            const desc = theme.fg("muted", "Enter a custom response");
            const line = `${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`;
            block.push(truncateToWidth(line, width, ""));
            blocks.push(block);
            continue;
         }

         const option = this.options[i]!;

         const checkbox = this.checked.has(i) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
         const num = theme.fg("dim", `${i + 1}.`);
         const title = isSelected
            ? theme.fg("accent", theme.bold(option.title))
            : theme.fg("text", theme.bold(option.title));

         const firstLine = `${prefix} ${num} ${checkbox} ${title}`;
         block.push(truncateToWidth(firstLine, width, ""));

         if (option.description) {
            const indent = "      ";
            const wrapWidth = Math.max(10, width - indent.length);
            const wrapped = wrapTextWithAnsi(option.description, wrapWidth);
            for (const w of wrapped) {
               block.push(truncateToWidth(indent + theme.fg("muted", w), width, ""));
            }
         }

         blocks.push(block);
      }

      const maxRows = this.maxVisibleRows;
      const totalRows = blocks.reduce((sum, block) => sum + block.length, 0);
      let lines: string[];

      if (totalRows <= maxRows) {
         lines = blocks.flat();
      } else {
         const availableRows = maxRows > 1 ? maxRows - 1 : 1;
         const selectedBlock = blocks[this.selectedIndex] ?? blocks[0] ?? [];

         if (selectedBlock.length >= availableRows) {
            lines = selectedBlock.slice(0, availableRows);
         } else {
            let startIndex = this.selectedIndex;
            let endIndex = this.selectedIndex + 1;
            let usedRows = selectedBlock.length;

            while (true) {
               const nextBlock = blocks[endIndex];
               if (nextBlock && usedRows + nextBlock.length <= availableRows) {
                  usedRows += nextBlock.length;
                  endIndex += 1;
                  continue;
               }

               const previousBlock = blocks[startIndex - 1];
               if (previousBlock && usedRows + previousBlock.length <= availableRows) {
                  startIndex -= 1;
                  usedRows += previousBlock.length;
                  continue;
               }

               break;
            }

            lines = blocks.slice(startIndex, endIndex).flat();
         }

         if (maxRows > 1) {
            lines.push(theme.fg("dim", truncateToWidth(`  (${this.selectedIndex + 1}/${count})`, width, "")));
         }
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}
