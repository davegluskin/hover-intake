// pages/api/intake.js
//
// Drop this file into your Next.js project at pages/api/intake.js
// Then redeploy on Vercel. It will:
//  - Respond 200 to GET (for simple health checks)
//  - Accept POST JSON from Fillout (or curl)
//  - Read email, legal_name, tier (and optional full_name) from multiple possible keys
//  - Validate required fields with helpful 400 errors (instead of vague 500s)
//  - Insert into the `clients` table
//  - Log the raw payload so you can see exactly what Fillout sends in Vercel > Functions > Logs

import { createClient } from "@supabase/supabase-js";

// Allow JSON up to 2mb (Fillout sends JSON with file URLs, not binary files)
export const config = {
  api: { bodyParser: true, sizeLimit: "2mb" },
};

// Simple helper: make sure env vars exist at runtime
function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// If Fillout sends an `answers` array like [{ key: "email", value: "..." }, ...],
// this pulls a value by key name.
function getFromAnswersArray(payload, key) {
  try {
    const arr = payload?.answers || payload?.data || null;
    if (!Array.isArray(arr)) return null;
    const hit = arr.find((a) => a?.key === key || a?.id === key || a?.name === key);
    // Some Fillout answers use { value }, some use { text }, some use { url } etc.
    return hit?.value ?? hit?.text ?? hit?.url ?? null;
  } catch {
    return null;
  }
}

// Read a value from several common places so minor key/name changes don’t break inserts.
function readFlexible(payload, key, aliases = []) {
  const candidates = [key, ...aliases];
  for (const k of candidates) {
    // top-level
    if (payload?.[k] != null) return payload[k];
    // nested under "client"
    if (payload?.client?.[k] != null) return payload.client[k];
    // answers array style
    const fromAns = getFromAnswersArray(payload, k);
    if (fromAns != null) return fromAns;
  }
  return null;
}

// Optionally normalize tier to the canonical values we expect
function normalizeTier(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (["starter", "start", "basic"].includes(s)) return "Starter";
  if (["growth", "grow"].includes(s)) return "Growth";
  if (["premium", "pro"].includes(s)) return "Premium";
  // Capitalize first letter if something like "starter" comes in
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Remove null/undefined keys so Postgres defaults can apply
function pruneNulls(obj) {
  const copy = { ...obj };
  for (const k of Object.keys(copy)) {
    if (copy[k] == null) delete copy[k];
  }
  return copy;
}

export default async function handler(req, res) {
  try {
    // 1) Friendly GET so tools/browsers don't cause scary logs
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, hint: "Send POST with JSON body" });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    // 2) Parse payload and log it so you can see exactly what arrived (check Vercel -> Functions -> Logs)
    const payload = req.body;
    console.log("INTAKE payload:", JSON.stringify(payload, null, 2));

    // 3) Flexibly read the fields we need
    const email = readFlexible(payload, "email", ["contact_email", "agent_email"]);
    // legal_name: try explicit field, fall back to company, then full_name if you want to allow that
    const legal_name = readFlexible(payload, "legal_name", ["company", "business_name"]) 
                    ?? readFlexible(payload, "full_name", ["name"]);
    const full_name = readFlexible(payload, "full_name", ["name", "agent_name"]);
    const rawTier = readFlexible(payload, "tier", ["package", "plan", "subscription"]);
    const tier = normalizeTier(rawTier);

    // 4) Clear, beginner-friendly validation (sends 400s, not 500s)
    if (!email)      return res.status(400).json({ ok: false, error: "Missing required field: email" });
    if (!legal_name) return res.status(400).json({ ok: false, error: "Missing required field: legal_name" });
    if (!tier)       return res.status(400).json({ ok: false, error: "Missing required field: tier" });

    // 5) Connect to Supabase using service role (RLS-safe)
    const supabase = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"));

    // 6) Build insert safely and prune nulls
    const insertData = pruneNulls({
      email,
      legal_name,
      full_name,   // optional
      tier,        // required by your schema
    });

    // 7) Insert into clients
    const { data: clientRow, error: cErr } = await supabase
      .from("clients")
      .insert(insertData)
      .select()
      .single();

    if (cErr) {
      console.error("Insert into clients failed:", cErr);
      return res.status(500).json({ ok: false, error: cErr.message });
    }

    // 8) Success
    return res.status(200).json({ ok: true, client_id: clientRow.id });
  } catch (e) {
    console.error("INTAKE_FATAL:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
