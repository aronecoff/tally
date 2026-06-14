import { createClient } from '@supabase/supabase-js'

// Public anon/publishable key — safe to ship. Row-level security is what
// protects the data (every row is scoped to auth.uid()).
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** Null when env isn't configured — the app still runs fully local without it. */
export const supabase =
  url && key
    ? createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true },
      })
    : null
