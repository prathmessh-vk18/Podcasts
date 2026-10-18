import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('treats empty values from a copied .env template as unset', () => {
    const c = loadConfig({ NODE_ENV: 'development', DATABASE_URL: '', SPOTIFY_CLIENT_ID: '  ', PORT: '' });
    expect(c.DATABASE_URL).toBeUndefined();
    expect(c.SPOTIFY_CLIENT_ID).toBeUndefined();
    expect(c.PORT).toBe(4000);
  });

  it('refuses to start in production without its secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', TOKEN_ENCRYPTION_KEY: '' })).toThrow(
      /SESSION_SECRET.*required in production/s,
    );
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() => loadConfig({ TOKEN_ENCRYPTION_KEY: Buffer.from('short').toString('base64') })).toThrow(
      /32 bytes/,
    );
  });
});
