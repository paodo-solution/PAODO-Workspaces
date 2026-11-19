// Public and unauthenticated: lets the VS Code extension check that an address is a PAODO instance before it
// opens /connect/vscode in the browser, so a wrong address never lands on a "Not found" page. Says nothing else.
export const runtime = "nodejs";

export function GET() {
  return Response.json({ paodo: true }, { headers: { "Cache-Control": "no-store" } });
}
