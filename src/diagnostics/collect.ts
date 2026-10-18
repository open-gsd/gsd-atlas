/**
 * What each data type of the catalog holds on this machine (docs/DIAGNOSTICS.md section 3). Every collector is a pure
 * function over a {@link DiagnosticsSources} object, so a test needs no Host. A collector returns exactly the fields the
 * catalog lists for its type, each a bounded, closed value: a number, a fixed bucket label, a name from a closed list or
 * `null` when there is no data yet. Nothing is invented: a value the sources cannot supply is `null`.
 */

/** Everything the collectors read. The Host assembles it from the tenant status, the metrics report and the registry. */
export interface DiagnosticsSources {
  readonly atlasVersion: string;
  readonly catalogVersion: number;
}

export type TypeValues = Readonly<Record<string, unknown>>;

/** The values of one data type, keyed by field name. An unknown type id has no values. */
export function collectType(typeId: string, sources: DiagnosticsSources): TypeValues {
  switch (typeId) {
    case 'header':
      return { atlas_version: sources.atlasVersion, catalog_version: sources.catalogVersion };
    default:
      return {};
  }
}
