/*!
   Copyright 2018 Propel http://propel.site/.  All rights reserved.
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
 */
import * as acorn from "acorn/dist/acorn";
import * as walk from "acorn/dist/walk";
import { assert } from "../src/util";

const importFn = "__import";
const globalVar = "__global";
const parseOptions = { ecmaVersion: 8, allowImportExportEverywhere: true };

function noop() {}

function walkRecursiveWithAncestors(node, state, visitors) {
  const ancestors = [];
  const wrappedVisitors = {};

  for (const nodeType of Object.keys(walk.base)) {
    const visitor = visitors[nodeType] || walk.base[nodeType];
    wrappedVisitors[nodeType] = (node, state, c) => {
      const isNew = node !== ancestors[ancestors.length - 1];
      if (isNew) ancestors.push(node);
      visitor(node, state, c, ancestors);
      if (isNew) ancestors.pop();
    };
  }

  return walk.recursive(node, state, wrappedVisitors);
}

const base64digits =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

function vlqEncode(value: number): string {
  let result = "";
  value = value < 0 ? (-value << 1) + 1 : value << 1;
  do {
    let digit = value & 31;
    value >>= 5;
    if (value > 0) digit |= 32;
    result += base64digits[digit];
  } while (value !== 0);
  return result;
}

interface MapPos {
  file?: SourceFile;
  line?: number;
  column?: number;
}

class MappedChar implements MapPos {
  readonly char: string;
  readonly file?: SourceFile;
  readonly line?: number;
  readonly column?: number;

  constructor(char: string, { file, line, column }: MapPos = {}) {
    this.char = char;
    (this.file = file), (this.line = line);
    this.column = column;
  }
}

class SourceFile {
  content: MappedString;

  constructor(readonly name: string, content: string) {
    const chars: MappedChar[] = [];
    let line = 0,
      column = 0;
    for (const char of content) {
      chars.push(new MappedChar(char, { file: this, line, column }));
      if (char === "\n") {
        line++;
        column = 0;
      } else {
        column++;
      }
    }
    this.content = new MappedString(chars);
  }
}

class MappedString extends Array<MappedChar> {
  constructor(chars: number | string | MappedChar[] = []) {
    if (typeof chars === "number") {
      super();
    } else if (typeof chars === "string") {
      super(...Array.from(chars).map(char => new MappedChar(char)));
    } else {
      super(...chars);
    }
  }

  private set(chars: MappedChar[]) {
    this.splice(0, this.length, ...chars);
  }

  split(): MappedString[] {
    return Array.from(this).map(c => new MappedString([c]));
  }

  concat(...parts: MappedString[]): MappedString {
    let str = Array.prototype.concat.apply(this, arguments);
    // Workaround for ES5.
    if (!(str instanceof MappedString)) {
      str = new MappedString(str);
    }
    return str;
  }

  toString(): string {
    return this.reduce((str, c) => str + c.char, "");
  }

  getSourceMap(): any {
    const sourcesMap = new Map<SourceFile, number>();
    const sources = [];
    const sourcesContent = [];
    let mappings = "";

    let firstOfLine = true;
    let genCol = 0,
      lastGenCol = 0;
    let lastSrcLine = 0,
      lastSrcCol = 0,
      lastSrcIndex = 0;

    for (const char of this) {
      if (char.file != null) {
        // Ensire the source file is present in the `sources` and
        // `sourcesContent` arrays.
        let srcIndex = sourcesMap.get(char.file);
        if (srcIndex == null) {
          srcIndex = sources.length;
          sourcesMap.set(char.file, srcIndex);
          sources.push(char.file.name);
          sourcesContent.push(char.file.content.toString());
        }

        if (
          firstOfLine ||
          !(
            srcIndex === lastSrcIndex &&
            char.line === lastSrcLine &&
            char.column === lastSrcCol
          )
        ) {
          if (firstOfLine) console.log("LINE: ", genCol, lastGenCol, char.char);
          firstOfLine = false;

          if (/[^;]$/.test(mappings)) {
            mappings += ",";
          }

          mappings += vlqEncode(genCol - lastGenCol);
          lastGenCol = genCol;

          mappings += vlqEncode(lastSrcIndex - srcIndex);
          lastSrcIndex = srcIndex;

          mappings += vlqEncode(char.line - lastSrcLine);
          lastSrcLine = char.line;

          mappings += vlqEncode(char.column - lastSrcCol);
          lastSrcCol = char.column;
        }
      }

      if (char.char === "\n") {
        mappings += ";";
        genCol = 0;
        lastGenCol = 0;
        firstOfLine = true;
      } else {
        genCol++;
      }
    }

    return {
      version: 3,
      file: `transpiled.js`,
      sources,
      sourcesContent,
      mappings
    };
  }

