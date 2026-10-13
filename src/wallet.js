/**
 * wallet.js — a key pair plus an address. Fictional coins only.
 *
 *   private key  ──(kept secret)──► signs messages
 *   public key   ──(shared)───────► lets anyone verify those signatures
 *   address      ──(derived from the public key, see address.js)
 *
 * We use Ed25519 from Node's built-in crypto module. Never write your own
 * cryptography — use a well-reviewed implementation like this one.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { addressFromPublicKey } from './address.js';
import { Transaction } from './transaction.js';
import { ESCROW_TEMPLATE, contractIdFor } from './contracts.js';

export class Wallet {
  // `#` makes this a truly private field: it can't be read from outside the
  // class, and it doesn't show up in console.log(wallet) or JSON.stringify(wallet).
  #privateKey;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    this.#privateKey = privateKey;

    // Export the public key as hex text so it can travel inside a transaction.
    // "spki" + "der" is the standard binary format for public keys.
    this.publicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('hex');
    this.address = addressFromPublicKey(this.publicKey);
  }

  /**
   * Sign any string with this wallet's private key.
   * Ed25519 is deterministic: same message + same key → same signature.
   *
   * @param {string} message
   * @returns {string} Signature as hex.
   */
  sign(message) {
    if (typeof message !== 'string') {
      throw new TypeError('message must be a string');
    }
    // Ed25519 hashes internally, so the algorithm argument is null.
    return sign(null, Buffer.from(message, 'utf8'), this.#privateKey).toString('hex');
  }

  /**
   * Build an UNSIGNED transaction that spends from this wallet.
   * Call signTransaction() afterwards to authorize it.
   *
   * @param {string} recipient - Recipient's address.
   * @param {number} amount    - Whole number of fictional coins.
   * @param {object} [options]
   * @param {number} [options.nonce=0]     - This wallet's transaction counter. Use
   *                                         ledger.getNextNonce(address) to get it.
   * @param {number} [options.timestamp]   - Defaults to now. Tests pass a fixed value.
   */
  createTransaction(recipient, amount, options = {}) {
    // Before Milestone 5 the third argument was a timestamp number. Fail loudly
    // instead of silently ignoring it.
    if (options === null || typeof options !== 'object') {
      throw new TypeError('createTransaction options must be an object, e.g. { nonce: 0 }');
    }
    const { nonce = 0, timestamp = Date.now() } = options;
    return new Transaction({
      sender: this.address,
      recipient,
      amount,
      senderPublicKey: this.publicKey,
      timestamp,
      nonce,
    });
  }

  /**
   * Build an UNSIGNED timelock-escrow deployment from this wallet (the creator).
   * The contract ID is derived from the terms and this wallet's nonce, so it's
   * known before anything is mined.
   *
   * @param {object} terms
   * @param {string} terms.beneficiary  - Who may claim.
   * @param {number} terms.amount       - Total the escrow must hold before it can be claimed.
   * @param {number} terms.deposit      - Coins deposited now (1..amount).
   * @param {number} terms.unlockHeight - First block height at which a claim is allowed.
   * @param {number} terms.expiryHeight - From this height on, no claim; the creator may refund.
   * @param {object} [options] - { nonce, timestamp } as in createTransaction.
   */
  createEscrowDeploy({ beneficiary, amount, deposit, unlockHeight, expiryHeight }, options = {}) {
    const { nonce = 0, timestamp = Date.now() } = options;
    const params = { beneficiary, amount, unlockHeight, expiryHeight };
    const contract = { op: 'deploy', template: ESCROW_TEMPLATE, params };
    return new Transaction({
      sender: this.address,
      recipient: contractIdFor({ creator: this.address, nonce, template: ESCROW_TEMPLATE, params }),
      amount: deposit,
      senderPublicKey: this.publicKey,
      timestamp,
      nonce,
      contract,
    });
  }

  /**
   * Build an UNSIGNED fund / claim / refund call on an existing contract.
   * For claim and refund, `amount` must equal the contract's whole balance.
   */
  createContractCall(contractId, op, amount, options = {}) {
    const { nonce = 0, timestamp = Date.now() } = options;
    return new Transaction({
      sender: this.address,
      recipient: contractId,
      amount,
      senderPublicKey: this.publicKey,
      timestamp,
      nonce,
      contract: { op },
    });
  }

  /**
   * Sign a transaction that spends from THIS wallet.
   * Refuses if the transaction's sender or public key isn't this wallet's.
   *
   * @param {Transaction} tx
   * @returns {Transaction} The same transaction, now with a signature.
   */
  signTransaction(tx) {
    if (tx.sender !== this.address || tx.senderPublicKey !== this.publicKey) {
      throw new Error('Cannot sign a transaction that spends from another wallet');
    }
    tx.signature = this.sign(tx.signingPayload());
    return tx;
  }
}
