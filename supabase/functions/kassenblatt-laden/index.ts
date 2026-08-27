// Laedt das Kassenblatt fuer ein Jahr: live alle Buchungen von Easyverein auf dem Bankkonto
// "Kasse" (bankAccount-Filter serverseitig zuverlaessig, siehe Memory
// reference_ev_bankaccount_booking_api), ergaenzt um den Jahres-Anfangsbestand aus
// kasse_jahresanfangsbestand. Keine eigene Kopie der Buchungsdaten - Easyverein bleibt
// alleinige Quelle der Wahrheit fuer Betrag/Text/Belegdatum.
//
// Anfangsbestand-Ermittlung: existiert noch keine Zeile fuer das angefragte Jahr, wird zunaechst
// geprueft, ob das Vorjahr einen bestaetigten Jahresabschluss hat (abgeschlossen=true) - falls ja,
// wird dessen Endbestand automatisch als Anfangsbestand fuer das angefragte Jahr uebernommen
// (quelle='uebernommen_vorjahr') und persistiert. Sonst liefert die Function 404 mit
// code="anfangsbestand_fehlt", das Frontend zeigt dann ein Eingabefeld fuer die manuelle Ersterfassung.

const EV_BASE_URL = "https://easyverein.com/api/v2.0";
const KASSE_BANK_ACCOUNT_ID = 214741342;
const PAGE_LIMIT = 100;

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

async function evGet(url: string, apiKey: string): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get("Retry-After") ?? "2");
      await new Promise((r) => setTimeout(r, (retryAfter || 2) * 1000));
      continue;
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Easyverein-Fehler ${resp.status}: ${text}`);
    }
    return resp.json();
  }
  throw new Error("Easyverein: zu viele 429-Antworten, abgebrochen.");
}

async function evGetPaginated(url: string, apiKey: string): Promise<any[]> {
  let next: string | null = url;
  const all: any[] = [];
  while (next) {
    const page = await evGet(next, apiKey);
    all.push(...(page.results || []));
    next = page.next || null;
  }
  return all;
}

async function sbGet(supabaseUrl: string, serviceRoleKey: string, path: string): Promise<any> {
  const resp = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  return resp.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const evApiKey = Deno.env.get("EV_API_KEY_BOOKING");
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!evApiKey) {
    return jsonResponse({ error: "EV_API_KEY_BOOKING ist als Function-Secret nicht konfiguriert." }, 500);
  }

  const url = new URL(req.url);
  const jahrParam = url.searchParams.get("jahr");
  const jahr = jahrParam ? parseInt(jahrParam, 10) : new Date().getFullYear();
  if (!Number.isInteger(jahr)) {
    return jsonResponse({ error: "Ungueltiges Jahr." }, 400);
  }

  try {
    let anfangsRows = await sbGet(
      SUPABASE_URL, SERVICE_ROLE_KEY,
      `kasse_jahresanfangsbestand?jahr=eq.${jahr}&select=jahr,anfangsbestand,abgeschlossen,endbestand,abgeschlossen_am`,
    );
    if (!Array.isArray(anfangsRows) || anfangsRows.length === 0) {
      // Automatische Uebernahme aus dem bestaetigten Vorjahresabschluss versuchen.
      const vorjahrRows = await sbGet(
        SUPABASE_URL, SERVICE_ROLE_KEY,
        `kasse_jahresanfangsbestand?jahr=eq.${jahr - 1}&select=abgeschlossen,endbestand`,
      );
      const vorjahr = Array.isArray(vorjahrRows) ? vorjahrRows[0] : null;
      if (vorjahr && vorjahr.abgeschlossen && vorjahr.endbestand != null) {
        const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/kasse_jahresanfangsbestand`, {
          method: "POST",
          headers: {
            apikey: SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=representation",
          },
          body: JSON.stringify({
            jahr,
            anfangsbestand: vorjahr.endbestand,
            quelle: "uebernommen_vorjahr",
            updated_at: new Date().toISOString(),
          }),
        });
        anfangsRows = await insertResp.json();
      }
    }

    if (!Array.isArray(anfangsRows) || anfangsRows.length === 0) {
      return jsonResponse(
        {
          error: `Kein Anfangsbestand fuer Jahr ${jahr} hinterlegt und kein bestaetigter Abschluss fuer ${jahr - 1} vorhanden.`,
          code: "anfangsbestand_fehlt",
          jahr,
        },
        404,
      );
    }
    const anfangsInfo = anfangsRows[0];
    const anfangsbestand = Number(anfangsInfo.anfangsbestand);

    const bookingsUrl = `${EV_BASE_URL}/booking/?bankAccount=${KASSE_BANK_ACCOUNT_ID}&ordering=date&limit=${PAGE_LIMIT}`;
    const bookings = await evGetPaginated(bookingsUrl, evApiKey);

    const jahrStart = `${jahr}-01-01`;
    const jahrEnde = `${jahr}-12-31`;
    const jahrBookings = bookings
      .filter((b: any) => {
        const d = String(b.date || "").slice(0, 10);
        return d >= jahrStart && d <= jahrEnde;
      })
      .sort((a: any, b: any) => String(a.date).localeCompare(String(b.date)) || a.id - b.id);

    // "Einkaufsort": Easyverein selbst nennt dieses Feld in seiner eigenen Buchungsuebersicht
    // "Gegenkonto/Inhaber" - der Name des Zahlungsempfaengers/Verkaeufers (z.B. "IKEA Deutschland
    // GmbH & Co. KG", "ALDI SUED"), nicht das Sachkonto ("Buchungskonto" in Easyvereins eigener
    // Spalte, z.B. "2668 Betrieb Geschaeftsstelle" - das API-Feld dafuer ist `billingAccount`).
    // In der Easyverein-API selbst heisst dieses Feld schlicht `receiver` - kasse-beleg-anlegen
    // befuellt es beim Anlegen einer Buchung bereits mit dem erkannten Aussteller.
    let bestand = anfangsbestand;
    const rows = jahrBookings.map((b: any) => {
      const amount = Number(b.amount);
      bestand += amount;
      return {
        booking_id: b.id,
        belegdatum: String(b.date || "").slice(0, 10),
        text: b.description || "",
        gegenkonto: b.receiver ? String(b.receiver).trim() || null : null,
        einnahme: amount > 0 ? amount : null,
        ausgabe: amount < 0 ? Math.abs(amount) : null,
        bestand: Math.round(bestand * 100) / 100,
      };
    });

    return jsonResponse(
      {
        jahr,
        anfangsbestand,
        anfangsbestand_quelle: anfangsInfo.quelle || null,
        abgeschlossen: !!anfangsInfo.abgeschlossen,
        endbestand: anfangsInfo.endbestand != null ? Number(anfangsInfo.endbestand) : null,
        abgeschlossen_am: anfangsInfo.abgeschlossen_am || null,
        rows,
      },
      200,
    );
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});
