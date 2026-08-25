// Manuelle Ersterfassung des Anfangsbestands fuer ein Jahr, fuer das es (noch) keinen
// bestaetigten Vorjahresabschluss gibt, aus dem er automatisch uebernommen werden koennte (siehe
// kassenblatt-laden). Ueberschreibt eine ggf. vorhandene Zeile bewusst nicht, wenn das Jahr
// bereits abgeschlossen ist - ein bestaetigter Jahresabschluss soll nicht versehentlich per
// Ersterfassungs-Formular ueberschrieben werden.

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

  const jahr = Number(body?.jahr);
  const anfangsbestand = Number(body?.anfangsbestand);
  if (!Number.isInteger(jahr) || !Number.isFinite(anfangsbestand)) {
    return jsonResponse({ error: "jahr (Zahl) und anfangsbestand (Zahl) sind erforderlich." }, 400);
  }

  const existingResp = await fetch(
    `${SUPABASE_URL}/rest/v1/kasse_jahresanfangsbestand?jahr=eq.${jahr}&select=abgeschlossen`,
    { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } },
  );
  const existing = await existingResp.json();
  if (Array.isArray(existing) && existing[0]?.abgeschlossen) {
    return jsonResponse(
      { error: `Jahr ${jahr} ist bereits abgeschlossen - der Anfangsbestand kann darueber nicht mehr per Ersterfassung geaendert werden.` },
      409,
    );
  }

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/kasse_jahresanfangsbestand`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ jahr, anfangsbestand, quelle: "manuell", updated_at: new Date().toISOString() }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return jsonResponse({ error: `Speichern fehlgeschlagen: ${text}` }, 502);
  }

  return jsonResponse({ ok: true }, 200);
});
