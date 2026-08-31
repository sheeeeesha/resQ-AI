/**
 * Geocoding — turning a stated place into candidate coordinates.
 *
 * The single rule this module exists to enforce:
 *
 *   **Never collapse an ambiguous place to one answer.**
 *
 * The prototype geocoded a model-produced address string and took
 * `results[0]`. On an Indian address that is a coin flip presented as a fact.
 * "Shiv Mandir" matches thousands of temples; "Gandhi Road" exists in most
 * cities in the country. Picking the first and rendering it as *the* location
 * sends a vehicle somewhere plausible and wrong, and nothing in the interface
 * ever indicates that a choice was made.
 *
 * So every provider here returns all matches, ranked, and the caller decides —
 * which in practice means a call-taker decides, because an ambiguous location
 * is exactly the case a human should see.
 */

export interface GeocodeQuery {
  /** The place as stated, in the original script. Never translated. */
  text: string;
  /** Locality/city to bias toward, when the transcript supplied one. */
  near?: string | null;
  /** Point to bias toward — a device fix, or the caller's known area. */
  bias?: { latitude: number; longitude: number } | null;
  limit?: number;
}

export interface GeocodeMatch {
  latitude: number;
  longitude: number;
  /** Formatted label for the console. */
  label: string;
  /**
   * Provider confidence in 0..1, normalised across providers.
   *
   * Normalised deliberately: every geocoder scores differently, and comparing
   * raw provider scores across two of them produces a ranking that looks
   * principled and is not.
   */
  confidence: number;
  /** Radius of uncertainty in metres where the provider reports one. */
  accuracy_m: number | null;
  /** What kind of thing matched — a building, a road, a locality. */
  category: string | null;
}

export interface GeocodeProvider {
  readonly name: string;
  /** Returns every plausible match, most likely first. Never truncated to one. */
  search(query: GeocodeQuery): Promise<GeocodeMatch[]>;
}

/** Used when no geocoder is configured. Resolves nothing, and says so. */
export class NullGeocoder implements GeocodeProvider {
  readonly name = "null";
  async search(): Promise<GeocodeMatch[]> {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Nominatim
 * ------------------------------------------------------------------ */

interface NominatimResult {
  lat?: string;
  lon?: string;
  display_name?: string;
  importance?: number;
  class?: string;
  type?: string;
  boundingbox?: [string, string, string, string];
}

/**
 * OpenStreetMap Nominatim.
 *
 * The default because it needs no key and no billing relationship, which
 * matters for a project that has to be demonstrable before it is funded.
 *
 * Its limits are real and worth stating plainly rather than discovering in a
 * demo. OSM coverage of Indian informal landmarks — the small temple, the
 * unnamed lane, the local name for a junction — is thin, and those are exactly
 * the references Indian callers use. It will resolve "Hitec City" and miss
 * "Shiv Mandir ke peeche". A commercial Indian geocoder (Ola Maps, MapmyIndia)
 * is materially better at this and slots in behind the same interface; the
 * decision to pay for one should be made on measured miss rates from M6, not
 * on argument.
 *
 * The usage policy caps requests at 1/s and requires a genuine User-Agent, so
 * both are enforced here rather than left to good behaviour.
 */
export class NominatimGeocoder implements GeocodeProvider {
  readonly name = "nominatim";

  private lastRequestAt = 0;

  constructor(
    private readonly config: {
      /** Contact address, per the usage policy. Requests without it get blocked. */
      userAgent: string;
      endpoint?: string;
      timeoutMs?: number;
      /** Restrict results to a country. "in" for India. */
      countryCode?: string | null;
    },
  ) {}

  async search(query: GeocodeQuery): Promise<GeocodeMatch[]> {
    const text = query.text.trim();
    if (!text) return [];

    await this.respectRateLimit();

    const url = new URL(this.config.endpoint ?? "https://nominatim.openstreetmap.org/search");
    // The locality is appended rather than sent as a separate field because
    // Nominatim's structured query and free-text query cannot be combined, and
    // free text handles Indian address phrasing considerably better.
    url.searchParams.set("q", query.near ? `${text}, ${query.near}` : text);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", String(query.limit ?? 5));
    url.searchParams.set("addressdetails", "1");

    if (this.config.countryCode) {
      url.searchParams.set("countrycodes", this.config.countryCode);
    }

    if (query.bias) {
      // A viewbox biases without excluding: bounded=0 keeps outside matches,
      // ranked lower. Excluding them would hide a correct match near a border
      // or just outside a stale device fix.
      const { latitude, longitude } = query.bias;
      const span = 0.5;
      url.searchParams.set(
        "viewbox",
        [longitude - span, latitude + span, longitude + span, latitude - span].join(","),
      );
      url.searchParams.set("bounded", "0");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 5_000);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": this.config.userAgent,
          "accept-language": "en",
        },
      });

      if (!response.ok) return [];

      const body = (await response.json()) as NominatimResult[];
      if (!Array.isArray(body)) return [];

      return body
        .map((result) => this.toMatch(result))
        .filter((match): match is GeocodeMatch => match !== null);
    } catch {
      // Timeout, network failure, malformed response — all the same outcome.
      // Geocoding is one signal among several and must never fail a pass.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  private toMatch(result: NominatimResult): GeocodeMatch | null {
    const latitude = Number(result.lat);
    const longitude = Number(result.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    return {
      latitude,
      longitude,
      label: result.display_name ?? "unnamed place",
      // Nominatim's `importance` is roughly 0..1 already but clusters low for
      // small features, which are precisely the ones an emergency caller
      // names. Floored so a genuine small-landmark match is not ranked below
      // a vague large-area one purely on prominence.
      confidence: Math.max(0.2, Math.min(result.importance ?? 0.3, 1)),
      accuracy_m: boundingBoxRadius(result.boundingbox),
      category: result.type ?? result.class ?? null,
    };
  }

  /**
   * Enforces the one-request-per-second policy.
   *
   * Serialised rather than merely throttled: the policy is a condition of use,
   * and getting the shared public instance blocked would take the only
   * key-free geocoder out for everyone using it.
   */
  private async respectRateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    const wait = 1_100 - elapsed;
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestAt = Date.now();
  }
}

/** Radius in metres of a circle containing a Nominatim bounding box. */
function boundingBoxRadius(
  box: [string, string, string, string] | undefined,
): number | null {
  if (!box || box.length !== 4) return null;

  const [south, north, west, east] = box.map(Number);
  if ([south, north, west, east].some((v) => !Number.isFinite(v))) return null;

  const midLatitude = ((south as number) + (north as number)) / 2;
  const heightM = ((north as number) - (south as number)) * 111_320;
  const widthM =
    ((east as number) - (west as number)) *
    111_320 *
    Math.cos((midLatitude * Math.PI) / 180);

  const radius = Math.round(Math.hypot(heightM, widthM) / 2);
  return Number.isFinite(radius) ? Math.abs(radius) : null;
}
