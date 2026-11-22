// The gate's CloudFront Functions as the runtime cloudfront-js-2.0 takes them (gate/build.ts lowers each bundle here).
// The runtime refuses syntax that the core and its adapter use freely: spread, destructuring, default parameters,
// `?.`, `??`, `??=`, `for...of`, `catch {}`, and an `await` inside a call's arguments. The source keeps its style:
// the build changes the syntax, mechanically, in two steps.
//
//   1. Babel's own plugins lower each kind of syntax (LOWER).
//   2. `settle` gives each await a place of its own: a statement, a declaration's value, a return's value, or the
//      value of an assignment that is a statement. An await anywhere else moves to a declaration before its statement.
//      An await that runs only sometimes (the right side of `a && b`, `a || b`, a branch of `a ? b : c`, a later part
//      of `a, b`) keeps its condition: that expression becomes statements first.
//
// `refused` names what is left of the syntax the runtime refuses, and String.normalize, which it does not have: the
// build fails on any (tests/gate-lower.test.ts).
// It takes an await in any other place than step 2's four for refused. That is more than the runtime was seen to
// refuse (a call's arguments), on purpose: code with its awaits in those four places only ran on a real distribution
// (2026-11-18: a first experiment of this lowering, and then this build's own output, all four functions, in the verify
// suite's setting 5).
//
// Trap: step 2 moves an await before the other parts of its statement. That is right only while what the gate awaits
// has no effect (HMAC, SHA-256, a key store's read) and the parts it passes change nothing. An assignment before an
// await in one statement stops the build: write two statements.
// Trap: the lowering takes every `for...of` and every spread for an array's. The gate's code has no other kind; a Map
// or a Set there would give a loop that runs no times.

import { type NodePath, type PluginObject, parseSync, transformSync, traverse, types as t } from "@babel/core";
import destructuring from "@babel/plugin-transform-destructuring";
import forOf from "@babel/plugin-transform-for-of";
import logicalAssignment from "@babel/plugin-transform-logical-assignment-operators";
import nullish from "@babel/plugin-transform-nullish-coalescing-operator";
import objectSpread from "@babel/plugin-transform-object-rest-spread";
import optionalCatch from "@babel/plugin-transform-optional-catch-binding";
import optionalChaining from "@babel/plugin-transform-optional-chaining";
import parameters from "@babel/plugin-transform-parameters";
import spread from "@babel/plugin-transform-spread";

const LOWER = [
  parameters,
  destructuring,
  spread,
  objectSpread,
  nullish,
  optionalChaining,
  logicalAssignment,
  [forOf, { assumeArray: true }],
  optionalCatch,
];
/** What the lowering may take for true of the gate's code, for shorter output (see the traps at the top). */
const assumptions = {
  setSpreadProperties: true,
  objectRestNoSymbols: true,
  iterableIsArray: true,
  noDocumentAll: true,
  pureGetters: true,
  ignoreFunctionLength: true,
};
const babel = (code: string, plugins: unknown[], minified = false) =>
  transformSync(code, {
    babelrc: false,
    configFile: false,
    comments: false,
    sourceType: "module",
    assumptions,
    plugins: plugins as never,
    compact: minified,
    minified,
  })!.code!;

type Await = NodePath<t.AwaitExpression>;

/** Whether an await is in a place of its own (see the top). */
function settled(path: Await): boolean {
  const p = path.parentPath;
  if (p.isExpressionStatement() || p.isReturnStatement()) return true;
  if (p.isVariableDeclarator()) return !p.parentPath.parentPath?.isFor();
  return p.isAssignmentExpression({ operator: "=" }) && path.key == "right" && p.parentPath.isExpressionStatement();
}

/** The awaits of `path`'s own function that are not settled. */
function unsettled(path: NodePath): Await[] {
  const found: Await[] = [];
  path.traverse({
    AwaitExpression(a) {
      if (!settled(a)) found.push(a);
    },
    Function(f) {
      f.skip();
    },
  });
  return found;
}

/**
 * One pass of step 2. It changes the first await that needs statements made (then the other paths are stale), and
 * every plain one before it: `lower` runs it until nothing changes.
 */
