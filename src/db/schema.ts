export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "0001_init",
    sql: `
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE menu_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_at TEXT NOT NULL
);

CREATE TABLE dishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_version_id INTEGER NOT NULL REFERENCES menu_versions(id),
  name TEXT NOT NULL,
  station TEXT NOT NULL,
  price_cents INTEGER NOT NULL DEFAULT 0,
  UNIQUE (menu_version_id, name)
);

CREATE TABLE ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  unit TEXT NOT NULL DEFAULT 'g',
  stock_qty REAL NOT NULL DEFAULT 0,
  reserved_qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE allergens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL
);

CREATE TABLE ingredient_allergens (
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  allergen_id INTEGER NOT NULL REFERENCES allergens(id),
  PRIMARY KEY (ingredient_id, allergen_id)
);

CREATE TABLE recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dish_id INTEGER NOT NULL REFERENCES dishes(id),
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  qty REAL NOT NULL,
  optional INTEGER NOT NULL DEFAULT 0,
  UNIQUE (dish_id, ingredient_id)
);

CREATE TABLE tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL UNIQUE
);

CREATE TABLE diners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL REFERENCES tables(id),
  name TEXT NOT NULL
);

CREATE TABLE diner_allergies (
  diner_id INTEGER NOT NULL REFERENCES diners(id),
  allergen_id INTEGER NOT NULL REFERENCES allergens(id),
  PRIMARY KEY (diner_id, allergen_id)
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id INTEGER NOT NULL REFERENCES tables(id),
  diner_id INTEGER NOT NULL REFERENCES diners(id),
  menu_version_id INTEGER NOT NULL REFERENCES menu_versions(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partially_served','served','cancelled')),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  dish_id INTEGER NOT NULL REFERENCES dishes(id),
  qty INTEGER NOT NULL,
  rush INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','in_progress','partially_served','served','cancelled')),
  served_qty INTEGER NOT NULL DEFAULT 0,
  cancelled_qty INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE order_item_mods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  kind TEXT NOT NULL CHECK (kind IN ('add','remove','substitute')),
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  replaces_ingredient_id INTEGER REFERENCES ingredients(id),
  qty REAL NOT NULL DEFAULT 0
);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  order_item_id INTEGER REFERENCES order_items(id),
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE stations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  station_id INTEGER NOT NULL REFERENCES stations(id),
  qty INTEGER NOT NULL,
  done_qty INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','in_progress','done','voided','redo')),
  supersedes_ticket_id INTEGER REFERENCES tickets(id),
  depends_on_ticket_id INTEGER REFERENCES tickets(id),
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  event_type TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE serve_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  qty INTEGER NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE inventory_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id),
  delta_stock REAL NOT NULL,
  delta_reserved REAL NOT NULL,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE return_reasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  qty INTEGER NOT NULL,
  reason TEXT NOT NULL,
  restock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`,
  },
];
