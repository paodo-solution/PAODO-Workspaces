// An expired IAP session answers every same-origin call with a 302 to its login page, which fetch follows
// cross-origin into an opaque CORS failure. Our API never redirects, so a redirect or 401 means re-login.

interface GuardedWindow {
  fetch: typeof fetch;
  location: { href: string; origin: string; reload(): void };
}

/** True when this response can only come from a lapsed session, not from the app. */
export function isSessionExpired(res: Response): boolean {
  return res.type === "opaqueredirect" || res.status === 401;
}

function requestUrl(input: RequestInfo | URL, base: string): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === "string" ? input : input.url, base);
}

// Wraps win.fetch once. Same-origin calls stop at the redirect instead of following it, and the first
// expired response reloads the page so the IAP login takes over and returns the user to the same URL.
export function installSessionGuard(win: GuardedWindow): void {
  const original = win.fetch;
  if ((original as { sessionGuarded?: true }).sessionGuarded) return;
  let reloading = false;

  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (requestUrl(input, win.location.href).origin !== win.location.origin) return original(input, init);
    const res = await original(input, { ...init, redirect: init?.redirect ?? "manual" });
    if (isSessionExpired(res) && !reloading) {
      reloading = true;
      win.location.reload();
    }
    return res;
  };
  win.fetch = Object.assign(guarded, { sessionGuarded: true as const });
}
