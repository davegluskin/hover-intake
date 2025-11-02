// pages/api/intake.js
import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: true, sizeLimit: "2mb" },
};

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, hint: "Send POST with JSON body" });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Use POST" });
    }

    const payload = req.body;
    console.log("INTAKE payload:", JSON.stringify(payload, null, 2)); // <— see exact shape in Vercel logs

    // Accept several common keys to avoid nulls
    const email =
      payload?.email ??
      payload?.contact_email ??
      payload?.client?.email ??
      null;

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing required field: email" });
    }

    const full_name =
      payload?.full_name ?? payload?.name ?? payload?.client?.full_name ?? null;

    const supabase = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"));

    const { data: clientRow, error: cErr } = await supabase
      .from("clients")
      .insert({ email, full_name })
      .select()
      .single();

    if (cErr) {
      console.error("Insert clients failed:", cErr);
      return res.status(500).json({ ok: false, error: cErr.message });
    }

    return res.status(200).json({ ok: true, client_id: clientRow.id });
  } catch (e) {
    console.error("INTAKE_FATAL:", e);
    return res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
}
