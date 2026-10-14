  // app/lib/scheduler.server.ts
  //
  // Runs the upkeep job (reconcile.server.ts) from inside the server process, so
  // prepaid payment links, reminders and payment checks happen on time without
  // anyone setting up a cron on the server. Before this, a server with no cron
  // calling /api/cron/reconcile never emailed a single payment link.
  //
  // Production only: `remix-serve` runs the built server with NODE_ENV set to
  // "production", while `shopify app dev` does not, so a developer's machine
  // never emails real customers. INTERNAL_SCHEDULER=off turns it off for a
  // server that would rather drive the job from its own cron.
  //
  // The daily billing run (api.cron.billing.ts) is NOT scheduled here; it keeps
  // its own external cron.

  import { runReconcile } from "./reconcile.server";

  // How precisely "send the link 12 hours before" is honoured.
  const EVERY_MS       = 15 * 60 * 1000;
  // Soon after a start or deploy, so anything that came due while the server was
  // down doesn't wait a full interval.
  const FIRST_AFTER_MS = 60 * 1000;

  declare global {
    // Survives a module being loaded twice in one process.
    // eslint-disable-next-line no-var
    var __kasSchedulerStarted: boolean | undefined;
  }

  export interface SchedulerOptions {
    everyMs?:      number;
    firstAfterMs?: number;
    job?:          () => Promise<unknown>;
  }

  /**
   * Starts the recurring job once per process. Returns whether this call
   * started it. The options exist for tests.
   */
  export function startScheduler(options: SchedulerOptions = {}): boolean {
    if (process.env.NODE_ENV !== "production") return false;
    if ((process.env.INTERNAL_SCHEDULER ?? "").toLowerCase() === "off") return false;
    if (globalThis.__kasSchedulerStarted) return false;
    globalThis.__kasSchedulerStarted = true;

    const everyMs = options.everyMs ?? EVERY_MS;
    const job     = options.job ?? runReconcile;

    // A run that outlasts the interval is left to finish, not doubled up.
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await job();
      } catch (err) {
        console.error("[scheduler] upkeep run failed:", err instanceof Error ? err.message : err);
      } finally {
        running = false;
      }
    };

    // unref: the timers must never be what keeps the process alive.
    setTimeout(tick, options.firstAfterMs ?? FIRST_AFTER_MS).unref();
    setInterval(tick, everyMs).unref();

    console.log(`[scheduler] upkeep runs every ${Math.round(everyMs / 60000)} minute(s)`);
    return true;
  }
