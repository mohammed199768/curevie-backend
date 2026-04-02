'use strict';

function ingestAnalyticsEvent(req, res, next) {
  const analyticsService = req.analyticsService;
  let pendingInsert;

  try {
    pendingInsert = analyticsService.ingestEvent(req.body, req.headers['user-agent']);
  } catch (error) {
    return next(error);
  }

  Promise.resolve(pendingInsert).catch(() => {});

  return res.status(201).json({ accepted: true });
}

async function getSummary(req, res) {
  const analyticsService = req.analyticsService;
  const summary = await analyticsService.getSummary(req.query);
  return res.json(summary);
}

async function getDailyTrend(req, res) {
  const analyticsService = req.analyticsService;
  const trend = await analyticsService.getDailyTrend(req.query);
  return res.json(trend);
}

async function getServiceInterest(req, res) {
  const analyticsService = req.analyticsService;
  const serviceInterest = await analyticsService.getServiceInterest(req.query);
  return res.json(serviceInterest);
}

async function getTopPaths(req, res) {
  const analyticsService = req.analyticsService;
  const topPaths = await analyticsService.getTopPaths(req.query);
  return res.json(topPaths);
}

module.exports = {
  ingestAnalyticsEvent,
  getSummary,
  getDailyTrend,
  getServiceInterest,
  getTopPaths,
};
