const express = require('express');
const pkg = require('../package.json');
const router = express.Router();

router.get('/version', (req, res) => {
  res.json({ name: pkg.name, version: pkg.version, node: process.version });
});

module.exports = router;
