(function () {
  var t = null;
  try { t = localStorage.getItem("theme"); } catch (e) {}
  if (!t && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) t = "dark";
  if (t) document.documentElement.setAttribute("data-theme", t);
})();
