import { describe, expect, it } from 'vitest';
import { getVaultShortId, registerVaultOrigin, getVaultOrigin, unregisterVaultOrigin } from '../api';

describe('vault routing helpers', () => {
  it('converts full UUID to 8-character uppercase hex short ID', () => {
    expect(getVaultShortId('f6ff1b89-62e6-41e3-a846-ad6b323538c3')).toBe('F6FF1B89');
    expect(getVaultShortId('54365642-20f9-4861-9639-fa59f9800a1c')).toBe('54365642');
    expect(getVaultShortId('abcdef01')).toBe('ABCDEF01');
  });

  it('matches 8-hex regex pattern with lowercase normalization', () => {
    const regex = /^\/vault\/([a-fA-F0-9]{8})$/i;
    const matchLower = regex.exec('/vault/cff98a2b');
    expect(matchLower).not.toBeNull();
    expect(matchLower![1].toUpperCase()).toBe('CFF98A2B');

    const matchUpper = regex.exec('/vault/CFF98A2B');
    expect(matchUpper).not.toBeNull();
    expect(matchUpper![1]).toBe('CFF98A2B');

    expect(regex.exec('/vault/invalid')).toBeNull();
    expect(regex.exec('/vault/12345')).toBeNull();
    expect(regex.exec('/vault/123456789')).toBeNull();
  });

  it('registers and retrieves origins by both full id and short 8-hex id', () => {
    const uuid = 'f6ff1b89-62e6-41e3-a846-ad6b323538c3';
    registerVaultOrigin(uuid, 'https://remote.example.com', 'token-123');

    // Retrieve by full UUID
    expect(getVaultOrigin(uuid)).toEqual({ origin: 'https://remote.example.com', token: 'token-123' });

    // Retrieve by 8-hex uppercase
    expect(getVaultOrigin('F6FF1B89')).toEqual({ origin: 'https://remote.example.com', token: 'token-123' });

    // Retrieve by 8-hex lowercase
    expect(getVaultOrigin('f6ff1b89')).toEqual({ origin: 'https://remote.example.com', token: 'token-123' });

    unregisterVaultOrigin(uuid);
    expect(getVaultOrigin(uuid)).toBeUndefined();
    expect(getVaultOrigin('F6FF1B89')).toBeUndefined();
  });
});
