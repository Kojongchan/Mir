import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True once the project's Supabase keys are present in the environment. */
export const isSupabaseConfigured = Boolean(url && anonKey);

// Username login is mapped onto an internal e-mail so we can use Supabase Auth
// (secure password hashing, sessions) while users only ever type a username.
export const USERNAME_DOMAIN = 'mir.local';
export const usernameToEmail = (username: string) =>
  `${username.trim().toLowerCase()}@${USERNAME_DOMAIN}`;

// Falls back to harmless placeholders so the app can still render a clear
// "not configured" message instead of crashing on import.
export const supabase = createClient(url ?? 'http://localhost', anonKey ?? 'public-anon-key');