  getInlineSourceMap(): string {
    console.log(this.getSourceMap());
    return (
      "//@ sourceMappingURL=data:application/json;charset=utf-8;base64," +
      new Buffer(JSON.stringify(this.getSourceMap())).toString("base64")
    );
  }

  static EMPTY = new MappedString();

  static convert(str: MappedStringLike, pos: MapPos = {}): MappedString {
    if (str instanceof MappedString) {
      return str;
    } else {
      return new MappedString(
        Array.from(str).map(char => new MappedChar(char, pos))
      );
    }
  }
}

type MappedStringLike = string | MappedString;

class SourceEditor {
  private index: MappedString[];

  constructor(source: MappedStringLike) {
    this.index = MappedString.convert(source).split();
  }

  merge(): MappedString {
    return new MappedString().concat(...this.index);
  }

  stratify(): string {
    const str = this.merge();
    this.index = str.split();
    return str.toString();
  }

  text(): string {
    return this.merge().toString();
  }

  dump() {
    console.log(this.merge().getSourceMap());
  }

  prepend(str: MappedStringLike): void {
    let mstr = MappedString.convert(str);
    if (this.index.length > 0) {
      mstr = mstr.concat(this.index[0]);
    }
    this.index[0] = mstr;
  }

  append(str: MappedStringLike): void {
    this.index.push(MappedString.convert(str));
  }

  replace(start, end, str: MappedStringLike): void {
    const pos: MapPos | undefined = this.index[start][0];
    this.index[start] = MappedString.convert(str, pos);

    for (let i = start + 1; i < end; i++) {
      this.index[i] = MappedString.EMPTY;
    }
  }

  insertBefore({ start }, str: MappedStringLike): void {
    const pos: MapPos | undefined = this.index[start][0];
    console.log("pos: ", pos);
    const mstr = MappedString.convert(str, pos);
    this.index[start] = mstr.concat(this.index[start]);
  }

  insertAfter({ end }, str: MappedStringLike): void {
    const pos: MapPos | undefined = this.index[end - 1].slice(-1)[0];
    const mstr = MappedString.convert(str, pos);
    this.index[end - 1] = this.index[end - 1].concat(mstr);
  }
}

/* tslint:disable:object-literal-sort-keys*/

const importVisitors = {
  ImportDeclaration(node, state, c) {
    const spec = node.specifiers;
    const src = node.source;

    if (spec.length) {
      let cur = spec[0];
      state.edit.replace(node.start, cur.start, "var {");
      for (let i = 1; i < spec.length; i++) {
        state.edit.replace(cur.end, spec[i].start, ",");
        cur = spec[i];
      }
      state.edit.replace(cur.end, src.start, `} = {_:await ${importFn}(`);
      state.edit.replace(src.end, node.end, ")};");
    } else {
      state.edit.replace(node.start, src.start, `await ${importFn}(`);
      state.edit.replace(src.end, node.end, ");");
    }

    walk.base.ImportDeclaration(node, state, c);
  },

  ImportSpecifier(node, state, c) {
    state.edit.insertBefore(node, "_:{");
    if (node.local.start > node.imported.end) {
      state.edit.replace(node.imported.end, node.local.start, ":");
    }
    state.edit.insertAfter(node, "}");
    walk.base.ImportSpecifier(node, state, c);
  },

  ImportDefaultSpecifier(node, state, c) {
    state.edit.insertBefore(node.local, "_:{default:");
    state.edit.insertAfter(node.local, "}");
    walk.base.ImportDefaultSpecifier(node, state, c);
  },

  ImportNamespaceSpecifier(node, state, c) {
    state.edit.replace(node.start, node.local.start, "_:");
    walk.base.ImportNamespaceSpecifier(node, state, c);
  },

  // Do not recurse into functions etc.
  FunctionDeclaration: noop,
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition: noop
};

