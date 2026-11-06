const $ = (id) => document.getElementById(id);
const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;
const AMOUNT_MSG = "Amount must be a positive number like 1500 or 1500.50 (letters and symbols are not allowed).";
const FIELDS = ["type", "date", "category", "amount", "description"];
let currency = "INR"; try { currency = localStorage.getItem("currency") || "INR"; } catch (e) {}
const LOCALES = { INR: "en-IN", USD: "en-US", EUR: "de-DE", GBP: "en-GB" };
const money = (n) => new Intl.NumberFormat(LOCALES[currency] || "en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(n || 0);
const r2 = (n) => Math.round(n * 100) / 100;
const pad = (n) => String(n).padStart(2, "0");
const ym = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1);
const curMonth = () => ym(new Date());
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
let entries = [], budgets = {}, view = "overview", typeFilter = "all", editId = null;

function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }
function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 2400); }
async function api(url, opts = {}) {
  const res = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...opts });
  if (res.status === 401 && !url.includes("/auth/change") && !url.includes("/account/")) { location.href = "/login.html"; throw new Error("Not signed in"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || "Request failed"); e.fields = data.fields || {}; throw e; }
  return data;
}
const send = (url, method, body) => api(url, { method, body: JSON.stringify(body || {}) });
function setErr(id, msg) { const e = $("err-" + id); if (e) e.textContent = msg || ""; const i = $(id); if (i) i.classList.toggle("invalid", !!msg); }
function clearErrs(ids) { ids.forEach((i) => setErr(i, "")); }

/* ---------- navigation ---------- */
function showView(v) {
  view = v;
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("hidden", s.id !== "view-" + v));
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  if (v === "security") loadSecurity();
}
document.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => showView(b.dataset.view)));
document.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => openDialog()));

/* ---------- calculations ---------- */
function totals(month) {
  const t = { income: 0, expense: 0, asset: 0, liability: 0 };
  entries.forEach((e) => { if (!month || e.date.slice(0, 7) === month) t[e.type] += e.amount; });
  return t;
}
function spentByCategory(month) {
  const s = {};
  entries.forEach((e) => { if (e.type === "expense" && e.date.slice(0, 7) === month) s[e.category] = r2((s[e.category] || 0) + e.amount); });
  return s;
}

