'use strict';
/**
 * AES-256-GCM encryption for sensitive values stored in the DB.
 * ENCRYPTION_KEY must be a 64-char hex string (32 bytes).
 */
const crypto = require('crypto');

const ALGO      = 'aes-256-gcm';
const KEY_HEX   = process.env.ENCRYPTION_KEY || '';
let   _key      = null;

function getKey() {
  if (_key) return _key;
  if (!KEY_HEX || KEY_HEX.length < 64) {
    // Fall back to a deterministic key derived from SESSION_SECRET (dev only)
    const secret = process.env.SESSION_SECRET || 'insecure-dev-only';
    _key = crypto.createHash('sha256').update(secret).digest();
  } else {
    _key = Buffer.from(KEY_HEX.slice(0, 64), 'hex');
  }
  return _key;
}

/**
 * Encrypt a plain-text string.
 * Returns a `iv:authTag:ciphertext` colon-separated hex string.
 */
function encrypt(plainText) {
  if (!plainText) return plainText;
  const iv       = crypto.randomBytes(12);
  const cipher   = crypto.createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const authTag   = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt a value produced by encrypt().
 * Returns the original string, or the value as-is if it doesn't look encrypted.
 */
function decrypt(encryptedText) {
  if (!encryptedText) return encryptedText;
  const parts = String(encryptedText).split(':');
  if (parts.length !== 3) return encryptedText; // not encrypted, return raw
  try {
    const [ivHex, tagHex, ctHex] = parts;
    const iv       = Buffer.from(ivHex, 'hex');
    const authTag  = Buffer.from(tagHex, 'hex');
    const ct       = Buffer.from(ctHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return encryptedText; // decryption failed — return raw (unencrypted legacy value)
  }
}

module.exports = { encrypt, decrypt };
