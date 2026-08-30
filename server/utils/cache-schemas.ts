import { z } from 'zod'

/**
 * The body `POST /api/cached/invalidate` accepts.
 *
 * A tag is a short label, not free text: it is written into a storage key, and
 * an unbounded one would let a caller fill the tag namespace with keys that
 * every later sweep of that prefix has to walk. The length cap and the character
 * set are the whole validation — {@link cacheInvalidationSchema} deliberately
 * does not check that a tag *exists*, because "invalidate a tag nothing is
 * cached under" is a no-op, not an error, and a client that had to know which
 * tags were live would be reading the cache to write to it.
 *
 * The alphabet is what a tag is made of in this app: a name, optionally scoped
 * to one record (`catalog`, `catalog:42`, `user:7:posts`). It is narrower than
 * `encodeKeySegment` in `server/utils/cache-tags.ts` can handle — that function
 * encodes anything — so widening this later cannot break stored keys.
 */
const TAG_PATTERN = /^[a-z][a-z\d_:-]*$/

export const cacheInvalidationSchema = z.object({
  tags: z
    .array(
      z
        .string()
        .min(1, 'A tag cannot be empty')
        .max(128, 'A tag must be 128 characters or less')
        .regex(
          TAG_PATTERN,
          'A tag must start with a lowercase letter and contain only letters, digits, "_", "-" and ":"',
        ),
    )
    .min(1, 'At least one tag is required')
    .max(50, 'At most 50 tags can be invalidated in one request'),
})

export type CacheInvalidationInput = z.infer<typeof cacheInvalidationSchema>
