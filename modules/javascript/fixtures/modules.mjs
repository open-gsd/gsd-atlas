// Fixture for plan 02-13: every import and export form of the javascript module (ES modules).
// Expected items are in modules.truth.json, written from this text before the extractor was run.

import defaultThing from './default-thing.mjs';
import * as everything from './everything.mjs';
import { plain, original as renamed } from './named.mjs';
import './side-effect.mjs';
import mixed, { extra } from './mixed.mjs';

export * from './all.mjs';
export * as grouped from './grouped.mjs';
export { plain as shown, renamed as other } from './reexport.mjs';

const localOne = 1;
const localTwo = 2;
export { localOne, localTwo as publicTwo };
export function exportedFunction() {}
export const exportedValue = localOne;
export class ExportedClass {}
export default localTwo;
