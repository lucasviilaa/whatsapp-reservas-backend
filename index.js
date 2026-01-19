const express = require("express");
const dotenv = require("dotenv");
const { createClient } = require("@supabase/supabase-js");

dotenv.config();

const app = express();
app.use(express.json());

// Supabase client (reads from .env)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Test endpoint: list restaurants
app.get("/restaurants", async (req, res) => {
  const { data, error } = await supabase
    .from("restaurants")
    .select("id,name,code,capacity_max")
    .order("name");

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

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

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  // supabase rpc returns an array for table-returning functions
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

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

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

  // 1) Check availability first
  const { data: availData, error: availError } = await supabase.rpc("check_availability", {
    p_restaurant_code: restaurant,
    p_service_date: date,
    p_service: service,
    p_party_size: partyInt,
  });

  if (availError) {
    return res.status(500).json({ ok: false, error: availError.message });
  }

  const avail = Array.isArray(availData) ? availData[0] : availData;
  if (!avail || avail.ok !== true) {
    return res.status(409).json({ ok: false, reason: avail?.reason || "NOT_AVAILABLE", details: avail });
  }

  // 2) Insert reservation
  const { data: restaurantRows, error: restaurantError } = await supabase
    .from("restaurants")
    .select("id")
    .eq("code", restaurant)
    .limit(1);

  if (restaurantError) {
    return res.status(500).json({ ok: false, error: restaurantError.message });
  }
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

  if (insertError) {
    return res.status(500).json({ ok: false, error: insertError.message });
  }

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

  if (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }

  if (!data || data.length === 0) {
    return res.status(404).json({ ok: false, error: "Reservation not found" });
  }

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
app.post("/webhook", (req, res) => {
  console.log("Incoming WhatsApp webhook:", JSON.stringify(req.body, null, 2));
  return res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});


