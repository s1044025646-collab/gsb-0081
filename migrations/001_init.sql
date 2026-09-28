-- Kitchen backend initial schema. Idempotent via IF NOT EXISTS;
-- the migration runner records applied versions in schema_migrations.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingredient (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL,
  stock_qty   REAL NOT NULL DEFAULT 0 CHECK (stock_qty >= 0)
);

-- Append-only inventory ledger. SUM(delta) must equal ingredient.stock_qty.
-- kind: 'hold' (reserve at accept), 'consume' (kitchen starts work),
--       'release' (cancel unstarted work), 'adjust' (manual set).
CREATE TABLE IF NOT EXISTS inventory_txn (
  id             TEXT PRIMARY KEY,
  ingredient_id  TEXT NOT NULL REFERENCES ingredient(id),
  delta          REAL NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('hold','consume','release','adjust')),
  ref_type       TEXT,
  ref_id         TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invtxn_ing ON inventory_txn(ingredient_id);

CREATE TABLE IF NOT EXISTS menu_version (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
  created_at  INTEGER NOT NULL,
  activated_at INTEGER
);

CREATE TABLE IF NOT EXISTS dish (
  id               TEXT PRIMARY KEY,
  menu_version_id  TEXT NOT NULL REFERENCES menu_version(id),
  code             TEXT NOT NULL,
  name             TEXT NOT NULL,
  UNIQUE (menu_version_id, code)
);

CREATE TABLE IF NOT EXISTS recipe (
  id       TEXT PRIMARY KEY,
  dish_id  TEXT NOT NULL REFERENCES dish(id),
  version  INTEGER NOT NULL,
  UNIQUE (dish_id, version)
);

CREATE TABLE IF NOT EXISTS recipe_ing (
  recipe_id      TEXT NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  ingredient_id  TEXT NOT NULL REFERENCES ingredient(id),
  qty            REAL NOT NULL CHECK (qty > 0),
  PRIMARY KEY (recipe_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS allergen (
  id    TEXT PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingredient_allergen (
  ingredient_id  TEXT NOT NULL REFERENCES ingredient(id) ON DELETE CASCADE,
  allergen_id    TEXT NOT NULL REFERENCES allergen(id),
  PRIMARY KEY (ingredient_id, allergen_id)
);

CREATE TABLE IF NOT EXISTS station (
  id    TEXT PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);

-- One row per production stage of a recipe at a station.
CREATE TABLE IF NOT EXISTS recipe_stage (
  recipe_id  TEXT NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  station_id TEXT NOT NULL REFERENCES station(id),
  stage      INTEGER NOT NULL,
  PRIMARY KEY (recipe_id, stage)
);

CREATE TABLE IF NOT EXISTS diner_order (
  id               TEXT PRIMARY KEY,
  table_no         TEXT NOT NULL,
  menu_version_id  TEXT NOT NULL REFERENCES menu_version(id),
  status           TEXT NOT NULL CHECK (status IN
                     ('accepted','prepping','partial_served','served','cancelled','closed')),
  urgent           INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_allergen (
  order_id     TEXT NOT NULL REFERENCES diner_order(id) ON DELETE CASCADE,
  allergen_id  TEXT NOT NULL REFERENCES allergen(id),
  PRIMARY KEY (order_id, allergen_id)
);

CREATE TABLE IF NOT EXISTS order_item (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES diner_order(id) ON DELETE CASCADE,
  recipe_id      TEXT NOT NULL REFERENCES recipe(id),
  qty            INTEGER NOT NULL CHECK (qty > 0),
  qty_started    INTEGER NOT NULL DEFAULT 0,
  qty_served     INTEGER NOT NULL DEFAULT 0,
  qty_returned   INTEGER NOT NULL DEFAULT 0,
  qty_cancelled  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);

-- Modifications on an item: add / replace / remove / note an ingredient.
-- Replacements participate in allergen verification (cannot bypass checks).
-- superseded=1 rows are history: after work started, edits create new rows /
-- new tickets rather than mutating in-flight tickets.
CREATE TABLE IF NOT EXISTS item_modification (
  id                       TEXT PRIMARY KEY,
  order_item_id            TEXT NOT NULL REFERENCES order_item(id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL CHECK (kind IN ('add','replace','remove')),
  base_ingredient_id       TEXT REFERENCES ingredient(id),
  substitute_ingredient_id TEXT REFERENCES ingredient(id),
  qty                      REAL NOT NULL CHECK (qty > 0),
  superseded               INTEGER NOT NULL DEFAULT 0,
  created_at               INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket (
 id             TEXT PRIMARY KEY,
  order_item_id  TEXT NOT NULL REFERENCES order_item(id),
  station_id     TEXT NOT NULL REFERENCES station(id),
  stage          INTEGER NOT NULL,
  seq            INTEGER NOT NULL,
  qty            INTEGER NOT NULL CHECK (qty > 0),
  qty_done       INTEGER NOT NULL DEFAULT 0,
  priority       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN
                    ('pending','ready','started','done','served','cancelled')),
  remake_of      TEXT REFERENCES ticket(id),
  return_reason  TEXT,
  batch_id       TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  done_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ticket_station_status ON ticket(station_id, status, priority);
CREATE INDEX IF NOT EXISTS idx_ticket_item ON ticket(order_item_id);

CREATE TABLE IF NOT EXISTS ticket_dep (
  ticket_id          TEXT NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
  depends_on_ticket  TEXT NOT NULL REFERENCES ticket(id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_id, depends_on_ticket)
);

CREATE TABLE IF NOT EXISTS batch (
  id          TEXT PRIMARY KEY,
  station_id  TEXT NOT NULL REFERENCES station(id),
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_ticket (
  batch_id   TEXT NOT NULL REFERENCES batch(id) ON DELETE CASCADE,
  ticket_id  TEXT NOT NULL REFERENCES ticket(id),
  PRIMARY KEY (batch_id, ticket_id)
);

CREATE TABLE IF NOT EXISTS return_record (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES ticket(id),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  reason_code TEXT NOT NULL,
  note        TEXT,
  action      TEXT NOT NULL CHECK (action IN ('remake','discard')),
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  entity      TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  before_json TEXT,
  after_json  TEXT,
  request_id  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE IF NOT EXISTS idempotency (
  request_id    TEXT PRIMARY KEY,
  scope         TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