const evalScopeVisitors = {
  // Turn function and class declarations into expressions that assign to
  // the global object. Do not recurse into function bodies.
  ClassDeclaration(node, state, c, ancestors) {
    walk.base.ClassDeclaration(node, state, c);

    // Classes are block-scoped, so don't do any transforms if the class
    // definition isn't at top-level.
    assert(ancestors.length >= 2);
    if (ancestors[ancestors.length - 2] !== state.body) {
      return;
    }

    state.edit.insertBefore(node, `${globalVar}.${node.id.name}=`);
    state.edit.insertAfter(node, `);`);
  },

  FunctionDeclaration(node, state, c) {
    state.edit.insertBefore(node, `void (${globalVar}.${node.id.name}=`);
    state.edit.insertAfter(node, `);`);
    // Don't do any translation inside the function body, therefore there's no
    // `walk.base.FunctionDeclaration()` call here.
  },

  VariableDeclaration(node, state, c, ancestors) {
    // Turn variable declarations into assignments to the global object.
    // TODO: properly hoist `var` declarations -- that is, insert
    // `global.varname = undefined` at the very top of the block.

    // Translate all `var` declarations as they are function-scoped.
    // `let` and `const` are only translated when they appear in the top level
    // block. Note that since we don't walk into function bodies, declarations
    // inside them are never translated.
    assert(ancestors.length >= 2);
    const translateDecl =
      node.kind === "var" || ancestors[ancestors.length - 2] === state.body;

    state.translatingVariableDeclaration = translateDecl;
    walk.base.VariableDeclaration(node, state, c);
    state.translatingVariableDeclaration = false;

    if (!translateDecl) {
      return;
    }

    state.edit.replace(node.start, node.start + node.kind.length + 1, "void (");

    let decl;
    for (decl of node.declarations) {
      if (decl.init) {
        state.edit.insertBefore(decl, "(");
        state.edit.insertAfter(decl, ")");
      } else {
        // A declaration without an initializer (e.g. `var a;`) turns into
        // an assignment with undefined. Note that for destructuring
        // declarations, an initializer is mandatory, hence it is safe to just
        // assign undefined here.
        // TODO: if the declaration kind is 'var', this should probably be
        // hoisted, as this is perfectly legal javascript :/
        //   function() {
        //     console.log(foo);
        //     foo = 4;
        //     var foo;
        //   }
        state.edit.insertBefore(decl, "(");
        state.edit.insertAfter(decl, "= undefined)");
      }
    }

    // Insert after `decl` rather than node, otherwise the closing bracket
    // might end up wrapping a semicolon.
    state.edit.insertAfter(decl, ")");
  },

  VariableDeclarator(node, state, c) {
    walk.base.VariableDeclarator(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    if (node.id.type === "Identifier") {
      state.edit.insertBefore(node.id, `${globalVar}.`);
    }
  },

  ObjectPattern(node, state, c) {
    walk.base.ObjectPattern(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    for (const p of node.properties) {
      if (p.shorthand) {
        state.edit.insertAfter(p.value, `:${globalVar}.${p.value.name}`);
      } else if (p.value.type === "Identifier") {
        state.edit.insertBefore(p.value, `${globalVar}.`);
      }
    }
  },

  ArrayPattern(node, state, c) {
    walk.base.ArrayPattern(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    for (const e of node.elements) {
      if (e.type === "Identifier") {
        state.edit.insertBefore(e, `${globalVar}.`);
      }
    }
  },

  // Don't do any translation inside function (etc.) bodies.
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition: noop
};

/* tslint:enable:object-literal-sort-keys*/

function parseAsyncWrapped(src) {
  console.log(" source : ", src);
  // Parse javascript code which has been wrapped in an async function
  // expression, then find function body node.
  const root = acorn.parse(src, parseOptions);
  const fnExpr = root.body[0].expression;
  assert(fnExpr.type === "ArrowFunctionExpression");
  const body = fnExpr.body;
  return { body, root };
}

// Transpiles a repl cell into an async function expression.
// The returning string has the form:
//   (async (global, import) => {
//     ... cell statements
//     return last_expression_result;
//   })
export function transpile(src: string, name: string = null): string {
  let body, root;
  const sourceFile = new SourceFile(name, src);
  const edit = new SourceEditor(sourceFile.content);

  // Wrap the source in an async function.
  edit.prepend(`(async (${globalVar}, ${importFn}, console) => {\n`);
  edit.append("\n})");

  // Translate imports into async imports.
  ({ body, root } = parseAsyncWrapped(edit.stratify()));
  walk.recursive(body, { edit }, importVisitors);

  // Translate variable declarations into global assignments.
  ({ body, root } = parseAsyncWrapped(edit.stratify()));
  walkRecursiveWithAncestors(
    body,
    {
      body,
      edit,
      translatingVariableDeclaration: false
    },
    evalScopeVisitors
  );

  // If the last statement is an expression, turn it into a return statement.
  if (body.body.length > 0) {
    const last = body.body[body.body.length - 1];
    if (last.type === "ExpressionStatement") {
      edit.insertBefore(last, "return (");
      edit.insertAfter(last.expression, ")");
    }
  }

  const mappedStr = edit.merge();
  let transpiledSource = mappedStr.toString();
  if (name != null) {
    transpiledSource +=
      "\n" +
      mappedStr.getInlineSourceMap() +
      "\n" +
      "//# sourceURL=transpiled.js";
  }
  console.log(transpiledSource);
  return transpiledSource;
}
