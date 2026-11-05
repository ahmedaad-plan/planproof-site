// The server-side settings every PlanProof function reads (Netlify
// environment variables, Functions scope). Values never reach the browser.
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY  database (public key; RLS protects data)
//   INTAKE_DB_SECRET   server-only secret: once set, only these functions can
//                      add requests to the database (optional until set)
//   RESEND_API_KEY, RESEND_FROM_ADDRESS     email
//   ALERT_EMAIL        extra address(es) for system alerts, comma-separated —
//                      ideally NOT on plan-proof.com, so an alert still
//                      arrives if the business inbox is the thing that broke
export function serverEnv() {
  const get = (k) => Netlify.env.get(k);
  return {
    SUPABASE_URL: get("SUPABASE_URL"),
    SUPABASE_PUBLISHABLE_KEY: get("SUPABASE_PUBLISHABLE_KEY"),
    INTAKE_DB_SECRET: get("INTAKE_DB_SECRET"),
    RESEND_API_KEY: get("RESEND_API_KEY"),
    RESEND_FROM_ADDRESS: get("RESEND_FROM_ADDRESS"),
    ALERT_EMAIL: get("ALERT_EMAIL"),
  };
}
