import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePolling } from './usePolling.js';

/** A fetch mock whose responses we resolve by hand. */
function controllableFetch() {
  const calls = [];
  const fetchMock = vi.fn((url, { signal }) => new Promise((resolve, reject) => {
    const call = {
      url,
      signal,
      respond: (body, status = 200) => resolve(new Response(JSON.stringify(body), { status })),
      fail: () => reject(new TypeError('Failed to fetch')),
    };
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    calls.push(call);
  }));
  return { fetchMock, calls };
}

let mock;
beforeEach(() => {
  vi.useFakeTimers();
  mock = controllableFetch();
  vi.stubGlobal('fetch', mock.fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('usePolling', () => {
  test('fetches immediately, then every interval after each response', async () => {
    const { result } = renderHook(() => usePolling('/api/a', 2000));
    expect(result.current.loading).toBe(true);
    expect(mock.calls).toHaveLength(1);

    await act(async () => mock.calls[0].respond({ n: 1 }));
    expect(result.current.data).toEqual({ n: 1 });
    expect(result.current.loading).toBe(false);

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(mock.calls).toHaveLength(2);
  });

  test('never overlaps: a slow request delays the next poll', async () => {
    renderHook(() => usePolling('/api/slow', 2000));
    await act(() => vi.advanceTimersByTimeAsync(10_000)); // first request still pending
    expect(mock.calls).toHaveLength(1);
    await act(async () => mock.calls[0].respond({}));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(mock.calls).toHaveLength(2);
  });

  test('changing the URL aborts the old request and ignores its response', async () => {
    const { result, rerender } = renderHook(({ url }) => usePolling(url, 2000), {
      initialProps: { url: '/api/nodes/alice' },
    });
    const old = mock.calls[0];
    rerender({ url: '/api/nodes/bob' });
    expect(old.signal.aborted).toBe(true);
    expect(result.current.data).toBe(null);

    await act(async () => mock.calls[1].respond({ id: 'bob' }));
    expect(result.current.data).toEqual({ id: 'bob' });
  });

  test('unmounting stops polling and aborts in-flight requests', async () => {
    const { unmount } = renderHook(() => usePolling('/api/a', 2000));
    await act(async () => mock.calls[0].respond({}));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    const inFlight = mock.calls[1];
    unmount();
    expect(inFlight.signal.aborted).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(mock.calls).toHaveLength(2);
  });

  test('offline errors keep the last good data and keep retrying', async () => {
    const { result } = renderHook(() => usePolling('/api/a', 2000));
    await act(async () => mock.calls[0].respond({ ok: 1 }));
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await act(async () => mock.calls[1].fail());
    expect(result.current.data).toEqual({ ok: 1 });
    expect(result.current.error.offline).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(2000));
    await act(async () => mock.calls[2].respond({ ok: 2 }));
    expect(result.current.error).toBe(null);
    expect(result.current.data).toEqual({ ok: 2 });
  });

  test('HTTP errors carry the status and the API message', async () => {
    const { result } = renderHook(() => usePolling('/api/missing', 2000));
    await act(async () => mock.calls[0].respond({ error: 'Not found' }, 404));
    expect(result.current.error.status).toBe(404);
    expect(result.current.error.message).toBe('Not found');
    expect(result.current.error.offline).toBe(false);
  });

  test('a null URL does nothing', () => {
    const { result } = renderHook(() => usePolling(null));
    expect(mock.calls).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });
});
