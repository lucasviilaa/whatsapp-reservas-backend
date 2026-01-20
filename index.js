const express = require("express");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();
app.use(express.json());

// -------------------------
// Supabase
// -------------------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// -------------------------
// Helpers
// -------------------------
const MENU_TEXT =
  "👋 Bienvenido al sistema de reservas\n\n" +
  "Escribí una opción:\n" +
  "1️⃣ Reservar mesa\n" +
  "2️⃣ Cancelar reserva\n" +
  "3️⃣ Locales";

function normalizeText(s) {
  return (s || "").toString().trim().toLowerCase();
}

function isISODate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isUUID(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s
  );
}

function restaurantLabel(code) {
  if (code === "deliclub") return "🥩 deliclub";
  if (code === "brodo-pasta") return "🍝 brodo-pasta";
  if (code === "brodo-pizza") return "🍕 brodo-pizza";
  return code;
}

function localsText() {
  return (
    "📍 Locales:\n" +
    "🥩 deliclub\n" +
    "🍝 brodo-pasta\n" +
    "🍕 brodo-pizza\n\n" +
    "Tip: escribí *menu* para volver al inicio."
  );
}

function formatAlternatives(alts) {
  if (!alts || alts.length === 0) return "No encontré alternativas en los próximos días.";
  // Mostramos hasta 3
  const top = alts.slice(0, 3);
  const lines = top.map(
    (a, i) => `${i + 1}) ${a.service_date} — ${a.service === "LUNCH" ? "Lunch" : "Dinner"}`
  );
  return lines.join("\n");
}

// -------------------------
// WhatsApp send helper
// -------------------------
async function sendWhatsAppText(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !token) {
    console.log("Missing WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN");
    return { ok: false, error: "missing_whatsapp_env" };
  }

  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.log("WhatsApp send error:", resp.status, data);
    return { ok: false, status: resp.status, data };
  }

  return { ok: true, data };
}

// -------------------------
// Session helpers (SQL)
// chat_sessions: wa_id PK, state, restaurant_code, party_size, service_date, service, updated_at
// -------------------------
async function getSession(wa_id) {
  const { data, error } = await supabase
    .from("chat_sessions")
    .select("*")
    .eq("wa_id", wa_id)
    .limit(1);

  if (error) throw error;
  return data && data.length ? data[0] : null;
}

async function upsertSession(wa_id, patch) {
  const payload = { wa_id, ...patch, updated_at: new Date().toISOString() };

  const { data, error } = await supabase
    .from("chat_sessions")
    .upsert(payload, { onConflict: "wa_id" })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function resetSession(wa_id) {
  return upsertSession(wa_id, {
    state: "IDLE",
    restaurant_code: null,
    party_size: null,
    service_date: null,
    service: null,
  });
}

// -------------------------
// API Endpoints (HTTP)
// -------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/restaurants", async (req, res) => {
  const { data, error } = await supabase
    .from("restaurants")
    .select("id,name,code,capacity_max")
    .order("name");

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, restaurants: data });
});

app.get("/availability", async (req, res) => {
  const restaurant = req.query.restaurant;
  const date = req.query.date;
  const service = req.query.service;
  const party = parseInt(req.query.party, 10);

  if (!restaurant || !date || !service || Number.isNaN(party)) {
    return res.status(400).json({
      ok: false,
      error: "Missing or invalid query params. Use restaurant, date, service, party.",
    });
  }

  const { data, error } = await supabase.rpc("check_availability", {
    p_restaurant_code: restaurant,
    p_service_date: date,
    p_service: service,
    p_party_size: party,
  });

  if (error) return res.status(500).json({ ok: false, error: error.message });

  const result = Array.isArray(data) ? data[0] : data;
  return res.json({ ok: true, result });
});

