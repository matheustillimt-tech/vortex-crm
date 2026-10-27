import { createClient } from '@supabase/supabase-js'

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

// Com as variáveis definidas o app usa o banco real; sem elas, roda no modo demonstração.
export const BACKEND = Boolean(SUPABASE_URL && KEY)

export const supabase = BACKEND ? createClient(SUPABASE_URL, KEY, { auth: { persistSession: true, autoRefreshToken: true } }) : null
