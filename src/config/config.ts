import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface DispensableAskConfig {
   timeoutSeconds: number;
   shortcut: string;
}

export const DEFAULT_CONFIG: Readonly<DispensableAskConfig> = Object.freeze({
   timeoutSeconds: 30,
   shortcut: "alt+a",
});

export const CONFIG_FILE_NAME = "dispensable-ask.json";
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 24 * 60 * 60;

const SHORTCUT_PATTERN = /^(?:(?:ctrl|alt|shift|super)\+)+[a-z0-9]$/;

export function getConfigPath(agentDir = getAgentDir()): string {
   return join(agentDir, CONFIG_FILE_NAME);
}

export function normalizeConfig(value: unknown): DispensableAskConfig {
   if (!value || typeof value !== "object") return { ...DEFAULT_CONFIG };

   const record = value as Record<string, unknown>;
   const timeout = Number(record.timeoutSeconds);
   const timeoutSeconds = Number.isFinite(timeout)
      && timeout >= MIN_TIMEOUT_SECONDS
      && timeout <= MAX_TIMEOUT_SECONDS
      ? Math.round(timeout)
      : DEFAULT_CONFIG.timeoutSeconds;

   const shortcutCandidate = typeof record.shortcut === "string"
      ? record.shortcut.trim().toLowerCase()
      : "";
   const shortcut = SHORTCUT_PATTERN.test(shortcutCandidate)
      ? shortcutCandidate
      : DEFAULT_CONFIG.shortcut;

   return { timeoutSeconds, shortcut };
}

export async function loadConfig(path = getConfigPath()): Promise<DispensableAskConfig> {
   try {
      return normalizeConfig(JSON.parse(await readFile(path, "utf8")));
   } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || error instanceof SyntaxError) return { ...DEFAULT_CONFIG };
      throw error;
   }
}

export async function saveConfig(config: DispensableAskConfig, path = getConfigPath()): Promise<void> {
   const normalized = normalizeConfig(config);
   await mkdir(dirname(path), { recursive: true });

   const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
   await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
   await rename(temporaryPath, path);
}

export function parseTimeoutSeconds(input: string): number | null {
   const match = input.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/);
   if (!match) return null;

   const amount = Number(match[1]);
   const unit = match[2] ?? "s";
   const seconds = unit === "ms" ? amount / 1000 : unit === "m" ? amount * 60 : amount;
   const rounded = Math.ceil(seconds);
   if (!Number.isFinite(rounded) || rounded < MIN_TIMEOUT_SECONDS || rounded > MAX_TIMEOUT_SECONDS) {
      return null;
   }
   return rounded;
}

export function formatTimeout(seconds: number): string {
   return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}
