// "Authorize VS Code?": opened by the extension in the browser, behind the instance's usual login. One click
// hands a one-time code to VS Code's loopback listener; Cancel tells it to stop waiting.
import Image from "next/image";
import { AppError } from "@/lib/errors/appError";
import { deviceAccessEnabled } from "@/lib/infra/security/credentialStore";
import { denyConnect, parseConnectRequest, type ConnectRequest } from "@/lib/operations/connect/vscode";
import AuthorizePanel from "./AuthorizePanel";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

// Only single values: a repeated parameter is malformed, and parseConnectRequest then refuses it.
function single(search: Search): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(search).map(([k, v]) => [k, Array.isArray(v) ? undefined : v]));
}

export default async function ConnectVscodePage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = single(await searchParams);
  let request: ConnectRequest | null = null;
  try {
    request = parseConnectRequest(search);
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
  }
  const problem = !request
    ? "This link is not a valid VS Code sign-in. Start again from VS Code."
    : !deviceAccessEnabled()
      ? "VS Code connections are turned off on this instance. An admin can turn them on in Settings."
      : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-tint p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-white p-8 shadow-sm">
        <Image src="/paodo-logo.svg" alt="PAODO" width={40} height={40} />
        <h1 className="mb-2 mt-5 text-lg font-semibold">Authorize VS Code</h1>
        {request && !problem ? (
          <AuthorizePanel request={search} cancel={denyConnect(request)} />
        ) : (
          <p role="alert" className="m-0 text-sm text-danger">
            {problem}
          </p>
        )}
      </div>
    </main>
  );
}
