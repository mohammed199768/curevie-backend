'use strict';

const pool = require('../../config/db');
const { AppError } = require('../../middlewares/errorHandler');
const AnalyticsEventRepository = require('../../repositories/AnalyticsEventRepository');

let analyticsEventRepo = new AnalyticsEventRepository(pool);

const ALLOWED_EVENT_TYPES = new Set([
  'public_page_view',
  'service_category_view',
  'contact_channel_click',
  'guest_request_dialog_open',
  'request_created',
]);

const VALID_SERVICE_KINDS = new Set(['MEDICAL', 'RADIOLOGY', 'LAB', 'PACKAGE']);
const VALID_CHANNELS = new Set(['phone', 'email', 'whatsapp']);

function configureAnalyticsService(repository) {
  analyticsEventRepo = repository;
  return module.exports;
}

function sanitizeString(value, maxLength) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, maxLength);
}

function validatePayload(payload) {
  if (!ALLOWED_EVENT_TYPES.has(payload.event_type)) {
    throw new AppError('Invalid analytics event type', 400, 'INVALID_ANALYTICS_EVENT_TYPE');
  }

  if (!payload.locale) {
    throw new AppError('locale is required', 400, 'ANALYTICS_LOCALE_REQUIRED');
  }

  if (payload.event_type === 'public_page_view' && !payload.pathname) {
    throw new AppError('pathname is required for public_page_view', 400, 'ANALYTICS_PATHNAME_REQUIRED');
  }

  if (payload.event_type === 'service_category_view') {
    if (!payload.service_slug) {
      throw new AppError('service_slug is required for service_category_view', 400, 'ANALYTICS_SERVICE_SLUG_REQUIRED');
    }
    if (!payload.service_kind) {
      throw new AppError('service_kind is required for service_category_view', 400, 'ANALYTICS_SERVICE_KIND_REQUIRED');
    }
  }

  if (payload.event_type === 'contact_channel_click') {
    if (!payload.channel) {
      throw new AppError('channel is required for contact_channel_click', 400, 'ANALYTICS_CHANNEL_REQUIRED');
    }
    if (!VALID_CHANNELS.has(payload.channel)) {
      throw new AppError('Invalid contact channel', 400, 'INVALID_ANALYTICS_CHANNEL');
    }
  }

  if (payload.event_type === 'guest_request_dialog_open' && !payload.service_slug) {
    throw new AppError(
      'service_slug is required for guest_request_dialog_open',
      400,
      'ANALYTICS_SERVICE_SLUG_REQUIRED'
    );
  }

  if (payload.event_type === 'request_created') {
    if (!payload.service_slug) {
      throw new AppError('service_slug is required for request_created', 400, 'ANALYTICS_SERVICE_SLUG_REQUIRED');
    }
    if (!payload.service_kind) {
      throw new AppError('service_kind is required for request_created', 400, 'ANALYTICS_SERVICE_KIND_REQUIRED');
    }
  }

  if (payload.service_kind && !VALID_SERVICE_KINDS.has(payload.service_kind)) {
    throw new AppError('Invalid service_kind', 400, 'INVALID_ANALYTICS_SERVICE_KIND');
  }
}

function clampDays(days) {
  const parsed = Number.parseInt(String(days ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return 30;
  }
  return Math.min(365, Math.max(1, parsed));
}

function clampLimit(limit) {
  const parsed = Number.parseInt(String(limit ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.min(50, Math.max(1, parsed));
}

function sanitizeEventType(value) {
  const eventType = sanitizeString(value, 60);
  if (eventType && !ALLOWED_EVENT_TYPES.has(eventType)) {
    throw new AppError('Invalid analytics event type', 400, 'INVALID_ANALYTICS_EVENT_TYPE');
  }
  return eventType;
}

function buildAnalyticsEventPayload(data = {}, requestUserAgent = null) {
  const payload = {
    event_type: sanitizeEventType(data.event_type),
    pathname: sanitizeString(data.pathname, 500),
    locale: sanitizeString(data.locale, 10),
    service_slug: sanitizeString(data.service_slug, 100),
    service_kind: sanitizeString(data.service_kind, 50),
    channel: sanitizeString(data.channel, 50),
    referrer: sanitizeString(data.referrer, 500),
    utm_source: sanitizeString(data.utm_source, 200),
    utm_medium: sanitizeString(data.utm_medium, 200),
    utm_campaign: sanitizeString(data.utm_campaign, 200),
    user_agent: sanitizeString(requestUserAgent || data.user_agent, 500),
  };

  validatePayload(payload);
  return payload;
}

function ingestEvent(data, userAgent) {
  const payload = buildAnalyticsEventPayload(data, userAgent);
  return analyticsEventRepo.insertEvent(payload);
}

function getSummary({ days } = {}) {
  return analyticsEventRepo.getSummary({ days: clampDays(days) });
}

function getDailyTrend({ days, event_type } = {}) {
  return analyticsEventRepo.getDailyTrend({
    days: clampDays(days),
    event_type: sanitizeEventType(event_type),
  });
}

function getServiceInterest({ days } = {}) {
  return analyticsEventRepo.getServiceInterest({ days: clampDays(days) });
}

function getTopPaths({ days, limit } = {}) {
  return analyticsEventRepo.getTopPaths({
    days: clampDays(days),
    limit: clampLimit(limit),
  });
}

module.exports = {
  configureAnalyticsService,
  ALLOWED_EVENT_TYPES,
  ingestEvent,
  getSummary,
  getDailyTrend,
  getServiceInterest,
  getTopPaths,
};
