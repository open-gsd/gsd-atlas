'use strict';

function greet(name) {
  return `hello ${name}`;
}

class Greeter {
  constructor(prefix) {
    this.prefix = prefix;
  }
}

const shout = (text) => text.toUpperCase();

module.exports = { greet, Greeter, shout };
