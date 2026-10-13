import { useEffect, useState } from 'react';
import { fetchJson } from '../api.js';

export const POLL_INTERVAL_MS = 2000;

const IDLE = { data: null, error: null, loading: false, updatedAt: null };
const LOADING = { data: null, error: null, loading: true, updatedAt: null };

/**
 * Fetch `url` now, then again every `interval` ms.
 *
 * Safety properties:
 *   • Never overlapping: the next request is scheduled only after the
 *     previous one finishes, so a slow API can't pile up requests.
 *   • No stale data: changing `url` (e.g. switching node) aborts the old
 *     request and ignores anything it returns.
 *   • Clean unmount: timers are cleared and in-flight requests aborted.
 *   • On errors, the last good data is kept (marked by `error`).
 *
 * @param {string|null} url - null means "don't fetch".
 * @returns {{ data: any, error: Error|null, loading: boolean, updatedAt: number|null }}
 */
export function usePolling(url, interval = POLL_INTERVAL_MS) {
  const [state, setState] = useState(url ? LOADING : IDLE);

  useEffect(() => {
    if (!url) {
      setState(IDLE);
      return undefined;
    }
    setState(LOADING); // new URL → don't show data that belonged to the old one

    let cancelled = false;
    let timer = null;
    let controller = null;

    async function tick() {
      controller = new AbortController();
      try {
        const data = await fetchJson(url, controller.signal);
        if (!cancelled) setState({ data, error: null, loading: false, updatedAt: Date.now() });
      } catch (error) {
        if (cancelled || error.name === 'AbortError') return;
        setState((previous) => ({ ...previous, error, loading: false }));
      }
      if (!cancelled) timer = setTimeout(tick, interval);
    }

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller?.abort();
    };
  }, [url, interval]);

  return state;
}
