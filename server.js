// server.js — Backend completo Noleggio Cantinota (ESM, Node 20)
// ---------------------------------------------------------------

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "pg";
const { Client } = pkg;
import jwt from "jsonwebtoken";

const app = express();

// ---------------------------------------------------------------
// ✅ Config da Render Environment
// ---------------------------------------------------------------
const SECRET_KEY = process.env.SECRET_KEY || "chiave_super_segretissima";
const DATABASE_URL = process.env.DATABASE_URL;

// (Facoltativo ma utile per debug su Render)
if (!DATABASE_URL) {
  console.error(DATABASE_URL); //DA TOGLIERE
  console.error("❌ DATABASE_URL non è impostata nelle Environment Variables di Render");
}

// ---------------------------------------------------------------
// ✅ CORS + Preflight (risolve il 'preflight' rosso nel browser)
// ---------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://noleggio-cantinota-frontend.onrender.com",
  "http://localhost:5173",
];

const corsOptions = {
  origin(origin, callback) {
    // Permette richieste senza Origin (es. Postman) e quelle della whitelist
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// ✅ gestione preflight per tutte le route
app.options("*", cors(corsOptions));

// ---------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------
app.use(bodyParser.json());

// ---------------------------------------------------------------
// 🔗 Connessione DB (Neon)
// ---------------------------------------------------------------
const client = new Client({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ✅ NON bloccare l’avvio del server (così non crasha su Render)
client
  .connect()
  .then(() => console.log("✅ DB connesso"))
  .catch((err) => console.error("❌ Errore connessione DB:", err.message));

// ---------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------
function euro(n) {
  const v = Number(n ?? 0);
  return isFinite(v) ? v : 0;
}

function calcolaTotale(prezzoWeekend, quantita, km) {
  const base = euro(prezzoWeekend) * Number(quantita || 0);
  const extraKm = Math.max(0, Number(km || 0) - 50) * 3;
  return base + extraKm;
}

// ---------------------------------------------------------------
// Healthcheck
// ---------------------------------------------------------------
app.get("/", (_req, res) => {
  res.send("✅ Noleggio Cantinota backend attivo");
});

// ---------------------------------------------------------------
// LOGIN (tabella admin con username/password in chiaro)
// ---------------------------------------------------------------
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const r = await client.query(
      "SELECT id, username FROM admin WHERE username = $1 AND password = $2",
      [username, password]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ message: "Credenziali non valide" });
    }

    const token = jwt.sign(
      { id: r.rows[0].id, username: r.rows[0].username },
      SECRET_KEY,
      { expiresIn: "4h" }
    );

    res.json({ token });
  } catch (err) {
    console.error("Errore login:", err);
    res.status(500).json({ message: "Errore durante il login" });
  }
});

// ---------------------------------------------------------------
// CLIENTI
// ---------------------------------------------------------------
app.get("/clienti", async (_req, res) => {
  try {
    const r = await client.query(
      "SELECT id, nome, indirizzo_spedizione, telefono FROM clienti ORDER BY id ASC"
    );
    res.json(r.rows);
  } catch (err) {
    console.error("Errore get clienti:", err);
    res.status(500).send("Errore nel recupero clienti");
  }
});

app.post("/clienti/add", async (req, res) => {
  const { nome, indirizzo_spedizione, telefono } = req.body || {};
  try {
    const r = await client.query(
      "INSERT INTO clienti (nome, indirizzo_spedizione, telefono) VALUES ($1,$2,$3) RETURNING *",
      [nome, indirizzo_spedizione, telefono]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Errore inserimento cliente:", err);
    res.status(500).json({ message: "Errore durante l'aggiunta del cliente" });
  }
});

app.put("/clienti/:id", async (req, res) => {
  const { id } = req.params;
  const { nome, indirizzo_spedizione, telefono } = req.body || {};
  try {
    const r = await client.query(
      "UPDATE clienti SET nome=$1, indirizzo_spedizione=$2, telefono=$3 WHERE id=$4 RETURNING *",
      [nome, indirizzo_spedizione, telefono, id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Errore aggiornamento cliente:", err);
    res.status(500).send("Errore durante l'aggiornamento del cliente");
  }
});

app.delete("/clienti/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const ord = await client.query(
      "SELECT 1 FROM ordini WHERE cliente_id=$1 LIMIT 1",
      [id]
    );
    if (ord.rows.length > 0) {
      return res.status(400).json({ message: "Cliente con ordini: non eliminabile" });
    }
    await client.query("DELETE FROM clienti WHERE id=$1", [id]);
    res.json({ message: "Cliente eliminato" });
  } catch (err) {
    console.error("Errore eliminazione cliente:", err);
    res.status(500).send("Errore durante l'eliminazione del cliente");
  }
});

