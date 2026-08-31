import { loadConfig } from "../config.js";
import { connect } from "./connect.js";
import { UnitRepository } from "../units/repository.js";

/**
 * Seeds a demonstration unit roster. Run with `npm run db:seed-units`.
 *
 * Real positions around Hyderabad so proximity search returns something a
 * person familiar with the city can sanity-check — a unit at Charminar should
 * come back for an incident in the old city and not for one in Hitec City.
 *
 * These are demonstration data, not a real roster. A deployment integrates with
 * the operating agency's own vehicle tracking; the `unit_id` prefix keeps these
 * identifiable so they can be removed cleanly.
 */

const PREFIX = "DEMO-";

const UNITS = [
  // Ambulances, spread across the city.
  { id: "AMB-01", name: "108 Ambulance · Charminar", kind: "ambulance", lat: 17.3616, lon: 78.4747, station: "Charminar UPHC" },
  { id: "AMB-02", name: "108 Ambulance · Osmania General", kind: "ambulance", lat: 17.3713, lon: 78.4804, station: "Osmania General Hospital" },
  { id: "AMB-03", name: "108 Ambulance · Gachibowli", kind: "ambulance", lat: 17.4401, lon: 78.3489, station: "Gachibowli" },
  { id: "AMB-04", name: "108 Ambulance · Secunderabad", kind: "ambulance", lat: 17.4399, lon: 78.4983, station: "Gandhi Hospital" },
  { id: "AMB-05", name: "108 Ambulance · LB Nagar", kind: "ambulance", lat: 17.3457, lon: 78.5522, station: "LB Nagar" },
  { id: "AMB-06", name: "108 Advanced Life Support · NIMS", kind: "ambulance", lat: 17.4239, lon: 78.4483, station: "NIMS Punjagutta", capabilities: ["als", "cardiac"] },

  // Police.
  { id: "POL-01", name: "Patrol · Charminar PS", kind: "police_vehicle", lat: 17.3606, lon: 78.4744, station: "Charminar" },
  { id: "POL-02", name: "Patrol · Banjara Hills PS", kind: "police_vehicle", lat: 17.4126, lon: 78.4392, station: "Banjara Hills" },
  { id: "POL-03", name: "Patrol · Cyberabad", kind: "police_vehicle", lat: 17.4483, lon: 78.3915, station: "Madhapur" },
  { id: "POL-04", name: "Patrol · Secunderabad PS", kind: "police_vehicle", lat: 17.4401, lon: 78.4983, station: "Secunderabad" },
  { id: "POL-05", name: "SHE Team · Central", kind: "police_vehicle", lat: 17.3850, lon: 78.4867, station: "Abids", capabilities: ["women_safety"] },

  // Fire.
  { id: "FIRE-01", name: "Fire Tender · Gandhi Bhavan", kind: "fire_tender", lat: 17.3891, lon: 78.4744, station: "Gandhi Bhavan" },
  { id: "FIRE-02", name: "Fire Tender · Secunderabad", kind: "fire_tender", lat: 17.4448, lon: 78.4982, station: "Secunderabad" },
  { id: "FIRE-03", name: "Fire Tender · Madhapur", kind: "fire_tender", lat: 17.4485, lon: 78.3908, station: "Madhapur" },

  // Rescue.
  { id: "RES-01", name: "NDRF Rescue Team", kind: "rescue_team", lat: 17.4065, lon: 78.4772, station: "Hyderabad", capabilities: ["collapse", "water"] },
];

async function main(): Promise<void> {
  const config = loadConfig();
  const db = connect(config.DATABASE_URL);
  const units = new UnitRepository(db);

  try {
    for (const unit of UNITS) {
      await units.upsert({
        unit_id: PREFIX + unit.id,
        name: unit.name,
        kind: unit.kind as never,
        latitude: unit.lat,
        longitude: unit.lon,
        station: unit.station,
        availability: "available",
        capabilities: unit.capabilities ?? [],
      });
    }

    console.log(`Seeded ${UNITS.length} demonstration units around Hyderabad.`);
    console.log(`Total units registered: ${await units.count()}`);
    console.log(`\nRemove them with:`);
    console.log(`  DELETE FROM response_units WHERE unit_id LIKE '${PREFIX}%';`);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
