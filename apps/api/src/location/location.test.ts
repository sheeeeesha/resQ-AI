import test from "node:test";
import assert from "node:assert/strict";

import {
  decodePlusCode,
  encodePlusCode,
  isFullPlusCode,
  isShortPlusCode,
  recoverShortCode,
} from "./plus-code.js";
import { extractLocations } from "./extract.js";
import { LocationResolver, distanceMetres } from "./resolve.js";
import { NullGeocoder, type GeocodeMatch, type GeocodeProvider } from "./geocode.js";

/* ------------------------------------------------------------------ *
 * Plus Codes
 * ------------------------------------------------------------------ */

/**
 * Round-trip rather than asserting against a code copied from elsewhere.
 *
 * A copied code only tests that the copy was accurate. Encoding a known point
 * and decoding it back tests the algorithm against itself: the error must land
 * inside the cell the code denotes, at every precision, at every latitude.
 */
const INDIAN_LANDMARKS: Array<[string, number, number]> = [
  ["Charminar, Hyderabad", 17.3616, 78.4747],
  ["India Gate, Delhi", 28.6129, 77.2295],
  ["Gateway of India, Mumbai", 18.922, 72.8347],
  ["Marina Beach, Chennai", 13.05, 80.2824],
];

test("encoding and decoding a Plus Code round-trips within its own cell", () => {
  for (const [name, latitude, longitude] of INDIAN_LANDMARKS) {
    for (const length of [10, 11]) {
      const code = encodePlusCode(latitude, longitude, length);
      assert.ok(code, `${name} at length ${length} should encode`);

      const decoded = decodePlusCode(code!);
      assert.ok(decoded, `${name}: ${code} should decode`);

      const error = distanceMetres({ latitude, longitude }, decoded!);

      // The decoded point is the cell centre, so the original can be up to the
      // cell's half-diagonal away. One metre of slack absorbs the difference
      // between the metres-per-degree constant used for the cell size and the
      // spherical model used for the distance.
      assert.ok(
        error <= decoded!.accuracy_m + 1,
        `${name} length ${length}: ${error.toFixed(1)} m from a cell of radius ${decoded!.accuracy_m} m`,
      );
    }
  }
});

test("a longer code denotes a smaller area", () => {
  const [, latitude, longitude] = INDIAN_LANDMARKS[0]!;

  const eight = decodePlusCode(encodePlusCode(latitude, longitude, 8)!);
  const ten = decodePlusCode(encodePlusCode(latitude, longitude, 10)!);
  const eleven = decodePlusCode(encodePlusCode(latitude, longitude, 11)!);

  assert.ok(eight && ten && eleven);
  assert.ok(eight!.accuracy_m > ten!.accuracy_m);
  assert.ok(ten!.accuracy_m > eleven!.accuracy_m);

  // An 11-digit code is precise enough to identify a building entrance, which
  // is the property that makes it worth reading aloud over radio.
  assert.ok(eleven!.accuracy_m < 5, `${eleven!.accuracy_m} m`);
});

test("a short code is not decoded without a reference", () => {
  // "7J9V+2W" is meaningless on its own — the same suffix exists in every
  // 100 km block on earth. Decoding it against a guessed reference would place
  // an emergency in the wrong city while looking entirely successful.
  assert.equal(isShortPlusCode("7J9V+2W"), true);
  assert.equal(isFullPlusCode("7J9V+2W"), false);
  assert.equal(decodePlusCode("7J9V+2W"), null);
});

test("a short code recovers against a nearby reference", () => {
  const [, latitude, longitude] = INDIAN_LANDMARKS[0]!;

  const full = encodePlusCode(latitude, longitude, 11)!;
  // Drop the first four characters, which is how these are written locally:
  // "9F6F+JVP" next to a locality name that supplies the missing block.
  const short = full.slice(4);

  const recovered = recoverShortCode(short, {
    // A reference a few kilometres away, as a caller's known area would be.
    latitude: latitude + 0.04,
    longitude: longitude + 0.04,
  });

  assert.ok(recovered, `should recover ${short}`);
  const error = distanceMetres({ latitude, longitude }, recovered!);
  assert.ok(error < 20, `recovered ${error.toFixed(1)} m from the true point`);
});

