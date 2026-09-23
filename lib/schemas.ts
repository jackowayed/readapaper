import { z } from "zod";

/**
 * Runtime validation for API request bodies and stored articles.
 *
 * Conventions:
 * - Routes call `safeParse` on the already-JSON-parsed body and answer 400
 *   with {@link firstIssueMessage} on failure. "Invalid JSON" stays a manual
 *   pre-check (JSON.parse failure never reaches a schema).
 * - Custom `error` strings preserve the legacy messages clients (and the
 *   bookmarklet toast) already display.
 * - Unknown keys are stripped from request bodies but preserved on stored
 *   articles (`looseObject`), so a future field never gets wiped by a
 *   read-modify-write cycle running on older code.
 */

/** First human-readable issue, or a generic fallback (never empty). */
export function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message || "Invalid request";
}

/** POST /api/extract — legacy message: "Missing url". */
export const ExtractBodySchema = z.object({
  url: z.string({ error: "Missing url" }).min(1, "Missing url"),
});

/**
 * POST /api/articles — either a bare URL (server extracts) or pre-extracted
 * HTML from the bookmarklet. Legacy message: "Provide url or html".
 * Empties fall through to the refine so `""` behaves like "not provided",
 * matching the old truthiness checks; the route keeps its own size caps
 * (10MB HTML → 422) and `assertSafeHttpUrl` checks after parsing.
 */
export const SaveBodySchema = z
  .object({
    url: z.string({ error: "Provide url or html" }).optional(),
    html: z.string({ error: "Provide url or html" }).optional(),
  })
  .refine((b) => (b.url ?? "") !== "" || (b.html ?? "") !== "", {
    error: "Provide url or html",
  });

/**
 * PUT .../progress — canonical `{ offset }` wins when both are present;
 * legacy `{ progress }` fraction still accepted. Both must be finite
 * (rejects NaN/Infinity). Legacy message: "Missing progress".
 */
export const ProgressBodySchema = z
  .object({
    offset: z.number({ error: "Missing progress" }).finite().optional(),
    progress: z.number({ error: "Missing progress" }).finite().optional(),
  })
  .refine((b) => b.offset !== undefined || b.progress !== undefined, {
    error: "Missing progress",
  });

/** PUT .../archive — legacy message: "Missing archived". */
export const ArchiveBodySchema = z.object({
  archived: z.boolean({ error: "Missing archived" }),
});
/** PUT .../like — legacy message: "Missing liked". */
export const LikeBodySchema = z.object({
  liked: z.boolean({ error: "Missing liked" }),
});
/** PUT .../trash — legacy message: "Missing deleted". */
export const TrashBodySchema = z.object({
  deleted: z.boolean({ error: "Missing deleted" }),
});

/**
 * Stored article row. Mirrors `Article` in `lib/types.ts` (kept as the
 * source of truth for static types to avoid churning every consumer).
 * `progress` is bounded 0..1; unknown future fields pass through so old
 * rows are never damaged by validation.
 */
export const ArticleSchema = z.looseObject({
  id: z.string().min(1),
  url: z.string().min(1),
  title: z.string(),
  byline: z.string().nullable(),
  excerpt: z.string().nullable(),
  html: z.string(),
  text: z.string(),
  wordCount: z.number().int().nonnegative(),
  progress: z.number().min(0).max(1),
  progressOffset: z.number().int().nonnegative(),
  progressUpdatedAt: z.string().nullable(),
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  liked: z.boolean(),
  likedAt: z.string().nullable(),
  deleted: z.boolean(),
  deletedAt: z.string().nullable(),
  createdAt: z.string().min(1),
});
