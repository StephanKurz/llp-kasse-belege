// Speichert (upsert) das manuell erfasste Kassendatum fuer eine Easyverein-Buchung. Aendert
// bewusst nur diese eine Spalte - Betrag/Text/Belegdatum bleiben ausschliesslich in Easyverein
// gepflegt und werden hier nicht dupliziert.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: unknown, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Nur POST erlaubt." }, 405);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Ungueltiges JSON im Request-Body." }, 400);
  }

  const bookingId = Number(body?.booking_id);
  const kassendatum = body?.kassendatum;
  if (!Number.isInteger(bookingId) || typeof kassendatum !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(kassendatum)) {
    return jsonResponse({ error: "booking_id (Zahl) und kassendatum (Format YYYY-MM-DD) sind erforderlich." }, 400);
  }

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/kasse_kassendatum`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ booking_id: bookingId, kassendatum, updated_at: new Date().toISOString() }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return jsonResponse({ error: `Speichern fehlgeschlagen: ${text}` }, 502);
  }

  return jsonResponse({ ok: true }, 200);
});
