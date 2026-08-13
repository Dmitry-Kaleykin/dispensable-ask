/** A restartable timeout that measures inactivity rather than wall-clock time. */
export class IdleTimeout {
   private handle: ReturnType<typeof setTimeout> | undefined;
   private tickHandle: ReturnType<typeof setInterval> | undefined;
   private running = false;
   private deadline = 0;
   private lastReportedSeconds: number | undefined;

   public constructor(
      private readonly delayMs: number,
      private readonly onExpire: () => void,
      private readonly onTick?: (remainingSeconds: number) => void,
   ) {}

   public start(): void {
      this.running = true;
      this.schedule();
   }

   /** Record user activity and grant a fresh idle window. */
   public touch(): void {
      if (this.running) this.schedule();
   }

   public stop(): void {
      this.running = false;
      if (this.handle) clearTimeout(this.handle);
      if (this.tickHandle) clearInterval(this.tickHandle);
      this.handle = undefined;
      this.tickHandle = undefined;
      this.lastReportedSeconds = undefined;
   }

   private schedule(): void {
      if (this.handle) clearTimeout(this.handle);
      if (this.tickHandle) clearInterval(this.tickHandle);
      this.deadline = Date.now() + this.delayMs;
      this.lastReportedSeconds = undefined;
      this.reportRemaining();
      this.handle = setTimeout(() => {
         this.running = false;
         this.handle = undefined;
         if (this.tickHandle) clearInterval(this.tickHandle);
         this.tickHandle = undefined;
         this.reportRemaining(0);
         this.onExpire();
      }, this.delayMs);
      if (this.onTick) {
         this.tickHandle = setInterval(() => this.reportRemaining(), 1_000);
      }
   }

   private reportRemaining(remainingSeconds?: number): void {
      if (!this.onTick) return;
      const nextRemaining = remainingSeconds
         ?? Math.max(0, Math.ceil((this.deadline - Date.now()) / 1_000));
      if (nextRemaining === this.lastReportedSeconds) return;
      this.lastReportedSeconds = nextRemaining;
      this.onTick(nextRemaining);
   }
}
