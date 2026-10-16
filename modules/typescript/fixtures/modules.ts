// Fixture for plan 02-13: every import and export form of the typescript module.
// Expected items are in modules.truth.json, written from this text before the extractor was run.

import defaultThing from './default-thing';
import * as everything from './everything';
import { plain, original as renamed } from './named';
import type { OnlyType } from './only-type';
import { type InlineType, value } from './inline-type';
import './side-effect';
import legacy = require('./legacy');
import mixed, { extra } from './mixed';
import type DefaultType from './default-type';

export * from './all';
export * as grouped from './grouped';
export { plain as shown, value as other } from './reexport';
export type { OnlyType } from './only-type';

const localOne = 1;
const localTwo = 2;
export { localOne, localTwo as publicTwo };
export function exportedFunction(): void {}
export const exportedValue = localOne;
export class ExportedClass {}
export default localTwo;

const fsLike = require('./fs-like');
const { destructured, aliased: renamedAlias } = require('./destructured');
const member = require('./member').thing;
require('./bare');
var oldStyle = require('./old-style');

module.exports = { localOne, publicOne: localTwo, inline() {} };
exports.direct = 1;
module.exports.nested = 2;
const typed = require('./typed') as { a: number };
const { named: renamedTyped } = require('./typed-destructured') satisfies object;
