import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { AskComponent } from "./src/ask-user/ui/ask-component";
import { MultiSelectList } from "./src/ask-user/ui/multi-select-list";
import { WrappedSingleSelectList } from "./src/ask-user/ui/single-select-list";
import { resolveShortcut } from "./src/ask-user/ui/shared";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keybindings = getKeybindings();
const commentToggle = resolveShortcut(undefined, undefined, "ctrl+g");
const description = Array.from({ length: 35 }, (_, i) => `Detail-${i.toString().padStart(2, "0")} text`).join("\n");
const options = [
   { title: "First option", description },
   { title: "Second option", description: "Second details" },
];
const shiftDown = "\x1b[1;2B";
const shiftUp = "\x1b[1;2A";
const shiftPageDown = "\x1b[6;2~";
const shiftPageUp = "\x1b[5;2~";

function createList(kind: "list" | "preview" | "multi", items = options) {
   return kind === "multi"
      ? new MultiSelectList(items, true, true, theme, keybindings, commentToggle)
      : new WrappedSingleSelectList(items, true, true, theme, kind === "list" ? "list" : "auto", keybindings, commentToggle);
}

for (const kind of ["list", "preview", "multi"] as const) {
   describe(`${kind} option scrolling`, () => {
      const width = kind === "preview" ? 100 : 40;
      it("makes every description line reachable without changing the selection", () => {
         const list = createList(kind);
         const submit = vi.fn();
         list.onSubmit = submit;
         list.setMaxVisibleRows(8);
         let lines = list.render(width);
         expect(lines.join("\n")).toContain("Shift+↑↓");
         expect(lines.join("\n")).not.toContain("Detail-34");
         const seen = new Set<number>();
         for (let step = 0; step < 100; step++) {
            for (const match of lines.join("\n").matchAll(/Detail-(\d+)/g)) seen.add(Number(match[1]));
            expect(lines.length).toBeLessThanOrEqual(8);
            expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
            list.handleInput(shiftDown);
            lines = list.render(width);
         }
         expect(seen.size).toBe(35);
         expect(lines.join("\n")).toContain("Detail-34");
         list.handleInput("\r");
         expect(submit).toHaveBeenCalledWith(kind === "multi" ? ["First option"] : "First option");
      });

      it("supports paging, scrolling back, and resetting on navigation", () => {
         const list = createList(kind);
         list.setMaxVisibleRows(8);
         const first = list.render(width);
         list.handleInput(shiftPageDown);
         expect(list.render(width)).not.toEqual(first);
         list.handleInput(shiftPageUp);
         expect(list.render(width)).toEqual(first);
         list.handleInput(shiftUp);
         expect(list.render(width)).toEqual(first);
         list.handleInput(shiftPageDown);
         list.render(width);
         list.handleInput("\x1b[B");
         expect(list.render(width).join("\n")).toContain("Second details");
         list.handleInput("\x1b[A");
         expect(list.render(width)).toEqual(first);
      });

      it("clamps scrolling after resize and preserves Unicode text", () => {
         const list = createList(kind, [{ title: "Title", description: "漢字🙂".repeat(45) + " END" }]);
         list.setMaxVisibleRows(7);
         let content = "";
         for (let i = 0; i < 100; i++) {
            const lines = list.render(width);
            expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
            content += lines.join("\n");
            list.handleInput(shiftDown);
         }
         expect(content).toContain("END");
         list.setMaxVisibleRows(100);
         expect(list.render(160).join("\n")).toContain("Title");
         expect(list.render(160).join("\n")).not.toContain("Shift+↑↓");
      });
   });
}

it("resets the preview after filtering while scrolled", () => {
   const list = createList("preview");
   list.setMaxVisibleRows(6);
   list.render(100);
   list.handleInput(shiftPageDown);
   list.render(100);
   list.handleInput("S");
   expect(list.render(100).join("\n")).toContain("Second details");
   list.handleInput("\x1b");
   expect(list.render(100).join("\n")).toContain("First option");
});

it.each([1, 2, 3])("keeps content reachable with only %i rows", (rows) => {
   for (const kind of ["list", "preview", "multi"] as const) {
      const list = createList(kind);
      list.setMaxVisibleRows(rows);
      let seen = "";
      for (let i = 0; i < 100; i++) {
         const lines = list.render(100);
         expect(lines.length).toBeLessThanOrEqual(rows);
         seen += lines.join("\n");
         list.handleInput(shiftDown);
      }
      expect(seen).toContain("Detail-34");
   }
});

it.each([
   [false, "overlay", 48, 16], [false, "overlay", 110, 24],
   [true, "overlay", 48, 16], [false, "inline", 48, 24], [true, "inline", 48, 24],
] as const)("routes option scrolling through the question UI (multi=%s, %s, %ix%i)", (multi, mode, width, rows) => {
   const onDone = vi.fn();
   const onActivity = vi.fn();
   const component = new AskComponent(
      "Which option?", description, options, multi, true, true, mode, "auto",
      { terminal: { rows }, requestRender: vi.fn() } as unknown as TUI,
      theme, keybindings, { commentToggle, overlayToggle: resolveShortcut(null, undefined, "alt+o") },
      onDone, onActivity,
   );
   let seen = "";
   for (let i = 0; i < 100; i++) {
      const lines = component.render(width);
      if (mode === "overlay") expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.85));
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      seen += lines.join("\n");
      component.handleInput(shiftDown);
   }
   expect(seen).toContain("Detail-34");
   expect(onDone).not.toHaveBeenCalled();
   expect(onActivity).toHaveBeenCalledTimes(100);
   component.handleInput("\r");
   expect(onDone).toHaveBeenCalledWith({ kind: "selection", selections: ["First option"] });
});

for (const kind of ["list", "multi"] as const) {
   it(`wraps every character of long Unicode titles and descriptions (${kind})`, () => {
      const title = "Long-title-漢字🙂".repeat(5);
      const detail = "Long-description-漢字🙂".repeat(5);
      const list = createList(kind, [{ title, description: detail }]);
      list.setMaxVisibleRows(100);
      const lines = list.render(30);
      expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
      const compact = lines.join("").replace(/\s/g, "");
      expect(compact).toContain(title);
      expect(compact).toContain(detail);
   });
}

it("scrolls the rendered Markdown preview to its final paragraph", () => {
   initTheme("dark", false);
   const list = createList("preview", [{
      title: "Markdown option",
      description: Array.from({ length: 25 }, (_, i) => `**Paragraph ${i}** with detail.\n\n`).join("") + "FINAL PARAGRAPH",
   }]);
   list.setMaxVisibleRows(8);
   let seen = "";
   for (let i = 0; i < 100; i++) {
      const lines = list.render(100);
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
      seen += lines.join("\n");
      list.handleInput(shiftDown);
   }
   expect(seen).toContain("FINAL PARAGRAPH");
});
