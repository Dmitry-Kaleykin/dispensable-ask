import { afterEach, describe, expect, it, vi } from "vitest";
import { IdleTimeout } from "./src/ask-user/idle-timeout";

describe("IdleTimeout", () => {
   afterEach(() => vi.useRealTimers());

   it("expires after a full idle period", async () => {
      vi.useFakeTimers();
      const onExpire = vi.fn();
      const timeout = new IdleTimeout(1_000, onExpire);

      timeout.start();
      await vi.advanceTimersByTimeAsync(999);
      expect(onExpire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onExpire).toHaveBeenCalledOnce();
   });

   it("grants a fresh period after activity", async () => {
      vi.useFakeTimers();
      const onExpire = vi.fn();
      const timeout = new IdleTimeout(1_000, onExpire);

      timeout.start();
      await vi.advanceTimersByTimeAsync(750);
      timeout.touch();
      await vi.advanceTimersByTimeAsync(750);
      expect(onExpire).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(onExpire).toHaveBeenCalledOnce();
   });

   it("does not expire after being stopped", async () => {
      vi.useFakeTimers();
      const onExpire = vi.fn();
      const timeout = new IdleTimeout(1_000, onExpire);

      timeout.start();
      timeout.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onExpire).not.toHaveBeenCalled();
   });
});
