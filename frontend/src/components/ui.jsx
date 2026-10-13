/**
 * ui.jsx — small building blocks shared by every view.
 */
import { useState } from 'react';
import { shortHash, splitLeadingZeros } from '../format.js';

/** A hash in monospace. `zeros` highlights the proof-of-work prefix. */
export function Hash({ value, full = false, zeros = false }) {
  if (!value) return <span className="muted">—</span>;
  const text = full ? value : shortHash(value);
  if (!zeros) {
    return <code className="hash" title={value}>{text}</code>;
  }
  const [leading, rest] = splitLeadingZeros(text);
  return (
    <code className="hash" title={value}>
      <span className="hash-zeros">{leading}</span>
      {rest}
    </code>
  );
}

export function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  if (!navigator.clipboard) return null;
  return (
    <button
      type="button"
      className="copy"
      onClick={() => navigator.clipboard.writeText(value).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })}
      aria-label="Copy to clipboard"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A display name (if known) shown NEXT TO the real address, never instead of it. */
export function Address({ address, label, full = false }) {
  return (
    <span className="address">
      {label ? <span className="name">{label}</span> : <span className="name unknown">Unlabeled</span>}
      <Hash value={address} full={full} />
    </span>
  );
}

export function Badge({ tone = 'neutral', children }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function StatCard({ label, hint, children }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{children}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

const ICONS = { loading: '◌', empty: '○', error: '!', offline: '⨯' };

export function StateMessage({ kind, title, children }) {
  const urgent = kind === 'error' || kind === 'offline';
  return (
    <div className={`state state-${kind}`} role={urgent ? 'alert' : 'status'}>
      <span className="state-icon" aria-hidden="true">{ICONS[kind]}</span>
      <div>
        <div className="state-title">{title}</div>
        {children && <div className="state-body">{children}</div>}
      </div>
    </div>
  );
}

export function OfflineMessage() {
  return (
    <StateMessage kind="offline" title="MiniChain API is offline">
      The dashboard can't reach the local API. Start it with <code>npm run explorer</code> — this page
      will reconnect automatically.
    </StateMessage>
  );
}

/**
 * Render loading / error / offline states for a usePolling() result, or call
 * `children(data)`. If a refresh fails after data loaded, the last data stays
 * visible with a warning, so the screen never goes blank on a hiccup.
 */
export function Loadable({ state, label, children }) {
  const { data, error } = state;
  if (!data) {
    if (error?.offline) return <OfflineMessage />;
    if (error) return <StateMessage kind="error" title={`Could not load ${label}`}>{error.message}</StateMessage>;
    return <StateMessage kind="loading" title={`Loading ${label}…`} />;
  }
  return (
    <>
      {error && (
        <div className="stale" role="status">
          Showing last known data — {error.offline ? 'the API is unreachable' : error.message}
        </div>
      )}
      {children(data)}
    </>
  );
}
