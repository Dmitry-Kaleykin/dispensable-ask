import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
   DEFAULT_CONFIG,
   formatTimeout,
   loadConfig,
   normalizeConfig,
   parseTimeoutSeconds,
   saveConfig,
} from "./config";

describe("configuration", () => {
   it("uses safe defaults for missing or malformed values", () => {
      expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
      expect(normalizeConfig({ timeoutSeconds: 0, shortcut: "not a shortcut" })).toEqual(DEFAULT_CONFIG);
      expect(normalizeConfig({ timeoutSeconds: 45, shortcut: "ALT+Z" })).toEqual({
         timeoutSeconds: 45,
         shortcut: "alt+z",
      });
   });

   it("parses human-friendly timeout values", () => {
      expect(parseTimeoutSeconds("30")).toBe(30);
      expect(parseTimeoutSeconds("45s")).toBe(45);
      expect(parseTimeoutSeconds("1500ms")).toBe(2);
      expect(parseTimeoutSeconds("2m")).toBe(120);
      expect(parseTimeoutSeconds("0")).toBeNull();
      expect(parseTimeoutSeconds("25h")).toBeNull();
      expect(formatTimeout(30)).toBe("30s");
      expect(formatTimeout(120)).toBe("2m");
   });

   it("loads defaults when the file is absent or invalid JSON", async () => {
      const directory = await mkdtemp(join(tmpdir(), "dispensable-ask-config-"));
      const path = join(directory, "config.json");
      expect(await loadConfig(path)).toEqual(DEFAULT_CONFIG);
      await writeFile(path, "{ nope", "utf8");
      expect(await loadConfig(path)).toEqual(DEFAULT_CONFIG);
   });

   it("saves normalized config atomically", async () => {
      const directory = await mkdtemp(join(tmpdir(), "dispensable-ask-config-"));
      const path = join(directory, "nested", "config.json");
      await saveConfig({ timeoutSeconds: 75, shortcut: "alt+x" }, path);

      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
         timeoutSeconds: 75,
         shortcut: "alt+x",
      });
   });
});
