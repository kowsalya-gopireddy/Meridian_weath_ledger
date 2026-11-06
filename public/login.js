const $ = (id) => document.getElementById(id);
let mode = "login";
function setMode(m) {
  mode = m;
  $("tabLogin").classList.toggle("on", m === "login");
  $("tabRegister").classList.toggle("on", m === "register");
  $("submit").textContent = m === "login" ? "Log in" : "Create my account";
  $("title").textContent = m === "login" ? "Welcome back" : "Create your account";
  $("sub").textContent = m === "login" ? "Log in to see your finances." : "It takes ten seconds.";
  $("password").autocomplete = m === "login" ? "current-password" : "new-password";
  $("meter").classList.toggle("hidden", m === "login"); $("meterTxt").classList.toggle("hidden", m === "login");
  clearErrors();
}
function clearErrors() {
  $("banner").classList.add("hidden");
  ["username", "password"].forEach((f) => { $("err-" + f).textContent = ""; $(f).classList.remove("invalid"); });
}
function showBanner(t) { $("banner").textContent = t; $("banner").classList.remove("hidden"); }
$("tabLogin").onclick = () => setMode("login");
$("tabRegister").onclick = () => setMode("register");
if (location.search.includes("timeout=1")) showBanner("You were signed out because you were inactive.");

$("password").addEventListener("input", () => {
  const p = $("password").value;
  const score = (p.length >= 8) + (p.length >= 12) + (/[a-z]/.test(p) && /[A-Z]/.test(p)) + /\d/.test(p) + /[^A-Za-z0-9]/.test(p);
  const lv = [["Too weak", "#ef4444"], ["Too weak", "#ef4444"], ["Weak", "#f59e0b"], ["Okay", "#f59e0b"], ["Strong", "#10b981"], ["Very strong", "#10b981"]][score];
  $("meterFill").style.width = (score / 5) * 100 + "%"; $("meterFill").style.background = lv[1];
  $("meterTxt").textContent = p ? "Strength: " + lv[0] : "";
});

$("authForm").addEventListener("submit", async (ev) => {
  ev.preventDefault(); clearErrors(); $("submit").disabled = true;
  try {
    const res = await fetch("/api/auth/" + mode, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("username").value, password: $("password").value, code: $("code").value }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.requires2fa) { $("codeField").classList.remove("hidden"); $("code").focus(); $("err-code").textContent = data.error || ""; $("submit").disabled = false; return; }
    if (res.ok) { location.href = "/"; return; }
    const fields = data.fields || {};
    for (const [f, msg] of Object.entries(fields)) if ($("err-" + f)) { $("err-" + f).textContent = msg; $(f).classList.add("invalid"); }
    if (!Object.keys(fields).length) showBanner(data.error || "Something went wrong.");
  } catch { showBanner("Cannot reach the server."); }
  $("submit").disabled = false;
});
