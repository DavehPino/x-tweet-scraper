import { describe, expect, it } from 'vitest';
import { parseInput } from '../src/validation.js';

describe('parseInput', () => {
    it('accepts a valid author target', () => {
        const input = parseInput({ fromUsers: ['apify'], maxResults: 50 });
        expect(input.fromUsers).toEqual(['apify']);
    });

    it('rejects input with no target at all', () => {
        expect(() => parseInput({ hashtags: ['buildinpublic'] })).toThrow(/at least one of fromUsers/i);
    });

    it('rejects unknown fields', () => {
        expect(() => parseInput({ fromUsers: ['x'], sneakyField: true })).toThrow();
    });

    it('rejects since > until', () => {
        expect(() => parseInput({ fromUsers: ['x'], since: '2025-02-01', until: '2025-01-01' })).toThrow(/since must be <= until/);
    });
});