/**
 * peer.js — one TCP connection to another node.
 *
 * Handles the "plumbing" so node.js can focus on blockchain logic:
 *   • splitting the byte stream into lines (messages)
 *   • enforcing the size limit
 *   • request → reply matching (GET_CHAIN → CHAIN) with timeouts
 *   • counting "strikes" for bad messages and disconnecting repeat offenders
 */
import { encode, parseMessage, MAX_MESSAGE_BYTES } from './protocol.js';

const MAX_STRIKES = 3;

export class Peer {
  #socket;
  #buffer = '';
  #pending = new Map(); // requestId → { resolve, reject, timer }
  #nextRequestId = 1;
  #strikes = 0;
  #requestTimeoutMs;
  #closedPromise;
  #closing = false; // close() was called; stop reading and writing

  /**
   * @param {import('node:net').Socket} socket
   * @param {object} options
   * @param {boolean} options.outbound          - true if WE opened the connection.
   * @param {number}  options.requestTimeoutMs  - How long to wait for replies.
   * @param {(peer: Peer, message: object) => void|Promise<void>} options.onMessage
   * @param {(peer: Peer) => void} options.onClose
   */
  constructor(socket, { outbound, requestTimeoutMs, onMessage, onClose }) {
    this.#socket = socket;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.outbound = outbound;
    this.id = null; // the remote node's ID, set once the handshake succeeds
    this.closed = false;

    let resolveClosed;
    this.#closedPromise = new Promise((resolve) => (resolveClosed = resolve));

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.#onData(chunk, onMessage));
    socket.on('error', () => {}); // an 'error' is always followed by 'close'
    socket.on('close', () => {
      this.closed = true;
      for (const { reject, timer } of this.#pending.values()) {
        clearTimeout(timer);
        reject(new Error('Connection closed'));
      }
      this.#pending.clear();
      onClose(this);
      resolveClosed();
    });
  }

  /** Send one message. Silently does nothing if the connection is closed. */
  send(message) {
    if (this.closed || this.#closing) return;
    this.#socket.write(encode(message));
  }

  /**
   * Send a request and wait for the reply with the matching requestId.
   * Rejects on timeout or if the connection closes first.
   */
  request(message) {
    const requestId = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`No reply to ${message.type} within ${this.#requestTimeoutMs} ms`));
      }, this.#requestTimeoutMs);
      timer.unref(); // never keep the process alive just for this timer
      this.#pending.set(requestId, { resolve, reject, timer });
      this.send({ ...message, requestId });
    });
  }

  /** If `requestId` matches a request we sent, deliver the reply and return true. */
  resolveRequest(requestId, message) {
    const pending = this.#pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
    pending.resolve(message);
    return true;
  }

  /** Record a protocol violation: reply with ERROR, disconnect after too many. */
  misbehave(reason) {
    this.#strikes++;
    this.send({ type: 'ERROR', message: reason.slice(0, 500) });
    if (this.#strikes >= MAX_STRIKES) this.close();
  }

  /** Close gracefully (pending writes are flushed). Resolves once fully closed. */
  close() {
    if (!this.closed && !this.#closing) {
      this.#closing = true;
      this.#socket.end();
      // If the other side never finishes closing, force it.
      setTimeout(() => this.#socket.destroy(), 1000).unref();
    }
    return this.#closedPromise;
  }

  // Split incoming text into lines; each line is one message.
  #onData(chunk, onMessage) {
    this.#buffer += chunk;
    let newline;
    while (!this.closed && !this.#closing && (newline = this.#buffer.indexOf('\n')) !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) return this.#tooLarge();

      const result = parseMessage(line);
      if (!result.ok) {
        this.misbehave(result.reason);
        continue;
      }
      // A bug or bad data in a handler must never crash the node.
      Promise.resolve()
        .then(() => onMessage(this, result.message))
        .catch((err) => this.misbehave(`Could not process ${result.message.type}: ${err.message}`));
    }
    // A partial line that's already too big will never become a valid message.
    if (Buffer.byteLength(this.#buffer) > MAX_MESSAGE_BYTES) this.#tooLarge();
  }

  #tooLarge() {
    this.#buffer = '';
    this.send({ type: 'ERROR', message: `Message exceeds ${MAX_MESSAGE_BYTES} bytes` });
    this.close();
  }
}
