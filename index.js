const express = require("express");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();
app.use(express.json());

// Supabase client (reads from env)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// --- WhatsApp send helper ---
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

// --- Session helpers (SQL) ---
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

// --- Health ---
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Test endpoint: list restaurants
app.get("/restaurants", async (req, res) => {
  const { data, error } = await supabase
    .from("restaurants")
    .select("id,name,code,capacity_max")
    .order("name");

  if (error) return res.status(500).json({ ok: false, error: error.message });
  res.json({ ok: true, restaurants: data });
});

// Availability endpoint
app.get("/availability", async (req, res) => {
  const restaurant = req.query.restaurant; // code, e.g. deliclub
  const date = req.query.date;             // YYYY-MM-DD
  const service = req.query.service;       // LUNCH or DINNER
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

// Alternatives endpoint
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

// Reserve endpoint
app.post("/reserve", async (req, res) => {
  const { restaurant, date, service, party, customer_name, customer_phone } = req.body;
  const partyInt = parseInt(party, 10);

  if (!restaurant || !date || !service || Number.isNaN(partyInt) || !customer_name || !customer_phone) {
    return res.status(400).json({
      ok: false,
      error: "Missing/invalid fields. Required: restaurant, date, service, party, customer_name, customer_phone",
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
    return res.status(409).json({ ok: false, reason: avail?.reason || "NOT_AVAILABLE", details: avail });
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

// Cancel endpoint
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

// WhatsApp webhook verification (GET)
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

// WhatsApp webhook receiver (POST)
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const text = msg?.text?.body;
    const from = msg?.from;

    if (text && from) {
      const wa_id = from;
      const normalized = text.trim().toLowerCase();

      let session = await getSession(wa_id);
      if (!session) session = await upsertSession(wa_id, { state: "IDLE" });

      let reply = "";

      if (session.state === "IDLE") {
        if (normalized === "1") {
          await upsertSession(wa_id, { state: "ASK_RESTAURANT" });
          reply =
            "📍 Elegí el restaurante:\n\n" +
            "1) deliclub\n" +
            "2) brodo-pasta\n" +
            "3) brodo-pizza\n\n" +
            "Respondé con 1, 2 o 3.";
        } else if (normalized === "2") {
          reply = "❌ Para cancelar: enviame el código de reserva (lo hacemos en el próximo paso).";
        } else if (normalized === "3") {
          reply =
            "📍 Locales:\n" +
            "🥩 deliclub\n" +
            "🍝 brodo-pasta\n" +
            "🍕 brodo-pizza";
        } else {
          reply =
            "👋 Bienvenido al sistema de reservas\n\n" +
            "Escribí una opción:\n" +
            "1️⃣ Reservar mesa\n" +
            "2️⃣ Cancelar reserva\n" +
            "3️⃣ Horarios y locales";
        }
      } else if (session.state === "ASK_RESTAURANT") {
        let code = null;
        if (normalized === "1" || normalized === "deliclub") code = "deliclub";
        if (normalized === "2" || normalized === "brodo-pasta") code = "brodo-pasta";
        if (normalized === "3" || normalized === "brodo-pizza") code = "brodo-pizza";

        if (!code) {
          reply = "No entendí. Respondé con 1, 2 o 3 (o escribí deliclub / brodo-pasta / brodo-pizza).";
        } else {
          await upsertSession(wa_id, { state: "IDLE", restaurant_code: code });
          reply = `✅ Perfecto. Elegiste *${code}*.\n\n(En el próximo paso te pido cantidad de personas).`;
        }
      } else {
        await upsertSession(wa_id, { state: "IDLE" });
        reply =
          "Reinicié la conversación por seguridad.\n\n" +
          "Escribí:\n1️⃣ Reservar\n2️⃣ Cancelar\n3️⃣ Horarios";
      }

      await sendWhatsAppText(wa_id, reply); // <-- solo una vez
    } else {
      console.log("WA EVENT (no text):", JSON.stringify(body));
    }
  } catch (e) {
    console.log("WA WEBHOOK ERROR:", e?.message);
  }

  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
