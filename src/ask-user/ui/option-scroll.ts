import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

/** A viewport for the highlighted option, independent of prompt scrolling. */
export class OptionScroll {
   private offset = 0;
   private maxOffset = 0;
   private pageRows = 1;

   reset(): void {
      this.offset = 0;
      this.maxOffset = 0;
   }

   handleInput(data: string): boolean {
      let delta: number;
      // Use unmodified keys: some terminals send Shift+Up/Down as plain
      // Up/Down, making those combinations indistinguishable from navigation.
      if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("up"))) delta = -1;
      else if (matchesKey(data, Key.right) || matchesKey(data, Key.shift("down"))) delta = 1;
      else if (matchesKey(data, Key.shift("pageUp"))) delta = -this.pageRows;
      else if (matchesKey(data, Key.shift("pageDown"))) delta = this.pageRows;
      else return false;

      this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset));
      return true;
   }

   render(lines: string[], maxRows: number, width: number): string[] {
      const rows = Math.max(1, Math.floor(maxRows));
      const overflows = lines.length > rows;
      // Keep at least one content row, even in a very short terminal.
      const contentRows = overflows && rows > 1 ? rows - 1 : rows;
      this.maxOffset = overflows ? Math.max(0, lines.length - contentRows) : 0;
      this.offset = Math.min(this.offset, this.maxOffset);
      this.pageRows = Math.max(1, contentRows - 1);
      const visible = lines.slice(this.offset, this.offset + contentRows);

      if (overflows && rows > 1) {
         const direction = this.offset === 0 ? "↓" : this.offset === this.maxOffset ? "↑" : "↕";
         visible.push(truncateToWidth(
            `${direction} ←/→ scroll · ${this.offset + 1}–${this.offset + visible.length}/${lines.length}`,
            width, "",
         ));
      }
      return visible;
   }
}