test("malformed codes are rejected rather than half-decoded", () => {
  for (const bad of ["", "hello", "1234+56", "7J9VPXQ2", "++", "7J9VPXQ2+2W+X"]) {
    assert.equal(decodePlusCode(bad), null, `"${bad}" should not decode`);
  }
});

/* ------------------------------------------------------------------ *
 * Extraction from text
 * ------------------------------------------------------------------ */

test("decimal coordinates in a message are found", () => {
  const found = extractLocations("we are at 17.4401, 78.3912 near the flyover");

  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind, "coordinates");
  assert.ok(Math.abs(found[0]!.latitude - 17.4401) < 1e-6);
  assert.ok(Math.abs(found[0]!.longitude - 78.3912) < 1e-6);
  assert.equal(found[0]!.outside_service_area, false);
});

test("hemisphere letters settle the order when it is reversed", () => {
  const found = extractLocations("78.3912 E, 17.4401 N");
  assert.equal(found.length, 1);
  assert.ok(Math.abs(found[0]!.latitude - 17.4401) < 1e-6);
  assert.ok(Math.abs(found[0]!.longitude - 78.3912) < 1e-6);
});

test("a point outside India is flagged, not dropped", () => {
  // Far more often a transposed pair than a genuine foreign caller — but
  // border regions exist, so it is surfaced rather than discarded.
  const found = extractLocations("40.7128, -74.0060");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.outside_service_area, true);
});

test("ordinary text is not mistaken for coordinates", () => {
  // Registration plates, phone numbers and pincodes all contain digit pairs a
  // looser pattern would happily read as a location.
  for (const text of [
    "vehicle MH12 AB 4471",
    "call me on 98765 43210",
    "pincode 500081, sector 12",
    "2 or 3 people, 4 injured",
  ]) {
    assert.deepEqual(extractLocations(text), [], `matched in: ${text}`);
  }
});

test("a Google Maps link yields its coordinates", () => {
  const found = extractLocations(
    "here https://www.google.com/maps?q=17.4401,78.3912 please hurry",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind, "map_link");
});

test("a geo: URI is understood", () => {
  const found = extractLocations("geo:17.4401,78.3912");
  assert.equal(found.length, 1);
  assert.ok(Math.abs(found[0]!.latitude - 17.4401) < 1e-6);
});

test("a link and its bare coordinates are not counted twice", () => {
  const found = extractLocations(
    "https://maps.google.com/?q=17.4401,78.3912 which is 17.4401, 78.3912",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind, "map_link");
});

test("0,0 is treated as a leaked default, not a location", () => {
  assert.deepEqual(extractLocations("0.0000, 0.0000"), []);
});

test("a full Plus Code inside a Hinglish message is found", () => {
  const found = extractLocations("bhai yahan aao 7J9VPXQ2+2W jaldi");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind, "plus_code");
  assert.ok(found[0]!.accuracy_m !== null);
});

/* ------------------------------------------------------------------ *
 * Resolution and the selection decision
 * ------------------------------------------------------------------ */

const NOW = "2026-08-31T09:00:00.000Z";

class StubGeocoder implements GeocodeProvider {
  readonly name = "stub";
  constructor(private readonly matches: GeocodeMatch[]) {}
  async search(): Promise<GeocodeMatch[]> {
    return this.matches;
  }
}

function landmark(latitude: number, longitude: number, label: string): GeocodeMatch {
  return { latitude, longitude, label, confidence: 0.6, accuracy_m: 100, category: "place" };
}

test("a device fix outranks everything the caller said", async () => {
  const resolver = new LocationResolver(
    new StubGeocoder([landmark(17.5, 78.6, "Some Temple")]),
  );

  const { location } = await resolver.resolve({
    stated: { raw: "Shiv Mandir", landmark: "Shiv Mandir", locality: null, city: null, street: null, code: null },
    device: {
      latitude: 17.4401,
      longitude: 78.3912,
      accuracy_m: 40,
      source: "device_els",
      obtained_at: NOW,
    },
    now: NOW,
  });

  assert.equal(location.candidates[0]!.source, "device_els");
  // Device location never passed through the transcript, so it carries no
  // recognition error and is selected without a human.
  assert.equal(location.selected_index, 0);
});

