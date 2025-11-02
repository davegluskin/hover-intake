// api/intake.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Use POST');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const p = req.body || {};

    // 1) create client
    const { data: clientRow, error: clientErr } = await supabase
      .from('clients')
      .insert({
        org_name: p.business?.legal_name || null,
        contact_name: p.contact?.name || null,
        email: p.contact?.email,
        phone: p.contact?.phone || null,
        legal_name: p.business?.legal_name,
        brokerage: p.business?.brokerage || null,
        website: p.business?.website || null,
        tier: p.package?.tier || 'Starter'
      })
      .select('id')
      .single();
    if (clientErr) throw clientErr;
    const client_id = clientRow.id;

    // 2) brand kit
    const { error: bkErr } = await supabase
      .from('brand_kits')
      .insert({
        client_id,
        primary_color: p.brand?.colors?.[0] || '#0A6FFF',
        secondary_color: p.brand?.colors?.[1] || null,
        font_main: (p.brand?.fonts && p.brand.fonts[0]) || 'Inter',
        // MVP: save Fillout file URLs directly (we can move to Supabase Storage later)
        logo_url: p.brand?.assets?.logo_url,
        headshot_url: p.brand?.assets?.headshot_url || null,
        disclaimer: p.business?.disclaimer || 'Equal Housing Opportunity.'
      });
    if (bkErr) throw bkErr;

    // 3) markets
    const { error: mkErr } = await supabase
      .from('markets')
      .insert({
        client_id,
        zips: p.market?.zips || [],
        cities: p.market?.cities || [],
        niches: p.market?.niches || []
      });
    if (mkErr) throw mkErr;

    // 4) systems
    const { error: sysErr } = await supabase
      .from('systems')
      .insert({
        client_id,
        calendly_url: p.systems?.calendly_url || null,
        idx_pattern: p.systems?.idx_source || null
      });
    if (sysErr) throw sysErr;

    // 5) status
    const { error: stErr } = await supabase
      .from('status')
      .insert({
        client_id,
        intake_complete: true,
        connections_ready: false
      });
    if (stErr) throw stErr;

    return res.status(200).json({ ok: true, client_id });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
}
