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
    const match = arr.find(a => {
      const lbl = (a?.label || a?.name || "").toLowerCase();
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
      return res.status(405).json({ ok: false, error
