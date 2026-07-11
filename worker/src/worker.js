/**
 * AfterSold mailer — Cloudflare Worker
 *
 * HTTP:
 *   POST /api/list      Accepts the order from list.html, stores it in D1.
 *   POST /api/signup    Simple email/name signup (waitlist / early-access).
 *   GET  /api/health    Liveness check.
 *   POST /api/test-send Dry-run a DocuPost letter (add ?live=1 to actually mail).
 *   GET  /api/promo     Enforceable per-IP launch discount.
 *   GET  /admin         Token-protected HTML view of signups.
 *
 * Cron (daily): scans recipients and mails any card whose occasion lands today,
 * deduped via the `sends` table so each occasion goes out once per year.
 *
 * Secrets:  DOCUPOST_API_KEY, ADMIN_TOKEN
 * Bindings: DB (D1), ALLOWED_ORIGIN (var — comma-separated list supported)
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
      if (url.pathname === "/api/signup" && request.method === "POST") {
        return await handleSignup(request, env, cors);
      }
      if (url.pathname === "/api/test-send" && request.method === "POST") {
        return await handleTestSend(request, env, cors, url);
      }
      if (url.pathname === "/api/promo") {
        return await handlePromo(request, env, cors);
      }
      if (url.pathname === "/admin") {
        return await handleAdmin(request, env);
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

/* ───────────────────────── signup (waitlist / early access) ───────────────────────── */

async function handleSignup(request, env, cors) {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim().slice(0, 100);
  const email = String(body.email || "").trim().toLowerCase().slice(0, 200);
  const source = String(body.source || "signin").trim().slice(0, 40);

  if (!name) return json({ error: "name required" }, 400, cors);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    return json({ error: "valid email required" }, 400, cors);

  const now = Date.now();
  try {
    await env.DB.prepare(
      "INSERT INTO users (name, email, source, created_at) VALUES (?, ?, ?, ?)"
    ).bind(name, email, source, now).run();
    return json({ ok: true, message: "signed up" }, 200, cors);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/UNIQUE|constraint/i.test(msg)) {
      return json({ ok: true, message: "already signed up", duplicate: true }, 200, cors);
    }
    throw e;
  }
}

/* ───────────────────────── admin view (token-gated) ───────────────────────── */

async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Admin-Token") || "";
  const expected = env.ADMIN_TOKEN || "";

  if (!expected) {
    return new Response("Admin not configured (missing ADMIN_TOKEN secret)", { status: 503 });
  }
  if (!token || token !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { results } = await env.DB.prepare(
    "SELECT id, name, email, source, created_at FROM users ORDER BY created_at DESC LIMIT 500"
  ).all();
  const rows = (results || [])
    .map((r) => {
      const when = new Date(Number(r.created_at)).toISOString().replace("T", " ").slice(0, 19);
      return `<tr>
        <td>${r.id}</td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.email)}</td>
        <td>${escapeHtml(r.source || "")}</td>
        <td>${when} UTC</td>
      </tr>`;
    })
    .join("");

  const count = (results || []).length;
  const html = `<!doctype html><html><head>
<meta charset="utf-8"><title>AfterSold — Admin</title>
<meta name="robots" content="noindex, nofollow">
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #faf7f2; color: #21303f; }
  header { padding: 24px 40px; border-bottom: 1px solid #e8e2d5; display: flex; align-items: center; justify-content: space-between; }
  h1 { margin: 0; font-size: 22px; }
  .count { color: #62707e; font-size: 14px; }
  main { padding: 24px 40px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.04); }
  th, td { padding: 12px 16px; border-bottom: 1px solid #eee; text-align: left; font-size: 14px; }
  th { background: #f6f2ea; color: #62707e; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #faf7f2; }
  .empty { padding: 40px; text-align: center; color: #888; background: #fff; border-radius: 6px; }
</style></head>
<body>
  <header>
    <h1>AfterSold — Signups</h1>
    <div class="count">${count} ${count === 1 ? "signup" : "signups"} (newest first, max 500)</div>
  </header>
  <main>
    ${count > 0 ? `<table>
      <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Source</th><th>Created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>` : `<div class="empty">No signups yet.</div>`}
  </main>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
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

function occasionsFor(row, today) {
  const cats = safeParse(row.categories, []);
  const has = (c) => cats.includes(c);
  const md = (iso) => (iso && iso.length >= 10) ? iso.slice(5, 10) : null;
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
  form.set("to_name", clip(recipient.name, 40));
  form.set("to_address1", recipient.street || "");
  form.set("to_city", recipient.city || "");
  form.set("to_state", (recipient.state || "").toUpperCase().slice(0, 2));
  form.set("to_zip", (recipient.zip || "").slice(0, 5));
  form.set("from_name", clip(sender.name || "AfterSold", 40));
  form.set("from_address1", sender.address1 || "");
  form.set("from_city", sender.city || "");
  form.set("from_state", (sender.state || "").toUpperCase().slice(0, 2));
  form.set("from_zip", (sender.zip || "").slice(0, 5));
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

/* ───────────────────────── launch promo ───────────────────────── */

const PROMO_WINDOW_MS = 2 * 60 * 1000;
const PROMO_LOCKOUT_MS = 60 * 24 * 60 * 60 * 1000;

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
  if (!row) {
    deadline = now + PROMO_WINDOW_MS;
    await env.DB.prepare(
      "INSERT INTO promo_offers (ip_hash, first_seen, deadline) VALUES (?,?,?)"
    ).bind(ipHash, now, deadline).run();
    eligible = true;
  } else {
    const firstSeen = Number(row.first_seen), dl = Number(row.deadline);
    if (now < dl) {
      eligible = true; deadline = dl;
    } else if (now < firstSeen + PROMO_LOCKOUT_MS) {
      eligible = false; deadline = dl;
    } else {
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

// CORS supports comma-separated origins: env.ALLOWED_ORIGIN = "https://a.com,https://b.com"
function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const raw = env.ALLOWED_ORIGIN || "*";
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const allowAll = list.includes("*");
  const allowed = allowAll ? "*" : (list.includes(origin) ? origin : (list[0] || "*"));
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
