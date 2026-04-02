CREATE TABLE IF NOT EXISTS analytics_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type    VARCHAR(60) NOT NULL,
  pathname      VARCHAR(500),
  locale        VARCHAR(10),
  service_slug  VARCHAR(100),
  service_kind  VARCHAR(50),
  channel       VARCHAR(50),
  referrer      VARCHAR(500),
  utm_source    VARCHAR(200),
  utm_medium    VARCHAR(200),
  utm_campaign  VARCHAR(200),
  user_agent    VARCHAR(500),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_type
  ON analytics_events(event_type);

CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at
  ON analytics_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_service_slug
  ON analytics_events(service_slug)
  WHERE service_slug IS NOT NULL;
