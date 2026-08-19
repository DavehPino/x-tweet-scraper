import { describe, it, expect } from 'vitest';
import { sessionIdFor } from '../src/lib/proxy.js';

describe('sessionIdFor', () => {
    it('passes valid labels through unchanged', () => {
        expect(sessionIdFor('author_apify')).toBe('author_apify');
        expect(sessionIdFor('tweet.123')).toBe('tweet.123');
        expect(sessionIdFor('a_b~c')).toBe('a_b~c');
    });

    it('replaces hyphens with underscores', () => {
        expect(sessionIdFor('author-apify')).toBe('author_apify');
        expect(sessionIdFor('tweet-12345')).toBe('tweet_12345');
    });

    it('replaces spaces and other invalid chars', () => {
        expect(sessionIdFor('author apify')).toBe('author_apify');
        expect(sessionIdFor('user@name!')).toBe('user_name_');
    });

    it('caps length at 50 characters', () => {
        const long = 'a'.repeat(100);
        expect(sessionIdFor(long)).toHaveLength(50);
    });
});
