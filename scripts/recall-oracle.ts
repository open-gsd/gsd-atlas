import path from 'node:path';

import ts from 'typescript';

import type { RecallItem } from './recall.ts';

/**
 * The dev-only compiler oracle of scripts/recall.ts (LNG-02, D-05, threat T-02-41).
 *
 * It is an independent implementation of what the language modules' queries claim to find: the
 * TypeScript compiler parses the file (`createSourceFile` only: no program and no checker, so it
 * needs no tsconfig and no other file) and one walk classifies declarations into the same constructs
 * the harness reports. Nothing here reads the extractor's output, and nothing here ships.
 *
 * Alignment with the module queries (their scope is stated in each module's fixtures/*.truth.json):
 * - declarations count in statement lists only (a file, a block or a namespace body), not inside a
 *   switch case, the same places the queries look;
 * - function: function declarations including overload and ambient signatures, and const, let or var
 *   bound arrow and function expressions; class, interface, type alias and enum by their declarations;
 * - const/var: a variable only at file level, with a plain identifier name, and not bound to a
 *   `require()` call (that is an import);
 * - method: methods and accessors of classes and method signatures of interfaces, never a
 *   constructor and never an object literal method; property: class fields and interface members;
 * - containment: the nearest enclosing definition above each definition;
 * - ES import/export and CommonJS forms as the compiler reads them; an `export` inside a namespace is
 *   not a module export.
 */

