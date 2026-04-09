const express = require('express');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ status: 'cases module ok' });
});

module.exports = router;
