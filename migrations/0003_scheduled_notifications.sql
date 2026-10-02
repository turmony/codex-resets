-- SQLite cannot extend a CHECK constraint in place. Copy all delivery history
-- before replacing the table; monitor state and authentication are untouched.
DROP TRIGGER notification_completed;

CREATE TABLE notifications_new (
  event_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('activation', 'forecast', 'scheduled', 'reset')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'uncertain', 'accepted', 'sent', 'cancelled')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  attempted_at TEXT,
  completed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
INSERT INTO notifications_new
  (event_id, kind, status, payload_json, created_at, attempted_at, completed_at, attempts, last_error)
SELECT event_id, kind, status, payload_json, created_at, attempted_at, completed_at, attempts, last_error
FROM notifications;
DROP TABLE notifications;
ALTER TABLE notifications_new RENAME TO notifications;
CREATE INDEX notifications_recovery ON notifications(status, created_at);
CREATE INDEX notifications_scheduled_history ON notifications(kind, status, json_extract(payload_json, '$.scheduledResetId'));

CREATE TRIGGER notification_completed AFTER UPDATE OF status ON notifications
WHEN NEW.status = 'sent' AND OLD.status != 'sent'
BEGIN
  UPDATE monitor SET state_json = json_set(
    state_json,
    '$.initialized', json(CASE WHEN COALESCE(json_extract(NEW.payload_json, '$.patch.initialized'), json_extract(state_json, '$.initialized')) = 1 THEN 'true' ELSE 'false' END),
    '$.notified_reset_id', CASE WHEN json_type(NEW.payload_json, '$.patch.notified_reset_id') IS NOT NULL THEN json_extract(NEW.payload_json, '$.patch.notified_reset_id') ELSE json_extract(state_json, '$.notified_reset_id') END,
    '$.active_watch_fingerprint', CASE WHEN json_type(NEW.payload_json, '$.patch.active_watch_fingerprint') IS NOT NULL THEN json_extract(NEW.payload_json, '$.patch.active_watch_fingerprint') ELSE json_extract(state_json, '$.active_watch_fingerprint') END,
    '$.state_updated_at', NEW.completed_at
  ) WHERE id = 1;
END;
