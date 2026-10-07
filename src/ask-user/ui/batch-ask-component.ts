import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, type KeybindingsManager, matchesKey, type TUI } from "@earendil-works/pi-tui";
import {
   type AskBatchResult, type AskDisplayMode, type AskQuestion, type AskResponse,
   type AskSingleSelectLayout, createBatchResult, formatResponseSummary,
} from "../model";
import { AskComponent } from "./ask-component";
import type { ResolvedAskShortcuts } from "./shared";

/** Owns navigation and submission; individual pages retain their editors and lists. */
export class BatchAskComponent implements Component {
   private pages: AskComponent[];
   private responses: (AskResponse | null)[];
   private pageIndex = 0;
   private review?: AskComponent;
   private returnToReview = false;
   private remainingIdleSeconds?: number;
   private completed = false;
   private _focused = false;

   constructor(
      private questions: AskQuestion[],
      private displayMode: AskDisplayMode,
      private singleSelectLayout: AskSingleSelectLayout,
      private tui: TUI,
      private theme: Theme,
      private keybindings: KeybindingsManager,
      private shortcuts: ResolvedAskShortcuts,
      private onDone: (result: AskBatchResult | null) => void,
      private onActivity: () => void,
   ) {
      this.responses = questions.map(() => null);
      this.pages = questions.map((question, index) => {
         const page = new AskComponent(
            question.question, question.context, question.options,
            question.allowMultiple, question.allowFreeform, question.allowComment,
            displayMode, singleSelectLayout, tui, theme, keybindings, shortcuts,
            (response) => {
               if (this.completed) return;
               if (!response) return this.finish(null);
               this.responses[index] = response;
               if (this.returnToReview || index === questions.length - 1) this.showReview();
               else this.showPage(index + 1);
            },
            onActivity,
         );
         page.setBatchPage(`Question ${index + 1}/${questions.length}`, "save & next");
         return page;
      });
   }

   private get active(): AskComponent {
      return this.review ?? this.pages[this.pageIndex];
   }

   get focused(): boolean { return this._focused; }
   set focused(value: boolean) {
      this._focused = value;
      this.active.focused = value;
   }

   setRemainingIdleSeconds(value: number | undefined): void {
      this.remainingIdleSeconds = value;
      this.active.setRemainingIdleSeconds(value);
   }

   invalidate(): void { this.active.invalidate(); }
   render(width: number): string[] { return this.active.render(width); }

   private finish(result: AskBatchResult | null): void {
      if (this.completed) return;
      this.completed = true;
      this.onDone(result);
   }

   private savePage(): void {
      if (!this.review) this.responses[this.pageIndex] = this.pages[this.pageIndex].getDraftResponse();
   }

   private showPage(index: number, fromReview = false): void {
      this.savePage();
      this.active.focused = false;
      this.review = undefined;
      this.pageIndex = Math.max(0, Math.min(index, this.pages.length - 1));
      this.returnToReview = fromReview;
      this.active.setBatchPage(`Question ${this.pageIndex + 1}/${this.pages.length}`, fromReview ? "save & review" : "save & next");
      this.active.focused = this._focused;
      this.active.setRemainingIdleSeconds(this.remainingIdleSeconds);
      this.tui.requestRender();
   }

   private showReview(): void {
      this.savePage();
      this.active.focused = false;
      const result = createBatchResult(this.questions, this.responses);
      const answered = this.responses.filter(Boolean).length;
      const action = result ? "Submit all answers" : "Answer remaining questions";
      const titles = this.questions.map((question, index) => `Question ${index + 1}: ${question.question}`);
      this.review = new AskComponent(
         `Review answers (${answered}/${this.questions.length} answered)`, undefined,
         [
            ...titles.map((title, index) => ({
               title,
               description: this.responses[index] ? `Answered: ${this.reviewSummary(this.responses[index]!)}` : "Unanswered",
            })),
            { title: action, description: result ? "Send the whole batch to the agent. Choose a question above to edit it." : "Every question needs an answer before submitting. Choose this to open the first unanswered question." },
         ],
         false, false, false, this.displayMode, "list",
         this.tui, this.theme, this.keybindings, this.shortcuts,
         (response) => {
            if (!response) return this.finish(null);
            if (response.kind !== "selection") return;
            const selected = response.selections[0];
            if (selected === action) {
               if (result) this.finish(result);
               else this.showPage(this.responses.findIndex((answer) => answer === null), true);
            } else {
               const index = titles.indexOf(selected);
               if (index >= 0) this.showPage(index, true);
            }
         },
         this.onActivity,
      );
      // Keep question numbers aligned with the list's numeric shortcuts; focus the final action.
      this.review.focusOption(action);
      this.review.setBatchPage("Review", "submit/edit");
      this.review.focused = this._focused;
      this.review.setRemainingIdleSeconds(this.remainingIdleSeconds);
      this.tui.requestRender();
   }

   private reviewSummary(response: AskResponse): string {
      const text = Array.from(formatResponseSummary(response).replace(/\s+/g, " "));
      return text.length > 160 ? `${text.slice(0, 160).join("")}…` : text.join("");
   }

   handleInput(data: string): void {
      if (this.completed) return;
      if (matchesKey(data, Key.ctrl("n"))) {
         this.onActivity();
         if (!this.review) {
            if (this.pageIndex === this.pages.length - 1) this.showReview();
            else this.showPage(this.pageIndex + 1);
         }
         return;
      }
      if (matchesKey(data, Key.ctrl("p"))) {
         this.onActivity();
         if (this.review) this.showPage(this.pages.length - 1, true);
         else if (this.pageIndex > 0) this.showPage(this.pageIndex - 1);
         return;
      }
      this.active.handleInput(data);
   }
}
