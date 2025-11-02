// pages/api/intake.js
//
// Works with Fillout free tier (no Developer Mode).
// It matches question labels like "Contact Email", "Legal Business Name", etc.
// and inserts cleanly into Supabase.

import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: true, sizeLimit: "2mb" },
};

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Find a value inside Fillout's "answers" array by matching label text
function getFromLabels(payload, label) {
  try {
    const arr = payload?.answers || payload?.data || payload?.fields || null;
    if (!Array.isArray(arr)) return null;

    // Look for an exact or partial label match
    const match = arr.find((a) => {
      const lbl = (a?.label || a?.name || a?.title || "").toLowerCase();
      return lbl.includes(label.toLowerCase());
    });
    return match?.value ?? match?.text ?? match?.answer ?? null;
  } catch {
    return null;
  }
}

// Remove nulls so Postgres defaults can apply
function pruneNulls(obj) {
  const copy = { ...obj };
  for (const k of Object.keys(copy)) {
    if (copy[k] == null) delete copy[k];
  }
  return copy;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, hint: "Send POST with JSON body" });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const payload = req.body;
    console.log("INTAKE payload:", JSON.stringify(payload, null, 2));

    // Try to find by label text (works without Developer Mode)
    const email = getFromLabels(payload, "Contact Email") || getFromLabels(payload, "Email");
    const legal_name = getFromLabels(payload, "Legal Business Name") || getFromLabels(payload, "Company");
    const full_name = getFromLabels(payload, "Contact Name") || getFromLabels(payload, "Name");
    const tierRaw = getFromLabels(payload, "Package") || getFromLabels(payload, "Tier") || "Starter";

    // Normalize tier capitalization
    let tier = tierRaw;
    if (typeof tierRaw === "string") {
      const s = tierRaw.trim().toLowerCase();
      if (["starter", "start", "basic"].includes(s)) tier = "Starter";
      else if (["growth", "grow"].includes(s)) tier = "Growth";
      else if (["premium", "pro"].includes(s)) tier = "Premium";
      else tier = s.charAt(0).toUpperCase() + s.slice(1);
    }

    // Basic validation
    if (!email) return res.status(400).json({ ok: false, error: "Missing required field: email" });
    if (!legal_name) return res.status(400).json({ ok: false, error: "Missing required field: legal_name" });
    if (!tier) return res.status(400).json({ ok: false, error: "Missing required field: tier" });

    const supabase = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"));

    const insertData = pruneNulls({
      email,
      legal_name,
      full_name,
      tier,
    });

    const { data: clientRow, error: cErr } = await supabase
      .from("clients")
      .insert(insertData)
      .select()
      .single();

    if (cErr) {
      console.error("Insert clients failed:", cErr);
      return res.status(500).json({ ok: false, error: cErr.message });
    }

    return res.status(200).json({ ok: true, client_id: clientRow.id });
  } catch (e) {
    console.error("INTAKE_FATAL:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
