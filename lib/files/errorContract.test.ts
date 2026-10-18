// Source guard on how the file API fails. `{ error: err.message }` gave programs nothing to branch on and
// leaked libuv's host paths; it is easy to reintroduce, since nothing about it looks wrong.
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import ts from "typescript";

const ROOT = path.resolve(__dirname, "../..");

/** The file surface: everything that serves, writes, moves, archives or lists workspace files. */
const SCANNED = [
  "lib/files",
  "lib/uploads",
  "lib/operations/files",
  "lib/api/fileContentRoutes.ts",
  "lib/api/fileTreeRoutes.ts",
  "lib/api/fileTransferRoutes.ts",
  "app/api/workspaces/[id]/files",
  "app/api/drives/[id]/files",
];

function scannedFiles(): string[] {
  const files: string[] = [];
  const visit = (target: string) => {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      if (target.endsWith(".ts") && !target.endsWith(".test.ts")) files.push(target);
      return;
    }
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      visit(path.join(target, entry.name));
    }
  };
  for (const entry of SCANNED) visit(path.join(ROOT, entry));
  return files;
}

function eachNextResponseJson(
  onCall: (call: ts.CallExpression, source: ts.SourceFile, location: string) => void,
): void {
  for (const file of scannedFiles()) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf-8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "NextResponse" &&
        node.expression.name.text === "json"
      ) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        onCall(node, source, `${path.relative(ROOT, file)}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

describe("file error contract", () => {
  // The status has to be derived from the code, in one place (STATUS_BY_CODE), or the two drift: this is
  // how a disk-full answer ended up as a 507 that no code named, and a lost save as a 409 with none.
  it("never sets a failure status directly — errorResponse maps code to status", () => {
    const violations: string[] = [];

    eachNextResponseJson((call, source, location) => {
      const init = call.arguments[1];
      if (!init || !ts.isObjectLiteralExpression(init)) return;
      for (const property of init.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        if (property.name.getText(source).replace(/["']/g, "") !== "status") continue;
        const status = Number(property.initializer.getText(source));
        if (Number.isFinite(status) && status >= 400) {
          violations.push(`${location} returns status ${status} directly — use errorResponse(code, ...)`);
        }
      }
    });

    expect(violations).toEqual([]);
  });

  // `error` without `code` gives a program nothing to act on. `error` beside a `code` is fine (the batch move's
  // partial success), hence checking the pairing.
  it("never returns an error field without a code beside it", () => {
    const violations: string[] = [];

    eachNextResponseJson((call, source, location) => {
      const body = call.arguments[0];
      if (!body || !ts.isObjectLiteralExpression(body)) return;
      const named = new Set(
        body.properties
          .filter((p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => Boolean(p.name))
          .map((p) => p.name!.getText(source).replace(/["']/g, "")),
      );
      if (named.has("error") && !named.has("code")) {
        violations.push(`${location} returns a bare { error } body — use errorResponse(code, message)`);
      }
    });

    expect(violations).toEqual([]);
  });

  // Host-path leaks are not a source rule: scanning `err.message` flagged our own AppError messages. The guard
  // is behavioural instead, in lib/operations/files/errors.test.ts.
});
