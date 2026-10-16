// Fixture for plan 02-13: definitions and CommonJS forms of the javascript module.
// Expected items are in constructs.truth.json, written from this text before the extractor was run.

const fsLike = require('./fs-like');
const { destructured, aliased: renamedAlias } = require('./destructured');
const member = require('./member').thing;
var oldStyle = require('./old-style');
require('./bare');

function plainFunction(a) {
  return a + 1;
}

async function asyncFunction() {
  return plainFunction(1);
}

function* generatorFunction() {
  yield 1;
}

const arrowConst = (n) => n * 2;
const expressionConst = function named() {};
var varArrow = () => 1;

const LIMIT = 10;
let counter = 0;
var legacy = 'old';

class Animal {
  name = 'x';
  static count = 0;
  #secret = 1;
  constructor(name) {
    this.name = name;
  }
  speak() {
    return this.name;
  }
  static create() {
    return new Animal('a');
  }
  #hidden() {}
  get label() {
    return this.name;
  }
  set label(v) {
    this.name = v;
  }
}

class Dog extends Animal {
  bark() {}
}

function outer() {
  function inner() {}
  const localArrow = () => inner();
  const localValue = 1;
  return localArrow() + localValue;
}

const café = 1; const tag = '😀'; function afterEmoji() {}

module.exports = { plainFunction, shown: asyncFunction, outer() {} };
exports.direct = arrowConst;
module.exports.nested = 2;
module.exports = Dog;
