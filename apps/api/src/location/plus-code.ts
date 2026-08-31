/**
 * Open Location Code (Plus Code) decoding.
 *
 * Implemented rather than pulled in as a dependency because it is a pure,
 * fully-specified algorithm — no network, no key, no rate limit, and no third
 * party told where an emergency is happening. That last property is the point:
 * this is the one location path that still works when every external service
 * is unreachable.
 *
 * Plus Codes matter more in India than almost anywhere else. Large areas have
 * no street addressing at all, India Post has moved to grid-based digital
 * addressing, and a Plus Code is short enough to read aloud over a bad line.
 * When one appears in a message it is the most trustworthy thing in that
 * message, and it costs nothing to use.
 *
 * Spec: https://github.com/google/open-location-code
 */

const ALPHABET = "23456789CFGHJMPQRVWX";
const SEPARATOR = "+";
const SEPARATOR_POSITION = 8;
const PADDING = "0";
const PAIR_CODE_LENGTH = 10;
const GRID_COLUMNS = 4;
const GRID_ROWS = 5;

/** Initial place value: 20^2, so the first division yields 20 degrees. */
const INITIAL_PLACE_VALUE = 400;

export interface DecodedArea {
  /** Centre of the area the code denotes. */
  latitude: number;
  longitude: number;

  /**
   * Radius in metres of a circle containing the area.
   *
   * Reported as a radius rather than box dimensions because everything
   * downstream — candidate ranking, proximity search, the console's
   * uncertainty circle — works in radii. Converting once here beats
   * converting in five places.
   */
  accuracy_m: number;

  /** Digits after stripping separator and padding. More digits, tighter box. */
  precision: number;
}

function digitValue(char: string): number {
  return ALPHABET.indexOf(char.toUpperCase());
}

/**
 * Whether a string is a full, self-sufficient Plus Code.
 *
 * Short codes such as `7J9V+2W` are rejected here on purpose. They are only
 * meaningful relative to a reference location, and decoding one against a
 * guessed reference would place an emergency in the wrong city while looking
 * entirely successful. `recoverShortCode` handles those, and demands the
 * reference explicitly.
 */
export function isFullPlusCode(code: string): boolean {
  const separatorIndex = code.indexOf(SEPARATOR);
  if (separatorIndex !== SEPARATOR_POSITION) return false;
  if (code.indexOf(SEPARATOR, separatorIndex + 1) !== -1) return false;

  const body = code.replace(SEPARATOR, "");

  // Padding is legal only as a trailing run within the first eight digits, and
  // only in even amounts — it stands in for whole unresolved pairs.
  const firstPad = body.indexOf(PADDING);
  if (firstPad !== -1) {
    if (firstPad < 2 || firstPad % 2 === 1) return false;
    if (!/^0+$/.test(body.slice(firstPad))) return false;
    if (body.length > SEPARATOR_POSITION) return false;
  }

  for (const char of body) {
    if (char !== PADDING && digitValue(char) === -1) return false;
  }

  // The first digit encodes latitude in 20-degree steps; anything above 8
  // would place the code past the pole.
  if (digitValue(body[0]!) > 8) return false;
  if (body.length > 1 && digitValue(body[1]!) > 17) return false;

  return body.replace(/0+$/, "").length >= 2;
}

/** True for a short code such as `7J9V+2W`, which needs a reference point. */
export function isShortPlusCode(code: string): boolean {
  const separatorIndex = code.indexOf(SEPARATOR);
  if (separatorIndex === -1 || separatorIndex >= SEPARATOR_POSITION) return false;
  if (separatorIndex % 2 === 1) return false;
  return !isFullPlusCode(code);
}

/**
 * Decodes a full Plus Code to the centre of its area.
 *
 * Returns null rather than throwing. A malformed code inside a caller message
 * is data, not a programming error, and the caller of this function should
 * fall through to other location sources rather than catch an exception.
 */
