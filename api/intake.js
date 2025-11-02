// pages/api/intake.js
//
// Ultra-forgiving handler for Fillout:
// - Works when Advanced view is OFF (submission.questions)
// - Also works with Advanced view ON (top-level mapped keys)
// - Reads by keys, labels, question names, and even type (EmailInput)
// - Last resort: regex scan anywhere for an email
// - Friendly 400s for missing required fields

import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: true, sizeLimit: "2mb" },
};

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// Depth-first walk of string values
function* walkStrings(node) {
  if (typeof node === "string") yield node;
  else if (Array.isArray(node)) for (const it of node) yield* walkStrings(it);
  else if (isObj(node)) for (const k of Object.keys(node)) yield* walkStrings(node[k]);
}

// ----- Extractors -----
function getByKeys(payload, keys = []) {
  const tryKeys = (obj) => {
    for (const k of keys) {
      if (obj?.[k] != null) return obj[k];
    }
    return null;
  };
  // direct
  const direct = tryKeys(payload);
  if (direct != null) return direct;
  // common containers
  for (const box of ["submission", "responses", "response", "client", "data", "hidden", "variables"]) {
    const v = payload?.[box];
    if (isObj(v)) {
      const found = tryKeys(v);
      if (found != null) return found;
    }
  }
  return null;
}

function getFromLabelsArrayish(arr, wantedLabels = []) {
  if (!Array.isArray(arr)) return null;
  const norm = (s) => (s || "").toString().trim().toLowerCase();
  const wants = wantedLabels.map(norm);
  for (const item of arr) {
    const lbl = norm(item?.label || item?.name || item?.title);
    if (wants.some((w) => lbl.includes(w))) {
      return item?.value ?? item?.text ?? item?.answer ?? item?.url ?? item?.email ?? null;
    }
  }
  return null;
}

function getByLabel(payload, labels = []) {
  const arr = payload?.answers || payload?.data || payload?.fields || payload?.items || null;
  return getFromLabelsArrayish(arr, labels);
}

// NEW: read from submission.questions by name (what your log showed)
function getFromQuestionsByName(payload, wantedNames = []) {
  const q = payload?.submission?.questions;
  return getFromLabelsArrayish(q, wantedNames);
}

// NEW: fallback — first EmailInput question with a non-null value
function getEmailFromQuestionsByType(payload) {
  const q = payload?.submission?.questions;
  if (!Array.isArray(q)) return null;
  for (const item of q) {
    const t = (item?.type || "").toString().toLowerCase();
    if (t.includes("email")) {
      if (item?.value) return item.value;
    }
  }
  return null;
}

function normalizeTier(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (["starter", "start", "basic"].includes(s)) return "Starter";
  if (["growth", "grow"].includes(s)) return "Growth";
  if (["premium", "pro"].includes(s)) return "Premium";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function findAnyEmail(payload) {
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  for (const s of walkStrings(payload)) {
    const m = s.match(re);
    if (m) return m[0];
  }
  return null;
}

function prune(obj) {
  const out = { ...obj };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

// ----- Handler -----
export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, hint: "Send POST with JSON body" });
    }
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST" });
    }

    const payload = req.body || {};
    try {
      console.log("INTAKE top-level keys:", Object.keys(payload || {}));
      console.log("INTAKE submission keys:", Object.keys(payload?.submission || {}));
      console.log("INTAKE questions count:", Array.isArray(payload?.submission?.questions) ? payload.submission.questions.length : 0);
    } catch {}

    // EMAIL: try many strategies
    const email =
      getByKeys(payload, ["email", "contact_email", "agent_email", "email_address"]) ||
      getByLabel(payload, ["contact email", "email"]) ||
      getFromQuestionsByName(payload, ["contact email", "email"]) ||
      getEmailFromQuestionsByType(payload) ||
      findAnyEmail(payload);

    // LEGAL NAME
    let legal_name =
      getByKeys(payload, ["legal_name", "company", "business_name", "organization"]) ||
      getByLabel(payload, ["legal business name", "company", "business name"]) ||
      getFromQuestionsByName(payload, ["legal business name", "company", "business name"]);

    // FULL NAME
    const full_name =
      getByKeys(payload, ["full_name", "name", "contact_name", "agent_name"]) ||
      getByLabel(payload, ["contact name", "name"]) ||
      getFromQuestionsByName(payload, ["contact name", "name"]);

    if (!legal_name) legal_name = full_name || null;

    // TIER
    const rawTier =
      getByKeys(payload, ["tier", "package", "plan", "subscription"]) ||
      getByLabel(payload, ["package", "tier", "plan"]) ||
      getFromQuestionsByName(payload, ["package", "tier", "plan"]) ||
      "Starter";
    const tier = normalizeTier(rawTier);

    if (!email)   return res.status(400).json({ ok: false, error: "Missing required field: email" });
    if (!legal_name) return res.status(400).json({ ok: false, error: "Missing required field: legal_name" });
    if (!tier)    return res.status(400).json({ ok: false, error: "Missing required field: tier" });

    const supabase = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"));

    const insertData = prune({ email, legal_name, full_name, tier });

    const { data: clientRow, error: cErr } = await supabase
      .from("clients")
      .insert(insertData)
      .select()
      .single();

    if (cErr) {
      console.error("Insert into clients failed:", cErr);
      return res.status(500).json({ ok: false, error: cErr.message });
    }

    return res.status(200).json({ ok: true, client_id: clientRow.id });
  } catch (e) {
    console.error("INTAKE_FATAL:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
