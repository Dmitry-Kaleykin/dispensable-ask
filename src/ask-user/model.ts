import type { QuestionOption } from "./ui/single-select-layout";

export type AskOptionInput = QuestionOption | string;

export type AskDisplayMode = "overlay" | "inline";
export type AskSingleSelectLayout = "auto" | "list";

export interface AskQuestionInput {
   question: string;
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   allowComment?: boolean;
}

export interface AskParams {
   questions: AskQuestionInput[];
}

export interface AskQuestion {
   question: string;
   context?: string;
   options: QuestionOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   allowComment: boolean;
}

export type AskResponse =
   | {
      kind: "selection";
      selections: string[];
      comment?: string;
   }
   | {
      kind: "freeform";
      text: string;
   };

export interface AskToolDetails {
   questions: AskQuestion[];
   answers: AskAnswer[] | null;
   cancelled: boolean;
   timedOut?: boolean;
   error?: string;
}

export type AskUIResult = AskResponse;

export interface AskAnswer {
   /** One-based index in the original questions array. */
   index: number;
   question: string;
   response: AskResponse;
}

export interface AskBatchResult {
   answers: AskAnswer[];
}

/** Validate the whole batch before opening any UI, including proxy-mangled inputs. */
export function normalizeQuestions(input: unknown, defaultAllowComment = false): AskQuestion[] {
   if (!Array.isArray(input) || input.length === 0) {
      throw new Error('Provide a non-empty "questions" array, for example { "questions": [{ "question": "Proceed?" }] }.');
   }
   return input.map((value, index) => {
      const label = `Question ${index + 1}`;
      if (!value || typeof value !== "object" || typeof value.question !== "string" || !value.question.trim()) {
         throw new Error(`${label} must contain a non-empty question string.`);
      }
      if (value.options !== undefined && !Array.isArray(value.options)) {
         throw new Error(`${label}: options must be an array.`);
      }
      const rawOptions: unknown[] = value.options ?? [];
      const options = rawOptions.map(coerceOption).filter((option): option is QuestionOption => option !== null);
      if (rawOptions.length > 0 && options.length === 0) {
         throw new Error(`${label}: all options were malformed. Each option needs a title, for example { "title": "Short label", "description": "Optional detail" }.`);
      }
      for (const key of ["allowMultiple", "allowFreeform", "allowComment"] as const) {
         if (value[key] !== undefined && typeof value[key] !== "boolean") {
            throw new Error(`${label}: ${key} must be a boolean.`);
         }
      }
      if (value.context !== undefined && typeof value.context !== "string") {
         throw new Error(`${label}: context must be a string.`);
      }
      const allowFreeform = value.allowFreeform ?? true;
      if (options.length === 0 && !allowFreeform) {
         throw new Error(`${label} needs options or allowFreeform enabled.`);
      }
      return {
         question: value.question.trim(),
         context: value.context?.trim() || undefined,
         options,
         allowMultiple: value.allowMultiple ?? false,
         allowFreeform,
         allowComment: value.allowComment ?? defaultAllowComment,
      };
   });
}

export function createBatchResult(questions: AskQuestion[], responses: (AskResponse | null)[]): AskBatchResult | null {
   if (responses.length !== questions.length || responses.some((response) => response === null)) return null;
   return {
      answers: questions.map((question, index) => ({ index: index + 1, question: question.question, response: responses[index]! })),
   };
}

// Key aliases models fall back to when a schema-mangling proxy (Google
// function calling, Codex-style backends, cmux) strips the option shape and
// the model has to guess. See issue #22.
export const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"] as const;

export function coerceOption(option: unknown): QuestionOption | null {
   if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") {
      const title = String(option).trim();
      return title ? { title } : null;
   }
   if (option && typeof option === "object") {
      const record = option as Record<string, unknown>;
      for (const key of OPTION_TITLE_KEYS) {
         const value = record[key];
         if (typeof value === "string" && value.trim()) {
            const description =
               typeof record.description === "string" && record.description.trim() ? record.description : undefined;
            return description ? { title: value.trim(), description } : { title: value.trim() };
         }
      }
   }
   return null;
}

export function formatOptionsForMessage(options: QuestionOption[]): string {
   return options
      .map((option, index) => {
         const desc = option.description ? ` — ${option.description}` : "";
         return `${index + 1}. ${option.title}${desc}`;
      })
      .join("\n");
}

function normalizeOptionalComment(text: string | null | undefined): string | undefined {
   const trimmed = text?.trim();
   return trimmed ? trimmed : undefined;
}

export function parseBooleanPreference(value: string | undefined): boolean | undefined {
   if (value === undefined) return undefined;
   switch (value.trim().toLowerCase()) {
      case "1":
      case "true":
      case "yes":
      case "on":
         return true;
      case "0":
      case "false":
      case "no":
      case "off":
         return false;
      default:
         return undefined;
   }
}

export function createFreeformResponse(text: string | null | undefined): AskResponse | null {
   const trimmed = text?.trim();
   return trimmed ? { kind: "freeform", text: trimmed } : null;
}

export function createSelectionResponse(selections: string[], comment?: string | null): AskResponse | null {
   const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
   if (normalizedSelections.length === 0) return null;

   const normalizedComment = normalizeOptionalComment(comment);
   return normalizedComment
      ? { kind: "selection", selections: normalizedSelections, comment: normalizedComment }
      : { kind: "selection", selections: normalizedSelections };
}

export function formatResponseSummary(response: AskResponse): string {
   if (response.kind === "freeform") return response.text;

   const selections = response.selections.join(", ");
   return response.comment ? `${selections} — ${response.comment}` : selections;
}

export function buildCommentPrompt(prompt: string, selections: string[]): string {
   const label = selections.length === 1 ? "Selected option" : "Selected options";
   const lines = selections.map((selection) => `- ${selection}`).join("\n");
   return `${prompt}\n\n${label}:\n${lines}`;
}

export function parseDialogSelections(input: string): string[] {
   return input
      .split(",")
      .map((selection) => selection.trim())
      .filter(Boolean);
}

export function isCancelledInput(value: unknown): value is null | undefined {
   return value === null || value === undefined;
}

export function isSelectionResponse(response: AskResponse): response is Extract<AskResponse, { kind: "selection" }> {
   return response.kind === "selection";
}