export function decodePlusCode(code: string): DecodedArea | null {
  if (!isFullPlusCode(code)) return null;

  const clean = code.replace(SEPARATOR, "").replace(/0+$/, "").toUpperCase();

  let latitude = -90;
  let longitude = -180;
  let latPlaceValue = INITIAL_PLACE_VALUE;
  let lngPlaceValue = INITIAL_PLACE_VALUE;
  let position = 0;

  // Pair section: each pair refines both axes by a factor of 20.
  while (position < Math.min(clean.length, PAIR_CODE_LENGTH)) {
    latPlaceValue /= 20;
    lngPlaceValue /= 20;
    latitude += digitValue(clean[position]!) * latPlaceValue;
    longitude += digitValue(clean[position + 1]!) * lngPlaceValue;
    position += 2;
  }

  // Grid section: each further character subdivides the cell into 4 x 5.
  while (position < clean.length) {
    latPlaceValue /= GRID_ROWS;
    lngPlaceValue /= GRID_COLUMNS;
    const digit = digitValue(clean[position]!);
    latitude += Math.floor(digit / GRID_COLUMNS) * latPlaceValue;
    longitude += (digit % GRID_COLUMNS) * lngPlaceValue;
    position += 1;
  }

  const centreLatitude = latitude + latPlaceValue / 2;
  const centreLongitude = longitude + lngPlaceValue / 2;

  return {
    latitude: centreLatitude,
    longitude: centreLongitude,
    accuracy_m: boxRadiusMetres(centreLatitude, latPlaceValue, lngPlaceValue),
    precision: clean.length,
  };
}

/**
 * Encodes a point as a Plus Code.
 *
 * The inverse of `decodePlusCode`, and useful in its own right: a Plus Code is
 * short enough for a dispatcher to read aloud over radio to a crew who cannot
 * take a coordinate pair, which is a real constraint on Indian field comms.
 *
 * It also makes this module verifiable without an external reference — encode
 * a known point, decode it back, and the round-trip error must be smaller than
 * the code's own resolution. That is a stronger check than asserting against a
 * code copied from somewhere, which only tests that the copy was accurate.
 *
 * `codeLength` 10 gives roughly 14 m; 11 gives roughly 3 m.
 */
export function encodePlusCode(
  latitude: number,
  longitude: number,
  codeLength = 10,
): string | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  // Below the pair section, only even lengths exist — each pair contributes one
  // latitude and one longitude digit. Above it the grid section adds single
  // characters, so 11 and 12 are both legal and 11 is the common precise form.
  if (codeLength < 2) return null;
  if (codeLength < PAIR_CODE_LENGTH && codeLength % 2 === 1) return null;

  // Clamp rather than reject: a latitude of exactly 90 is legal input and
  // would otherwise fall outside the top cell.
  const lat = Math.min(Math.max(latitude, -90), 90);
  const lng = ((((longitude + 180) % 360) + 360) % 360) - 180;

  let remainingLat = lat + 90;
  let remainingLng = lng + 180;
  if (remainingLat >= 180) remainingLat = 179.999999;

  let code = "";
  let placeValue = INITIAL_PLACE_VALUE;

  const pairDigits = Math.min(codeLength, PAIR_CODE_LENGTH);
  for (let i = 0; i < pairDigits; i += 2) {
    placeValue /= 20;
    const latDigit = Math.min(Math.floor(remainingLat / placeValue), 19);
    const lngDigit = Math.min(Math.floor(remainingLng / placeValue), 19);
    code += ALPHABET[latDigit]! + ALPHABET[lngDigit]!;
    remainingLat -= latDigit * placeValue;
    remainingLng -= lngDigit * placeValue;
  }

  let latPlaceValue = placeValue;
  let lngPlaceValue = placeValue;

  for (let i = PAIR_CODE_LENGTH; i < codeLength; i += 1) {
    latPlaceValue /= GRID_ROWS;
    lngPlaceValue /= GRID_COLUMNS;
    const row = Math.min(Math.floor(remainingLat / latPlaceValue), GRID_ROWS - 1);
    const col = Math.min(Math.floor(remainingLng / lngPlaceValue), GRID_COLUMNS - 1);
    code += ALPHABET[row * GRID_COLUMNS + col]!;
    remainingLat -= row * latPlaceValue;
    remainingLng -= col * lngPlaceValue;
  }

  // Pad out to the separator position for codes shorter than eight digits.
  if (code.length < SEPARATOR_POSITION) {
    code += PADDING.repeat(SEPARATOR_POSITION - code.length);
  }

  return (
    code.slice(0, SEPARATOR_POSITION) +
    SEPARATOR +
    code.slice(SEPARATOR_POSITION)
  );
}

