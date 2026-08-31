import { EventEmitter } from "node:events";
import pg from "pg";

/**
 * Live incident updates, from Postgres LISTEN to the console.
 *
 * One dedicated connection listens; every SSE client subscribes to this
 * emitter. A connection per browser tab would exhaust the pool during exactly
 * the incident that draws a crowd of operators.
 *
 * The connection is deliberately not from the shared pool. A pooled client
 * holding a LISTEN registration is a client that never returns, and a pool
 * that slowly loses its members to listeners fails in a way that looks like a
 * capacity problem rather than a leak.
 */

export interface IncidentChanged {
  incident_id: string;
  reference: string;
  status: string;
  priority: string | null;
  incident_type: string | null;
  version: number;
  escalated: boolean;
  degraded: boolean;
  location_confirmed: boolean;
  op: "INSERT" | "UPDATE";
}

const CHANNEL = "incident_changed";

export class IncidentNotifier extends EventEmitter {
  private client: pg.Client | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  /** Consecutive failures, for backoff. Reset on a successful connect. */
  private failures = 0;

  constructor(private readonly connectionString: string) {
    super();
    // One listener per connected console, plus internal bookkeeping. The
    // default cap of 10 would start printing warnings on a busy shift.
    this.setMaxListeners(200);
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.client) {
      const client = this.client;
      this.client = null;
      await client.end().catch(() => {
        // Already gone. Nothing useful to do here.
      });
    }
  }

  /** True when the listening connection is currently established. */
  get connected(): boolean {
    return this.client !== null;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const client = new pg.Client({ connectionString: this.connectionString });

    client.on("notification", (message) => {
      if (message.channel !== CHANNEL || !message.payload) return;
      try {
        this.emit("incident", JSON.parse(message.payload) as IncidentChanged);
      } catch {
        // A malformed payload means the trigger and this parser disagree.
        // Dropping one notification is survivable; the console polls as well.
        this.emit("warning", "unparseable notification payload");
      }
    });

    // A dropped connection is the failure that matters here, because it is
    // silent: the console keeps its SSE stream open and simply stops receiving
    // anything. Reconnecting is not optional.
    client.on("error", (err) => {
      this.emit("warning", `listener connection error: ${err.message}`);
      this.client = null;
      this.scheduleReconnect();
    });

    client.on("end", () => {
      if (this.client === client) {
        this.client = null;
        this.scheduleReconnect();
      }
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.failures = 0;
      this.emit("connected");
    } catch (err) {
      this.emit(
        "warning",
        `listener could not connect: ${err instanceof Error ? err.message : err}`,
      );
      this.scheduleReconnect();
    }
  }

  /**
   * Reconnects with exponential backoff, capped at 30 seconds.
   *
   * Capped rather than unbounded because this must recover on its own after a
   * database restart or a failover. An unbounded backoff eventually means a
   * console that silently stops updating until someone restarts the service.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    this.failures += 1;
    const delay = Math.min(1000 * 2 ** (this.failures - 1), 30_000);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