/** Lines are 1-based, like the truth files. */
function scriptKindOf(filePath: string): ts.ScriptKind {
  switch (path.extname(filePath).toLowerCase()) {
    case '.js':
    case '.cjs':
    case '.mjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.tsx':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** The text of a plain identifier or private name; computed, string and numeric names have none. */
function simpleName(name: ts.Node | undefined): string | undefined {
  if (name !== undefined && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) {
    return name.text;
  }
  return undefined;
}

function isFunctionValue(node: ts.Expression | undefined): boolean {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** `require('x')`, `require('x').member`, `require('x')(...)`: the value is an import, not a plain const. */
function isRequireChain(node: ts.Expression | undefined): boolean {
  let current: ts.Expression | undefined = node;
  while (current !== undefined) {
    if (ts.isCallExpression(current)) {
      if (ts.isIdentifier(current.expression) && current.expression.text === 'require') {
        return true;
      }
      current = current.expression;
    } else if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
    } else {
      return false;
    }
  }
  return false;
}

/** The statement lists the queries look in: a file, a block, a namespace body. */
function inStatementList(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isSourceFile(parent) || ts.isBlock(parent) || ts.isModuleBlock(parent);
}

/** `module.exports` as written: the property access, not the `module` or `exports` part alone. */
function isModuleExports(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module' &&
    node.name.text === 'exports'
  );
}

/**
 * Classify one file with the TypeScript compiler. Returns definition, import, export and containment
 * items with 1-based lines; a containment item names its child, its parent and the child's line.
 */
export function classifyWithCompiler(filePath: string, text: string): RecallItem[] {
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindOf(filePath));
  const items: RecallItem[] = [];
  // A line is what a line feed ends, the same rule the engine's spans and every editor use. The compiler's own
  // line map also breaks at U+2028, U+2029 and a lone CR, which would shift every later line of a file that holds one.
  const breaks: number[] = [];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    breaks.push(at);
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((breaks[middle] ?? 0) < offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low + 1;
  };
  const lineOf = (node: ts.Node): number => lineAt(node.getStart(source));

  /** Emit a definition and, when something encloses it, the containment pair. */
  const define = (construct: RecallItem['construct'], name: string, node: ts.Node, parent: string | undefined): void => {
    const line = lineOf(node);
    items.push({ construct, name, line });
    if (parent !== undefined) {
      items.push({ construct: 'containment', name, parent, line });
    }
  };

  const exportItem = (name: string, node: ts.Node): void => {
    items.push({ construct: 'ES export', name, line: lineOf(node) });
  };

  const cjsExport = (name: string, node: ts.Node): void => {
    items.push({ construct: 'CJS module.exports', name, line: lineOf(node) });
  };

  /** The ES exports a file-level declaration with an `export` modifier makes. */
  const exportsOfDeclaration = (node: ts.Statement): void => {
    if (!hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      return;
    }
    if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
      exportItem('default', node);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const name = simpleName(declaration.name);
        if (name !== undefined) {
          exportItem(name, node);
        }
      }
      return;
    }
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node)
    ) {
      const name = simpleName(node.name);
      if (name !== undefined) {
        exportItem(name, node);
      }
    }
  };

  const exportsOfDeclarationList = (node: ts.ExportDeclaration): void => {
    const clause = node.exportClause;
    if (clause === undefined) {
      exportItem('*', node);
    } else if (ts.isNamespaceExport(clause)) {
      exportItem(clause.name.text, node);
    } else {
      for (const element of clause.elements) {
        exportItem(element.name.text, node);
      }
    }
  };

  /** `module.exports = x`, `exports.name = x`, `module.exports.name = x`. */
  const exportsOfAssignment = (node: ts.BinaryExpression): void => {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
      return;
    }
    const left = node.left;
    if (isModuleExports(left)) {
      if (ts.isObjectLiteralExpression(node.right)) {
        for (const property of node.right.properties) {
          const name = ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)
            ? simpleName(property.name)
            : undefined;
          if (name !== undefined) {
            cjsExport(name, node);
          }
        }
      } else {
        cjsExport('module.exports', node);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.name)) {
      const base = left.expression;
      if ((ts.isIdentifier(base) && base.text === 'exports') || isModuleExports(base)) {
        cjsExport(left.name.text, node);
      }
    }
  };

  const visit = (node: ts.Node, parent: string | undefined): void => {
    // Each case either returns after walking its own children or falls through to the generic walk.
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        items.push({ construct: 'ES import', name: node.moduleSpecifier.text, line: lineOf(node) });
      }
      return;
    }
    if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
        items.push({ construct: 'CJS require', name: node.moduleReference.expression.text, line: lineOf(node) });
      }
      return;
    }
    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier === undefined || ts.isStringLiteral(node.moduleSpecifier)) {
        exportsOfDeclarationList(node);
      }
      return;
    }
    if (ts.isExportAssignment(node)) {
      if (node.isExportEquals !== true) {
        exportItem('default', node);
      }
      ts.forEachChild(node, (child) => visit(child, parent));
      return;
    }
    if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && first !== undefined && ts.isStringLiteral(first)) {
        items.push({ construct: 'CJS require', name: first.text, line: lineOf(node) });
      }
    }
    if (ts.isBinaryExpression(node)) {
      exportsOfAssignment(node);
    }

    if (ts.isFunctionDeclaration(node) && inStatementList(node)) {
      const name = simpleName(node.name);
      if (ts.isSourceFile(node.parent)) {
        exportsOfDeclaration(node);
      }
      if (name !== undefined) {
        define('function', name, node, parent);
      }
      ts.forEachChild(node, (child) => visit(child, name ?? parent));
      return;
    }
    if (ts.isClassDeclaration(node) && inStatementList(node)) {
      const name = simpleName(node.name);
      if (ts.isSourceFile(node.parent)) {
        exportsOfDeclaration(node);
      }
      if (name !== undefined) {
        define('class', name, node, parent);
      }
      ts.forEachChild(node, (child) => visit(child, name ?? parent));
      return;
    }
    if (ts.isInterfaceDeclaration(node) && inStatementList(node)) {
      if (ts.isSourceFile(node.parent)) {
        exportsOfDeclaration(node);
      }
      define('interface', node.name.text, node, parent);
      for (const member of node.members) {
        const memberName = simpleName(member.name);
        if (memberName === undefined) {
          continue;
        }
        if (ts.isMethodSignature(member)) {
          define('method', memberName, member, node.name.text);
        } else if (ts.isPropertySignature(member)) {
          define('property', memberName, member, node.name.text);
        }
      }
      return;
    }
    if (ts.isTypeAliasDeclaration(node) && inStatementList(node)) {
      if (ts.isSourceFile(node.parent)) {
        exportsOfDeclaration(node);
      }
      define('type alias', node.name.text, node, parent);
      return;
    }
    if (ts.isEnumDeclaration(node) && inStatementList(node)) {
      if (ts.isSourceFile(node.parent)) {
        exportsOfDeclaration(node);
      }
      define('enum', node.name.text, node, parent);
      return;
    }
    if (ts.isModuleDeclaration(node) && inStatementList(node)) {
      const name = ts.isIdentifier(node.name) && node.body !== undefined && !ts.isModuleDeclaration(node.body) ? node.name.text : undefined;
      if (ts.isSourceFile(node.parent)) {
        exportsOfDeclaration(node);
      }
      // A namespace is a container for containment only; the harness has no row for it.
      if (name !== undefined && parent !== undefined) {
        items.push({ construct: 'containment', name, parent, line: lineOf(node) });
      }
      ts.forEachChild(node, (child) => visit(child, name ?? parent));
      return;
    }
    if (ts.isVariableStatement(node) && inStatementList(node)) {
      if (ts.isSourceFile(node.parent)) {
        exportsOfDeclaration(node);
      }
      for (const declaration of node.declarationList.declarations) {
        const name = simpleName(declaration.name);
        const value = declaration.initializer;
        if (name !== undefined && isFunctionValue(value)) {
          define('function', name, declaration, parent);
          ts.forEachChild(declaration, (child) => visit(child, name));
        } else if (name !== undefined && ts.isSourceFile(node.parent) && !isRequireChain(value)) {
          // A definition holds whatever is declared inside its value, so it is the parent of those.
          define('const/var', name, declaration, undefined);
          ts.forEachChild(declaration, (child) => visit(child, name));
        } else {
          ts.forEachChild(declaration, (child) => visit(child, parent));
        }
      }
      return;
    }
    if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node)) {
      // A class expression, or a class in a position the queries do not look: its members still count.
      ts.forEachChild(node, (child) => visit(child, parent));
      return;
    }
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      const name = simpleName(node.name);
      if (name !== undefined && ts.isClassLike(node.parent)) {
        define('method', name, node, parent);
        ts.forEachChild(node, (child) => visit(child, name));
        return;
      }
    }
    if (ts.isPropertyDeclaration(node)) {
      const name = simpleName(node.name);
      if (name !== undefined && ts.isClassLike(node.parent)) {
        define('property', name, node, parent);
        ts.forEachChild(node, (child) => visit(child, name));
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(child, parent));
  };

  visit(source, undefined);
  return items;
}
