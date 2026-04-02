'use strict';

const pool = require('../../config/db');
const CultureRepository = require('../../repositories/CultureRepository');

let cultureRepo = new CultureRepository(pool);

function configureCultureService(repo) {
  cultureRepo = repo;
  return module.exports;
}

async function getCultureResult(labResultId) {
  return cultureRepo.getByLabResultId(labResultId);
}

async function upsertCultureResult(labResultId, data) {
  return cultureRepo.withTransaction((client) =>
    cultureRepo.upsert(labResultId, data, client)
  );
}

async function deleteCultureResult(labResultId) {
  return cultureRepo.withTransaction((client) =>
    cultureRepo.delete(labResultId, client)
  );
}

module.exports = {
  configureCultureService,
  getCultureResult,
  upsertCultureResult,
  deleteCultureResult,
};
