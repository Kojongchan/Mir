#!/usr/bin/env node
// =====================================================================
// MIR_VDC — username → internal auth e-mail mapping.
// MIRROR of usernameToEmail() in src/lib/supabase.ts — KEEP IN SYNC.
//
// ASCII usernames pass through ("admin" -> "admin@mir.local"). Non-ASCII
// usernames (e.g. Korean "고종찬") are encoded to a reversible ASCII-safe
// "u-<hex>" local part, because GoTrue rejects non-ASCII e-mail local parts.
//
// CLI — print the e-mail + Supabase "User Metadata" JSON to paste when
// creating a user in the dashboard:
//   node scripts/username-email.mjs 고종찬 "고종찬"
// =====================================================================
export const USERNAME_DOMAIN = 'mir.local';

export function usernameToEmail(username) {
  const name = username.trim().toLowerCase();
  if (/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(name) && !name.startsWith('u-')) {
    return `${name}@${USERNAME_DOMAIN}`;
  }
  const hex = Array.from(new TextEncoder().encode(name))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `u-${hex}@${USERNAME_DOMAIN}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const username = process.argv[2];
  if (!username) {
    console.error('usage: node scripts/username-email.mjs <username> [full_name]');
    process.exit(1);
  }
  const fullName = process.argv[3] ?? username;
  console.log(`username : ${username}`);
  console.log(`email    : ${usernameToEmail(username)}`);
  console.log(`metadata : ${JSON.stringify({ username, full_name: fullName })}`);
}
