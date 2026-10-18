/**
 * Worker-side relation extraction (plan 03-25, TSM-01): `extends`, `implements` and `overrides`, read from the compiler's
 * checker for the classes and interfaces declared in one source file.
 *
 * - `extends`: a class to its base class, an interface to each base interface. `implements`: a class to each interface (or
 *   class) in its `implements` clause. The type each heritage clause names is asked of the checker, so an alias, a
 *   namespace import, `Base<T>` with type arguments and a mixin that returns a class all resolve to the declared types; an
 *   expression the checker cannot resolve to a declaration (an `any` value) gives no relation and no error.
 * - `overrides`: an instance member of a class to the member of the nearest base class that declares it, abstract members
 *   included. The checker finds that member through the base chain, so `C extends B extends A` with `m` declared only in `A`
 *   gives `C.m overrides A.m`. A class member that only implements an interface member is not an override: the class
 *   already has an `implements` relation to the interface.
 *
 * A relation is reported only when both ends are declarations inside the worktree that have an identifier name: a base in a
 * library or under `node_modules` is dropped here, so nothing the host cannot map is sent. This file never loads the
 * compiler itself: `worker.ts` passes the loaded API in, and the types below are derived from it.
 */
import type { Target } from './protocol.ts';
import type { Compiler } from './worker.ts';

type Api = Compiler;
type Node = Parameters<Api['isIdentifier']>[0];

type SourceFile = ReturnType<Api['createSourceFile']>;
type Checker = ReturnType<ReturnType<Api['createProgram']>['getTypeChecker']>;
// The declaration types come from the factory functions' results, so no name has to be imported from the compiler package.
type ClassDeclaration = ReturnType<Api['factory']['createClassDeclaration']>;
type InterfaceDeclaration = ReturnType<Api['factory']['createInterfaceDeclaration']>;
type CompilerType = ReturnType<Checker['getTypeAtLocation']>;
type CompilerSymbol = NonNullable<ReturnType<Checker['getSymbolAtLocation']>>;
type Declaration = NonNullable<CompilerSymbol['declarations']>[number];
type ClassElement = ClassDeclaration['members'][number];

export type RelationName = 'extends' | 'implements' | 'overrides';

/** One relation found in a file: both ends as the name token of their declaration. */
export interface FoundRelation {
  readonly from: Target;
  readonly to: Target;
  readonly relation: RelationName;
}

export interface RelationHelpers {
  /** The loaded compiler API. */
  readonly api: Api;
  /** The target of a declaration's name token, or undefined when it is outside the worktree, in a library or has no identifier name. */
  targetOf(declaration: Declaration): Target | undefined;
  /** The most declarations reported for one heritage type: a heavily merged interface is cut here, like the targets of a site. */
  readonly maxDeclarations: number;
}

export function collectRelations(checker: Checker, sourceFile: SourceFile, helpers: RelationHelpers): FoundRelation[] {
  const { api } = helpers;
  const found: FoundRelation[] = [];
  const seen = new Set<string>();

  const add = (from: Target | undefined, to: Target | undefined, relation: RelationName): void => {
    if (from === undefined || to === undefined) return;
    const key = [relation, from.path, from.row, from.col, to.path, to.row, to.col].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ from, to, relation });
  };

  /** The class and interface declarations a type is made of: one for a class or an interface, several for an intersection (a mixin). */
  const declarationsOfType = (type: CompilerType): Declaration[] => {
    const parts = type.isIntersection() ? type.types : [type];
    const out: Declaration[] = [];
    for (const part of parts) {
      const symbol = part.getSymbol();
      for (const declaration of symbol?.declarations ?? []) {
        if (api.isClassDeclaration(declaration) || api.isInterfaceDeclaration(declaration)) {
          if (declaration.name !== undefined) out.push(declaration);
        }
      }
    }
    return out.slice(0, helpers.maxDeclarations);
  };

  const heritage = (node: ClassDeclaration | InterfaceDeclaration): void => {
    const from = helpers.targetOf(node);
    if (from === undefined) return;
    for (const clause of node.heritageClauses ?? []) {
      const relation: RelationName = clause.token === api.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
      for (const type of clause.types) {
        for (const declaration of declarationsOfType(checker.getTypeAtLocation(type))) add(from, helpers.targetOf(declaration), relation);
      }
    }
  };

  /** A member that a subclass can override: a named, non-static method, property or accessor. */
  const overridable = (member: ClassElement): boolean => {
    if (!(api.isMethodDeclaration(member) || api.isPropertyDeclaration(member) || api.isGetAccessorDeclaration(member) || api.isSetAccessorDeclaration(member))) return false;
    if (!api.isIdentifier(member.name)) return false;
    return !(member.modifiers ?? []).some((modifier) => modifier.kind === api.SyntaxKind.StaticKeyword);
  };

  /** True for a member declared in the body of a class: an interface merged into the class is no base class member. */
  const isClassMember = (declaration: Declaration): boolean =>
    api.isClassLike(declaration.parent) &&
    (api.isMethodDeclaration(declaration) || api.isPropertyDeclaration(declaration) || api.isGetAccessorDeclaration(declaration) || api.isSetAccessorDeclaration(declaration));

  const overrides = (node: ClassDeclaration): void => {
    const classType = checker.getTypeAtLocation(node);
    if (!classType.isClass()) return;
    const bases = checker.getBaseTypes(classType);
    if (bases.length === 0) return;
    for (const member of node.members) {
      if (!overridable(member)) continue;
      const from = helpers.targetOf(member);
      if (from === undefined) continue;
      const name = (member.name as { readonly text: string }).text;
      for (const base of bases) {
        const property = checker.getPropertyOfType(base, name);
        if (property === undefined) continue;
        for (const declaration of property.declarations ?? []) {
          if (isClassMember(declaration)) add(from, helpers.targetOf(declaration), 'overrides');
        }
      }
    }
  };

  const visit = (node: Node): void => {
    if (api.isClassDeclaration(node) && node.name !== undefined) {
      heritage(node);
      overrides(node);
    } else if (api.isInterfaceDeclaration(node)) {
      heritage(node);
    }
    api.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