/* ---------- overview ---------- */
const NS = "http://www.w3.org/2000/svg";
function svg(tag, attrs, cls) { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (cls) n.setAttribute("class", cls); return n; }
function renderTrend() {
  const now = new Date(), months = [];
  for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const data = months.map((d) => { const t = totals(ym(d)); return { d, inc: t.income, exp: t.expense }; });
  const max = Math.max(1, ...data.flatMap((x) => [x.inc, x.exp]));
  const W = 480, H = 210, base = 170, bh = 150, gw = W / 6, s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Income and spending for the last 6 months" });
  data.forEach((x, i) => {
    const gx = i * gw + gw / 2;
    [[x.inc, "bar-in", -14, "Income"], [x.exp, "bar-out", 2, "Spending"]].forEach(([v, c, dx, name]) => {
      const h = (v / max) * bh, r = svg("rect", { x: gx + dx, y: base - Math.max(h, v > 0 ? 2 : 0), width: 12, height: Math.max(h, v > 0 ? 2 : 0), rx: 3 }, c);
      const t = svg("title", {}); t.textContent = `${name}: ${money(v)}`; r.append(t); s.append(r);
    });
    const lb = svg("text", { x: gx, y: base + 22, "text-anchor": "middle" }, "axis"); lb.textContent = x.d.toLocaleString("en", { month: "short" }); s.append(lb);
  });
  s.append(svg("line", { x1: 0, x2: W, y1: base, y2: base }, "axis-line"));
  $("trend").replaceChildren(s);
}
function bar(name, value, max, cls) {
  const d = el("div", undefined, "cat"), r = el("div", undefined, "row"), t = el("div", undefined, "track"), f = el("div", undefined, "fill " + (cls || ""));
  r.append(el("span", name), el("strong", money(value))); f.style.width = Math.min(100, (value / max) * 100) + "%"; t.append(f); d.append(r, t); return d;
}
function renderOverview() {
  const all = totals(), m = totals(curMonth()), tot = all.asset + all.liability;
  $("net").textContent = money(all.asset - all.liability);
  $("ratioFill").style.width = (tot ? (all.asset / tot) * 100 : 0) + "%";
  $("capA").textContent = "Assets " + money(all.asset); $("capL").textContent = "Liabilities " + money(all.liability);
  const saved = m.income - m.expense, rate = m.income ? Math.round((saved / m.income) * 100) : 0;
  const st = [["Income this month", money(m.income), "⬇", "rgba(16,185,129,.15)"], ["Spent this month", money(m.expense), "⬆", "rgba(239,68,68,.15)"],
    ["Saved this month", money(saved), "≈", "rgba(99,102,241,.15)"], ["Savings rate", m.income ? rate + "%" : "–", "%", "rgba(245,158,11,.15)"]];
  $("stats").replaceChildren(...st.map(([l, v, ic, bg]) => { const c = el("div", undefined, "card stat"), d = el("div", ic, "dot"), w = el("div"); d.style.background = bg; w.append(el("div", l, "lbl"), el("div", v, "val")); c.append(d, w); return c; }));
  renderTrend(); renderNetWorth(); renderAlloc();
  const top = Object.entries(spentByCategory(curMonth())).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $("cats").replaceChildren(...(top.length ? top.map(([n, v]) => bar(n, v, top[0][1])) : [el("div", "No spending recorded this month yet.", "empty")]));
  renderAlerts();
}
function renderAlerts() {
  const sp = spentByCategory(curMonth()), keys = Object.keys(budgets), box = $("alerts"); box.replaceChildren();
  if (!keys.length) { box.append(el("div", "You have not set any budgets. Open the Budgets tab to add one.", "empty")); return; }
  const rows = keys.map((c) => ({ c, pct: ((sp[c] || 0) / budgets[c]) * 100, sp: sp[c] || 0, lim: budgets[c] })).filter((x) => x.pct >= 80).sort((a, b) => b.pct - a.pct);
  if (!rows.length) { box.append(el("div", "All budgets are on track. Nicely done.", "alert ok")); return; }
  rows.forEach((x) => box.append(el("div", x.pct >= 100 ? `${x.c}: over budget by ${money(x.sp - x.lim)}` : `${x.c}: ${Math.round(x.pct)}% used (${money(x.sp)} of ${money(x.lim)})`, "alert " + (x.pct >= 100 ? "over" : "warn"))));
}

/* ---------- entries ---------- */
function renderEntries() {
  const q = $("q").value.trim().toLowerCase(), month = $("monthSel").value;
  const months = [...new Set(entries.map((e) => e.date.slice(0, 7)))].sort().reverse(), prev = $("monthSel").value;
  $("monthSel").replaceChildren(...[["all", "All months"], ...months.map((m) => [m, new Date(m + "-01T00:00:00").toLocaleString("en", { month: "long", year: "numeric" })])].map(([v, t]) => { const o = el("option", t); o.value = v; return o; }));
  $("monthSel").value = months.includes(prev) ? prev : "all";
  $("catList").replaceChildren(...[...new Set(entries.map((e) => e.category))].sort().map((c) => { const o = el("option"); o.value = c; return o; }));
  $("pills").replaceChildren(...["all", "income", "expense", "asset", "liability"].map((t) => {
    const b = el("button", t[0].toUpperCase() + t.slice(1), "pill" + (t === typeFilter ? " on" : "")); b.type = "button"; b.onclick = () => { typeFilter = t; renderEntries(); }; return b;
  }));
  const sel = $("monthSel").value;
  const list = entries.filter((e) => (typeFilter === "all" || e.type === typeFilter) && (sel === "all" || e.date.startsWith(sel)) &&
    (!q || e.category.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)));
  const body = $("rows"); body.replaceChildren();
  if (!list.length) { const tr = el("tr"), td = el("td", entries.length ? "No entries match your filters." : "Nothing here yet. Click “+ Add entry” to start.", "empty"); td.colSpan = 6; tr.append(td); body.append(tr); return; }
  list.forEach((e) => {
    const tr = el("tr"), tb = el("td"), act = el("td"), ed = el("button", "✎", "edit"), x = el("button", "✕", "x");
    tb.append(el("span", e.type, "badge t-" + e.type)); ed.type = x.type = "button"; ed.title = "Edit"; x.title = "Delete";
    ed.onclick = () => openDialog(e);
    x.onclick = async () => { if (confirm("Delete this entry?")) { await send("/api/entries/" + e.id, "DELETE"); toast("Entry deleted"); refresh(); } };
    act.append(ed, x);
    tr.append(el("td", e.date), tb, el("td", e.category), el("td", e.description), el("td", (e.type === "expense" || e.type === "liability" ? "−" : "+") + money(e.amount), "amt"), act); body.append(tr);
  });
}
["input", "change"].forEach((ev) => { $("q").addEventListener(ev, renderEntries); $("monthSel").addEventListener(ev, renderEntries); });

