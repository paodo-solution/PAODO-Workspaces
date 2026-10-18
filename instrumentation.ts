import type { Instrumentation } from "next";

// Logs route exceptions the custom server only sees as a 500. The import must sit inside the `=== "nodejs"`
// branch: webpack drops it there, but an early-return guard would pull pino into the Edge bundle.
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { logNextRequestError } = await import("./instrumentation.node");
    return logNextRequestError(err, request, context);
  }
};
