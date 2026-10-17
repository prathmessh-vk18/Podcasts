import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for OAuth tokens at rest.
 * Format: v1.<keyId>.<iv>.<ciphertext>.<tag> (base64url parts).
 * - keyId lets us rotate keys: new writes use the current key, old keys still decrypt.
 * - Associated data (e.g. "userId:platform") binds a ciphertext to its row, so a token
 *   copied into another user's row fails to decrypt.
 */
export class TokenCipher {
  private readonly keys: Map<string, Buffer>;
  private readonly currentId: string;

  constructor(current: Buffer, old: Buffer[] = []) {
    if (current.length !== 32) throw new Error('Encryption key must be 32 bytes');
    this.currentId = TokenCipher.keyId(current);
    this.keys = new Map([[this.currentId, current], ...old.map((k) => [TokenCipher.keyId(k), k] as const)]);
  }

  static keyId(key: Buffer): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 8);
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.currentId)!, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      this.currentId,
      iv.toString('base64url'),
      ct.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string, aad: string): string {
    const parts = payload.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Unrecognised token format');
    const [, keyId, iv, ct, tag] = parts as [string, string, string, string, string];
    const key = this.keys.get(keyId);
    if (!key) throw new Error('Token was encrypted with an unknown key');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  /** True when the payload should be re-encrypted with the current key. */
  needsRotation(payload: string): boolean {
    return payload.split('.')[1] !== this.currentId;
  }
}
