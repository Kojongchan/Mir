import { createHash } from 'node:crypto';

/** R2 cache directory for one exact model version: SHA-256 of the full URN (version included), 40 hex chars.
 * Must match api/aps-convert.ts cacheKey(). */
export const cacheKey = urn => createHash('sha256').update(String(urn)).digest('hex').slice(0, 40);

/** Former key: first 40 alphanumerics of the base64 URN. For ACC that is only
 * "urn:adsk.wipprod:fs.file:vf." plus two ID characters, so versions and many files collided.
 * Read-only compatibility; new data is never written here. */
export const legacyCacheKey = urn => String(urn).replace(/[^a-zA-Z0-9]/g, '').slice(0, 40);
