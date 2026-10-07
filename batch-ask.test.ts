import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { normalizeQuestions } from "./src/ask-user/model";
import { BatchAskComponent } from "./src/ask-user/ui/batch-ask-component";
import { resolveShortcut } from "./src/ask-user/ui/shared";
import { askBatchViaDialogs } from "./src/ask-user/dialogs";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const next = "\x0e";
const prev = "\x10";
const down = "\x1b[B";
const enter = "\r";
const esc = "\x1b";
const yesNo = [{ title: "Yes" }, { title: "No" }];

beforeAll(() => initTheme("dark", false));

function createUI(input: unknown, mode: "overlay" | "inline" = "overlay", rows = 24) {
   const done = vi.fn();
   const activity = vi.fn();
   const ui = new BatchAskComponent(
      normalizeQuestions(input), mode, "auto",
      { terminal: { rows }, requestRender: vi.fn() } as unknown as TUI,
      theme, getKeybindings(), {
         overlayToggle: resolveShortcut(null, undefined, "alt+o"),
         commentToggle: resolveShortcut(undefined, undefined, "ctrl+g"),
      }, done, activity,
   );
   ui.focused = true;
   return { ui, done, activity, text: (width = 100) => ui.render(width).join("\n") };
}

describe("batch question window", () => {
   it("reviews and edits answers, returning one ordered batch only after final submission", () => {
      const { ui, done, text } = createUI([{ question: "First?", options: yesNo }, { question: "Second?", options: yesNo }]);
      expect(text()).toContain("Question 1/2");
      ui.handleInput(enter);
      expect(text()).toContain("Question 2/2");
      expect(done).not.toHaveBeenCalled();
      ui.handleInput(down);
      ui.handleInput(enter);
      expect(text()).toContain("Review answers (2/2 answered)");
      expect(done).not.toHaveBeenCalled();
      ui.handleInput("1"); // Numeric shortcuts match the original question numbers.
      ui.handleInput(enter);
      expect(text()).toContain("Question 1/2");
      ui.handleInput(down);
      ui.handleInput(enter);
      expect(text()).toContain("Review answers (2/2 answered)");
      ui.handleInput(enter);
      expect(done).toHaveBeenCalledExactlyOnceWith({ answers: [
         { index: 1, question: "First?", response: { kind: "selection", selections: ["No"] } },
         { index: 2, question: "Second?", response: { kind: "selection", selections: ["No"] } },
      ] });
      ui.handleInput(enter);
      expect(done).toHaveBeenCalledOnce();
   });

   it("preserves unsent freeform drafts and submitted editor text across pages and review", () => {
      const { ui, done, text } = createUI([{ question: "Describe it?" }, { question: "Other?", options: yesNo }]);
      ui.handleInput("draft");
      ui.handleInput(next);
      ui.handleInput(prev);
      expect(text()).toContain("draft");
      ui.handleInput(" revised");
      ui.handleInput(enter);
      ui.handleInput(enter);
      expect(text()).toContain("Review answers (2/2 answered)");
      ui.handleInput(down);
      ui.handleInput(enter);
      expect(text()).toContain("draft revised");
      ui.handleInput(" again");
      ui.handleInput(next);
      ui.handleInput(next);
      ui.handleInput(enter);
      expect(done.mock.calls[0][0].answers[0].response).toEqual({ kind: "freeform", text: "draft revised again" });
   });

   it("preserves multi-selection and optional comments, including edits made with page shortcuts", () => {
      const { ui, done, text } = createUI([
         { question: "Choose?", options: yesNo, allowMultiple: true, allowComment: true },
         { question: "Other?", options: yesNo },
      ]);
      ui.handleInput(" ");
      ui.handleInput(down);
      ui.handleInput(" ");
      ui.handleInput("\x07"); // Ctrl+G enables the optional comment.
      ui.handleInput(enter);
      ui.handleInput("detail");
      ui.handleInput(next);
      ui.handleInput(prev);
      expect(text()).toContain("detail");
      expect(text()).toContain("Yes, No");
      ui.handleInput(" updated");
      ui.handleInput(enter);
      ui.handleInput(enter);
      ui.handleInput(enter);
      expect(done.mock.calls[0][0].answers[0].response).toEqual({ kind: "selection", selections: ["Yes", "No"], comment: "detail updated" });
   });

   it("blocks submission of unanswered questions and does not interpret a highlighted default as an answer", () => {
      const { ui, done, text } = createUI([{ question: "First?", options: yesNo }, { question: "Second?", options: yesNo }]);
      ui.handleInput(next);
      ui.handleInput(next);
      expect(text()).toContain("Review answers (0/2 answered)");
      ui.handleInput(enter);
      expect(text()).toContain("Question 1/2");
      expect(done).not.toHaveBeenCalled();
   });

   it("does not finish on an empty freeform answer", () => {
      const { ui, done, text } = createUI([{ question: "Describe?" }]);
      ui.handleInput(enter);
      expect(text()).toContain("Question 1/1");
      expect(done).not.toHaveBeenCalled();
      ui.handleInput(next);
      expect(text()).toContain("Review answers (0/1 answered)");
   });

   it("cancels a batch with previously saved answers without exposing them", () => {
      const { ui, done } = createUI([{ question: "First?", options: yesNo }, { question: "Second?", options: yesNo }]);
      ui.handleInput(enter);
      ui.handleInput(esc);
      expect(done).toHaveBeenCalledExactlyOnceWith(null);
   });

   it.each(["overlay", "inline"] as const)("keeps option scrolling and navigation distinct in %s mode", (mode) => {
      const description = Array.from({ length: 30 }, (_, index) => `Detail ${index}`).join("\n");
      const { ui, text, activity } = createUI([{ question: "First?", options: [{ title: "Long", description }] }, { question: "Second?" }], mode);
      for (let index = 0; index < 35; index++) { ui.render(60); ui.handleInput("\x1b[C"); }
      expect(text(60)).toContain("Question 1/2");
      expect(text(60)).toContain("Detail 29");
      ui.handleInput(next);
      expect(text(60)).toContain("Question 2/2");
      ui.handleInput(prev);
      expect(text(60)).toContain("Detail 29");
      expect(activity).toHaveBeenCalledTimes(37);
   });

   it.each([[40, 16], [80, 24], [110, 30]])("fits questions and review after resizing to %ix%i", (width, rows) => {
      const { ui } = createUI([{ question: "漢字🙂".repeat(30), options: yesNo }, { question: "Text?" }], "overlay", rows);
      for (const input of ["", next, next, prev]) {
         if (input) ui.handleInput(input);
         ui.setRemainingIdleSeconds(15);
         const lines = ui.render(width);
         expect(lines.length).toBeLessThanOrEqual(Math.floor(rows * 0.85));
         expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
   });
});

describe("batch dialogs", () => {
   it("collects mixed answers and lets the user edit them from review before submitting", async () => {
      const ui = {
         input: vi.fn().mockResolvedValueOnce("Initial").mockResolvedValueOnce("Edited"),
         select: vi.fn().mockResolvedValueOnce("2. No").mockResolvedValueOnce("1. Edit: Describe?").mockResolvedValueOnce("Submit all answers"),
      };
      const result = await askBatchViaDialogs(ui, normalizeQuestions([{ question: "Describe?" }, { question: "Choice?", options: yesNo }]), undefined, vi.fn());
      expect(result?.answers.map((answer) => answer.response)).toEqual([{ kind: "freeform", text: "Edited" }, { kind: "selection", selections: ["No"] }]);
      expect(ui.input.mock.calls[1][0]).toContain("Current answer: Initial");
   });

   it("discards earlier answers if the user cancels an optional comment", async () => {
      const ui = { input: vi.fn().mockResolvedValueOnce("First").mockResolvedValueOnce(undefined), select: vi.fn().mockResolvedValue("1. Yes") };
      const result = await askBatchViaDialogs(ui, normalizeQuestions([{ question: "Text?" }, { question: "Choice?", options: yesNo, allowComment: true }]), undefined, vi.fn());
      expect(result).toBeNull();
      expect(ui.select).toHaveBeenCalledOnce();
   });

   it("keeps an existing freeform answer on Enter while editing and reprompts for empty first answers", async () => {
      const ui = {
         input: vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("First").mockResolvedValueOnce(""),
         select: vi.fn().mockResolvedValueOnce("1. Edit: Text?").mockResolvedValueOnce("Submit all answers"),
      };
      const result = await askBatchViaDialogs(ui, normalizeQuestions([{ question: "Text?" }]), undefined, vi.fn());
      expect(result?.answers[0].response).toEqual({ kind: "freeform", text: "First" });
   });
});
