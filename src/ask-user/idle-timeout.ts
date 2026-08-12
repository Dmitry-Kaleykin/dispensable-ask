/** A restartable timeout that measures inactivity rather than wall-clock time. */
export class IdleTimeout {
   private handle: ReturnType<typeof setTimeout> | undefined;
   private running = false;

   public constructor(
      private readonly delayMs: number,
      private readonly onExpire: () => void,
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
      this.handle = undefined;
   }

   private schedule(): void {
      if (this.handle) clearTimeout(this.handle);
      this.handle = setTimeout(() => {
         this.running = false;
         this.handle = undefined;
         this.onExpire();
      }, this.delayMs);
   }
}