/* ---------- add / edit dialog ---------- */
function openDialog(e) {
  $("banner").classList.add("hidden"); clearErrs(FIELDS); editId = e ? e.id : null;
  $("dlgTitle").textContent = e ? "Edit entry" : "Add an entry"; $("save").textContent = e ? "Save changes" : "Add entry";
  $("type").value = e ? e.type : "expense"; $("date").value = e ? e.date : today(); $("category").value = e ? e.category : "";
  $("amount").value = e ? String(e.amount) : ""; $("description").value = e ? e.description : ""; $("dlg").showModal();
}
$("dlgClose").onclick = () => $("dlg").close();
$("amount").addEventListener("input", () => setErr("amount", ""));
$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault(); clearErrs(FIELDS); $("banner").classList.add("hidden");
  const d = Object.fromEntries(FIELDS.map((f) => [f, $(f).value.trim()]));
  if (!AMOUNT_RE.test(d.amount)) { setErr("amount", AMOUNT_MSG); return; }
  $("save").disabled = true;
  try {
    if (editId) await send("/api/entries/" + editId, "PUT", d); else await send("/api/entries", "POST", d);
    $("dlg").close(); toast(editId ? "Changes saved ✓" : "Entry added ✓"); await refresh();
  } catch (e) {
    Object.entries(e.fields || {}).forEach(([f, m]) => setErr(f, m));
    if (!Object.keys(e.fields || {}).length) { $("banner").textContent = e.message; $("banner").classList.remove("hidden"); }
  }
  $("save").disabled = false;
});

/* ---------- budgets ---------- */
function renderBudgets() {
  const sp = spentByCategory(curMonth()), keys = Object.keys(budgets).sort(), list = $("budgetList"); list.replaceChildren();
  if (!keys.length) { list.append(el("div", "No budgets yet. Add one on the right.", "empty")); return; }
  keys.forEach((c) => {
    const spent = sp[c] || 0, pct = (spent / budgets[c]) * 100, cls = pct >= 100 ? "over" : pct >= 80 ? "warn" : "";
    const row = el("div", undefined, "brow"), top = el("div", undefined, "row"), left = el("span"), del = el("button", "✕", "x");
    left.append(el("strong", c), el("span", `  ${money(spent)} of ${money(budgets[c])} · ${Math.round(pct)}%`, "hint"));
    del.type = "button"; del.title = "Remove budget";
    del.onclick = async () => { const next = { ...budgets }; delete next[c]; budgets = (await send("/api/budgets", "PUT", { budgets: next })).budgets; toast("Budget removed"); renderBudgets(); renderAlerts(); };
    top.append(left, del); const t = el("div", undefined, "track"), f = el("div", undefined, "fill " + cls); f.style.width = Math.min(100, pct) + "%"; t.append(f); row.append(top, t); list.append(row);
  });
}
$("bForm").addEventListener("submit", async (ev) => {
  ev.preventDefault(); clearErrs(["bCat", "bLimit"]); $("bBanner").classList.add("hidden");
  const cat = $("bCat").value.trim(), lim = $("bLimit").value.trim();
  if (!cat) { setErr("bCat", "Category is required."); return; }
  if (!AMOUNT_RE.test(lim)) { setErr("bLimit", AMOUNT_MSG); return; }
  try {
    budgets = (await send("/api/budgets", "PUT", { budgets: { ...budgets, [cat]: lim } })).budgets;
    $("bCat").value = $("bLimit").value = ""; toast("Budget saved ✓"); renderBudgets(); renderAlerts();
  } catch (e) { $("bBanner").textContent = e.message; $("bBanner").classList.remove("hidden"); }
});
$("bLimit").addEventListener("input", () => setErr("bLimit", ""));