/**
 * Expands a short code against a reference point.
 *
 * The reference has to be genuinely nearby — within roughly 40 km for a code
 * missing four digits — because recovery selects the nearest matching cell.
 * A reference from the wrong city produces a confident wrong answer, which is
 * why there is no default and the caller must supply one.
 */
export function recoverShortCode(
  code: string,
  reference: { latitude: number; longitude: number },
): DecodedArea | null {
  if (!isShortPlusCode(code)) return null;

  const separatorIndex = code.indexOf(SEPARATOR);
  const missingDigits = SEPARATOR_POSITION - separatorIndex;
  if (missingDigits <= 0 || missingDigits % 2 === 1) return null;

  // Size of the block the missing digits would have identified.
  const resolution = 20 / Math.pow(20, missingDigits / 2 - 1);

  const prefix = encodePrefix(
    Math.floor(reference.latitude / resolution) * resolution,
    Math.floor(reference.longitude / resolution) * resolution,
    missingDigits,
  );
  if (prefix === null) return null;

  const decoded = decodePlusCode(prefix + code);
  if (!decoded) return null;

  // Recovery can land a block away when the reference sits near an edge.
  // Nudge toward the reference so the result is the nearest matching cell.
  let { latitude, longitude } = decoded;
  if (latitude - reference.latitude > resolution / 2) latitude -= resolution;
  else if (reference.latitude - latitude > resolution / 2) latitude += resolution;

  if (longitude - reference.longitude > resolution / 2) longitude -= resolution;
  else if (reference.longitude - longitude > resolution / 2) longitude += resolution;

  return { ...decoded, latitude, longitude };
}

/** Encodes the leading `digits` characters of the code covering a point. */
function encodePrefix(
  latitude: number,
  longitude: number,
  digits: number,
): string | null {
  let remainingLat = latitude + 90;
  let remainingLng = longitude + 180;
  if (remainingLat < 0 || remainingLat >= 180) return null;
  if (remainingLng < 0 || remainingLng >= 360) return null;

  let out = "";
  let placeValue = INITIAL_PLACE_VALUE;

  for (let i = 0; i < digits; i += 2) {
    placeValue /= 20;
    const latDigit = Math.min(Math.floor(remainingLat / placeValue), 19);
    const lngDigit = Math.min(Math.floor(remainingLng / placeValue), 19);
    out += ALPHABET[latDigit]! + ALPHABET[lngDigit]!;
    remainingLat -= latDigit * placeValue;
    remainingLng -= lngDigit * placeValue;
  }

  return out;
}

/** Radius in metres of a circle containing the code's bounding box. */
function boxRadiusMetres(
  latitude: number,
  latSpanDegrees: number,
  lngSpanDegrees: number,
): number {
  const metresPerDegreeLatitude = 111_320;
  const metresPerDegreeLongitude =
    111_320 * Math.cos((latitude * Math.PI) / 180);

  const heightM = latSpanDegrees * metresPerDegreeLatitude;
  const widthM = lngSpanDegrees * Math.abs(metresPerDegreeLongitude);

  return Math.round(Math.hypot(heightM, widthM) / 2);
}