test("a landmark alone is never auto-selected", async () => {
  const resolver = new LocationResolver(
    new StubGeocoder([landmark(17.5, 78.6, "Shiv Mandir, Secunderabad")]),
  );

  const outcome = await resolver.resolve({
    stated: { raw: "Shiv Mandir", landmark: "Shiv Mandir", locality: null, city: null, street: null, code: null },
    now: NOW,
  });

  assert.ok(outcome.location.candidates.length > 0, "the lead is kept");
  // "Shiv Mandir" matches thousands of places. A lead is not a location.
  assert.equal(outcome.location.selected_index, null);
  assert.equal(outcome.needs_human, true);
  assert.match(outcome.ambiguity!, /landmark/i);
});

test("two trusted sources that disagree leave the location unselected", async () => {
  const resolver = new LocationResolver(new NullGeocoder());

  const outcome = await resolver.resolve({
    // A Plus Code in the message, and a device fix 12 km away.
    text: "7J9VPXQ2+2W",
    device: {
      latitude: 17.55,
      longitude: 78.45,
      accuracy_m: 30,
      source: "device_gps",
      obtained_at: NOW,
    },
    now: NOW,
  });

  assert.equal(outcome.location.candidates.length, 2);
  // Silently taking the higher-ranked one would send a vehicle to a place
  // nobody verified, with no indication a choice was made.
  assert.equal(outcome.location.selected_index, null);
  assert.equal(outcome.needs_human, true);
  assert.match(outcome.ambiguity!, /disagree/i);
});

test("trusted sources that agree are selected without a human", async () => {
  const resolver = new LocationResolver(new NullGeocoder());

  const outcome = await resolver.resolve({
    text: "17.4401, 78.3912",
    device: {
      // ~60 m away: the same street corner for dispatch purposes.
      latitude: 17.4406,
      longitude: 78.3914,
      accuracy_m: 30,
      source: "device_gps",
      obtained_at: NOW,
    },
    now: NOW,
  });

  assert.equal(outcome.location.selected_index, 0);
  assert.equal(outcome.needs_human, false);
  assert.equal(outcome.ambiguity, null);
});

test("no signals at all yields nothing rather than a guess", async () => {
  const resolver = new LocationResolver(new NullGeocoder());
  const outcome = await resolver.resolve({ text: "please help", now: NOW });

  assert.deepEqual(outcome.location.candidates, []);
  assert.equal(outcome.location.selected_index, null);
  // Nothing to adjudicate, so this is not a question for a human — it is a
  // question for the caller.
  assert.equal(outcome.needs_human, false);
});

test("a location outside India is demoted below a domestic one", async () => {
  const resolver = new LocationResolver(new NullGeocoder());

  const outcome = await resolver.resolve({
    text: "40.7128, -74.0060 and also 17.4401, 78.3912",
    now: NOW,
  });

  const labels = outcome.location.candidates.map((c) => c.label);
  assert.equal(outcome.location.candidates.length, 2);
  // The domestic point ranks first; the foreign one is kept but demoted.
  assert.ok(labels[0]!.includes("17.4401"));
  assert.match(labels[1]!, /outside the service area/);
});

test("existing candidates from earlier messages are carried forward", async () => {
  const resolver = new LocationResolver(new NullGeocoder());

  const first = await resolver.resolve({ text: "17.4401, 78.3912", now: NOW });
  const second = await resolver.resolve({
    text: "actually we are at 17.4402, 78.3913",
    existing: first.location.candidates,
    now: "2026-08-31T09:05:00.000Z",
  });

  // Same source, near-identical point: collapsed rather than accumulated.
  assert.equal(second.location.candidates.length, 1);
});

/* ------------------------------------------------------------------ *
 * Distance
 * ------------------------------------------------------------------ */

test("distance is in metres and is named so", () => {
  // Hyderabad to Secunderabad, roughly 8 km.
  const d = distanceMetres(
    { latitude: 17.3850, longitude: 78.4867 },
    { latitude: 17.4399, longitude: 78.4983 },
  );

  assert.ok(d > 5_000 && d < 8_000, `${d} m`);
  // The prototype computed this number and rendered it as "miles".
  assert.ok(d > 100, "metres, not kilometres");
});

test("distance is symmetric and zero for a point to itself", () => {
  const a = { latitude: 17.44, longitude: 78.39 };
  const b = { latitude: 12.97, longitude: 77.59 };

  assert.equal(Math.round(distanceMetres(a, a)), 0);
  assert.equal(Math.round(distanceMetres(a, b)), Math.round(distanceMetres(b, a)));
});
