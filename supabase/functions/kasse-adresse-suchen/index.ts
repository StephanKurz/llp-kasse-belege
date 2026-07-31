// Durchsucht das gemeinsame Easyverein-Adressbuch (/contact-details/) nach einer frei
// eingegebenen Zeichenkette. Das Adressbuch umfasst sowohl externe Firmen/Lieferanten als auch
// Vereinsmitglieder (jedes Mitglied hat einen verknuepften ContactDetails-Datensatz, erkennbar am
// gesetzten `member`-Feld) - daher liefert dieselbe Suche auch Mitglieder.
//
// Anwendungsfall: die automatische Aussteller-Erkennung in kasse-beleg-analysieren sucht nach dem
// auf dem Beleg gedruckten Namen (z.B. dem Lieferanten "IKEA"). Wurde eine Rechnung aber bereits
// privat von einem Mitglied bezahlt und soll diesem Mitglied die Auslage erstattet werden, muss
// stattdessen das Mitglied (nicht der Lieferant) als relatedAddress verknuepft werden - dafuer
// braucht es eine manuelle, frei benennbare Suche statt der automatischen Aussteller-Zuordnung.

const EV_BASE_URL = "https://easyverein.com/api/v2.0";

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

  const apiKey = Deno.env.get("EV_API_KEY_BOOKING");
  if (!apiKey) {
    return jsonResponse({ error: "EV_API_KEY_BOOKING ist als Function-Secret nicht konfiguriert." }, 500);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Ungueltiges JSON im Request-Body." }, 400);
  }

  const query = String(body?.query ?? "").trim();
  if (query.length < 2) {
    return jsonResponse({ results: [] }, 200);
  }

  const resp = await fetch(
    `${EV_BASE_URL}/contact-details/?search=${encodeURIComponent(query)}&limit=10`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  if (!resp.ok) {
    const text = await resp.text();
    return jsonResponse({ error: `Easyverein-Fehler (${resp.status}): ${text}` }, 502);
  }

  const data = await resp.json();
  const results = (data.results ?? []).map((c: any) => ({
    id: c.id,
    name: c.name || c.companyName || "(ohne Namen)",
    istMitglied: !!c.member,
    ort: c.companyCity || c.city || null,
  }));

  return jsonResponse({ results }, 200);
});