/* ---------- security ---------- */
const EVENTS = { register: "Account created", login_success: "Signed in", login_failed: "Failed sign-in attempt", account_locked: "Account locked after repeated failures",
  logout: "Signed out", logout_all: "Signed out of all devices", session_revoked: "A device was signed out", password_changed: "Password changed", data_export: "Data exported", data_import: "Data imported", "2fa_enabled": "Two-factor turned on", "2fa_disabled": "Two-factor turned off", "2fa_failed": "Failed two-factor code" };
const when = (d) => new Date(d).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
async function loadSecurity() {
  loadTfa();
  const [ss, log] = await Promise.all([api("/api/sessions"), api("/api/security/log")]);
  $("sessions").replaceChildren(...ss.map((s) => {
    const row = el("div", undefined, "item"), l = el("div"); l.append(el("span", s.device), el("small", `${s.ip || "unknown IP"} · since ${when(s.createdAt)}`));
    row.append(l);
    if (s.current) row.append(el("span", "This device", "tag"));
    else { const b = el("button", "Sign out", "btn-ghost"); b.type = "button"; b.onclick = async () => { await send("/api/sessions/" + s.id, "DELETE"); toast("Device signed out"); loadSecurity(); }; row.append(b); }
    return row;
  }));
  $("activity").replaceChildren(...(log.length ? log.map((a) => { const row = el("div", undefined, "item"), l = el("div"); l.append(el("span", EVENTS[a.event] || a.event), el("small", `${a.device} · ${a.ip || ""}`)); row.append(l, el("small", when(a.at))); return row; }) : [el("div", "No activity yet.", "empty")]));
}
$("pwForm").addEventListener("submit", async (ev) => {
  ev.preventDefault(); clearErrs(["curPw", "newPw"]);
  try { await send("/api/auth/change-password", "POST", { currentPassword: $("curPw").value, newPassword: $("newPw").value }); $("curPw").value = $("newPw").value = ""; toast("Password updated ✓"); loadSecurity(); }
  catch (e) { const f = e.fields || {}; setErr("curPw", f.currentPassword); setErr("newPw", f.newPassword); if (!Object.keys(f).length) toast(e.message); }
});
$("logoutAll").onclick = async () => { if (confirm("Sign out of every device, including this one?")) { await send("/api/auth/logout-all", "POST"); location.href = "/login.html"; } };
$("delForm").addEventListener("submit", async (ev) => {
  ev.preventDefault(); setErr("delPw", "");
  if (!confirm("This permanently deletes your account and ALL your data. Continue?")) return;
  try { await send("/api/account/delete", "POST", { password: $("delPw").value }); location.href = "/login.html"; }
  catch (e) { setErr("delPw", (e.fields || {}).password || e.message); }
});

/* ---------- misc ---------- */
$("logout").onclick = async () => { await send("/api/auth/logout", "POST"); location.href = "/login.html"; };
$("theme").onclick = () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next); try { localStorage.setItem("theme", next); } catch (e) {}
};
let idleT, warnT, last = 0;
function resetIdle() {
  clearTimeout(idleT); clearTimeout(warnT);
  warnT = setTimeout(() => toast("You will be signed out soon because you are inactive."), 14 * 60000);
  idleT = setTimeout(async () => { try { await send("/api/auth/logout", "POST"); } catch (e) {} location.href = "/login.html?timeout=1"; }, 15 * 60000);
}
["click", "keydown", "touchstart", "mousemove"].forEach((ev) => addEventListener(ev, () => { if (Date.now() - last > 5000) { last = Date.now(); resetIdle(); } }, { passive: true }));

