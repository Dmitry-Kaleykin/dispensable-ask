import type { QuestionOption } from "./ui/single-select-layout";
import {
  type AskUIResult, type AskBatchResult, type AskQuestion, type AskResponse,
  buildCommentPrompt, createFreeformResponse, createBatchResult, formatResponseSummary,
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
   timeoutMs: number | undefined,
   onTimeout: () => void,
   operation: (options: DialogOptions) => Promise<T>,
   parentSignal?: AbortSignal,
   onTick?: (remainingSeconds: number) => void,
): Promise<T | undefined> {
   const dialogAbort = new AbortController();
   const idleTimeout = timeoutMs === undefined ? undefined : new IdleTimeout(timeoutMs, () => {
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
   const removeInputListener = idleTimeout ? ui.onTerminalInput?.(() => {
      idleTimeout.touch();
      return undefined;
   }) : undefined;

   idleTimeout?.start();
   try {
      if (dialogAbort.signal.aborted) return undefined;
      return await operation({ signal: dialogAbort.signal });
   } finally {
      idleTimeout?.stop();
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
   timeoutMs: number | undefined,
   onTimeout: () => void,
   signal?: AbortSignal,
   onTick?: (remainingSeconds: number) => void,
   previous?: AskResponse,
): Promise<AskUIResult | null> {
   const basePrompt = context ? `${question}\n\nContext:\n${context}` : question;
   const prompt = previous ? `${basePrompt}\n\nCurrent answer: ${formatResponseSummary(previous)}` : basePrompt;
   const input = (title: string, placeholder: string) => runDialogWithIdleTimeout<string>(
      ui, timeoutMs, onTimeout, (dialogOptions) => ui.input(title, placeholder, dialogOptions), signal, onTick,
   );

   if (options.length === 0) {
      while (!signal?.aborted) {
         const answer = await input(prompt, previous ? "New answer (Enter to keep current)..." : "Type your answer...");
         if (isCancelledInput(answer)) return null;
         if (!answer?.trim() && previous) return previous;
         const response = createFreeformResponse(answer);
         if (response) return response;
      }
      return null;
   }

   if (allowMultiple) {
      const optionList = formatOptionsForMessage(options);
      let selections: string[] = [];
      while (selections.length === 0 && !signal?.aborted) {
         const rawSelections = await input(
            `${prompt}\n\nOptions (select one or more by number or title):\n${optionList}${allowFreeform ? "\nOr type a custom answer." : ""}`,
            previous ? "New selection(s) (Enter to keep current)..." : "Type your selection(s)...",
         );
         if (isCancelledInput(rawSelections)) return null;
         if (!rawSelections?.trim() && previous) return previous;
         const parsed = parseDialogSelections(rawSelections!);
         const titles = parsed.map((value) => /^\d+$/.test(value) ? options[Number(value) - 1]?.title : options.find((option) => option.title === value)?.title);
         if (titles.length && titles.every((title) => title !== undefined)) selections = [...new Set(titles as string[])];
         else if (allowFreeform && rawSelections?.trim()) return createFreeformResponse(rawSelections);
      }
      if (signal?.aborted) return null;

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
      if (isCancelledInput(comment)) return null;
      return createSelectionResponse(selections, comment);
   }

   // Number the labels so real option titles cannot collide with control actions.
   const selectOptions = options.map((o, index) => `${index + 1}. ${o.title}`);
   if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);
   const keepCurrent = "Keep current answer";
   if (previous) selectOptions.unshift(keepCurrent);

   const selected = await runDialogWithIdleTimeout(
      ui,
      timeoutMs,
      onTimeout,
      (dialogOptions) => ui.select(prompt, selectOptions, dialogOptions),
      signal,
      onTick,
   ) as string | undefined;
   if (isCancelledInput(selected)) return null;
   if (selected === keepCurrent && previous) return previous;

   if (selected === FREEFORM_SENTINEL) {
      while (!signal?.aborted) {
         const answer = await input(prompt, "Type your answer...");
         if (isCancelledInput(answer)) return null;
         const response = createFreeformResponse(answer);
         if (response) return response;
      }
      return null;
   }

   const selectedIndex = selectOptions.indexOf(selected!)-(previous ? 1 : 0);
   const selectedTitle = options[selectedIndex]?.title;
   if (!selectedTitle) return null;

   if (!allowComment) {
      return createSelectionResponse([selectedTitle]);
   }

   const comment = await runDialogWithIdleTimeout(
      ui,
      timeoutMs,
      onTimeout,
      (dialogOptions) => ui.input(
         buildCommentPrompt(prompt, [selectedTitle]),
         "Optional comment (press Enter to skip)...",
         dialogOptions,
      ),
      signal,
      onTick,
   ) as string | undefined;
   if (isCancelledInput(comment)) return null;
   return createSelectionResponse([selectedTitle], comment);
}

/** RPC clients receive ordinary dialogs with an explicit review/edit loop. */
export async function askBatchViaDialogs(
   ui: DialogUI,
   questions: AskQuestion[],
   timeoutMs: number | undefined,
   onTimeout: () => void,
   signal?: AbortSignal,
   onTick?: (remainingSeconds: number) => void,
): Promise<AskBatchResult | null> {
   const responses: (AskResponse | null)[] = questions.map(() => null);
   let index = 0;
   while (!signal?.aborted) {
      const question = questions[index];
      const response = await askViaDialogs(
         ui, `Question ${index + 1}/${questions.length}: ${question.question}`, question.context,
         question.options, question.allowMultiple, question.allowFreeform, question.allowComment,
         timeoutMs, onTimeout, signal, onTick, responses[index] ?? undefined,
      );
      if (!response || signal?.aborted) return null;
      responses[index] = response;
      const nextUnanswered = responses.findIndex((answer) => answer === null);
      if (nextUnanswered >= 0) {
         index = nextUnanswered;
         continue;
      }
      const result = createBatchResult(questions, responses)!;
      const summary = result.answers.map((answer) => `${answer.index}. ${answer.question}\n   ${formatResponseSummary(answer.response)}`).join("\n\n");
      const editLabels = questions.map((question, index) => `${index + 1}. Edit: ${question.question}`);
      const selected = await runDialogWithIdleTimeout<string>(
         ui, timeoutMs, onTimeout,
         (dialogOptions) => ui.select(`Review answers\n\n${summary}`, ["Submit all answers", ...editLabels], dialogOptions),
         signal, onTick,
      );
      if (isCancelledInput(selected) || signal?.aborted) return null;
      if (selected === "Submit all answers") return result;
      index = editLabels.indexOf(selected!);
      if (index < 0) return null;
   }
   return null;
}
