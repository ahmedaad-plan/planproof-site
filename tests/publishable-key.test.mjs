// Publishable key switch (7 November 2026). The new Supabase key
// (sb_publishable_…) is not a JWT: the gateway refuses it as
// "Authorization: Bearer". Every server call must send it as apikey only,
// and keep working with the legacy anon JWT (the rollback path).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { supabaseHeaders, isJwt } from "../netlify/lib/intake-core.mjs";
import { allowed } from "../netlify/lib/transcribe-core.mjs";

const PUB = "sb_publishable_7jiMcaR_m87y9Avu5bZs9g_KdLij01H";
const LEGACY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln";

test("isJwt tells the two key kinds apart", () => {
  assert.equal(isJwt(PUB), false);
  assert.equal(isJwt(LEGACY), true);
  assert.equal(isJwt(undefined), false);
});

test("intake/system-check headers: publishable key in apikey only, never as Bearer", () => {
  const h = supabaseHeaders({ SUPABASE_PUBLISHABLE_KEY: PUB, INTAKE_DB_SECRET: "s" }, { "Content-Type": "application/json" });
  assert.equal(h.apikey, PUB);
  assert.equal(h.Authorization, undefined);
  assert.equal(h["x-intake-secret"], "s");
  assert.equal(h["Content-Type"], "application/json");
});

test("intake headers still work with the legacy key (rollback)", () => {
  const h = supabaseHeaders({ SUPABASE_PUBLISHABLE_KEY: LEGACY });
  assert.equal(h.apikey, LEGACY);
  assert.equal(h.Authorization, `Bearer ${LEGACY}`);
});

test("voice notes: the speech_allowed check sends the key as apikey only", async () => {
  let seen;
  const fetchFn = async (url, init) => { seen = init.headers; return { ok: true, json: async () => true }; };
  const ok = await allowed({ env: { SUPABASE_URL: "https://db.test", SUPABASE_PUBLISHABLE_KEY: PUB }, fetchFn,
    sessionId: "7f674d9e-7aa2-4e0c-8bef-9b02e118734e", attendeeId: null, facilitatorToken: null });
  assert.equal(ok, true);
  assert.equal(seen.apikey, PUB);
  assert.equal(seen.Authorization, undefined);
});

test("pages: the player and the admin page carry the publishable key and no legacy key", () => {
  for (const f of ["play/shared.js", "admin/index.html", "play/check.html"]) {
    const s = readFileSync(new URL("../" + f, import.meta.url), "utf8");
    assert.ok(!/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/.test(s), f + " still holds the legacy anon key");
    assert.ok(!/Bearer \$\{SUPABASE_PUBLISHABLE_KEY\}/.test(s), f + " sends the key as a Bearer token");
  }
  assert.ok(readFileSync(new URL("../play/shared.js", import.meta.url), "utf8").includes(PUB));
  assert.ok(readFileSync(new URL("../admin/index.html", import.meta.url), "utf8").includes(PUB));
});
