// server.js — Backend Noleggio Cantinota (ESM, Node 20)
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import pkg from "pg";
const { Client } = pkg;
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

const SECRET_KEY = process.env.SECRET_KEY;

const app = express();

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

app.use(
  cors({
    origin: [
      "http://localhost:5173",
      process.env.FRONTEND_URL,
    ].filter(Boolean),
  })
);

app.use(bodyParser.json());

// ---------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------
function euro(n) {
  const v = Number(n ?? 0);
  return isFinite(v) ? v : 0;
}

function toUTCDateOnly(yyyy_mm_dd) {
  const [y, m, d] = String(yyyy_mm_dd).split("-").map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

// conta quanti sabati ci sono tra start e end (inclusi)
function countSaturdaysInclusive(startStr, endStr) {
  const start = toUTCDateOnly(startStr);
  const end = toUTCDateOnly(endStr);

  if (isNaN(start) || isNaN(end)) return 1;
  if (end < start) return 1;

  let count = 0;
  const cur = new Date(start);

  while (cur <= end) {
    if (cur.getUTCDay() === 6) count++; // 6 = sabato
    cur.setUTCDate(cur.getUTCDate() + 1);
  }

  return count;
}

function weekendMultiplier(data_consegna, data_ritiro) {
  return Math.max(1, countSaturdaysInclusive(data_consegna, data_ritiro));
}

// ---------------------------------------------------------------
// AUTH middleware
// ---------------------------------------------------------------
function authRequired(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) return res.status(401).json({ message: "Token mancante" });

  try {
    const payload = jwt.verify(token, SECRET_KEY);
    req.user = payload; // { id, username, role }
    next();
  } catch (_e) {
    return res.status(401).json({ message: "Token non valido" });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Permesso negato" });
  }
  next();
}

// ---------------------------------------------------------------
// LOGIN (multiutente su tabella admin: password_hash + role)
// Supporta anche vecchia password in chiaro se presente.
// ---------------------------------------------------------------
app.post("/login", async (req, res) => {
  const { username, password } = req.body || {};

  try {
    const r = await client.query(
      "SELECT id, username, role, password, password_hash FROM admin WHERE username = $1 LIMIT 1",
      [username]
    );

    if (r.rows.length === 0) {
      return res.status(401).json({ message: "Credenziali non valide" });
    }

    const u = r.rows[0];

    let ok = false;
    if (u.password_hash) {
      ok = await bcrypt.compare(password || "", u.password_hash);
    } else {
      ok = (u.password || "") === (password || "");
    }

    if (!ok) {
      return res.status(401).json({ message: "Credenziali non valide" });
    }

    const token = jwt.sign(
      { id: u.id, username: u.username, role: u.role || "admin" },
      SECRET_KEY,
      { expiresIn: "8h" }
    );

    res.json({
      token,
      role: u.role || "admin",
      username: u.username,
    });
  } catch (err) {
    console.error("Errore login:", err);
    res.status(500).json({ message: "Errore durante il login" });
  }
});

// health (pubblico)
app.get("/", (_req, res) => {
  res.send("✅ Noleggio Cantinota backend attivo");
});

// Da qui in poi: tutto protetto
app.use(authRequired);

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