async function refresh() {
  const [list, b] = await Promise.all([api("/api/entries"), api("/api/budgets")]);
  entries = list; budgets = b.budgets; applySort(); renderOverview(); renderEntries(); renderBudgets();
}
/* ---------- v5: charts, goals, import, sorting, 2FA, preferences ---------- */
let goals = [], sortKey = "date", sortDir = -1;
const PALETTE = ["#6366f1", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4"];
function applySort() { entries.sort((a, b) => (sortKey === "amount" ? a.amount - b.amount : a.date.localeCompare(b.date)) * sortDir); }
document.querySelectorAll("th[data-sort]").forEach((th) => (th.onclick = () => {
  const k = th.dataset.sort; if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = -1; }
  applySort(); renderEntries();
}));

function renderNetWorth() {
  const now = new Date(), ms = [];
  for (let i = 11; i >= 0; i--) ms.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const vals = ms.map((d) => { const k = ym(d); let v = 0; entries.forEach((e) => { if (e.date.slice(0, 7) <= k) { if (e.type === "asset") v += e.amount; else if (e.type === "liability") v -= e.amount; } }); return { d, v: r2(v) }; });
  const lo = Math.min(0, ...vals.map((x) => x.v)), hi = Math.max(1, ...vals.map((x) => x.v)), W = 480, H = 210, L = 10, R = 10, T = 14, B = 30;
  const x = (i) => L + (i * (W - L - R)) / 11, y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Net worth over the last 12 months" });
  s.append(svg("line", { x1: 0, x2: W, y1: y(0), y2: y(0) }, "axis-line"));
  const pts = vals.map((p, i) => `${x(i)},${y(p.v)}`);
  s.append(svg("path", { d: `M${pts.join(" L")} L${x(11)},${y(0)} L${x(0)},${y(0)} Z` }, "nw-area"), svg("path", { d: "M" + pts.join(" L") }, "nw-line"));
  vals.forEach((p, i) => {
    const c = svg("circle", { cx: x(i), cy: y(p.v), r: 3.5 }, "nw-dot"), t = svg("title", {});
    t.textContent = `${p.d.toLocaleString("en", { month: "short", year: "numeric" })}: ${money(p.v)}`; c.append(t); s.append(c);
    if (i % 2 === 0) { const lb = svg("text", { x: x(i), y: H - 8, "text-anchor": "middle" }, "axis"); lb.textContent = p.d.toLocaleString("en", { month: "short" }); s.append(lb); }
  });
  $("nwChart").replaceChildren(s);
}
function renderAlloc() {
  const m = {}; entries.forEach((e) => { if (e.type === "asset") m[e.category] = r2((m[e.category] || 0) + e.amount); });
  let list = Object.entries(m).sort((a, b) => b[1] - a[1]);
  if (list.length > 5) { const o = list.slice(5).reduce((a, x) => a + x[1], 0); list = [...list.slice(0, 5), ["Other", r2(o)]]; }
  const total = list.reduce((a, x) => a + x[1], 0), box = $("alloc"); box.replaceChildren();
  if (!total) { box.append(el("div", "Add an asset (savings, gold, funds) to see how your wealth is spread.", "empty")); return; }
  const R = 52, C = 2 * Math.PI * R, s = svg("svg", { viewBox: "0 0 140 140", role: "img", "aria-label": "Asset allocation" }, "donut"); let off = 0;
  list.forEach(([n, v], i) => {
    const len = (v / total) * C, c = svg("circle", { cx: 70, cy: 70, r: R, fill: "none", "stroke-width": 18, stroke: PALETTE[i % 6], "stroke-dasharray": `${len} ${C - len}`, "stroke-dashoffset": -off, transform: "rotate(-90 70 70)" }), t = svg("title", {});
    t.textContent = `${n}: ${money(v)}`; c.append(t); s.append(c); off += len;
  });
  const wrap = el("div", undefined, "alloc"), lg = el("div", undefined, "alloc-legend");
  list.forEach(([n, v], i) => { const r = el("div", undefined, "alloc-row"), sw = el("b", undefined, "sw"); sw.style.background = PALETTE[i % 6]; r.append(sw, el("span", n), el("strong", Math.round((v / total) * 100) + "%")); lg.append(r); });
  wrap.append(s, lg); box.append(wrap);
}

