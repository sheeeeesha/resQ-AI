import test from "node:test";
import assert from "node:assert/strict";
import type { ResolvedLocation } from "@resqai/schema";

import { createHarness, type Harness } from "../test-support/harness.js";
import { UnitRepository } from "./repository.js";
import { DispatchService } from "./dispatch.js";
import { StraightLineRouter, estimateLeg, type RoutingProvider, type RouteRequest, type RouteLeg } from "./routing.js";

/**
 * Dispatch, against real PostGIS.
 *
 * The proximity query is a PostGIS geography query with a GIST index, so it can
 * only be meaningfully tested against a real Postgres. PGlite gives us that
 * in-process, which is why these are unit-test-cheap rather than integration
 * ceremony.
 */

/* Hyderabad, so distances are recognisable. */
const CHARMINAR = { latitude: 17.3616, longitude: 78.4747 };

async function withUnits(
  fn: (ctx: { h: Harness; units: UnitRepository }) => Promise<void>,
): Promise<void> {
  const h = await createHarness();
  try {
    await fn({ h, units: new UnitRepository(h.db) });
  } finally {
    await h.close();
  }
}

/** Offsets a point by roughly the given metres, north and east. */
function offset(
  point: { latitude: number; longitude: number },
  northM: number,
  eastM: number,
) {
  return {
    latitude: point.latitude + northM / 111_320,
    longitude:
      point.longitude +
      eastM / (111_320 * Math.cos((point.latitude * Math.PI) / 180)),
  };
}

async function seed(units: UnitRepository) {
  const near = offset(CHARMINAR, 800, 0);
  const mid = offset(CHARMINAR, 3_000, 0);
  const far = offset(CHARMINAR, 12_000, 0);

  await units.upsert({
    unit_id: "AMB-01", name: "Ambulance 01", kind: "ambulance",
    latitude: near.latitude, longitude: near.longitude,
    availability: "available", station: "Charminar PHC",
  });
  await units.upsert({
    unit_id: "AMB-02", name: "Ambulance 02", kind: "ambulance",
    latitude: mid.latitude, longitude: mid.longitude,
    availability: "available",
  });
  await units.upsert({
    unit_id: "AMB-03", name: "Ambulance 03", kind: "ambulance",
    latitude: far.latitude, longitude: far.longitude,
    availability: "available",
  });
  await units.upsert({
    unit_id: "FIRE-01", name: "Fire Tender 01", kind: "fire_tender",
    latitude: mid.latitude, longitude: mid.longitude,
    availability: "available",
  });
  await units.upsert({
    unit_id: "AMB-BUSY", name: "Ambulance Busy", kind: "ambulance",
    latitude: CHARMINAR.latitude, longitude: CHARMINAR.longitude,
    availability: "assigned",
  });
}

function confirmedAt(point: { latitude: number; longitude: number }): ResolvedLocation {
  return {
    candidates: [
      {
        source: "device_els",
        point,
        accuracy_m: 30,
        label: "Device location",
        trust: 100,
        obtained_at: "2026-08-31T09:00:00.000Z",
      },
    ],
    selected_index: 0,
    selected_by_human: false,
    stated: null,
  };
}

const UNRESOLVED: ResolvedLocation = {
  candidates: [
    {
      source: "stated_landmark",
      point: CHARMINAR,
      accuracy_m: 500,
      label: "Shiv Mandir",
      trust: 20,
      obtained_at: "2026-08-31T09:00:00.000Z",
    },
    {
      source: "stated_landmark",
      point: offset(CHARMINAR, 12_000, 0),
      accuracy_m: 500,
      label: "Shiv Mandir, Secunderabad",
      trust: 20,
      obtained_at: "2026-08-31T09:00:00.000Z",
    },
  ],
  selected_index: null,
  selected_by_human: false,
  stated: null,
};

/* ------------------------------------------------------------------ *
 * Proximity
 * ------------------------------------------------------------------ */

test("nearest returns units in distance order with real distances", async () => {
  await withUnits(async ({ units }) => {
    await seed(units);

    const found = await units.nearest({
      point: CHARMINAR,
      kinds: ["ambulance"],
      radiusM: 20_000,
    });

    assert.deepEqual(
      found.map((u) => u.unit_id),
      ["AMB-01", "AMB-02", "AMB-03"],
      "closest first; the assigned unit is excluded",
    );

    // PostGIS geography distance is in metres and spheroid-accurate.
    assert.ok(
      Math.abs(found[0]!.straight_line_m - 800) < 50,
      `expected ~800 m, got ${found[0]!.straight_line_m}`,
    );
  });
});

test("the radius actually excludes", async () => {
  await withUnits(async ({ units }) => {
    await seed(units);

    const found = await units.nearest({
      point: CHARMINAR,
      kinds: ["ambulance"],
      radiusM: 5_000,
    });

    assert.deepEqual(found.map((u) => u.unit_id), ["AMB-01", "AMB-02"]);
  });
});

