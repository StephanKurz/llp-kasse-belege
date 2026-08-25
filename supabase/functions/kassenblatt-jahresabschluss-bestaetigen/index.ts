// Bestaetigt (oder hebt die Bestaetigung wieder auf) den Jahresendbestand fuer ein Jahr im
// Kassenblatt. Bei Bestaetigung wird der Endbestand auf der Jahreszeile gespeichert und
// automatisch als Anfangsbestand des Folgejahres uebernommen (quelle="uebernommen_vorjahr") -
// aber nur, wenn das Folgejahr nicht bereits selbst abgeschlossen ist (das wuerde einen bereits
// bestaetigten Abschluss rueckwirkend veraendern).

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
  const sbHeaders = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Ungueltiges JSON im Request-Body." }, 400);
  }

  const jahr = Number(body?.jahr);
  const bestaetigt = !!body?.bestaetigt;

  if (!Number.isInteger(jahr)) {
    return jsonResponse({ error: "jahr (Zahl) ist erforderlich." }, 400);
  }

  if (!bestaetigt) {
    // Bestaetigung aufheben - Folgejahr wird bewusst NICHT automatisch zurueckgesetzt, um dessen
    // Daten nicht kaskadierend zu veraendern.
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/kasse_jahresanfangsbestand?jahr=eq.${jahr}`, {
      method: "PATCH",
      headers: { ...sbHeaders, Prefer: "return=minimal" },
      body: JSON.stringify({ abgeschlossen: false, endbestand: null, abgeschlossen_am: null }),
    });
    if (!resp.ok) {
      return jsonResponse({ error: `Aufheben fehlgeschlagen: ${await resp.text()}` }, 502);
    }
    return jsonResponse({ ok: true }, 200);
  }

  const endbestand = Number(body?.endbestand);
  if (!Number.isFinite(endbestand)) {
    return jsonResponse({ error: "endbestand (Zahl) ist fuer die Bestaetigung erforderlich." }, 400);
  }

  const patchResp = await fetch(`${SUPABASE_URL}/rest/v1/kasse_jahresanfangsbestand?jahr=eq.${jahr}`, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify({ abgeschlossen: true, endbestand, abgeschlossen_am: new Date().toISOString() }),
  });
  if (!patchResp.ok) {
    return jsonResponse({ error: `Bestaetigen fehlgeschlagen: ${await patchResp.text()}` }, 502);
  }

  // Folgejahr-Anfangsbestand automatisch setzen - aber nur, wenn das Folgejahr nicht selbst
  // schon abgeschlossen ist.
  const nextYear = jahr + 1;
  const nextResp = await fetch(
    `${SUPABASE_URL}/rest/v1/kasse_jahresanfangsbestand?jahr=eq.${nextYear}&select=abgeschlossen`,
    { headers: sbHeaders },
  );
  const nextRows = await nextResp.json();
  const nextAlreadyClosed = Array.isArray(nextRows) && nextRows[0]?.abgeschlossen;

  if (!nextAlreadyClosed) {
    await fetch(`${SUPABASE_URL}/rest/v1/kasse_jahresanfangsbestand`, {
      method: "POST",
      headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        jahr: nextYear,
        anfangsbestand: endbestand,
        quelle: "uebernommen_vorjahr",
        updated_at: new Date().toISOString(),
      }),
    });
  }

  return jsonResponse({ ok: true, naechstes_jahr_aktualisiert: !nextAlreadyClosed }, 200);
});
