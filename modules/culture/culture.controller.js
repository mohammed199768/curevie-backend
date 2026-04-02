'use strict';

const cultureService = require('./culture.service');

async function getCultureResult(req, res) {
  const result = await cultureService.getCultureResult(req.params.labResultId);
  return res.json(result || null);
}

async function upsertCultureResult(req, res) {
  const result = await cultureService.upsertCultureResult(
    req.params.labResultId,
    req.body
  );
  return res.json(result);
}

async function deleteCultureResult(req, res) {
  const result = await cultureService.deleteCultureResult(req.params.labResultId);
  return res.json(result);
}

module.exports = { getCultureResult, upsertCultureResult, deleteCultureResult };
