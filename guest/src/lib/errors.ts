/**
 * Error printing for server responses.
 *
 * Single place where server errors are printed to console.error,
 * allowing a future task to append matching schema excerpts.
 */
export function printServerError(endpoint: string, status: number, body: unknown): void {
  if (typeof body === "object" && body !== null) {
    const b = body as Record<string, unknown>;
    const msg = b.error ?? b.message;
    if (typeof msg === "string") {
      console.error(msg);
    } else {
      console.error(`Server returned ${status}`);
    }
    if (Array.isArray(b.issues)) {
      for (const issue of b.issues) {
        console.error(String(issue));
      }
    }
  } else if (typeof body === "string" && body.trim()) {
    console.error(body);
  } else {
    console.error(`Server returned ${status}`);
  }
}
