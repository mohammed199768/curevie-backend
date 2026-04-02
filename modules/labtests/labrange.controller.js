const labrangeService = require('./labrange.service');

async function listRangesForTest(req, res) {
  const data = await labrangeService.getRangesForTest(req.params.testId);
  return res.json(data);
}

async function getOrdinalScale(req, res) {
  const scale = await labrangeService.getOrdinalScale(req.params.testId);
  return res.json(scale);
}

async function replaceOrdinalScale(req, res) {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) {
    return res.status(400).json({ message: 'items array is required', code: 'NO_ITEMS' });
  }
  const result = await labrangeService.replaceOrdinalScale(req.params.testId, items);
  return res.status(200).json(result);
}

async function deleteOrdinalScale(req, res) {
  const result = await labrangeService.deleteOrdinalScale(req.params.testId);
  return res.json(result);
}

async function createRange(req, res) {
  const created = await labrangeService.createRange(req.params.testId, req.body);
  return res.status(201).json(created);
}

async function createManyRanges(req, res) {
  const ranges = Array.isArray(req.body.ranges) ? req.body.ranges : [];
  const result = await labrangeService.createManyRanges(req.params.testId, ranges);

  return res.status(201).json({
    created: result.created,
    skipped: result.skipped,
    test_id: req.params.testId,
    data: result.data,
    errors: result.errors,
  });
}

async function updateRange(req, res) {
  const result = await labrangeService.updateRange(req.params.rangeId, req.body);
  if (result.noUpdates) {
    return res.status(400).json({ message: 'No fields to update', code: 'NO_UPDATES' });
  }
  if (!result.row) {
    return res.status(404).json({ message: 'Range not found', code: 'RANGE_NOT_FOUND' });
  }
  return res.json(result.row);
}

async function deleteRange(req, res) {
  const deleted = await labrangeService.deleteRange(req.params.rangeId);
  if (!deleted) {
    return res.status(404).json({ message: 'Range not found', code: 'RANGE_NOT_FOUND' });
  }
  return res.json({ message: 'Range deleted', id: req.params.rangeId });
}

async function deleteAllRangesForTest(req, res) {
  const result = await labrangeService.deleteAllRangesForTest(req.params.testId);
  return res.json({ test_id: req.params.testId, deleted: result.deleted });
}

async function resolveRange(req, res) {
  const {
    gender = null,
    age = null,
    fasting_state = null,
    cycle_phase = null,
    is_pregnant = null,
  } = req.query;

  const range = await labrangeService.resolveRange(
    req.params.testId,
    { gender, age, fasting_state, cycle_phase, is_pregnant }
  );
  return res.json(range || null);
}

module.exports = {
  listRangesForTest,
  getOrdinalScale,
  replaceOrdinalScale,
  deleteOrdinalScale,
  createRange,
  createManyRanges,
  updateRange,
  deleteRange,
  deleteAllRangesForTest,
  resolveRange,
};
