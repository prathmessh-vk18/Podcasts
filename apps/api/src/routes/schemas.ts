import { z } from 'zod';
import { PLATFORMS } from '@tangent/core';

export const platform = z.enum(PLATFORMS);
export const uuid = z.string().uuid();

export const idParam = z.object({ id: uuid });
export const platformParam = z.object({ platform });

export const searchQuery = z.object({
  q: z.string().trim().min(1, 'Enter something to search for').max(200),
  // YouTube search costs 100 quota units per call, so it's opt-in rather than default.
  platforms: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : ['apple', 'spotify']))
    .pipe(z.array(platform).min(1).max(3))
    .transform((arr) => [...new Set(arr)]),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

export const episodeRef = z
  .object({
    platform,
    sourceId: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/, 'Invalid id'),
    /** Lookup hints copied from a search result. Used to find the item, never stored as truth. */
    showId: z
      .string()
      .trim()
      .max(100)
      .regex(/^[A-Za-z0-9_-]+$/, 'Invalid show id')
      .optional(),
    title: z.string().trim().max(300).optional(),
  })
  .refine((r) => r.platform !== 'apple' || !!r.showId || !!r.title, {
    message: 'Apple episodes need the showId or title from the search result',
    path: ['showId'],
  });

const name = z.string().trim().min(1, 'Name is required').max(120);
const description = z.string().trim().max(500);

export const createCollection = z.object({ name, description: description.optional() });
export const updateCollection = z
  .object({
    name: name.optional(),
    description: description.optional(),
    privacy: z.enum(['private', 'link']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const reorderBody = z.object({ itemIds: z.array(uuid).max(500) });
export const itemParams = z.object({ id: uuid, itemId: uuid });

export const createExport = z.object({
  collectionId: uuid,
  destination: platform,
  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, numbers, - and _'),
  playlistTitle: z.string().trim().max(150).optional(),
});

export const decisionsBody = z.object({
  decisions: z
    .array(z.object({ itemId: uuid, decision: z.enum(['accept', 'reject']).nullable() }))
    .min(1)
    .max(500)
    .refine((d) => new Set(d.map((x) => x.itemId)).size === d.length, 'Each item can only appear once'),
});

export const connectStartQuery = z.object({ returnTo: z.string().max(500).optional() });
export const callbackQuery = z.object({
  code: z.string().max(2048).optional(),
  state: z.string().max(256).optional(),
  error: z.string().max(200).optional(),
});
