// Error records feed the surfaced-log UI, so this source guard requires stable grouping and an explicit
// result rather than a bare message or stack.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");
const LOGGER_RECEIVERS = new Set(["log", "wlog", "elog", "this.log"]);
const EVENT_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const LOG_METHODS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

// Pino owns these keys; a call-site binding appends a duplicate the reader takes instead. `hostname` once
// hid the machine, and `level: "light"` sorted above 40, matching the deploy/README triage recipe.
const RESERVED_BINDINGS = new Set(["level", "time", "pid", "hostname", "msg", "context", "audit"]);

/** Receivers that are plausibly a logger — deliberately broader than LOGGER_RECEIVERS above. */
function isLoggerReceiver(receiver: string): boolean {
  return /(^|\.)(log|logger|audit)$/i.test(receiver);
}

function productionFiles(): string[] {
  const files = [
    path.join(ROOT, "server.ts"),
    path.join(ROOT, "proxyEntry.ts"),
    path.join(ROOT, "instrumentation.node.ts"),
  ];
  const visitDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visitDir(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  };
  visitDir(path.join(ROOT, "app"));
  visitDir(path.join(ROOT, "lib"));
  return files;
}

function literalField(object: ts.ObjectLiteralExpression, name: string): string | null {
  const property = object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && candidate.name.getText().replace(/["']/g, "") === name,
  );
  return property && ts.isStringLiteral(property.initializer) ? property.initializer.text : null;
}

describe("error log contract", () => {
  it("requires literal event and outcome fields on every application error/fatal record", () => {
    const violations: string[] = [];

    for (const file of productionFiles()) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const receiver = node.expression.expression.getText(source);
          if ((method === "error" || method === "fatal") && LOGGER_RECEIVERS.has(receiver)) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            const location = `${path.relative(ROOT, file)}:${line}`;
            const bindings = node.arguments[0];
            if (!bindings || !ts.isObjectLiteralExpression(bindings)) {
              violations.push(`${location} must pass an object literal as its first argument`);
            } else {
              const event = literalField(bindings, "event");
              const outcome = literalField(bindings, "outcome");
              if (!event || !EVENT_NAME.test(event)) violations.push(`${location} needs a snake_case literal event`);
              if (!outcome || !EVENT_NAME.test(outcome))
                violations.push(`${location} needs a snake_case literal outcome`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });

  it("never binds a field name Pino already writes, at any level", () => {
    const violations: string[] = [];

    for (const file of productionFiles()) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const method = node.expression.name.text;
          const receiver = node.expression.expression.getText(source);
          const bindings = node.arguments[0];
          if (
            LOG_METHODS.has(method) &&
            isLoggerReceiver(receiver) &&
            bindings &&
            ts.isObjectLiteralExpression(bindings)
          ) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            for (const property of bindings.properties) {
              // Shorthand (`{ hostname }`) collides just as readily as `{ hostname: x }`.
              if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
              const name = property.name?.getText(source).replace(/["']/g, "");
              if (name && RESERVED_BINDINGS.has(name)) {
                violations.push(`${path.relative(ROOT, file)}:${line} binds reserved log field "${name}"`);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(violations).toEqual([]);
  });
});
