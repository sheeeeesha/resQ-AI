import { decodePlusCode, isShortPlusCode, recoverShortCode } from "./plus-code.js";

/**
 * Pulling machine-readable locations out of message text.
 *
 * Everything here is offline and exact. A caller who sends coordinates, a Plus
 * Code or a map link has handed over a location with no ambiguity and no
 * recognition error, and treating that as just another string for the language
 * model to interpret would throw away the best signal in the message.
 *
 * This runs before extraction and independently of it, so a model outage or a
 * rate limit cannot cost us a location the caller stated precisely.
 */

/** Roughly the Indian landmass plus territorial waters and a border margin. */
const INDIA_BOUNDS = {
  minLatitude: 6.0,
  maxLatitude: 37.5,
  minLongitude: 67.5,
  maxLongitude: 97.5,
};

export interface ExtractedLocation {
  latitude: number;
  longitude: number;
  /** Which pattern produced this, for provenance in the candidate. */
  kind: "coordinates" | "plus_code" | "map_link";
  /** Radius of uncertainty in metres, where the format implies one. */
  accuracy_m: number | null;
  /** The exact substring matched, retained for the audit trail. */
  matched: string;
  /**
   * True when the point falls outside India.
   *
   * Not rejected — border regions and genuinely foreign callers exist — but
   * surfaced, because the far more common cause is a transposed pair, and a
   * silently swapped latitude and longitude is a plausible-looking point
   * thousands of kilometres from the emergency.
   */
  outside_service_area: boolean;
}

function withinIndia(latitude: number, longitude: number): boolean {
  return (
    latitude >= INDIA_BOUNDS.minLatitude &&
    latitude <= INDIA_BOUNDS.maxLatitude &&
    longitude >= INDIA_BOUNDS.minLongitude &&
    longitude <= INDIA_BOUNDS.maxLongitude
  );
}

function build(
  latitude: number,
  longitude: number,
  kind: ExtractedLocation["kind"],
  matched: string,
  accuracy_m: number | null,
): ExtractedLocation | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90) return null;
  if (longitude < -180 || longitude > 180) return null;

  // 0,0 is in the Gulf of Guinea and is almost always a default that leaked
  // through rather than a position anyone reported.
  if (latitude === 0 && longitude === 0) return null;

  return {
    latitude,
    longitude,
    kind,
    accuracy_m,
    matched: matched.trim(),
    outside_service_area: !withinIndia(latitude, longitude),
  };
}

/* ------------------------------------------------------------------ *
 * Coordinates
 * ------------------------------------------------------------------ */

/**
 * Decimal degrees, optionally with hemisphere letters.
 *
 * Requires a separator and at least three decimal places on each value.
 * Without that, ordinary text produces matches — Indian vehicle plates, phone
 * fragments and pincodes all contain digit pairs that a looser pattern reads
 * as a location.
 *
 * Hemisphere letters are accepted on either position, and each must be
 * followed by a word boundary. Without that boundary the "w" of "which" reads
 * as a West marker and silently negates the longitude, turning a Hyderabad
 * coordinate into a point in the Atlantic while still looking like a clean
 * parse. Written with String.raw so the escapes stay legible.
 */
const DECIMAL_PAIR = new RegExp(
  String.raw`(-?\d{1,3}\.\d{3,})\s*°?\s*(?:([NSEW])\b)?\s*[,;/ ]\s*(-?\d{1,3}\.\d{3,})\s*°?\s*(?:([NSEW])\b)?`,
  "gi",
);