// ---------------------------------------------------------------
// MATERIALI
// ---------------------------------------------------------------
app.get("/materiali", async (_req, res) => {
  try {
    const r = await client.query(
      "SELECT id, nome, quantita_disponibile, prezzo_weekend FROM materiali ORDER BY nome ASC"
    );
    res.json(r.rows);
  } catch (err) {
    console.error("Errore get materiali:", err);
    res.status(500).send("Errore nel recupero dei materiali");
  }
});

app.post("/materiali", async (req, res) => {
  const { nome, quantita_disponibile, prezzo_weekend } = req.body || {};
  try {
    const r = await client.query(
      "INSERT INTO materiali (nome, quantita_disponibile, prezzo_weekend) VALUES ($1,$2,$3) RETURNING *",
      [nome, quantita_disponibile, prezzo_weekend]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Errore inserimento materiale:", err);
    res.status(500).send("Errore durante l'inserimento del materiale");
  }
});

app.put("/materiali/:id", async (req, res) => {
  const { id } = req.params;
  const { nome, quantita_disponibile, prezzo_weekend } = req.body || {};
  try {
    const r = await client.query(
      "UPDATE materiali SET nome=$1, quantita_disponibile=$2, prezzo_weekend=$3 WHERE id=$4 RETURNING *",
      [nome, quantita_disponibile, prezzo_weekend, id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error("Errore aggiornamento materiale:", err);
    res.status(500).send("Errore durante l'aggiornamento del materiale");
  }
});

app.delete("/materiali/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const ord = await client.query(
      "SELECT 1 FROM ordini WHERE materiale_id=$1 LIMIT 1",
      [id]
    );
    if (ord.rows.length > 0) {
      return res.status(400).json({ message: "Materiale usato in ordini: non eliminabile" });
    }
    await client.query("DELETE FROM materiali WHERE id=$1", [id]);
    res.json({ message: "Materiale eliminato" });
  } catch (err) {
    console.error("Errore eliminazione materiale:", err);
    res.status(500).send("Errore durante l'eliminazione del materiale");
  }
});

// Disponibilità/occupazione per ogni materiale (ordini non ritirati)
app.get("/materiali/disponibilita", async (_req, res) => {
  try {
    const sql = `
      SELECT
        m.id,
        m.nome,
        m.quantita_disponibile AS stock_totale,
        COALESCE(SUM(CASE WHEN o.ritirato = false THEN o.quantita ELSE 0 END), 0) AS occupati,
        m.quantita_disponibile - COALESCE(SUM(CASE WHEN o.ritirato = false THEN o.quantita ELSE 0 END), 0) AS disponibili
      FROM materiali m
      LEFT JOIN ordini o ON o.materiale_id = m.id
      GROUP BY m.id, m.nome, m.quantita_disponibile
      ORDER BY m.nome ASC;
    `;
    const r = await client.query(sql);
    res.json(
      r.rows.map((row) => ({
        ...row,
        low_stock:
          Number(row.disponibili) <=
          Math.max(1, Math.floor(Number(row.stock_totale) * 0.1)),
      }))
    );
  } catch (err) {
    console.error("Errore disponibilità materiali:", err);
    res.status(500).send("Errore nel calcolo disponibilità");
  }
});

// ---------------------------------------------------------------
// ORDINI
// ---------------------------------------------------------------
app.post("/ordini", async (req, res) => {
  const { cliente_id, materiali, data_consegna, data_ritiro, km, note } = req.body || {};

  try {
    if (Array.isArray(materiali) && materiali.length > 0) {
      const creati = [];
      for (const item of materiali) {
        const { materiale_id, quantita } = item;

        const m = await client.query("SELECT prezzo_weekend FROM materiali WHERE id=$1", [
          materiale_id,
        ]);
        if (m.rows.length === 0) continue;

        const prezzoWeekend = m.rows[0].prezzo_weekend;
        const totale = calcolaTotale(prezzoWeekend, quantita, km);

        const ins = await client.query(
          `INSERT INTO ordini
           (cliente_id, materiale_id, quantita, data_consegna, data_ritiro, km, totale, consegnato, ritirato, pagato, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false,false,false,$8)
           RETURNING *`,
          [cliente_id, materiale_id, quantita, data_consegna, data_ritiro, km, totale, note || null]
        );
        creati.push(ins.rows[0]);
      }
      return res.json({ message: "Ordini creati", ordini: creati });
    } else {
      const { materiale_id, quantita } = req.body || {};

      const m = await client.query("SELECT prezzo_weekend FROM materiali WHERE id=$1", [
        materiale_id,
      ]);
      if (m.rows.length === 0) return res.status(400).json({ message: "Materiale non valido" });

      const prezzoWeekend = m.rows[0].prezzo_weekend;
      const totale = calcolaTotale(prezzoWeekend, quantita, km);

      const ins = await client.query(
        `INSERT INTO ordini
         (cliente_id, materiale_id, quantita, data_consegna, data_ritiro, km, totale, consegnato, ritirato, pagato, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,false,false,false,$8)
         RETURNING *`,
        [cliente_id, materiale_id, quantita, data_consegna, data_ritiro, km, totale, note || null]
      );
      return res.json(ins.rows[0]);
    }
  } catch (err) {
    console.error("Errore nella creazione ordine:", err);
    res.status(500).send("Errore nella creazione dell'ordine");
  }
});