/* goals */
async function loadGoals() { goals = (await api("/api/goals")).goals; renderGoals(); }
function renderGoals() {
  const list = $("goalList"); list.replaceChildren();
  if (!goals.length) { list.append(el("div", "No goals yet. Add one on the right, for example “Emergency fund”.", "empty")); return; }
  goals.forEach((g) => {
    const pct = Math.min(100, (g.saved / g.target) * 100), done = g.saved >= g.target;
    const row = el("div", undefined, "brow"), top = el("div", undefined, "row"), left = el("span"), acts = el("span");
    left.append(el("strong", g.name + (done ? " 🎉" : "")), el("span", `  ${money(g.saved)} of ${money(g.target)} · ${Math.round(pct)}%`, "hint"));
    const add = el("button", "+ Add funds", "btn-ghost"), del = el("button", "✕", "x"); add.type = del.type = "button";
    add.onclick = async () => {
      const v = prompt("How much do you want to add? (numbers only)"); if (v === null) return;
      if (!AMOUNT_RE.test(v.trim())) { toast("Enter a number like 500 or 500.50"); return; }
      const upd = await send("/api/goals/" + g.id, "PUT", { name: g.name, target: String(g.target), saved: String(r2(g.saved + Number(v.trim()))) });
      goals = goals.map((x) => (x.id === g.id ? upd : x)); renderGoals(); toast("Funds added ✓");
    };
    del.onclick = async () => { if (confirm("Delete this goal?")) { await send("/api/goals/" + g.id, "DELETE"); goals = goals.filter((x) => x.id !== g.id); renderGoals(); } };
    acts.append(add, del); top.append(left, acts);
    const t = el("div", undefined, "track"), f = el("div", undefined, "fill" + (done ? " done" : "")); f.style.width = pct + "%"; t.append(f); row.append(top, t); list.append(row);
  });
}
$("gForm").addEventListener("submit", async (ev) => {
  ev.preventDefault(); clearErrs(["gName", "gTarget", "gSaved"]);
  const name = $("gName").value.trim(), target = $("gTarget").value.trim(), saved = $("gSaved").value.trim() || "0"; let bad = false;
  if (!name) { setErr("gName", "Give your goal a name."); bad = true; }
  if (!AMOUNT_RE.test(target) || Number(target) <= 0) { setErr("gTarget", AMOUNT_MSG); bad = true; }
  if (!AMOUNT_RE.test(saved)) { setErr("gSaved", AMOUNT_MSG); bad = true; }
  if (bad) return;
  try { goals.push(await send("/api/goals", "POST", { name, target, saved })); $("gName").value = $("gTarget").value = $("gSaved").value = ""; renderGoals(); toast("Goal created ✓"); }
  catch (e) { const f = e.fields || {}; setErr("gName", f.name); setErr("gTarget", f.target); setErr("gSaved", f.saved); if (!Object.keys(f).length) toast(e.message); }
});

/* CSV import */
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async () => {
  const f = $("importFile").files[0]; $("importFile").value = ""; if (!f) return;
  if (f.size > 2e6) { toast("That file is too large (max 2 MB)"); return; }
  const rows = parseCsv(await f.text());
  if (rows.length && /date/i.test(rows[0][0])) rows.shift();
  const data = rows.map((r) => ({ date: (r[0] || "").trim(), type: (r[1] || "").trim().toLowerCase(), category: r[2] || "", description: r[3] || "", amount: (r[4] || "").trim() }));
  if (!data.length) { toast("No rows found in that file"); return; }
  if (!confirm(`Import ${data.length} rows from ${f.name}?\nColumns must be: date, type, category, description, amount.`)) return;
  let ok = 0, skipped = 0; const errs = [];
  try {
    for (let i = 0; i < data.length; i += 500) {
      const r = await send("/api/entries/import", "POST", { rows: data.slice(i, i + 500) });
      ok += r.imported; skipped += r.skipped; errs.push(...r.errors.map((e) => ({ ...e, row: e.row + i })));
    }
  } catch (e) { toast(e.message); }
  await refresh(); toast(`Imported ${ok} rows` + (skipped ? `, skipped ${skipped}` : ""));
  if (errs.length) alert("Some rows were skipped:\n" + errs.slice(0, 10).map((e) => `Row ${e.row}: ${e.message}`).join("\n"));
};

