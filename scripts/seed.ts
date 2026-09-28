import { openDb, migrate, makeCtx } from "../src/db/connection.js";
import { seedFixtures, seedMenus } from "../fixtures/seed.js";

const dbPath = process.env.DB_PATH ?? "restaurant.db";
const db = openDb(dbPath);
migrate(db);
const ctx = makeCtx(db);
const fx = seedFixtures(ctx);
const menus = seedMenus(ctx);
console.log(
  fx
    ? `seeded ${dbPath}: menus=${JSON.stringify(menus)}`
    : `${dbPath} already seeded (idempotent, nothing changed)`
);
db.close();