app.get("/ordini", async (_req, res) => {
  try {
    const sql = `
      SELECT
        o.id,
        o.cliente_id,
        o.materiale_id,
        c.nome AS cliente,
        c.indirizzo_spedizione,
        m.nome AS materiale,
        o.quantita,
        o.km,
        o.totale,
        o.consegnato,
        o.ritirato,
        o.pagato,
        o.note,
        o.data_consegna,
        o.data_ritiro
      FROM ordini o
      JOIN clienti c ON c.id = o.cliente_id
      JOIN materiali m ON m.id = o.materiale_id
      ORDER BY o.data_consegna DESC, o.id DESC;
    `;
    const r = await client.query(sql);
    res.json(r.rows);
  } catch (err) {
    console.error("Errore get ordini:", err);
    res.status(500).send("Errore nel recupero degli ordini");
  }
});

app.put("/ordini/:id", async (req, res) => {
  const { id } = req.params;
  const { cliente_id, materiale_id, quantita, data_consegna, data_ritiro, km, note } = req.body || {};
  try {
    const m = await client.query("SELECT prezzo_weekend FROM materiali WHERE id=$1", [
      materiale_id,
    ]);
    if (m.rows.length === 0) return res.status(400).json({ message: "Materiale non valido" });

    const prezzoWeekend = m.rows[0].prezzo_weekend;
    const totale = calcolaTotale(prezzoWeekend, quantita, km);

    const up = await client.query(
      `UPDATE ordini
       SET cliente_id=$1, materiale_id=$2, quantita=$3, data_consegna=$4, data_ritiro=$5, km=$6, totale=$7, note=$8
       WHERE id=$9
       RETURNING *`,
      [cliente_id, materiale_id, quantita, data_consegna, data_ritiro, km, totale, note || null, id]
    );
    res.json(up.rows[0]);
  } catch (err) {
    console.error("Errore update ordine:", err);
    res.status(500).send("Errore durante l'aggiornamento dell'ordine");
  }
});

app.patch("/ordini/:id/stato", async (req, res) => {
  const { id } = req.params;
  const { consegnato, ritirato, pagato } = req.body || {};
  try {
    const up = await client.query(
      "UPDATE ordini SET consegnato=$1, ritirato=$2, pagato=$3 WHERE id=$4 RETURNING *",
      [!!consegnato, !!ritirato, !!pagato, id]
    );
    res.json(up.rows[0]);
  } catch (err) {
    console.error("Errore patch stato:", err);
    res.status(500).send("Errore aggiornamento stato ordine");
  }
});

app.delete("/ordini/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await client.query("DELETE FROM ordini WHERE id=$1", [id]);
    res.json({ message: "Ordine eliminato" });
  } catch (err) {
    console.error("Errore delete ordine:", err);
    res.status(500).send("Errore durante l'eliminazione dell'ordine");
  }
});

// ---------------------------------------------------------------
// PROFITTI (solo ordini pagati)
// ---------------------------------------------------------------
app.get("/profitti/mensili", async (_req, res) => {
  try {
    const sql = `
      SELECT
        TO_CHAR(date_trunc('month', data_consegna), 'YYYY-MM') AS anno_mese,
        TO_CHAR(date_trunc('month', data_consegna), 'TMMonth', 'it_IT') AS mese_nome,
        SUM(CASE WHEN pagato = true THEN COALESCE(totale,0) ELSE 0 END) AS totale_pagato
      FROM ordini
      GROUP BY 1,2
      ORDER BY 1 ASC;
    `;
    const r = await client.query(sql);
    res.json(
      r.rows.map((row) => ({
        anno_mese: row.anno_mese,
        mese: row.mese_nome?.trim() || row.anno_mese,
        totale_pagato: euro(row.totale_pagato),
      }))
    );
  } catch (err) {
    console.error("Errore profitti mensili:", err);
    res.status(500).send("Errore nel calcolo profitti");
  }
});

app.get("/statistiche/materiali", async (_req, res) => {
  try {
    const sql = `
      SELECT m.nome, COUNT(o.id) AS numero_ordini
      FROM materiali m
      LEFT JOIN ordini o ON o.materiale_id = m.id
      GROUP BY m.nome
      ORDER BY numero_ordini DESC;
    `;
    const r = await client.query(sql);
    res.json(
      r.rows.map((row) => ({
        nome: row.nome,
        numero_ordini: Number(row.numero_ordini || 0),
      }))
    );
  } catch (err) {
    console.error("Errore statistiche materiali:", err);
    res.status(500).send("Errore nel recupero delle statistiche");
  }
});

// ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Backend attivo su porta ${PORT}`);
});
