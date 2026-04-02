'use strict';

class AnalyticsEventRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async insertEvent(event, client = null) {
    const executor = client || this.pool;
    const { rows } = await executor.query(
      `
      INSERT INTO analytics_events (
        event_type,
        pathname,
        locale,
        service_slug,
        service_kind,
        channel,
        referrer,
        utm_source,
        utm_medium,
        utm_campaign,
        user_agent
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id, event_type, created_at
      `,
      [
        event.event_type,
        event.pathname,
        event.locale,
        event.service_slug,
        event.service_kind,
        event.channel,
        event.referrer,
        event.utm_source,
        event.utm_medium,
        event.utm_campaign,
        event.user_agent,
      ]
    );

    return rows[0];
  }

  async getSummary({ days = 30 } = {}, client = null) {
    const executor = client || this.pool;
    const { rows } = await executor.query(
      `
      SELECT
        event_type,
        COUNT(*)::int AS total,
        COUNT(DISTINCT pathname)::int AS unique_paths,
        COUNT(DISTINCT service_slug)::int AS unique_services
      FROM analytics_events
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
      GROUP BY event_type
      ORDER BY event_type ASC
      `,
      [days]
    );

    return rows;
  }

  async getDailyTrend({ days = 30, event_type = null } = {}, client = null) {
    const executor = client || this.pool;
    const { rows } = await executor.query(
      `
      SELECT
        DATE_TRUNC('day', created_at AT TIME ZONE 'Asia/Amman')::date AS day,
        event_type,
        COUNT(*)::int AS total
      FROM analytics_events
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND ($2::varchar IS NULL OR event_type = $2)
      GROUP BY 1, 2
      ORDER BY day ASC, event_type ASC
      `,
      [days, event_type]
    );

    return rows;
  }

  async getServiceInterest({ days = 30 } = {}, client = null) {
    const executor = client || this.pool;
    const { rows } = await executor.query(
      `
      WITH scoped_events AS (
        SELECT event_type, service_slug, service_kind
        FROM analytics_events
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
          AND service_slug IS NOT NULL
      ),
      service_kinds AS (
        SELECT service_slug, MAX(service_kind) AS service_kind
        FROM scoped_events
        GROUP BY service_slug
      )
      SELECT
        se.service_slug,
        sk.service_kind,
        COUNT(*) FILTER (WHERE se.event_type = 'service_category_view')::int AS views,
        COUNT(*) FILTER (WHERE se.event_type = 'guest_request_dialog_open')::int AS dialog_opens,
        COUNT(*) FILTER (WHERE se.event_type = 'request_created')::int AS conversions
      FROM scoped_events se
      LEFT JOIN service_kinds sk ON sk.service_slug = se.service_slug
      GROUP BY se.service_slug, sk.service_kind
      ORDER BY views DESC, dialog_opens DESC, conversions DESC, se.service_slug ASC
      `,
      [days]
    );

    return rows;
  }

  async getTopPaths({ days = 30, limit = 10 } = {}, client = null) {
    const executor = client || this.pool;
    const { rows } = await executor.query(
      `
      SELECT pathname, COUNT(*)::int AS total
      FROM analytics_events
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND event_type = 'public_page_view'
        AND pathname IS NOT NULL
      GROUP BY pathname
      ORDER BY total DESC, pathname ASC
      LIMIT $2
      `,
      [days, limit]
    );

    return rows;
  }
}

module.exports = AnalyticsEventRepository;
