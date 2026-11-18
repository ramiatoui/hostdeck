// Optional PIN lock. The PIN itself is never stored: only a salted scrypt
// hash. While locked, the main process refuses requests from the UI except
// the ones needed to unlock (see main.js).
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1 };
const FREE_ATTEMPTS = 5;
const MAX_WAIT_SECONDS = 300;

function validatePin(pin) {
  if (!/^\d{4,12}$/.test(String(pin || ''))) throw new Error('The PIN must be 4 to 12 digits.');
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32, SCRYPT);
  return { salt: salt.toString('base64'), hash: hash.toString('base64'), v: 1 };
}

function matches(pin, record) {
  if (!record || !record.hash) return false;
  const expected = Buffer.from(record.hash, 'base64');
  const actual = crypto.scryptSync(String(pin || ''), Buffer.from(record.salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

class AppLock {
  /**
   * @param {import('./store').Store} store
   * @param {{ now?: () => number }} [opts]
   */
  constructor(store, { now = () => Date.now() } = {}) {
    this.store = store;
    this.now = now;
    this.failures = 0;
    this.blockedUntil = 0;
    this.locked = this.enabled; // a PIN means every start begins locked
  }

  get enabled() {
    return Boolean(this.store.data.lock && this.store.data.lock.hash);
  }

  waitSeconds() {
    return Math.max(0, Math.ceil((this.blockedUntil - this.now()) / 1000));
  }

  status() {
    return { enabled: this.enabled, locked: this.locked, waitSeconds: this.waitSeconds() };
  }

  setPin(pin, currentPin) {
    validatePin(pin);
    if (this.enabled && !matches(currentPin, this.store.data.lock)) throw new Error('The current PIN is not right.');
    this.store.data.lock = hashPin(pin);
    this.store.save();
  }

  disable(currentPin) {
    if (!this.enabled) return;
    if (!matches(currentPin, this.store.data.lock)) throw new Error('The current PIN is not right.');
    this.store.data.lock = null;
    this.store.save();
    this.locked = false;
  }

  /** Lock now. Returns true if the app is locked afterwards. */
  lock() {
    if (this.enabled) this.locked = true;
    return this.locked;
  }

  unlock(pin) {
    if (!this.locked) return { ok: true };
    const wait = this.waitSeconds();
    if (wait > 0) return { ok: false, waitSeconds: wait };
    if (matches(pin, this.store.data.lock)) {
      this.locked = false;
      this.failures = 0;
      this.blockedUntil = 0;
      return { ok: true };
    }
    this.failures += 1;
    if (this.failures >= FREE_ATTEMPTS) {
      const seconds = Math.min(MAX_WAIT_SECONDS, 30 * 2 ** (this.failures - FREE_ATTEMPTS));
      this.blockedUntil = this.now() + seconds * 1000;
    }
    return { ok: false, attemptsLeft: Math.max(0, FREE_ATTEMPTS - this.failures), waitSeconds: this.waitSeconds() };
  }

  /**
   * Forgotten PIN: remove the lock together with every saved secret
   * (passwords, pasted keys, passphrases, browser logins). Servers stay.
   */
  reset() {
    this.store.clearAllSecrets();
    this.store.data.history = {}; // commands can contain secrets too
    this.store.data.lock = null;
    this.store.save();
    this.locked = false;
    this.failures = 0;
    this.blockedUntil = 0;
  }
}

module.exports = { AppLock, validatePin };
