import { cp } from "node:fs/promises";

// tsc does not copy non-TS assets. Migrations are plain .sql on purpose, so
// they need moving into dist alongside the runner that reads them.
await cp("src/db/migrations", "dist/db/migrations", { recursive: true });
console.log("copied migrations -> dist/db/migrations");