const settle = (): PluginObject => {
  let stale = false;
  return {
    visitor: {
      Program() {
        stale = false;
      },
      // One declaration of many names, with an await to move inside a value: one declaration for each name, so the
      // await stays after the names before it.
      VariableDeclaration(path) {
        if (stale || path.node.declarations.length < 2 || path.parentPath.isFor() || !unsettled(path).length) return;
        path.replaceWithMultiple(path.node.declarations.map((d) => t.variableDeclaration(path.node.kind, [d])));
        stale = true;
      },
      AwaitExpression(path) {
        if (stale || settled(path)) return;
        // An arrow function with no braces: its value is a return's.
        const body = path.getFunctionParent()?.get("body");
        if (body && !Array.isArray(body) && body.isExpression()) {
          body.replaceWith(t.blockStatement([t.returnStatement(body.node)]));
          stale = true;
          return;
        }
        const stmt = path.findParent((p) => p.isStatement())!;
        if (stmt.isLoop() || (stmt.parentPath!.isLoop() && stmt.key != "body"))
          throw stmt.buildCodeFrameError("The gate's build can't move an await out of a loop's head: await in the loop's body.");
        // A branch or a loop's body with no braces: in braces first, so that the await stays inside it. (Trap: Babel's
        // getStatementParent passes such a statement, and gives the `if` around it: the await would run always.)
        if (!Array.isArray(stmt.container)) {
          stmt.replaceWith(t.blockStatement([stmt.node as t.Statement]));
          stale = true;
          return;
        }
        // The outermost expression that decides whether this await runs, or what runs before it.
        let guard: NodePath | null = null;
        for (let at: NodePath = path; at != stmt; at = at.parentPath!) {
          const up = at.parentPath!;
          if (
            (up.isLogicalExpression() && at.key == "right") ||
            (up.isConditionalExpression() && at.key != "test") ||
            (up.isSequenceExpression() && at.key != 0)
          )
            guard = up;
        }
        // What moves after the await: nothing there may change a value.
        const moved = guard ?? path;
        stmt.traverse({
          enter(early) {
            if (early.node.start! >= moved.node.start! || early.isFunction()) return early.skip();
            const change = early.isAssignmentExpression() || early.isUpdateExpression() || early.isUnaryExpression({ operator: "delete" });
            if (change && early.node.end! <= moved.node.start!)
              throw early.buildCodeFrameError("The gate's build can't move an await before this change: write two statements.");
          },
        });
        const id = path.scope.generateUidIdentifier("t");
        if (!guard) {
          stmt.insertBefore(t.variableDeclaration("const", [t.variableDeclarator(id, path.node)]));
          path.replaceWith(t.cloneNode(id));
          return;
        }
        const g = guard.node;
        const set = (value: t.Expression) => t.blockStatement([t.expressionStatement(t.assignmentExpression("=", t.cloneNode(id), value))]);
        if (t.isSequenceExpression(g)) {
          // `a, b` with the await in `b`: `a` is a statement before it.
          const at = g.expressions.findIndex((e) => e.start! <= path.node.start! && path.node.end! <= e.end!);
          stmt.insertBefore(g.expressions.slice(0, at).map((e) => t.expressionStatement(e)));
          const rest = g.expressions.slice(at);
          guard.replaceWith(rest.length == 1 ? rest[0] : t.sequenceExpression(rest));
        } else if (t.isConditionalExpression(g)) {
          stmt.insertBefore([
            t.variableDeclaration("let", [t.variableDeclarator(id)]),
            t.ifStatement(g.test, set(g.consequent), set(g.alternate)),
          ]);
          guard.replaceWith(t.cloneNode(id));
        } else if (t.isLogicalExpression(g)) {
          stmt.insertBefore([
            t.variableDeclaration("let", [t.variableDeclarator(id, g.left as t.Expression)]),
            t.ifStatement(g.operator == "&&" ? t.cloneNode(id) : t.unaryExpression("!", t.cloneNode(id)), set(g.right)),
          ]);
          guard.replaceWith(t.cloneNode(id));
        }
        stale = true;
      },
    },
  };
};

/** The names that the lowering made (Babel starts each with "_"), made short. */
const shorten = (): PluginObject => {
  let n = 0;
  return {
    visitor: {
      // (Babel makes a plugin one time, and uses it for every file.)
      Program() {
        n = 0;
      },
      Scopable(path) {
        for (const name of Object.keys(path.scope.bindings)) {
          if (!/^_[A-Za-z$]/.test(name)) continue;
          let to: string;
          do to = `$${(n++).toString(36)}`;
          while (path.scope.hasBinding(to) || path.scope.hasGlobal(to));
          path.scope.rename(name, to);
        }
      },
    },
  };
};

/**
 * A bundle as the runtime takes it, minified. The bundle comes minified already: this shortens only the names that
 * the lowering made. Trap: no minifier may run after it. Bun's writes destructuring again, and puts an await back
 * into a call's arguments.
 */
export function lower(code: string): string {
  let out = babel(code, LOWER);
  for (let before = ""; before != out; ) {
    before = out;
    out = babel(out, [settle]);
  }
  return babel(out, [shorten], true);
}

/** What `code` has of the syntax that the runtime refuses: each kind's name, one time. None: the runtime takes it. */
export function refused(code: string): string[] {
  const found = new Set<string>();
  const ast = parseSync(code, { babelrc: false, configFile: false, sourceType: "module" })!;
  traverse(ast, {
    SpreadElement: () => void found.add("spread"),
    RestElement: () => void found.add("rest"),
    ObjectPattern: () => void found.add("destructuring"),
    ArrayPattern: () => void found.add("destructuring"),
    AssignmentPattern: () => void found.add("a default parameter"),
    OptionalMemberExpression: () => void found.add("?."),
    OptionalCallExpression: () => void found.add("?."),
    LogicalExpression: (p) => void (p.node.operator == "??" && found.add("??")),
    AssignmentExpression: (p) => void (/^(\?\?|\|\||&&)=$/.test(p.node.operator) && found.add(p.node.operator)),
    ForOfStatement: () => void found.add("for...of"),
    CatchClause: (p) => void (!p.node.param && found.add("catch {}")),
    AwaitExpression: (p) => void (!settled(p) && found.add("an await inside an expression")),
    // Not syntax: a method that the runtime does not have. A call of it stops the function (a 503).
    MemberExpression: (p) => void (!p.node.computed && t.isIdentifier(p.node.property, { name: "normalize" }) && found.add(".normalize()")),
  });
  return [...found];
}