app.get("/alternatives", async (req, res) => {
  const restaurant = req.query.restaurant;
  const date = req.query.date;
  const service = req.query.service;
  const party = parseInt(req.query.party, 10);
  const days = req.query.days ? parseInt(req.query.days, 10) : 14;

  if (!restaurant || !date || !service || Number.isNaN(party)) {
    return res.status(400).json({
      ok: false,
      error: "Missing or invalid query params. Use restaurant, date, service, party, days(optional).",
    });
  }

  const { data, error } = await supabase.rpc("suggest_alternatives", {
    p_restaurant_code: restaurant,
    p_service_date: date,
    p_service: service,
    p_party_size: party,
    p_days_ahead: days,
  });

  if (error) return res.status(500).json({ ok: false, error: error.message });
  return res.json({ ok: true, alternatives: data });
});

app.post("/reserve", async (req, res) => {
  const { restaurant, date, service, party, customer_name, customer_phone } = req.body;
  const partyInt = parseInt(party, 10);

  if (
    !restaurant ||
    !date ||
    !service ||
    Number.isNaN(partyInt) ||
    !customer_name ||
    !customer_phone
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "Missing/invalid fields. Required: restaurant, date, service, party, customer_name, customer_phone",
    });
  }

  const { data: availData, error: availError } = await supabase.rpc("check_availability", {
    p_restaurant_code: restaurant,
    p_service_date: date,
    p_service: service,
    p_party_size: partyInt,
  });

  if (availError) return res.status(500).json({ ok: false, error: availError.message });

  const avail = Array.isArray(availData) ? availData[0] : availData;
  if (!avail || avail.ok !== true) {
    return res.status(409).json({
      ok: false,
      reason: avail?.reason || "NOT_AVAILABLE",
      details: avail,
    });
  }

  const { data: restaurantRows, error: restaurantError } = await supabase
    .from("restaurants")
    .select("id")
    .eq("code", restaurant)
    .limit(1);

  if (restaurantError) return res.status(500).json({ ok: false, error: restaurantError.message });
  if (!restaurantRows || restaurantRows.length === 0) {
    return res.status(404).json({ ok: false, error: "Unknown restaurant code" });
  }

  const restaurantId = restaurantRows[0].id;

  const { data: insertData, error: insertError } = await supabase
    .from("reservations")
    .insert({
      restaurant_id: restaurantId,
      customer_name,
      customer_phone,
      party_size: partyInt,
      service_date: date,
      service,
      status: "CONFIRMED",
    })
    .select("id");

  if (insertError) return res.status(500).json({ ok: false, error: insertError.message });

  return res.json({ ok: true, reservation_id: insertData[0].id });
});

app.post("/cancel", async (req, res) => {
  const { reservation_id } = req.body;

  if (!reservation_id) {
    return res.status(400).json({ ok: false, error: "Missing reservation_id" });
  }

  const { data, error } = await supabase
    .from("reservations")
    .update({ status: "CANCELLED" })
    .eq("id", reservation_id)
    .select("id,status");

  if (error) return res.status(500).json({ ok: false, error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ ok: false, error: "Reservation not found" });

  return res.json({ ok: true, reservation: data[0] });
});

