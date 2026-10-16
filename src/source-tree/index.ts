/**
 * The Source Tree seam (FND-05, FND-06, D-10): what the rest of the system learns from git and the file
 * system. Production surface only. The shared contract suite (`contract.ts`) is test code and is
 * deliberately NOT exported here; the module's own tests import it by relative path.
 */
export { createSourceTree } from './real.ts';
export type { SourceTreeOptions } from './real.ts';
export { createFakeSourceTree } from './fake.ts';
export { SOURCE_TREE_CODES, SourceTreeError } from './types.ts';
export type { HashPathsResult, SnapshotResult, SourceTree, SourceTreeIdentity, SourceTreeWorld } from './types.ts';
