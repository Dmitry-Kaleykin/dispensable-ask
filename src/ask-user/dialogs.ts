import type { QuestionOption } from "./ui/single-select-layout";
import {
  type AskUIResult, buildCommentPrompt, createFreeformResponse,
  createSelectionResponse, formatOptionsForMessage, isCancelledInput,
  parseDialogSelections,
} from "./model";
import { FREEFORM_SENTINEL } from "./ui/shared";

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
export async function runDialogBeforeDeadline<T>(
   deadline: number,
   onTimeout: () => void,
   operation: (options: { timeout: number }) => Promise<T>,
): Promise<T | undefined> {
   const remaining = Math.floor(deadline - Date.now());
   if (remaining <= 0) {
      onTimeout();
      return undefined;
   }

   // Register our marker before Pi registers its own dismissal timer. That lets
   // us distinguish an elapsed deadline from Escape, both of which return null.
   const marker = setTimeout(onTimeout, remaining);
   try {
      return await operation({ timeout: remaining });
   } finally {
      clearTimeout(marker);
   }
}

export async function askViaDialogs(
   ui: { select: Function; input: Function },
   question: string,
   context: string | undefined,
   options: QuestionOption[],
   allowMultiple: boolean,
   allowFreeform: boolean,
   allowComment: boolean,
   deadline: number,
   onTimeout: () => void,
): Promise<AskUIResult | null> {
   const prompt = context ? `${question}\n\nContext:\n${context}` : question;

   if (allowMultiple) {
      const optionList = formatOptionsForMessage(options);
      const rawSelections = await runDialogBeforeDeadline(
         deadline,
         onTimeout,
         (dialogOptions) => ui.input(
            `${prompt}\n\nOptions (select one or more):\n${optionList}`,
            "Type your selection(s)...",
            dialogOptions,
         ),
      ) as string | undefined;
      if (isCancelledInput(rawSelections)) return null;

      const selections = parseDialogSelections(rawSelections);
      if (selections.length === 0) return null;

      if (!allowComment) {
         return createSelectionResponse(selections);
      }

      const comment = await runDialogBeforeDeadline(
         deadline,
         onTimeout,
         (dialogOptions) => ui.input(
            buildCommentPrompt(prompt, selections),
            "Optional comment (press Enter to skip)...",
            dialogOptions,
         ),
      ) as string | undefined;
      return createSelectionResponse(selections, comment);
   }

   const selectOptions = options.map((o) => o.title);
   if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

   const selected = await runDialogBeforeDeadline(
      deadline,
      onTimeout,
      (dialogOptions) => ui.select(prompt, selectOptions, dialogOptions),
   ) as string | undefined;
   if (isCancelledInput(selected)) return null;

   if (selected === FREEFORM_SENTINEL) {
      const answer = await runDialogBeforeDeadline(
         deadline,
         onTimeout,
         (dialogOptions) => ui.input(prompt, "Type your answer...", dialogOptions),
      ) as string | undefined;
      if (isCancelledInput(answer)) return null;
      return createFreeformResponse(answer);
   }

   if (!allowComment) {
      return createSelectionResponse([selected]);
   }

   const comment = await runDialogBeforeDeadline(
      deadline,
      onTimeout,
      (dialogOptions) => ui.input(
         buildCommentPrompt(prompt, [selected]),
         "Optional comment (press Enter to skip)...",
         dialogOptions,
      ),
   ) as string | undefined;
   return createSelectionResponse([selected], comment);
}
