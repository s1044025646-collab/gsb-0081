import { openDb, migrate, makeCtx } from "./db/connection.js";
import { buildServer } from "./api/server.js";

const dbPath = process.env.DB_PATH ?? "restaurant.db";
const db = openDb(dbPath);
migrate(db);
const ctx = makeCtx(db);

const server = buildServer(ctx);
// Port 0 = auto-assign a free local port.
const port = Number(process.env.PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : port;
  console.log(`restaurant backend listening on http://127.0.0.1:${actual} (db: ${dbPath})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