/* two-factor */
async function loadTfa() {
  const s = await api("/api/2fa/status"), box = $("tfaBox");
  if (!s.enabled) {
    $("tfaHint").textContent = "Add a second step at login with an authenticator app (Google Authenticator, Authy, 1Password…).";
    box.innerHTML = '<button class="btn" id="tfaOn" type="button">Turn on two-factor</button>';
    $("tfaOn").onclick = startTfa;
  } else {
    $("tfaHint").textContent = `Two-factor is ON. Recovery codes left: ${s.recoveryLeft}.`;
    box.innerHTML = '<form class="stack" id="tfaOffForm" novalidate><div class="field"><label for="offPw">Password</label><input id="offPw" type="password" autocomplete="current-password"><div class="err" id="err-offPw"></div></div><div class="field"><label for="offCode">Current code or a recovery code</label><input id="offCode" autocomplete="one-time-code"><div class="err" id="err-offCode"></div></div><button class="btn danger" type="submit">Turn off two-factor</button></form>';
    $("tfaOffForm").onsubmit = async (ev) => {
      ev.preventDefault(); clearErrs(["offPw", "offCode"]);
      try { await send("/api/2fa/disable", "POST", { password: $("offPw").value, code: $("offCode").value }); toast("Two-factor turned off"); loadTfa(); loadSecurity(); }
      catch (e) { const f = e.fields || {}; setErr("offPw", f.password); setErr("offCode", f.code); if (!Object.keys(f).length) toast(e.message); }
    };
  }
}
async function startTfa() {
  const r = await send("/api/2fa/setup", "POST");
  $("qrImg").src = r.qr; $("secretTxt").textContent = r.secret.match(/.{1,4}/g).join(" ");
  $("tfaStep1").classList.remove("hidden"); $("tfaStep2").classList.add("hidden"); $("tfaCode").value = ""; setErr("tfaCode", ""); $("dlg2fa").showModal();
}
$("tfaVerify").onclick = async () => {
  setErr("tfaCode", "");
  try {
    const r = await send("/api/2fa/enable", "POST", { code: $("tfaCode").value.trim() });
    $("codesBox").replaceChildren(...r.recoveryCodes.map((c) => el("span", c))); $("tfaStep1").classList.add("hidden"); $("tfaStep2").classList.remove("hidden");
  } catch (e) { setErr("tfaCode", (e.fields || {}).code || e.message); }
};
$("copyCodes").onclick = async () => { try { await navigator.clipboard.writeText([...$("codesBox").children].map((s) => s.textContent).join("\n")); toast("Codes copied"); } catch { toast("Copy failed. Select and copy them by hand."); } };
$("tfaDone").onclick = () => { $("dlg2fa").close(); $("codesBox").replaceChildren(); loadTfa(); loadSecurity(); };
$("tfaClose").onclick = () => { $("dlg2fa").close(); loadTfa(); };

/* preferences + shortcut */
$("curSel").value = currency;
$("curSel").onchange = () => { currency = $("curSel").value; try { localStorage.setItem("currency", currency); } catch (e) {} renderOverview(); renderEntries(); renderBudgets(); renderGoals(); toast("Currency updated"); };
addEventListener("keydown", (e) => {
  if (e.key === "n" && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && !document.querySelector("dialog[open]")) { e.preventDefault(); openDialog(); }
});

api("/api/me").then((m) => { $("who").textContent = "👤 " + m.username; resetIdle(); refresh(); loadGoals(); });
