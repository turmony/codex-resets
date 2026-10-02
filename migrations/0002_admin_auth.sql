-- Only password verifiers and hashed, expiring sessions are persisted.
CREATE TABLE admin_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
INSERT INTO admin_auth (id) VALUES (1);

CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY,
  auth_version INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX admin_sessions_expiry ON admin_sessions(expires_at);

CREATE TRIGGER admin_password_changed AFTER UPDATE OF version ON admin_auth
WHEN NEW.version != OLD.version
BEGIN
  DELETE FROM admin_sessions;
END;

CREATE TABLE auth_attempts (
  scope TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
