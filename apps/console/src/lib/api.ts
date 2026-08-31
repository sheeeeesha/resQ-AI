/**
 * The API client.
 *
 * The console reaches the database through exactly one path: this file, calling
 * the API. It holds no database credentials and has no Supabase client, because
 * the specific architectural failure being engineered out of this project was a
 * browser writing incident state directly to the datastore with the access
 * rules living nowhere in the repository.
 *
 * Every write here goes through an authenticated endpoint that records who did
 * it and refuses a stale version.
 */

export interface QueueIncident {
  incident_id: string;
  reference: string;
  status: string;
  channel: string;
  language: string;
  priority: string | null;
  incident_type: string | null;
  summary: string;
  escalation_triggers: string[];
  degraded_mode: boolean;
  overall_confidence: number;
  received_at: string;
  version: number;
  location_confirmed: boolean;
  location_ambiguity: string | null;
}

export interface ReviewedField {
  value: unknown;
  status: "extracted" | "not_stated" | "unclear";
  confidence: number;
  evidence: string[];
  review: {
    state: "ai_proposed" | "human_confirmed" | "human_corrected";
    reviewed_by: string | null;
    reviewed_at: string | null;
    override_reason: string | null;
    superseded_value: unknown;
  };
}

export interface LocationCandidate {
  source: string;
  point: { latitude: number; longitude: number };
  accuracy_m: number | null;
  label: string;
  trust: number;
  obtained_at: string;
}

export interface IncidentDetail extends QueueIncident {
  fields: Record<string, ReviewedField>;
  location: {
    candidates: LocationCandidate[];
    selected_index: number | null;
    selected_by_human: boolean;
    stated: Record<string, string | null> | null;
  };
  location_lat: number | null;
  location_lon: number | null;
  caller_number_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface Segment {
  idx: number;
  speaker: string;
  text: string;
  text_en: string | null;
  language: string;
  asr_confidence: number | null;
  received_at: string;
  is_final: boolean;
}

export interface AuditEvent {
  seq: string;
  type: string;
  at: string;
  actor: string | null;
  field_path: string | null;
  before: unknown;
  after: unknown;
  detail: Record<string, unknown> | null;
}

export interface ExtractionPass {
  pass: number;
  model_id: string;
  prompt_version: string;
  latency_ms: number;
  problems: string[];
  error: string | null;
  created_at: string;
}

export interface RecommendedUnit {
  unit_id: string;
  name: string;
  kind: string;
  point: { latitude: number; longitude: number };
  road_distance_m: number | null;
  travel_time_s: number | null;
  straight_line_m: number;
  is_fallback_estimate: boolean;
  availability: string;
  contact_number: string | null;
  address: string | null;
}

export interface UnitRecommendation {
  units: RecommendedUnit[];
  from: { latitude: number; longitude: number } | null;
  blocked_reason: string | null;
  degraded_routing: boolean;
}

/**
 * A failure the console must show rather than swallow.
 *
 * `conflict` is the one that shapes the UI: two operators editing one incident
 * is a coordination problem the console surfaces, never resolves by retrying
 * with a fresh version. Retrying would silently overwrite whatever the other
 * person just decided.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  get isAuth(): boolean {
    return this.status === 401;
  }
}

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5000";

/** Where the operator token lives. Interim, alongside the API's bearer tokens. */
const TOKEN_KEY = "resqai.operator_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = getToken();

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    let code = `http_${response.status}`;
    let message = response.statusText;
    let detail: Record<string, unknown> | undefined;

    try {
      const body = (await response.json()) as Record<string, unknown>;
      code = (body.error as string) ?? code;
      message = (body.message as string) ?? code;
      detail = body;
    } catch {
      // A non-JSON error body is still an error; the status carries the meaning.
    }

    throw new ApiError(response.status, code, message, detail);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  queue: () => request<{ incidents: QueueIncident[] }>("/incidents"),

  incident: (id: string) =>
    request<{ incident: IncidentDetail }>(`/incidents/${id}`),

  transcript: (id: string) =>
    request<{ segments: Segment[] }>(`/incidents/${id}/transcript`),

  audit: (id: string) =>
    request<{ events: AuditEvent[]; extraction_passes: ExtractionPass[] }>(
      `/incidents/${id}/audit`,
    ),

  units: (id: string) => request<UnitRecommendation>(`/incidents/${id}/units`),

  confirmField: (id: string, field: string, version: number) =>
    request<{ version: number }>(`/incidents/${id}/fields/${field}/confirm`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),

  overrideField: (
    id: string,
    field: string,
    version: number,
    value: unknown,
    reason: string,
  ) =>
    request<{ version: number }>(`/incidents/${id}/fields/${field}/override`, {
      method: "POST",
      body: JSON.stringify({ version, value, reason }),
    }),

  selectLocation: (id: string, version: number, candidateIndex: number) =>
    request<{ version: number }>(`/incidents/${id}/location/select`, {
      method: "POST",
      body: JSON.stringify({ version, candidate_index: candidateIndex }),
    }),

  dispatchUnit: (id: string, version: number, unitId: string) =>
    request<{ dispatched: boolean }>(`/incidents/${id}/dispatch`, {
      method: "POST",
      body: JSON.stringify({ version, unit_id: unitId }),
    }),

  setStatus: (id: string, version: number, status: string) =>
    request<{ version: number }>(`/incidents/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ version, status }),
    }),
};

/* ------------------------------------------------------------------ *
 * Live updates
 * ------------------------------------------------------------------ */

export interface IncidentChanged {
  incident_id: string;
  reference: string;
  status: string;
  priority: string | null;
  version: number;
  escalated: boolean;
  op: "INSERT" | "UPDATE";
}

/**
 * Subscribes to the live incident stream.
 *
 * Uses `fetch` with a stream reader rather than `EventSource`, because
 * `EventSource` cannot set an `Authorization` header. The alternative would be
 * putting an operator token in a query string, where every proxy, access log
 * and browser history entry would keep a copy of it.
 *
 * Returns an unsubscribe function. Reconnects on drop, because a stream that
 * dies silently looks exactly like a quiet shift — which is the worst way for
 * this particular thing to fail.
 */
export function subscribeToIncidents(handlers: {
  onIncident: (payload: IncidentChanged) => void;
  onStatus?: (live: boolean) => void;
}): () => void {
  const controller = new AbortController();
  let stopped = false;
  let failures = 0;

  async function connect(): Promise<void> {
    if (stopped) return;

    try {
      const response = await fetch(`${BASE}/events`, {
        signal: controller.signal,
        headers: { authorization: `Bearer ${getToken() ?? ""}` },
      });

      if (!response.ok || !response.body) {
        throw new Error(`stream returned ${response.status}`);
      }

      failures = 0;
      handlers.onStatus?.(true);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Anything after the last
        // separator is a partial frame and stays in the buffer.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event !== "incident" || !data) continue;

          try {
            handlers.onIncident(JSON.parse(data) as IncidentChanged);
          } catch {
            // A malformed frame means the API and this parser disagree.
            // Dropping one update is survivable; the queue also polls.
          }
        }
      }
    } catch {
      if (stopped) return;
      handlers.onStatus?.(false);
    }

    if (stopped) return;

    failures += 1;
    const delay = Math.min(1000 * 2 ** (failures - 1), 30_000);
    setTimeout(() => void connect(), delay);
  }

  void connect();

  return () => {
    stopped = true;
    controller.abort();
  };
}
