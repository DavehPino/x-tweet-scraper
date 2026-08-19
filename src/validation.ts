import { z } from 'zod';
import { MEDIA_TYPES, SORT_ORDERS } from './types.js';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/, 'Invalid ISO-8601 date');

/**
 * Boundary validation of the actor input. Rejects malformed input with a
 * clear error before any outbound request is made.
 */
export const inputSchema = z
    .object({
        fromUsers: z.array(z.string().regex(/^\S+$/, 'handle cannot contain whitespace')).max(100).optional(),
        tweetIds: z.array(z.string().regex(/^\d+$/, 'tweet id must be numeric')).max(500).optional(),
        searchTerms: z.array(z.string().min(1).max(512)).max(20).optional(),
        hashtags: z.array(z.string().regex(/^[^\s#]+$/, 'hashtag cannot contain whitespace or #')).max(50).optional(),
        since: dateString.optional(),
        until: dateString.optional(),
        language: z.string().regex(/^[a-z]{2,3}$/i, 'language must be an ISO-639-1/2 code').optional(),
        minLikes: z.number().int().min(0).optional(),
        minRetweets: z.number().int().min(0).optional(),
        minReplies: z.number().int().min(0).optional(),
        onlyVerified: z.boolean().optional(),
        mediaType: z.enum(MEDIA_TYPES).optional(),
        includeReplies: z.boolean().optional(),
        includeRetweets: z.boolean().optional(),
        sortBy: z.enum(SORT_ORDERS).optional(),
        maxResults: z.number().int().min(1).max(10000).optional(),
        proxyConfiguration: z
            .object({
                useApifyProxy: z.boolean().optional(),
                apifyProxyGroups: z.array(z.string()).optional(),
                apifyProxyCountry: z.string().optional(),
                apifyProxySession: z.string().optional(),
            })
            .optional(),
    })
    .strict()
    .superRefine((input, ctx) => {
        if (!input.fromUsers?.length && !input.tweetIds?.length && !input.searchTerms?.length) {
            ctx.addIssue({
                code: 'custom',
                message: 'At least one of fromUsers, tweetIds or searchTerms must be provided',
            });
        }
        if (input.since && input.until && input.since > input.until) {
            ctx.addIssue({ code: 'custom', message: 'since must be <= until' });
        }
    });

export type ValidatedInput = z.infer<typeof inputSchema>;

export function parseInput(raw: unknown): ValidatedInput {
    return inputSchema.parse(raw);
}