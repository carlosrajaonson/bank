/* Configuration publique uniquement. Ne jamais mettre service_role ou clé IA ici. */
window.APP_CONFIG = Object.freeze({
  SUPABASE_URL: "https://yigoeugeiznvyywtwkwk.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_bEkWO0CxVC6VNbXKMt7sZw_szM3L5Rh"
});

window.createSupabaseClient = function () {
  const c = window.APP_CONFIG;
  if (!window.supabase || !c || !c.SUPABASE_URL || !c.SUPABASE_ANON_KEY ||
      c.SUPABASE_URL.includes("VOTRE-PROJET") || c.SUPABASE_ANON_KEY.includes("VOTRE_CLE")) return null;
  return window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
};