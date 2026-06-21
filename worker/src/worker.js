/**
 * AfterSold mailer — Cloudflare Worker
 *
 * HTTP:
 *   POST /api/list      Accepts the order from list.html, stores it in D1.
 *   GET  /api/health    Liveness check.
 *   POST /api/test-send Dry-run a DocuPost letter (add ?live=1 to actually mail).
 *
 * Cron (daily): scans recipients and mails any card whose occasion lands today,
 * deduped via the `sends` table so each occasion goes out once per year.
 *
 * Secrets:  DOCUPOST_API_KEY  (wrangler secret put DOCUPOST_API_KEY)
 * Bindings: DB (D1), ALLOWED_ORIGIN (var)
 */

const DOCUPOST_URL = "https://app.docupost.com/api/1.1/wf/sendletter";

// Fixed-date holiday sends (month is 1-based). Recipients with the "Holidays"
// category get one piece on this date each year.
const HOLIDAYS = [{ key: "holiday-winter", m: 12, d: 12, label: "Holidays" }];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, ts: new Date().toISOString() }, 200, cors);
      }
      if (url.pathname === "/api/list" && request.method === "POST") {
        return await handleList(request, env, cors);
      }
      if (url.pathname === "/api/test-send" && request.method === "POST") {
        return await handleTestSend(request, env, cors, url);
      }
      if (url.pathname === "/api/promo") {
        return await handlePromo(request, env, cors);
      }
      return json({ error: "not found" }, 404, cors);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailySend(env));
  },
};

/* ───────────────────────── order intake ───────────────────────── */