test("kind filtering keeps lanes apart", async () => {
  await withUnits(async ({ units }) => {
    await seed(units);

    const fire = await units.nearest({
      point: CHARMINAR,
      kinds: ["fire_tender"],
      radiusM: 20_000,
    });
    assert.deepEqual(fire.map((u) => u.unit_id), ["FIRE-01"]);
  });
});

test("a stale unit is not offered", async () => {
  await withUnits(async ({ h, units }) => {
    await seed(units);

    // A vehicle that has not reported for an hour is not meaningfully
    // available, whatever its row says.
    await h.db.query(
      "UPDATE response_units SET last_seen_at = now() - interval '2 hours' WHERE unit_id = 'AMB-01'",
    );

    const found = await units.nearest({
      point: CHARMINAR,
      kinds: ["ambulance"],
      radiusM: 20_000,
      maxStalenessS: 3600,
    });

    assert.ok(!found.some((u) => u.unit_id === "AMB-01"));
    assert.equal(found[0]!.unit_id, "AMB-02");
  });
});

/* ------------------------------------------------------------------ *
 * The location gate
 * ------------------------------------------------------------------ */

test("an unconfirmed location produces no recommendation", async () => {
  await withUnits(async ({ units }) => {
    await seed(units);
    const dispatch = new DispatchService(units, new StraightLineRouter());

    const result = await dispatch.recommend({
      location: UNRESOLVED,
      agencies: ["health"],
      priority: "P0_immediate",
    });

    // Ranking distances from a point nobody verified, and presenting them with
    // the same confidence as a real one, is the failure this gate exists for.
    assert.deepEqual(result.units, []);
    assert.match(result.blocked_reason!, /not confirmed/i);
  });
});

test("no location at all is distinguished from no units", async () => {
  await withUnits(async ({ units }) => {
    const dispatch = new DispatchService(units, new StraightLineRouter());

    const noLocation = await dispatch.recommend({
      location: { candidates: [], selected_index: null, selected_by_human: false, stated: null },
      agencies: ["health"],
      priority: "P1_urgent",
    });
    assert.match(noLocation.blocked_reason!, /No location/i);

    await seed(units);
    const noUnits = await dispatch.recommend({
      // Confirmed, but 400 km away in Bengaluru.
      location: confirmedAt({ latitude: 12.9716, longitude: 77.5946 }),
      agencies: ["health"],
      priority: "P1_urgent",
    });
    // Both return an empty list; only the reason tells the call-taker which
    // question to ask next.
    assert.match(noUnits.blocked_reason!, /No units/i);
  });
});

/* ------------------------------------------------------------------ *
 * Ranking
 * ------------------------------------------------------------------ */

test("road travel time reorders the straight-line shortlist", async () => {
  await withUnits(async ({ units }) => {
    await seed(units);

    // A router where the nearest unit by line is slowest by road — a rail
    // crossing, a one-way flyover, the wrong side of a divided highway.
    const inverting: RoutingProvider = {
      name: "inverting",
      async route(request: RouteRequest): Promise<RouteLeg[]> {
        const legs = request.to.map((d) => estimateLeg(request.from, d));
        const maxTime = Math.max(...legs.map((l) => l.travel_time_s ?? 0));
        return legs.map((leg) => ({
          ...leg,
          travel_time_s: maxTime - (leg.travel_time_s ?? 0),
          is_fallback_estimate: false,
        }));
      },
    };

    const dispatch = new DispatchService(units, inverting);
    const result = await dispatch.recommend({
      location: confirmedAt(CHARMINAR),
      agencies: ["health"],
      priority: "P0_immediate",
    });

    // The nearest by line is now the slowest by road, so it must not lead.
    assert.notEqual(result.units[0]!.unit_id, "AMB-01");
    assert.equal(result.degraded_routing, false);

    // Straight-line distance is still reported, just not ranked on.
    assert.ok(result.units[0]!.straight_line_m > 0);
  });
});

test("a straight-line fallback is flagged on every unit", async () => {
  await withUnits(async ({ units }) => {
    await seed(units);
    const dispatch = new DispatchService(units, new StraightLineRouter());

    const result = await dispatch.recommend({
      location: confirmedAt(CHARMINAR),
      agencies: ["health"],
      priority: "P1_urgent",
    });

    assert.ok(result.units.length > 0);
    // An unlabelled fallback estimate is indistinguishable from a routed one
    // at exactly the moment it matters.
    assert.ok(result.units.every((u) => u.is_fallback_estimate));
    assert.equal(result.degraded_routing, true);
  });
});

test("the list stays balanced across agency lanes", async () => {
  await withUnits(async ({ units }) => {
    await seed(units);
    const dispatch = new DispatchService(units, new StraightLineRouter());

    const result = await dispatch.recommend({
      location: confirmedAt(CHARMINAR),
      agencies: ["health", "fire"],
      priority: "P0_immediate",
      perAgency: 2,
    });

    const kinds = new Set(result.units.map((u) => u.kind));
    // Ranking purely by arrival time would fill the list with ambulances and
    // show no fire tender at all, which is useless to whoever must send both.
    assert.ok(kinds.has("ambulance"), "ambulances present");
    assert.ok(kinds.has("fire_tender"), "fire tender present");
  });
});

