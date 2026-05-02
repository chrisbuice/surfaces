-- Migration 008: Hello-heartbeat table for offload infrastructure validation.
-- Used by the grimmauldplace hello container to prove D1 HTTP API round-trip.
-- Additive — does not modify existing tables.

CREATE TABLE IF NOT EXISTS hello_heartbeat (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at  INTEGER NOT NULL,
  message TEXT    NOT NULL
);
