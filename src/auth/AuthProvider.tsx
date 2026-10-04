import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, usernameToEmail, isSupabaseConfigured } from '../lib/supabase';
import { queryClient } from '../lib/queryClient';

interface Profile {
  id: string;
  username: string;
  full_name: string | null;
  is_admin: boolean;
}

interface AuthContextValue {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /** True while the signed-in user's profile is being fetched (false once it loaded or failed). */
  profileLoading: boolean;
  signIn: (username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  // User id whose profile fetch has finished (successfully or not).
  const [profileFor, setProfileFor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Token refreshes replace the session object hourly; refetch the profile only when the user changes.
  const userId = session?.user.id ?? null;
  // Derived, so the first render after sign-in already counts as loading (no redirect race).
  const profileLoading = !!userId && profileFor !== userId;

  // Cached server data belongs to one account: drop it on sign-out or when another user signs in.
  const cachedFor = useRef<string | null>(null);
  useEffect(() => {
    // (Not on the first sign-in: the cache is empty and the first screen's requests are already in flight.)
    if (cachedFor.current !== null && cachedFor.current !== userId) queryClient.clear();
    cachedFor.current = userId;
  }, [userId]);

  useEffect(() => {
    // Without real keys the client points at a placeholder host; skip the
    // network calls so the app renders the "not configured" notice instead.
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      setProfileFor(null);
      return;
    }
    let cancelled = false;
    supabase
      .from('profiles')
      .select('id, username, full_name, is_admin')
      .eq('id', userId)
      .maybeSingle()
      .then(
        ({ data }) => { if (!cancelled) setProfile((data as Profile) ?? null); },
        () => { if (!cancelled) setProfile(null); },
      )
      // A failed or missing profile must end the wait (admin routes previously spun forever).
      .then(() => { if (!cancelled) setProfileFor(userId); });
    return () => { cancelled = true; };
  }, [userId]);

  const signIn = async (username: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password,
    });
    if (error) throw new Error('아이디 또는 비밀번호가 올바르지 않습니다.');
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, profile, loading, profileLoading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