app.post("/clienti/add", adminOnly, async (req, res) => {
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

app.put("/clienti/:id", adminOnly, async (req, res) => {
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

app.delete("/clienti/:id", adminOnly, async (req, res) => {
  const { id } = req.params;

  try {
    const ord = await client.query(
      "SELECT 1 FROM ordini WHERE cliente_id=$1 LIMIT 1",
      [id]
    );

    if (ord.rows.length > 0) {
      return res
        .status(400)
        .json({ message: "Cliente con ordini: non eliminabile" });
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
app.get("/materiali", async (req, res) => {
  try {
    const isOperatore = req.user?.role === "operatore";

    const sql = isOperatore
      ? "SELECT id, nome, quantita_disponibile, NULL::numeric AS prezzo_weekend FROM materiali ORDER BY nome ASC"
      : "SELECT id, nome, quantita_disponibile, prezzo_weekend FROM materiali ORDER BY nome ASC";

    const r = await client.query(sql);
    res.json(r.rows);
  } catch (err) {
    console.error("Errore get materiali:", err);
    res.status(500).send("Errore nel recupero dei materiali");
  }
});

app.post("/materiali", adminOnly, async (req, res) => {
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

app.put("/materiali/:id", adminOnly, async (req, res) => {
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

app.delete("/materiali/:id", adminOnly, async (req, res) => {
  const { id } = req.params;

  try {
    const ord = await client.query(
      "SELECT 1 FROM ordini_materiali WHERE materiale_id=$1 LIMIT 1",
      [id]
    );

    if (ord.rows.length > 0) {
      return res
        .status(400)
        .json({ message: "Materiale usato in ordini: non eliminabile" });
    }

    await client.query("DELETE FROM materiali WHERE id=$1", [id]);
    res.json({ message: "Materiale eliminato" });
  } catch (err) {
    console.error("Errore eliminazione materiale:", err);
    res.status(500).send("Errore durante l'eliminazione del materiale");
  }
});

// Disponibilità (scala SOLO se consegnato=true e ritirato=false)
app.get("/materiali/disponibilita", async (_req, res) => {
  try {
    const sql = `
      SELECT
        m.id,
        m.nome,
        m.quantita_disponibile AS stock_totale,
        COALESCE(
          SUM(
            CASE
              WHEN o.consegnato = true AND o.ritirato = false
              THEN om.quantita
              ELSE 0
            END
          ), 0
        ) AS occupati
      FROM materiali m
      LEFT JOIN ordini_materiali om ON om.materiale_id = m.id
      LEFT JOIN ordini o ON o.id = om.ordine_id
      GROUP BY m.id, m.nome, m.quantita_disponibile
      ORDER BY m.nome ASC;
    `;

    const r = await client.query(sql);

    res.json(
      r.rows.map((row) => {
        const stock = Number(row.stock_totale || 0);
        const occupati = Number(row.occupati || 0);
        const disponibili = stock - occupati;

        return {
          id: row.id,
          nome: row.nome,
          stock_totale: stock,
          occupati,
          disponibili,
          low_stock: disponibili <= Math.max(1, Math.floor(stock * 0.1)),
        };
      })
    );
  } catch (err) {
    console.error("Errore disponibilità materiali:", err);
    res.status(500).send("Errore nel calcolo disponibilità");
  }
});

// ---------------------------------------------------------------
// ORDINI (ordine unico + righe materiali)
// ---------------------------------------------------------------
app.post("/ordini", adminOnly, async (req, res) => {
  const {
    cliente_id,
    materiali,
    data_consegna,
    data_ritiro,
    km,
    note,
  } = req.body || {};

  try {
    if (
      !cliente_id ||
      !data_consegna ||
      !data_ritiro ||
      !Array.isArray(materiali) ||
      materiali.length === 0
    ) {
      return res.status(400).json({ message: "Dati ordine non validi" });
    }

    const extraKm = Number(km || 0) * 3;
    const w = weekendMultiplier(data_consegna, data_ritiro);

    let base = 0;
    for (const item of materiali) {
      const materiale_id = Number(item.materiale_id);
      const quantita = Number(item.quantita);
      if (!materiale_id || !quantita) continue;

      const m = await client.query(
        "SELECT prezzo_weekend FROM materiali WHERE id=$1",
        [materiale_id]
      );

      if (m.rows.length === 0) {
        return res.status(400).json({ message: "Materiale non valido" });
      }

      base += euro(m.rows[0].prezzo_weekend) * quantita;
    }

    const totale = base * w + extraKm;

    const insOrd = await client.query(
      `INSERT INTO ordini (cliente_id, data_consegna, data_ritiro, km, totale, consegnato, ritirato, pagato, note)
       VALUES ($1,$2,$3,$4,$5,false,false,false,$6)
       RETURNING *`,
      [
        Number(cliente_id),
        data_consegna,
        data_ritiro,
        Number(km || 0),
        totale,
        note || null,
      ]
    );

    const ordine = insOrd.rows[0];

    for (const item of materiali) {
      const materiale_id = Number(item.materiale_id);
      const quantita = Number(item.quantita);
      if (!materiale_id || !quantita) continue;

      await client.query(
        `INSERT INTO ordini_materiali (ordine_id, materiale_id, quantita)
         VALUES ($1,$2,$3)`,
        [ordine.id, materiale_id, quantita]
      );
    }

    res.json({ message: "Ordine creato", ordine_id: ordine.id });
  } catch (err) {
    console.error("Errore nella creazione ordine:", err);
    res.status(500).send("Errore nella creazione dell'ordine");
  }
});

app.get("/ordini", async (req, res) => {
  try {
    const isOperatore = req.user?.role === "operatore";

    const sql = `
      SELECT
        o.id,
        o.cliente_id,
        c.nome AS cliente,
        c.indirizzo_spedizione,
        o.data_consegna,
        o.data_ritiro,
        o.km,
        ${isOperatore ? "NULL::numeric AS totale" : "o.totale"},
        o.consegnato,
        o.ritirato,
        o.pagato,
        o.note,
        COALESCE(
          json_agg(
            json_build_object(
              'materiale_id', om.materiale_id,
              'materiale', m.nome,
              'quantita', om.quantita
            )
          ) FILTER (WHERE om.id IS NOT NULL),
          '[]'::json
        ) AS materiali
      FROM ordini o
      JOIN clienti c ON c.id = o.cliente_id
      LEFT JOIN ordini_materiali om ON om.ordine_id = o.id
      LEFT JOIN materiali m ON m.id = om.materiale_id
      GROUP BY o.id, c.nome, c.indirizzo_spedizione
      ORDER BY o.data_consegna DESC, o.id DESC;
    `;

    const r = await client.query(sql);

    const out = r.rows.map((o) => {
      let stato = "DA CONSEGNARE";
      if (o.pagato) stato = "PAGATO";
      else if (o.ritirato) stato = "RITIRATO";
      else if (o.consegnato) stato = "CONSEGNATO";
      return { ...o, stato };
    });

    res.json(out);
  } catch (err) {
    console.error("Errore get ordini:", err);
    res.status(500).send("Errore nel recupero degli ordini");
  }
});

app.put("/ordini/:id", adminOnly, async (req, res) => {
  const { id } = req.params;
  const {
    cliente_id,
    materiali,
    data_consegna,
    data_ritiro,
    km,
    note,
  } = req.body || {};

  try {
    if (
      !cliente_id ||
      !data_consegna ||
      !data_ritiro ||
      !Array.isArray(materiali) ||
      materiali.length === 0
    ) {
      return res.status(400).json({ message: "Dati ordine non validi" });
    }

    const extraKm = Number(km || 0) * 3;
    const w = weekendMultiplier(data_consegna, data_ritiro);

    let base = 0;

    for (const item of materiali) {
      const materiale_id = Number(item.materiale_id);
      const quantita = Number(item.quantita);
      if (!materiale_id || !quantita) continue;

      const m = await client.query(
        "SELECT prezzo_weekend FROM materiali WHERE id=$1",
        [materiale_id]
      );

      if (m.rows.length === 0) {
        return res.status(400).json({ message: "Materiale non valido" });
      }

      base += euro(m.rows[0].prezzo_weekend) * quantita;
    }

    const totale = base * w + extraKm;

    const up = await client.query(
      `UPDATE ordini
       SET cliente_id=$1, data_consegna=$2, data_ritiro=$3, km=$4, totale=$5, note=$6
       WHERE id=$7
       RETURNING *`,
      [
        Number(cliente_id),
        data_consegna,
        data_ritiro,
        Number(km || 0),
        totale,
        note || null,
        Number(id),
      ]
    );

    await client.query("DELETE FROM ordini_materiali WHERE ordine_id=$1", [
      Number(id),
    ]);

    for (const item of materiali) {
      const materiale_id = Number(item.materiale_id);
      const quantita = Number(item.quantita);
      if (!materiale_id || !quantita) continue;

      await client.query(
        `INSERT INTO ordini_materiali (ordine_id, materiale_id, quantita)
         VALUES ($1,$2,$3)`,
        [Number(id), materiale_id, quantita]
      );
    }

    res.json(up.rows[0]);
  } catch (err) {
    console.error("Errore update ordine:", err);
    res.status(500).send("Errore durante l'aggiornamento dell'ordine");
  }
});

app.patch("/ordini/:id/stato", adminOnly, async (req, res) => {
  const { id } = req.params;
  const { consegnato, ritirato, pagato } = req.body || {};

  try {
    const up = await client.query(
      "UPDATE ordini SET consegnato=$1, ritirato=$2, pagato=$3 WHERE id=$4 RETURNING *",
      [!!consegnato, !!ritirato, !!pagato, Number(id)]
    );
    res.json(up.rows[0]);
  } catch (err) {
    console.error("Errore patch stato:", err);
    res.status(500).send("Errore aggiornamento stato ordine");
  }
});

app.delete("/ordini/:id", adminOnly, async (req, res) => {
  const { id } = req.params;

  try {
    await client.query("DELETE FROM ordini WHERE id=$1", [Number(id)]);
    res.json({ message: "Ordine eliminato" });
  } catch (err) {
    console.error("Errore delete ordine:", err);
    res.status(500).send("Errore durante l'eliminazione dell'ordine");
  }
});

// ---------------------------------------------------------------
// PROFITTI (solo admin)
// ---------------------------------------------------------------
app.get("/profitti/mensili", adminOnly, async (_req, res) => {
  try {
    const sql = `
      SELECT
        TO_CHAR(date_trunc('month', data_consegna), 'YYYY-MM') AS anno_mese,
        SUM(CASE WHEN pagato = true THEN COALESCE(totale, 0) ELSE 0 END) AS totale_pagato
      FROM ordini
      GROUP BY 1
      ORDER BY 1 ASC;
    `;

    const r = await client.query(sql);

    res.json(
      r.rows.map((row) => ({
        anno_mese: row.anno_mese,
        totale_pagato: euro(row.totale_pagato),
      }))
    );
  } catch (err) {
    console.error("Errore profitti mensili:", err);
    res.status(500).json({ message: "Errore nel calcolo profitti" });
  }
});

// ---------------------------------------------------------------
// Statistiche (corrette col nuovo schema ordini_materiali)
// ---------------------------------------------------------------
app.get("/statistiche/materiali", async (_req, res) => {
  try {
    const sql = `
      SELECT m.nome, COALESCE(SUM(om.quantita),0) AS numero_ordini
      FROM materiali m
      LEFT JOIN ordini_materiali om ON om.materiale_id = m.id
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Backend attivo sulla porta ${PORT}`));
