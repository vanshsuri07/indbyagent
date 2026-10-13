/**
 * Probe helper for integration tests.
 * Decides whether to skip, fail, or run integration tests based on probe results.
 */

export type ProbeDecision = "skip" | "fail" | "run";

export interface ProbeDecisionInput {
  connectionError?: unknown;
  status?: number | null;
}

/**
 * Pure decision function:
 * - connection failure (ECONNREFUSED, ENOTFOUND, timeout with no response) -> skip
 * - 5xx status -> fail
 * - any other HTTP response (e.g. 200, 404, 405) -> run (server is up)
 */
export function decideProbe(input: ProbeDecisionInput): ProbeDecision {
  if (input.connectionError) {
    return "skip";
  }
  if (input.status !== undefined && input.status !== null) {
    if (input.status >= 500) {
      return "fail";
    }
    return "run";
  }
  return "skip";
}

/**
 * Probes the server baseUrl with a 60-second timeout.
 * Returns { connectionError, status }.
 */
export async function probeServer(baseUrl: string): Promise<ProbeDecisionInput> {
  try {
    const res = await fetch(baseUrl, {
      signal: AbortSignal.timeout(60000),
    });
    return { status: res.status };
  } catch (err: unknown) {
    return { connectionError: err };
  }
}
