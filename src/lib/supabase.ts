import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True once the project's Supabase keys are present in the environment. */
export const isSupabaseConfigured = Boolean(url && anonKey);

// Username login is mapped onto an internal e-mail so we can use Supabase Auth
// (secure password hashing, sessions) while users only ever type a username.
// ASCII usernames pass through unchanged ("admin" -> "admin@mir.local").
// Non-ASCII usernames (e.g. Korean "고종찬") are encoded to a reversible,
// ASCII-safe "u-<hex>" local part, because GoTrue's e-mail validation rejects
// non-ASCII local parts. The e-mail is internal; users only see the username.
// KEEP IN SYNC with scripts/username-email.mjs.
export const USERNAME_DOMAIN = 'mir.local';
export function usernameToEmail(username: string): string {
  const name = username.trim().toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name) && !name.startsWith('u-')) {
    return `${name}@${USERNAME_DOMAIN}`;
  }
  const hex = Array.from(new TextEncoder().encode(name))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `u-${hex}@${USERNAME_DOMAIN}`;
}

// Falls back to harmless placeholders so the app can still render a clear
// "not configured" message instead of crashing on import.
export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'public-anon-key');