function parseCoordinates(text: string): ExtractedLocation[] {
  const found: ExtractedLocation[] = [];

  for (const match of text.matchAll(DECIMAL_PAIR)) {
    const [matched, rawFirst, firstHemisphere, rawSecond, secondHemisphere] = match;

    let first = Number(rawFirst);
    let second = Number(rawSecond);

    const firstLetter = firstHemisphere?.toUpperCase();
    const secondLetter = secondHemisphere?.toUpperCase();

    if (firstLetter === "S" || firstLetter === "W") first = -Math.abs(first);
    if (secondLetter === "S" || secondLetter === "W") second = -Math.abs(second);

    let latitude = first;
    let longitude = second;

    // Hemisphere letters settle the order when the pair is written the other
    // way round, which several mapping tools and most dictation produce.
    if (firstLetter === "E" || firstLetter === "W") {
      latitude = second;
      longitude = first;
    } else if (!firstLetter && !secondLetter && Math.abs(first) > 90) {
      // Unlabelled, and the first value cannot be a latitude.
      latitude = second;
      longitude = first;
    }

    const location = build(latitude, longitude, "coordinates", matched!, null);
    if (location) found.push(location);
  }

  return found;
}

/* ------------------------------------------------------------------ *
 * Plus Codes
 * ------------------------------------------------------------------ */

/** Full codes have eight leading characters; short ones have two, four or six. */
const PLUS_CODE = /\b([23456789CFGHJMPQRVWX0]{2,8}\+[23456789CFGHJMPQRVWX]{2,7})\b/gi;

function parsePlusCodes(
  text: string,
  reference: { latitude: number; longitude: number } | null,
): ExtractedLocation[] {
  const found: ExtractedLocation[] = [];

  for (const match of text.matchAll(PLUS_CODE)) {
    const code = match[1]!;

    const full = decodePlusCode(code);
    if (full) {
      const location = build(
        full.latitude,
        full.longitude,
        "plus_code",
        code,
        full.accuracy_m,
      );
      if (location) found.push(location);
      continue;
    }

    // A short code without a reference is left alone rather than guessed at.
    // Resolving it against the wrong city is worse than not resolving it.
    if (reference && isShortPlusCode(code)) {
      const recovered = recoverShortCode(code, reference);
      if (recovered) {
        const location = build(
          recovered.latitude,
          recovered.longitude,
          "plus_code",
          code,
          recovered.accuracy_m,
        );
        if (location) found.push(location);
      }
    }
  }

  return found;
}

/* ------------------------------------------------------------------ *
 * Map links
 * ------------------------------------------------------------------ */

/**
 * Coordinates embedded in map URLs.
 *
 * Covers the forms people actually paste from Android and iOS share sheets.
 * Shortened links (`maps.app.goo.gl`) are deliberately not followed: resolving
 * one means an outbound request to a third party carrying an emergency
 * location, which is not a decision to make silently inside a text parser.
 */
const MAP_LINK_PATTERNS = [
  /(?:google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)[^\s]*?[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/gi,
  /google\.[a-z.]+\/maps[^\s]*?@(-?\d+\.\d+),(-?\d+\.\d+)/gi,
  /geo:(-?\d+\.\d+),(-?\d+\.\d+)/gi,
  /openstreetmap\.org[^\s]*?[#?]map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/gi,
];

function parseMapLinks(text: string): ExtractedLocation[] {
  const found: ExtractedLocation[] = [];

  for (const pattern of MAP_LINK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const location = build(
        Number(match[1]),
        Number(match[2]),
        "map_link",
        match[0]!,
        null,
      );
      if (location) found.push(location);
    }
  }

  return found;
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

/**
 * Extracts every machine-readable location in a message.
 *
 * Returns all of them rather than the first. A message can legitimately carry
 * more than one — a caller correcting themselves, or quoting a landmark's code
 * alongside their own position — and choosing between them is a ranking
 * decision that belongs upstream with the other candidates, not here.
 *
 * `reference` enables short Plus Code recovery. Pass the caller's known area
 * when there is one, and nothing when there is not.
 */
export function extractLocations(
  text: string,
  reference: { latitude: number; longitude: number } | null = null,
): ExtractedLocation[] {
  const found = [
    ...parseMapLinks(text),
    ...parseCoordinates(text),
    ...parsePlusCodes(text, reference),
  ];

  // A map link contains a coordinate pair, so the same point arrives twice.
  // Deduplicate at roughly a metre, keeping the first — map links are parsed
  // first because the link is the more informative provenance.
  const seen = new Set<string>();
  return found.filter((location) => {
    const key = `${location.latitude.toFixed(5)},${location.longitude.toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
