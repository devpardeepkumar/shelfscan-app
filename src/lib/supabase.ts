import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Public client config only — never read empty Lovable env placeholders. */
const url = "https://wcrhpqnplrutoooowmjt.supabase.co";
const anonKey = "sb_publishable_PeX-jxejW12XIEHMbFIsrQ_q6_3ksJ4";

export const isSupabaseConfigured = true;

export const supabase: SupabaseClient = createClient(url, anonKey);
