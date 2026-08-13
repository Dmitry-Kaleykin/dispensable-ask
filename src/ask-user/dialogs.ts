import type { QuestionOption } from "./ui/single-select-layout";
import {
  type AskUIResult, buildCommentPrompt, createFreeformResponse,
  createSelectionResponse, formatOptionsForMessage, isCancelledInput,
  parseDialogSelections,
} from "./model";
import { FREEFORM_SENTINEL } from "./ui/shared";
import { IdleTimeout } from "./idle-timeout";

interface DialogOptions {
   signal: AbortSignal;
}

interface DialogUI {
   select: Function;
   input: Function;
   onTerminalInput?: (handler: (data: string) => undefined) => () => void;
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
export async function runDialogWithIdleTimeout<T>(
   ui: DialogUI,
   timeoutMs: number,
   onTimeout: () => void,
   operation: (options: DialogOptions) => Promise<T>,
   parentSignal?: AbortSignal,
   onTick?: (remainingSeconds: number) => void,
): Promise<T | undefined> {
   const dialogAbort = new AbortController();
   const idleTimeout = new IdleTimeout(timeoutMs, () => {
      onTimeout();
      dialogAbort.abort();
   }, onTick);
   const abortFromParent = () => dialogAbort.abort();
   if (parentSignal?.aborted) {
      dialogAbort.abort();
   } else {
      parentSignal?.addEventListener("abort", abortFromParent, { once: true });
   }

   // TUI dialogs do not expose their editor directly. Raw input observation
   // lets typing and navigation reset the idle clock without consuming input.
   const removeInputListener = ui.onTerminalInput?.(() => {
      idleTimeout.touch();
      return undefined;
   });

   idleTimeout.start();
   try {
      return await operation({ signal: dialogAbort.signal });
   } finally {
      idleTimeout.stop();
      removeInputListener?.();
      parentSignal?.removeEventListener("abort", abortFromParent);
   }
}

export async function askViaDialogs(
   ui: DialogUI,
   question: string,
   context: string | undefined,
   options: QuestionOption[],
   allowMultiple: boolean,
   allowFreeform: boolean,
   allowComment: boolean,
   timeoutMs: number,
   onTimeout: () => void,
   signal?: AbortSignal,
   onTick?: (remainingSeconds: number) => void,
): Promise<AskUIResult | null> {
   const prompt = context ? `${question}\n\nContext:\n${context}` : question;

   if (allowMultiple) {
      const optionList = formatOptionsForMessage(options);
      const rawSelections = await runDialogWithIdleTimeout(
         ui,
         timeoutMs,
         onTimeout,
         (dialogOptions) => ui.input(
            `${prompt}\n\nOptions (select one or more):\n${optionList}`,
            "Type your selection(s)...",
            dialogOptions,
         ),
         signal,
         onTick,
      ) as string | undefined;
      if (isCancelledInput(rawSelections)) return null;

      const selections = parseDialogSelections(rawSelections);
      if (selections.length === 0) return null;

      if (!allowComment) {
         return createSelectionResponse(selections);
      }

      const comment = await runDialogWithIdleTimeout(
         ui,
         timeoutMs,
         onTimeout,
         (dialogOptions) => ui.input(
            buildCommentPrompt(prompt, selections),
            "Optional comment (press Enter to skip)...",
            dialogOptions,
         ),
         signal,
         onTick,
      ) as string | undefined;
      return createSelectionResponse(selections, comment);
   }

   const selectOptions = options.map((o) => o.title);
   if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

   const selected = await runDialogWithIdleTimeout(
      ui,
      timeoutMs,
      onTimeout,
      (dialogOptions) => ui.select(prompt, selectOptions, dialogOptions),
      signal,
      onTick,
   ) as string | undefined;
   if (isCancelledInput(selected)) return null;

   if (selected === FREEFORM_SENTINEL) {
      const answer = await runDialogWithIdleTimeout(
         ui,
         timeoutMs,
         onTimeout,
         (dialogOptions) => ui.input(prompt, "Type your answer...", dialogOptions),
         signal,
         onTick,
      ) as string | undefined;
      if (isCancelledInput(answer)) return null;
      return createFreeformResponse(answer);
   }

   if (!allowComment) {
      return createSelectionResponse([selected]);
   }

   const comment = await runDialogWithIdleTimeout(
      ui,
      timeoutMs,
      onTimeout,
      (dialogOptions) => ui.input(
         buildCommentPrompt(prompt, [selected]),
         "Optional comment (press Enter to skip)...",
         dialogOptions,
      ),
      signal,
      onTick,
   ) as string | undefined;
   return createSelectionResponse([selected], comment);
}