async function handleList(request, env, cors) {
  const body = await request.json();
  const sender = body.sender || {};
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];
  if (!recipients.length) return json({ error: "no recipients" }, 400, cors);

  const order = await env.DB.prepare(
    "INSERT INTO orders (email, plan, sender_json, signature) VALUES (?,?,?,?)"
  ).bind(
    body.email || sender.email || "",
    body.plan || null,
    JSON.stringify(sender),
    body.signaturePng || ""
  ).run();
  const orderId = order.meta.last_row_id;

  const stmt = env.DB.prepare(
    `INSERT INTO recipients
       (order_id,name,relationship,street,city,state,zip,birthday,closing,anniversary,categories,notes,heritage)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const batch = recipients.map((r) => {
    const a = r.address || {}, d = r.dates || {};
    return stmt.bind(
      orderId, r.name || "", r.relationship || "",
      a.street || "", a.city || "", a.state || "", a.zip || "",
      d.birthday || null, d.closing || null, d.anniversary || null,
      JSON.stringify(r.categories || []), r.notes || "", r.heritage || ""
    );
  });
  await env.DB.batch(batch);

  return json({ ok: true, orderId, recipients: recipients.length }, 200, cors);
}

/* ───────────────────────── daily cron ───────────────────────── */

async function runDailySend(env) {
  const now = new Date();
  const mm = pad(now.getUTCMonth() + 1), dd = pad(now.getUTCDate());
  const year = now.getUTCFullYear();
  const today = `${mm}-${dd}`;

  const { results } = await env.DB.prepare(
    `SELECT r.*, o.sender_json, o.signature
       FROM recipients r JOIN orders o ON o.id = r.order_id
      WHERE r.active = 1 AND r.street <> '' AND r.city <> '' AND r.state <> '' AND r.zip <> ''`
  ).all();

  let sent = 0, skipped = 0, failed = 0;
  for (const row of results || []) {
    const occasions = occasionsFor(row, today);
    if (!occasions.length) continue;

    const sender = safeParse(row.sender_json, {});
    for (const occ of occasions) {
      // dedupe: one per occasion per recipient per year
      const exists = await env.DB.prepare(
        "SELECT 1 FROM sends WHERE recipient_id=? AND occasion=? AND year=?"
      ).bind(row.id, occ.key, year).first();
      if (exists) { skipped++; continue; }

      const html = renderCard(occ, row, sender);
      let status = "ok", resp = "";
      try {
        resp = await sendLetter(env, { recipient: row, sender, html });
      } catch (e) { status = "error"; resp = String(e && e.message || e); failed++; }
      if (status === "ok") sent++;

      await env.DB.prepare(
        "INSERT OR IGNORE INTO sends (recipient_id,occasion,year,status,response) VALUES (?,?,?,?,?)"
      ).bind(row.id, occ.key, year, status, String(resp).slice(0, 2000)).run();
    }
  }
  console.log(`AfterSold cron ${today}: sent=${sent} skipped=${skipped} failed=${failed}`);
  return { sent, skipped, failed };
}

// Which cards are due today for this recipient, gated by their chosen categories.
function occasionsFor(row, today) {
  const cats = safeParse(row.categories, []);
  const has = (c) => cats.includes(c);
  const md = (iso) => (iso && iso.length >= 10) ? iso.slice(5, 10) : null; // MM-DD
  const out = [];
  if (md(row.birthday) === today && has("Birthday"))
    out.push({ key: "birthday", label: "Birthday" });
  if (md(row.anniversary) === today && has("Anniversary"))
    out.push({ key: "anniversary", label: "Anniversary" });
  if (md(row.closing) === today && has("Anniversary"))
    out.push({ key: "home-anniversary", label: "Anniversary" });
  for (const h of HOLIDAYS)
    if (today === `${pad(h.m)}-${pad(h.d)}` && has(h.label))
      out.push({ key: h.key, label: h.label });
  return out;
}

/* ───────────────────────── DocuPost ───────────────────────── */

async function sendLetter(env, { recipient, sender, html }) {
  const key = env.DOCUPOST_API_KEY;
  if (!key) throw new Error("DOCUPOST_API_KEY not configured");

  const form = new URLSearchParams();
  // recipient
  form.set("to_name", clip(recipient.name, 40));
  form.set("to_address1", recipient.street || "");
  form.set("to_city", recipient.city || "");
  form.set("to_state", (recipient.state || "").toUpperCase().slice(0, 2));
  form.set("to_zip", (recipient.zip || "").slice(0, 5));
  // return address
  form.set("from_name", clip(sender.name || "AfterSold", 40));
  form.set("from_address1", sender.address1 || "");
  form.set("from_city", sender.city || "");
  form.set("from_state", (sender.state || "").toUpperCase().slice(0, 2));
  form.set("from_zip", (sender.zip || "").slice(0, 5));
  // options + content
  form.set("color", "true");
  form.set("doublesided", "false");
  form.set("description", clip("AfterSold card", 40));
  form.set("html", html);

  const res = await fetch(`${DOCUPOST_URL}?api_token=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DocuPost ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

// Dry-run by default so you can verify wiring without spending postage.
async function handleTestSend(request, env, cors, url) {
  const body = await request.json().catch(() => ({}));
  const recipient = body.recipient || { name: "Test Recipient", street: "123 Main St", city: "Austin", state: "TX", zip: "78704" };
  const sender = body.sender || { name: "AfterSold", address1: "1 Sender Way", city: "Austin", state: "TX", zip: "78701" };
  const occ = { key: "birthday", label: "Birthday" };
  const html = renderCard(occ, { ...recipient, categories: "[]" }, sender);

  if (url.searchParams.get("live") === "1") {
    const resp = await sendLetter(env, { recipient, sender, html });
    return json({ ok: true, live: true, docupost: resp }, 200, cors);
  }
  return json({ ok: true, live: false, note: "dry run — add ?live=1 to actually mail", htmlChars: html.length, html }, 200, cors);
}

/* ───────────────────────── card templates ───────────────────────── */

function firstName(n) { return (n || "").trim().split(/\s+/)[0] || "there"; }

function messageFor(occ, row, sender) {
  const fn = firstName(row.name);
  const warm = row.notes ? `` : ``;
  switch (occ.key) {
    case "birthday":
      return `Happy birthday, ${fn}! Hope your day is full of the people and things you love. Thinking of you today.`;
    case "anniversary":
      return `Happy anniversary, ${fn}! Wishing you many more years of happiness together.`;
    case "home-anniversary":
      return `Happy home anniversary, ${fn}! Hard to believe how fast the time has gone — hope the house still feels like home.`;
    default:
      if (occ.key.startsWith("holiday"))
        return `Wishing you and yours a warm and happy holiday season, ${fn}. So grateful to know you.`;
      return `Thinking of you, ${fn}.`;
  }
}

function renderCard(occ, row, sender) {
  const msg = escapeHtml(messageFor(occ, row, sender));
  const signName = escapeHtml(firstName(sender.name || "") === "there" ? "" : (sender.name || ""));
  const sig = sender && row.signature && String(row.signature).length < 6000
    ? `<img src="${row.signature}" alt="" style="height:54px;margin-top:6px" />`
    : `<div style="font-family:'Brush Script MT',cursive;font-size:30px;color:#21303f;margin-top:6px">${signName}</div>`;

  // Inline-styled, kept well under DocuPost's 9000-char html limit.
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;font-family:Georgia,'Times New Roman',serif;color:#21303f">
  <div style="max-width:640px;margin:120px auto 0;padding:0 60px;text-align:center">
    <div style="font-size:13px;letter-spacing:3px;text-transform:uppercase;color:#C0392B">${escapeHtml(occ.label)}</div>
    <p style="font-size:24px;line-height:1.6;margin:34px 0 40px">${msg}</p>
    <div style="font-size:20px;color:#62707e">— </div>
    ${sig}
  </div>
</body></html>`;
}

/* ───────────────────────── launch promo (one-time 50% off, per-IP) ───────────────────────── */

const PROMO_WINDOW_MS = 2 * 60 * 1000;             // each visitor gets ONE 2-minute window
const PROMO_LOCKOUT_MS = 60 * 24 * 60 * 60 * 1000; // then that IP can't get it again for 60 days

// GET /api/promo — real, enforceable launch discount. The visitor's IP is stored
// only as a salted SHA-256 hash (no raw IP retained). Refreshing does NOT reset the
// clock; once the 2-minute window passes, the IP is locked out of the discount for 60
// days. Returns { eligible, msLeft } — msLeft is the time remaining in their window.
async function handlePromo(request, env, cors) {
  const ip = request.headers.get("CF-Connecting-IP")
    || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim()
    || "0.0.0.0";
  const ipHash = await sha256(ip + "|" + (env.PROMO_SALT || "aftersold-launch"));
  const now = Date.now();

  const row = await env.DB.prepare(
    "SELECT first_seen, deadline FROM promo_offers WHERE ip_hash = ?"
  ).bind(ipHash).first();

  let eligible, deadline;
  if (!row) {                                       // first time this IP sees the offer
    deadline = now + PROMO_WINDOW_MS;
    await env.DB.prepare(
      "INSERT INTO promo_offers (ip_hash, first_seen, deadline) VALUES (?,?,?)"
    ).bind(ipHash, now, deadline).run();
    eligible = true;
  } else {
    const firstSeen = Number(row.first_seen), dl = Number(row.deadline);
    if (now < dl) {                                 // still inside their original window
      eligible = true; deadline = dl;
    } else if (now < firstSeen + PROMO_LOCKOUT_MS) { // window passed → locked 60 days
      eligible = false; deadline = dl;
    } else {                                        // 60 days elapsed → grant a fresh window
      deadline = now + PROMO_WINDOW_MS;
      await env.DB.prepare(
        "UPDATE promo_offers SET first_seen = ?, deadline = ? WHERE ip_hash = ?"
      ).bind(now, deadline, ipHash).run();
      eligible = true;
    }
  }
  return json({ eligible, msLeft: eligible ? Math.max(0, deadline - now) : 0 }, 200, cors);
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ───────────────────────── helpers ───────────────────────── */

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allow = env.ALLOWED_ORIGIN || "*";
  const allowed = allow === "*" || origin === allow ? (allow === "*" ? "*" : origin) : allow;
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", ...(cors || {}) },
  });
}
function pad(n) { return String(n).padStart(2, "0"); }
function clip(s, n) { return String(s || "").slice(0, n); }
function safeParse(s, d) { try { return JSON.parse(s); } catch { return d; } }
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