// -------------------------
// WhatsApp webhook verification (GET)
// -------------------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (mode === "subscribe" && token === expectedToken) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// -------------------------
// WhatsApp webhook receiver (POST)
// -------------------------
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    // WhatsApp puede enviar statuses y otros eventos. Solo procesamos mensajes entrantes.
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const text = msg?.text?.body;
    const from = msg?.from;

    if (!text || !from) {
      // logs útiles, pero no respondemos
      console.log("WA EVENT (no inbound text):", JSON.stringify(body));
      return res.sendStatus(200);
    }

    const wa_id = from;
    const normalized = normalizeText(text);

    // Comandos globales
    if (normalized === "menu" || normalized === "hola" || normalized === "hi") {
      await resetSession(wa_id);
      await sendWhatsAppText(wa_id, MENU_TEXT);
      return res.sendStatus(200);
    }
    if (normalized === "reiniciar" || normalized === "reset") {
      await resetSession(wa_id);
      await sendWhatsAppText(wa_id, "Listo ✅ Reinicié la conversación.\n\n" + MENU_TEXT);
      return res.sendStatus(200);
    }

    let session = await getSession(wa_id);
    if (!session) session = await upsertSession(wa_id, { state: "IDLE" });

    let reply = "";

    // -------------------------
    // State machine
    // -------------------------
    if (session.state === "IDLE") {
      if (normalized === "1" || normalized === "reservar") {
        await upsertSession(wa_id, { state: "ASK_RESTAURANT" });
        reply =
          "📍 Elegí el restaurante:\n\n" +
          "1) deliclub\n" +
          "2) brodo-pasta\n" +
          "3) brodo-pizza\n\n" +
          "Respondé con 1, 2 o 3.";
      } else if (normalized === "2" || normalized === "cancelar") {
        await upsertSession(wa_id, { state: "ASK_CANCEL_ID" });
        reply =
          "❌ Cancelar reserva\n\n" +
          "Enviame el *código de reserva* (UUID) que te dimos al confirmar.\n" +
          "Ejemplo: f15db596-52b3-4bf7-a040-ad3d51e6e2db\n\n" +
          "Tip: escribí *menu* para volver.";
      } else if (normalized === "3" || normalized === "locales" || normalized === "horarios") {
        reply = localsText();
      } else {
        reply = MENU_TEXT;
      }
    }

    else if (session.state === "ASK_RESTAURANT") {
      let code = null;
      if (normalized === "1" || normalized === "deliclub") code = "deliclub";
      if (normalized === "2" || normalized === "brodo-pasta" || normalized === "pasta") code = "brodo-pasta";
      if (normalized === "3" || normalized === "brodo-pizza" || normalized === "pizza") code = "brodo-pizza";

      if (!code) {
        reply =
          "No entendí.\n\n" +
          "Respondé con 1, 2 o 3\n" +
          "(o escribí deliclub / brodo-pasta / brodo-pizza).";
      } else {
        await upsertSession(wa_id, {
          state: "ASK_PARTY_SIZE",
          restaurant_code: code,
          party_size: null,
          service_date: null,
          service: null,
        });

        reply =
          `✅ Perfecto. Elegiste *${restaurantLabel(code)}*.\n\n` +
          "👥 ¿Para cuántas personas es la reserva?\n" +
          "Respondé con un número (ej: 2, 4, 6).";
      }
    }

    else if (session.state === "ASK_PARTY_SIZE") {
      const n = parseInt(normalized, 10);

      if (Number.isNaN(n) || n < 1 || n > 50) {
        reply =
          "❌ Cantidad inválida.\n\n" +
          "Respondé con un número entre 1 y 50.";
      } else {
        await upsertSession(wa_id, { state: "ASK_DATE", party_size: n });
        reply =
          `👥 Perfecto, ${n} personas.\n\n` +
          "📅 ¿Para qué fecha es la reserva?\n" +
          "Respondé con formato YYYY-MM-DD (ej: 2026-01-25).";
      }
    }

    else if (session.state === "ASK_DATE") {
      const date = normalized;

      if (!isISODate(date)) {
        reply =
          "❌ Formato de fecha inválido.\n\n" +
          "Usá el formato YYYY-MM-DD (ej: 2026-01-25).";
      } else {
        await upsertSession(wa_id, { state: "ASK_SERVICE", service_date: date });
        reply =
          "🍽️ ¿En qué servicio?\n\n" +
          "1️⃣ Lunch\n" +
          "2️⃣ Dinner\n\n" +
          "Respondé con 1 o 2.";
      }
    }

    else if (session.state === "ASK_SERVICE") {
      let service = null;
      if (normalized === "1" || normalized === "lunch") service = "LUNCH";
      if (normalized === "2" || normalized === "dinner") service = "DINNER";

      if (!service) {
        reply = "❌ Respondé con 1 (Lunch) o 2 (Dinner).";
      } else {
        // Guardamos el servicio y pasamos a confirmar / crear
        session = await upsertSession(wa_id, { state: "CONFIRM_RESERVATION", service });

        const r = session.restaurant_code;
        const p = session.party_size;
        const d = session.service_date;

        reply =
          "✅ Confirmación\n\n" +
          `Restaurante: *${restaurantLabel(r)}*\n` +
          `Personas: *${p}*\n` +
          `Fecha: *${d}*\n` +
          `Servicio: *${service === "LUNCH" ? "Lunch" : "Dinner"}*\n\n` +
          "Respondé:\n" +
          "1️⃣ Confirmar\n" +
          "2️⃣ Cambiar fecha\n" +
          "3️⃣ Cambiar servicio\n" +
          "4️⃣ Cancelar";
      }
    }

    else if (session.state === "CONFIRM_RESERVATION") {
      if (normalized === "4" || normalized === "cancelar") {
        await resetSession(wa_id);
        reply = "Listo ✅ Cancelé el proceso.\n\n" + MENU_TEXT;
      } else if (normalized === "2") {
        await upsertSession(wa_id, { state: "ASK_DATE" });
        reply =
          "📅 Ok. Enviame la nueva fecha en formato YYYY-MM-DD (ej: 2026-01-25).";
      } else if (normalized === "3") {
        await upsertSession(wa_id, { state: "ASK_SERVICE" });
        reply =
          "🍽️ Ok. Elegí el servicio:\n\n" +
          "1️⃣ Lunch\n" +
          "2️⃣ Dinner\n\n" +
          "Respondé con 1 o 2.";
      } else if (normalized === "1" || normalized === "confirmar") {
        // 1) Check availability
        const r = session.restaurant_code;
        const d = session.service_date;
        const s = session.service;
        const p = session.party_size;

        const { data: availData, error: availError } = await supabase.rpc("check_availability", {
          p_restaurant_code: r,
          p_service_date: d,
          p_service: s,
          p_party_size: p,
        });

        if (availError) {
          reply = "⚠️ Error interno validando disponibilidad. Probá de nuevo con *menu*.";
        } else {
          const avail = Array.isArray(availData) ? availData[0] : availData;

          if (avail?.ok === true) {
            // 2) Create reservation
            // buscar restaurant_id
            const { data: restaurantRows, error: restaurantError } = await supabase
              .from("restaurants")
              .select("id")
              .eq("code", r)
              .limit(1);

            if (restaurantError || !restaurantRows?.length) {
              reply = "⚠️ No pude identificar el restaurante. Probá con *menu*.";
            } else {
              const restaurantId = restaurantRows[0].id;

              const { data: insertData, error: insertError } = await supabase
                .from("reservations")
                .insert({
                  restaurant_id: restaurantId,
                  customer_name: "WhatsApp User",
                  customer_phone: wa_id,
                  party_size: p,
                  service_date: d,
                  service: s,
                  status: "CONFIRMED",
                })
                .select("id")
                .limit(1);

              if (insertError || !insertData?.length) {
                reply = "⚠️ No pude crear la reserva. Probá de nuevo con *menu*.";
              } else {
                const reservationId = insertData[0].id;
                await resetSession(wa_id);

                reply =
                  "🎉 ¡Reserva confirmada!\n\n" +
                  `Restaurante: *${restaurantLabel(r)}*\n` +
                  `Personas: *${p}*\n` +
                  `Fecha: *${d}*\n` +
                  `Servicio: *${s === "LUNCH" ? "Lunch" : "Dinner"}*\n\n` +
                  `📌 Código de reserva:\n${reservationId}\n\n` +
                  "Para cancelar más tarde, elegí 2 en el menú.\n\n" +
                  MENU_TEXT;
              }
            }
          } else {
            // No available -> suggest alternatives
            const { data: altData, error: altError } = await supabase.rpc("suggest_alternatives", {
              p_restaurant_code: r,
              p_service_date: d,
              p_service: s,
              p_party_size: p,
              p_days_ahead: 14,
            });

            if (altError) {
              await resetSession(wa_id);
              reply =
                "❌ No hay disponibilidad y no pude calcular alternativas.\n\n" +
                "Escribí *menu* para intentar de nuevo.";
            } else {
              await upsertSession(wa_id, { state: "ASK_ALT_PICK" });
              reply =
                "❌ No hay disponibilidad para ese horario.\n\n" +
                "Te propongo alternativas:\n" +
                formatAlternatives(altData) +
                "\n\nRespondé con 1, 2 o 3 para elegir una alternativa.\n" +
                "O escribí *menu* para empezar de nuevo.";
            }
          }
        }
      } else {
        reply = "Respondé con 1, 2, 3 o 4.";
      }
    }

    else if (session.state === "ASK_ALT_PICK") {
      const pick = parseInt(normalized, 10);
      if (Number.isNaN(pick) || pick < 1 || pick > 3) {
        reply = "Respondé con 1, 2 o 3 para elegir una alternativa (o *menu*).";
      } else {
        // Recalcular alternativas con los datos guardados y elegir la N
        const r = session.restaurant_code;
        const d = session.service_date;
        const s = session.service;
        const p = session.party_size;

        const { data: altData, error: altError } = await supabase.rpc("suggest_alternatives", {
          p_restaurant_code: r,
          p_service_date: d,
          p_service: s,
          p_party_size: p,
          p_days_ahead: 14,
        });

        if (altError || !altData?.length || !altData[pick - 1]) {
          await resetSession(wa_id);
          reply =
            "⚠️ No pude tomar esa alternativa.\n\n" +
            "Escribí *menu* para intentar de nuevo.";
        } else {
          const chosen = altData[pick - 1];
          // Actualizamos date/service y volvemos a confirmar directo
          await upsertSession(wa_id, {
            state: "CONFIRM_RESERVATION",
            service_date: chosen.service_date,
            service: chosen.service,
          });

          reply =
            "✅ Elegiste alternativa:\n\n" +
            `Fecha: *${chosen.service_date}*\n` +
            `Servicio: *${chosen.service === "LUNCH" ? "Lunch" : "Dinner"}*\n\n` +
            "Respondé 1️⃣ para *Confirmar* o *menu* para cancelar.";
        }
      }
    }

    else if (session.state === "ASK_CANCEL_ID") {
      const id = normalized;
      if (!isUUID(id)) {
        reply =
          "❌ Ese código no parece válido.\n\n" +
          "Pegá el código completo (UUID) tal cual te llegó.\n" +
          "Tip: escribí *menu* para volver.";
      } else {
        const { data, error } = await supabase
          .from("reservations")
          .update({ status: "CANCELLED" })
          .eq("id", id)
          .select("id,status")
          .limit(1);

        await resetSession(wa_id);

        if (error) {
          reply = "⚠️ Error cancelando la reserva. Probá de nuevo con *menu*.";
        } else if (!data || data.length === 0) {
          reply =
            "No encontré una reserva con ese código.\n\n" +
            MENU_TEXT;
        } else {
          reply =
            "✅ Reserva cancelada.\n\n" +
            `Código: ${data[0].id}\n\n` +
            MENU_TEXT;
        }
      }
    }

    else {
      // Estado desconocido -> reset
      await resetSession(wa_id);
      reply =
        "Reinicié la conversación por seguridad.\n\n" +
        MENU_TEXT;
    }

    // Enviar respuesta (una sola vez)
    await sendWhatsAppText(wa_id, reply);
    return res.sendStatus(200);
  } catch (e) {
    console.log("WA WEBHOOK ERROR:", e?.message);
    return res.sendStatus(200);
  }
});

// -------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
