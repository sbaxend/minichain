/**
 * transaction.js — a signed request to move fictional coins.
 *
 * A valid signature proves AUTHORIZATION: the owner of the sender's private
 * key approved exactly this transaction. It does NOT prove the sender has
 * enough coins, or that this transaction hasn't already been used — those
 * checks need the chain's history, so they live in ledger.js.
 */
import { createPublicKey, verify } from 'node:crypto';
import { serialize } from './serialize.js';
import { addressFromPublicKey, isValidAddress } from './address.js';
import { checkCallShape, contractIdFor, isValidContractId } from './contracts.js';

// Every field a transfer has — no more, no less (see fromJSON).
const FIELDS = ['amount', 'nonce', 'recipient', 'sender', 'senderPublicKey', 'signature', 'timestamp'];
// A contract operation has exactly ONE extra field: `contract` (see contracts.js).
// Transfers never carry it, so their serialization, signatures and IDs are
// exactly what they were before smart contracts existed.
const CONTRACT_FIELDS = [...FIELDS, 'contract'].sort();

export class Transaction {
  /**
   * @param {object} fields
   * @param {string} fields.sender          - Sender's address.
   * @param {string} fields.recipient       - Recipient's address.
   * @param {number} fields.amount          - Whole number of fictional coins.
   * @param {string} fields.senderPublicKey - Sender's public key (hex). Needed because
   *                                          an address is a one-way hash of the key.
   * @param {number} fields.timestamp       - Creation time in ms.
   * @param {number} [fields.nonce]         - Sender's transaction counter: 0 for their
   *                                          first transaction, then 1, 2, ... Prevents
   *                                          replays. NOT the same as a block's mining nonce.
   * @param {string|null} [fields.signature] - Hex signature, or null if unsigned.
   * @param {object} [fields.contract]      - Contract call ({ op, ... }); omitted for plain transfers.
   *                                          When present, `recipient` is the contract ID.
   */
  constructor({ sender, recipient, amount, senderPublicKey, timestamp, nonce = 0, signature = null, contract }) {
    this.sender = sender;
    this.recipient = recipient;
    this.amount = amount;
    this.senderPublicKey = senderPublicKey;
    this.timestamp = timestamp;
    this.nonce = nonce;
    this.signature = signature;
    if (contract !== undefined) this.contract = structuredClone(contract);
  }

  /** True for contract operations (deploy / fund / claim / refund). */
  get isContractCall() {
    return this.contract !== undefined;
  }

  /**
   * Rebuild a Transaction from plain data (e.g. read back out of a block).
   * Strict: the object must have exactly the expected fields, so nothing
   * unverified can ride along inside a transaction.
   *
   * @throws {TypeError} if the data has missing or extra fields.
   */
  static fromJSON(data) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('Transaction data must be an object');
    }
    const keys = Object.keys(data).sort().join();
    if (keys !== FIELDS.join() && keys !== CONTRACT_FIELDS.join()) {
      throw new TypeError(`Transaction must have exactly these fields: ${FIELDS.join(', ')} (and optionally contract)`);
    }
    return new Transaction(data);
  }

  /**
   * Plain-data copy of this transaction, suitable for storing in a block.
   */
  toJSON() {
    return {
      sender: this.sender,
      recipient: this.recipient,
      amount: this.amount,
      senderPublicKey: this.senderPublicKey,
      timestamp: this.timestamp,
      nonce: this.nonce,
      signature: this.signature,
      ...(this.isContractCall ? { contract: structuredClone(this.contract) } : {}),
    };
  }

  /**
   * The exact text that gets signed: every field EXCEPT the signature
   * (a signature can't sign itself). serialize() sorts keys and quotes
   * strings, so the same transaction always produces the same text.
   * For contract calls the call itself is signed too, so nobody can change
   * the operation or its terms.
   */
  signingPayload() {
    return serialize({
      sender: this.sender,
      recipient: this.recipient,
      amount: this.amount,
      senderPublicKey: this.senderPublicKey,
      timestamp: this.timestamp,
      nonce: this.nonce, // signed, so nobody can change it to replay the transaction
      ...(this.isContractCall ? { contract: this.contract } : {}),
    });
  }

  /**
   * Check that this transaction is well-formed and properly authorized.
   * Does NOT check balances or whether the nonce is the right next one —
   * that needs chain history (see ledger.js).
   *
   * @returns {{ valid: true } | { valid: false, reason: string }}
   */
  verify() {
    // 1. Amount: a positive whole number. Whole numbers avoid floating-point
    //    surprises like 0.1 + 0.2 = 0.30000000000000004.
    if (!Number.isSafeInteger(this.amount) || this.amount <= 0) {
      return fail('Amount must be a positive whole number');
    }
    if (!Number.isSafeInteger(this.nonce) || this.nonce < 0) {
      return fail('Transaction nonce must be a whole number ≥ 0');
    }

    // 2. Addresses must look like addresses. A contract call is addressed to
    //    a contract ID instead, and its call data must match the strict schema.
    if (!isValidAddress(this.sender)) return fail('Invalid sender address');
    if (this.isContractCall) {
      const problem = checkCallShape(this.contract);
      if (problem) return fail(problem);
      if (!isValidContractId(this.recipient)) return fail('Invalid contract ID');
      if (this.contract.op === 'deploy') {
        const { template, params } = this.contract;
        if (this.recipient !== contractIdFor({ creator: this.sender, nonce: this.nonce, template, params })) {
          return fail('Deploy recipient must be the contract ID derived from creator, nonce and terms');
        }
      }
    } else if (!isValidAddress(this.recipient)) {
      return fail('Invalid recipient address');
    }

    // 3. Must be signed.
    if (!this.signature) return fail('Transaction is not signed');

    // 4. The public key must belong to the sender address. Without this,
    //    anyone could attach THEIR key and sign "from" someone else's address.
    if (typeof this.senderPublicKey !== 'string' ||
        addressFromPublicKey(this.senderPublicKey) !== this.sender) {
      return fail('Public key does not match sender address');
    }

    // 5. The signature must be valid for this exact payload and key.
    if (!verifySignature(this.signingPayload(), this.signature, this.senderPublicKey)) {
      return fail('Invalid signature');
    }

    return { valid: true };
  }

  /**
   * Shortcut when you only need yes/no.
   */
  isValid() {
    return this.verify().valid;
  }
}

function fail(reason) {
  return { valid: false, reason };
}

// An Ed25519 signature is always 64 bytes = 128 hex characters.
const SIGNATURE_PATTERN = /^[0-9a-f]{128}$/;

/**
 * Verify an Ed25519 signature. Returns false (instead of crashing) if the
 * key or signature is malformed — bad input should just be "invalid".
 */
function verifySignature(message, signatureHex, publicKeyHex) {
  // Strict format check first: Buffer.from(hex) silently ignores trailing junk,
  // so without this, "<valid signature>zz" would also be accepted.
  if (typeof signatureHex !== 'string' || !SIGNATURE_PATTERN.test(signatureHex)) {
    return false;
  }
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
