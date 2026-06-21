-- AfterSold mailer — D1 schema
-- Apply with:  wrangler d1 execute aftersold --file=schema.sql        (local)
--              wrangler d1 execute aftersold --remote --file=schema.sql (production)

CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT,
  plan         TEXT,
  sender_json  TEXT,            -- {name,email,address1,city,state,zip}
  signature    TEXT,            -- data:image/png;base64,... (optional)
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  name          TEXT NOT NULL,
  relationship  TEXT,
  street        TEXT,
  city          TEXT,
  state         TEXT,
  zip           TEXT,
  birthday      TEXT,           -- YYYY-MM-DD
  closing       TEXT,           -- YYYY-MM-DD
  anniversary   TEXT,           -- YYYY-MM-DD
  categories    TEXT,           -- JSON array
  notes         TEXT,
  heritage      TEXT,
  active        INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_recipients_order ON recipients(order_id);

-- One row per piece actually mailed — prevents sending the same occasion twice
-- in the same calendar year and gives a delivery log.
CREATE TABLE IF NOT EXISTS sends (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient_id  INTEGER NOT NULL REFERENCES recipients(id),
  occasion      TEXT NOT NULL,  -- birthday | anniversary | home-anniversary | holiday-...
  year          INTEGER NOT NULL,
  status        TEXT,           -- ok | error
  response      TEXT,           -- raw DocuPost response / error text
  sent_at       TEXT DEFAULT (datetime('now')),
  UNIQUE(recipient_id, occasion, year)
);
