// pages/api/intake.js
//
// End-to-end intake handler with file mirroring:
// - Works with Fillout "Advanced view" OFF (submission.questions) and ON (mapped keys)
// - Inserts into `clients`
// - Mirrors file uploads (logo/headshot) into Supabase Storage bucket `agent-assets`
// - Inserts brand info + mirrored URLs into `brand_kits`
//
// Requirements:
//   - Environment vars in Vercel: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   - Supabase Storage bucket named: agent-assets (public or private; see notes below)
//   - Tables: clients, brand_kits (as discussed earlier)

import { createClient } from "@supabase/supabase-js";

export const config = {
  api: { bodyParser: true, sizeLimit: "10mb" }, // allow generous JSON (we fetch files server-side)
};

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

// --- string walker (for last-resort email find) ---
function* walkStrings(node) {
  if (typeof node === "string") yield node;
  else if (Array.isArray(node)) for (const it of node) yield* walkStrings(it);
  else if (isObj(node)) for (const k of Object.keys(node)) yield* walkStrings(node[k]);
}

function findAnyEmail(payload) {
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  for (const s of walkStrings(payload)) {
    const m = s.match(re);
    if (m) return m[0];
  }
  return null;
}

// --- generic extractors (keys/labels/Fillout arrays) ---
function getByKeys(payload, keys = []) {
  const tryKeys = (obj) => {
    for (const k of keys) if (obj?.[k] != null) return obj[k];
    return null;
  };
  const direct = tryKeys(payload);
  if (direct != null) return direct;
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
    if (!lbl) continue;
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

// Your Fillout log shows "submission.questions"
function getFromQuestionsByName(payload, wantedNames = []) {
  const q = payload?.submission?.questions;
  return getFromLabelsArrayish(q, wantedNames);
}

// Fallback: first EmailInput with a value
function getEmailFromQuestionsByType(payload) {
  const q = payload?.submission?.questions;
  if (!Array.isArray(q)) return null;
  for (const item of q) {
    const t = (item?.type || "").toString().toLowerCase();
    if (t.includes("email") && item?.value) return item.value;
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

function prune(obj) {
  const out = { ...obj };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

// Extract file URLs from specific question names
function getFileUrlsFromQuestions(payload, names = []) {
  const q = payload?.submission?.questions;
  if (!Array.isArray(q)) return [];
  const norm = (s) => (s || "").toString().trim().toLowerCase();
  const wants = names.map(norm);

  const urls = [];
  for (const item of q) {
    const nm = norm(item?.name);
    if (!nm) continue;
    if (wants.some((w) => nm.includes(w))) {
      const v = item?.value;
      if (Array.isArray(v)) {
        for (const f of v) {
          if (typeof f === "string") urls.push(f);
          else if (f?.url) urls.push(f.url);
        }
      } else if (isObj(v)) {
        if (v.url) urls.push(v.url);
      } else if (typeof v === "string") {
        urls.push(v);
      }
    }
  }
  return Array.from(new Set(urls));
}

// Mirror external URLs into Supabase Storage and return public (or path) URLs
async function mirrorUrlsToSupabase(supabase, bucket, clientId, folder, urls = []) {
  const outUrls = [];
  for (const srcUrl of urls) {
    try {
      const r = await fetch(srcUrl);
      if (!r.ok) throw new Error(`Download failed: ${r.status}`);
      const contentType = r.headers.get("content-type") || undefined;
      const ab = await r.arrayBuffer();

      const urlObj = new URL(srcUrl);
      const base = decodeURIComponent(urlObj.pathname.split("/").pop() || `file-${Date.now()}`);
      const path = `${clientId}/${folder}/${base}`;

      const { error: upErr } = await supabase
        .storage
        .from(bucket)
        .upload(path, new Uint8Array(ab), { upsert: true, contentType });
      if (upErr) throw upErr;

      // If bucket is public, getPublicUrl gives a usable URL. If private, you'll get a path.
      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
      outUrls.push(pub?.publicUrl || path);
    } catch (e) {
      console.warn("mirror failed", srcUrl, e?.message);
    }
  }
  return outUrls;
}

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

    // ---- read required fields ----
    const email =
      getByKeys(payload, ["email", "contact_email", "agent_email", "email_address"]) ||
      getByLabel(payload, ["contact email", "email"]) ||
      getFromQuestionsByName(payload, ["contact email", "email"]) ||
      getEmailFromQuestionsByType(payload) ||
      findAnyEmail(payload);

    let legal_name =
      getByKeys(payload, ["legal_name", "company", "business_name", "organization"]) ||
      getByLabel(payload, ["legal business name", "company", "business name"]) ||
      getFromQuestionsByName(payload, ["legal business name", "company", "business name"]);

    const full_name =
      getByKeys(payload, ["full_name", "name", "contact_name", "agent_name"]) ||
      getByLabel(payload, ["contact name", "name"]) ||
      getFromQuestionsByName(payload, ["contact name", "name"]);

    if (!legal_name) legal_name = full_name || null;

    const rawTier =
      getByKeys(payload, ["tier", "package", "plan", "subscription"]) ||
      getByLabel(payload, ["package", "tier", "plan"]) ||
      getFromQuestionsByName(payload, ["package", "tier", "plan"]) ||
      "Starter";
    const tier = normalizeTier(rawTier);

    if (!email)      return res.status(400).json({ ok: false, error: "Missing required field: email" });
    if (!legal_name) return res.status(400).json({ ok: false, error: "Missing required field: legal_name" });
    if (!tier)       return res.status(400).json({ ok: false, error: "Missing required field: tier" });

    // ---- connect to supabase ----
    const supabase = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"));

    // ---- insert client ----
    const insertClient = prune({ email, legal_name, full_name, tier });
    const { data: clientRow, error: cErr } = await supabase
      .from("clients")
      .insert(insertClient)
      .select()
      .single();
    if (cErr) {
      console.error("Insert into clients failed:", cErr);
      return res.status(500).json({ ok: false, error: cErr.message });
    }

    // ---- collect brand fields from the submission ----
    const primary_color =
      getFromQuestionsByName(payload, ["primary brand color"]) ||
      getByLabel(payload, ["primary brand color"]) ||
      getByKeys(payload, ["primary_color"]);

    const secondary_color =
      getFromQuestionsByName(payload, ["secondary brand color"]) ||
      getByLabel(payload, ["secondary brand color"]) ||
      getByKeys(payload, ["secondary_color"]);

    const font_primary =
      getFromQuestionsByName(payload, ["preferred font"]) ||
      getByLabel(payload, ["preferred font"]) ||
      getByKeys(payload, ["font_primary"]);

    const disclaimer =
      getFromQuestionsByName(payload, ["disclaimer text"]) ||
      getByLabel(payload, ["disclaimer text"]) ||
      getByKeys(payload, ["disclaimer"]);

    // ---- get file URLs from Fillout answers ----
    const logoSrc = getFileUrlsFromQuestions(payload, ["logo (png/svg)", "logo"]);
    const headshotSrc = getFileUrlsFromQuestions(payload, ["headshot (png/jpg)", "headshot"]);

    // ---- mirror into Supabase Storage (agent-assets/<client_id>/...) ----
    let logo_urls = logoSrc;
    let headshot_urls = headshotSrc;

    if (logoSrc.length || headshotSrc.length) {
      try {
        logo_urls = await mirrorUrlsToSupabase(supabase, "agent-assets", clientRow.id, "logos", logoSrc);
        headshot_urls = await mirrorUrlsToSupabase(supabase, "agent-assets", clientRow.id, "headshots", headshotSrc);
      } catch (e) {
        console.warn("mirroring skipped:", e?.message);
      }
    }

    // ---- insert brand_kits row if anything present ----
    const brandInsert = prune({
      client_id: clientRow.id,
      primary_color,
      secondary_color,
      font_primary,
      disclaimer,
      logos: logo_urls?.length ? logo_urls : null,       // jsonb
      headshots: headshot_urls?.length ? headshot_urls : null, // jsonb
    });

    if (Object.keys(brandInsert).length > 1) {
      const { error: bErr } = await supabase.from("brand_kits").insert(brandInsert);
      if (bErr) console.warn("brand_kits insert warning:", bErr.message);
    }

    // done 🎉
    return res.status(200).json({ ok: true, client_id: clientRow.id });

  } catch (e) {
    console.error("INTAKE_FATAL:", e);
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
}
