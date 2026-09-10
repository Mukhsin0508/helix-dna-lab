import type { LabSession } from "../shared/types";

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly session?: LabSession,
  ) {
    super(message);
  }
}

/** Returns JSON from the lab API or a recoverable error; requests time out after ten seconds. */
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      signal: controller.signal,
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
      throw new RequestError(
        "The lab returned an unexpected response. Try again.",
        response.status || 502,
      );
    }
    const data = await response.json();
    if (!response.ok) {
      throw new RequestError(
        data?.message || "The lab could not save this change.",
        response.status,
        data?.session,
      );
    }
    return data as T;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError(
      controller.signal.aborted
        ? "The lab took too long to respond. Reconnect and try again."
        : "Connection interrupted. Your last saved experiment is safe; try again.",
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}
