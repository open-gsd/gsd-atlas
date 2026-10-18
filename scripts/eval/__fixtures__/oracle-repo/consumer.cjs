'use strict';

const { compute } = require('./out/lib.cjs');

function run() {
  return compute(5);
}

module.exports = { run };
