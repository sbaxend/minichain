/**
 * api.js — the only place the frontend talks to the MiniChain API.
 * Read-only: every request is a GET.
 */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, offline?: boolean }} details
   */
  constructor(message, { status = null, offline = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status; // HTTP status, if the server answered
    this.offline = offline; // true if the server could not be reached at all
  }
}

/**
 * GET a JSON resource. Distinguishes "API unreachable" (offline) from
 * "API answered with an error" (status). Abort errors are re-thrown untouched
 * so callers can ignore them.
 */
export async function fetchJson(path, signal) {
  let response;
  try {
    response = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Cannot reach the MiniChain API', { offline: true });
  }

  let body = null;
  try {
    body = await response.json();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
  }

  if (!response.ok) {
    throw new ApiError(body?.error ?? `Request failed (HTTP ${response.status})`, { status: response.status });
  }
  if (body === null) throw new ApiError('The API returned invalid JSON', { status: response.status });
  return body;
}