test("when nothing is free, committed units are offered with a reason", async () => {
  await withUnits(async ({ units }) => {
    await units.upsert({
      unit_id: "AMB-ONLY", name: "The only ambulance", kind: "ambulance",
      latitude: CHARMINAR.latitude, longitude: CHARMINAR.longitude,
      availability: "assigned",
    });

    const dispatch = new DispatchService(units, new StraightLineRouter());
    const result = await dispatch.recommend({
      location: confirmedAt(CHARMINAR),
      agencies: ["health"],
      priority: "P0_immediate",
    });

    // An empty list would read as "no ambulance exists". The dispatcher needs
    // to see what is committed so they can make a reassignment decision.
    assert.equal(result.units.length, 1);
    assert.equal(result.units[0]!.availability, "assigned");
    assert.match(result.blocked_reason!, /reassign/i);
  });
});

/* ------------------------------------------------------------------ *
 * Recommendations and dispatch
 * ------------------------------------------------------------------ */

test("a recommendation snapshots unit state at the time it was made", async () => {
  await withUnits(async ({ h, units }) => {
    await seed(units);
    const incident = await h.repo.create({ reference: "TS-UNITS-1", channel: "web" });

    const dispatch = new DispatchService(units, new StraightLineRouter());
    const result = await dispatch.recommend({
      location: confirmedAt(CHARMINAR),
      agencies: ["health"],
      priority: "P1_urgent",
    });

    await units.recordRecommendations(incident.incident_id, CHARMINAR, result.units);

    // The unit then moves 40 km away.
    await units.reportStatus("AMB-01", { latitude: 17.7, longitude: 78.9 });

    const stored = await units.latestRecommendations(incident.incident_id);
    const amb = stored.find((r) => r.unit_id === "AMB-01")!;

    // "Why was this unit chosen" can only be answered with where it was then.
    assert.ok(Math.abs((amb.unit_lat as number) - CHARMINAR.latitude) < 0.05);
    assert.ok(Math.abs((amb.from_lat as number) - CHARMINAR.latitude) < 1e-9);
  });
});

test("dispatch requires a prior recommendation and is recorded against an operator", async () => {
  await withUnits(async ({ h, units }) => {
    await seed(units);
    const incident = await h.repo.create({ reference: "TS-UNITS-2", channel: "web" });

    const dispatch = new DispatchService(units, new StraightLineRouter());
    const result = await dispatch.recommend({
      location: confirmedAt(CHARMINAR),
      agencies: ["health"],
      priority: "P0_immediate",
    });
    await units.recordRecommendations(incident.incident_id, CHARMINAR, result.units);

    // A unit that was never recommended for this incident cannot be dispatched.
    assert.equal(
      await units.markDispatched(incident.incident_id, "FIRE-01", "op-1"),
      false,
    );

    assert.equal(
      await units.markDispatched(incident.incident_id, "AMB-01", "op-1"),
      true,
    );

    const stored = await units.latestRecommendations(incident.incident_id);
    const amb = stored.find((r) => r.unit_id === "AMB-01")!;
    assert.equal(amb.dispatched_by, "op-1");
    assert.ok(amb.dispatched_at);

    // The unit is now committed and drops out of availability searches.
    const free = await units.nearest({
      point: CHARMINAR, kinds: ["ambulance"], radiusM: 20_000,
    });
    assert.ok(!free.some((u) => u.unit_id === "AMB-01"));
  });
});

test("the same unit cannot be dispatched twice to one incident", async () => {
  await withUnits(async ({ h, units }) => {
    await seed(units);
    const incident = await h.repo.create({ reference: "TS-UNITS-3", channel: "web" });

    const dispatch = new DispatchService(units, new StraightLineRouter());
    const result = await dispatch.recommend({
      location: confirmedAt(CHARMINAR),
      agencies: ["health"],
      priority: "P0_immediate",
    });
    await units.recordRecommendations(incident.incident_id, CHARMINAR, result.units);

    assert.equal(await units.markDispatched(incident.incident_id, "AMB-01", "op-1"), true);
    assert.equal(await units.markDispatched(incident.incident_id, "AMB-01", "op-2"), false);
  });
});

/* ------------------------------------------------------------------ *
 * Routing fallback
 * ------------------------------------------------------------------ */

test("the straight-line estimate is pessimistic about road distance", () => {
  const leg = estimateLeg(CHARMINAR, offset(CHARMINAR, 1_000, 0));

  assert.ok(leg.is_fallback_estimate);
  assert.ok(Math.abs(leg.straight_line_m - 1_000) < 20);
  // Real roads are not straight. Under-reporting distance means over-promising
  // arrival, which is the more harmful direction of error.
  assert.ok(leg.road_distance_m! > leg.straight_line_m);
  assert.ok(leg.travel_time_s! > 0);
});
