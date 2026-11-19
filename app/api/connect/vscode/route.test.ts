import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("GET /api/connect/vscode", () => {
  it("only says this is a PAODO instance", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ paodo: true });
  });
});
