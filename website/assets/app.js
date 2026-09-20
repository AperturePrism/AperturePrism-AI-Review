/* AperturePrism product website interactions */
(function () {
  "use strict";

  /* ---------- scrolled nav state ---------- */
  var nav = document.getElementById("nav");
  function onScroll() {
    if (nav) nav.classList.toggle("is-scrolled", window.scrollY > 24);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- mobile drawer ---------- */
  var toggle = document.getElementById("navToggle");
  var drawer = document.getElementById("drawer");

  function closeDrawer() {
    if (!drawer || !toggle) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    toggle.classList.remove("open");
    toggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("no-scroll");
  }
  function openDrawer() {
    if (!drawer || !toggle) return;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    toggle.classList.add("open");
    toggle.setAttribute("aria-expanded", "true");
    document.body.classList.add("no-scroll");
  }
  if (toggle && drawer) {
    toggle.addEventListener("click", function () {
      drawer.classList.contains("open") ? closeDrawer() : openDrawer();
    });
    // close when a link inside drawer is tapped
    drawer.querySelectorAll("a").forEach(function (a) {
      a.addEventListener("click", closeDrawer);
    });
    // close on Escape
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeDrawer();
    });
  }

  /* ---------- reveal on scroll (IntersectionObserver) ---------- */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) {
            en.target.classList.add("visible");
            io.unobserve(en.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("visible"); });
  }

  /* ---------- copy on click for command blocks ---------- */
  document.querySelectorAll(".code").forEach(function (block) {
    var text =
      block.getAttribute("data-cmd") ||
      block.textContent.replace(/^\s*\$\s?/, "").trim();
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code__copy";
    btn.textContent = "复制";
    btn.setAttribute("aria-label", "复制命令");
    btn.addEventListener("click", function () {
      var done = function () {
        btn.textContent = "已复制 ✓";
        setTimeout(function () { btn.textContent = "复制"; }, 1600);
      };
      var fail = function () { btn.textContent = "复制失败"; };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {
          fallback(text, done, fail);
        });
      } else {
        fallback(text, done, fail);
      }
    });
    block.classList.add("has-copy");
    block.appendChild(btn);
  });

  function fallback(text, done, fail) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { fail(); }
    document.body.removeChild(ta);
  }

  /* ---------- footer year ---------- */
  var year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();

  /* ---------- GitHub star count ---------- */
  var star = document.getElementById("starCount");
  if (star) {
    fetch("https://api.github.com/repos/BB0813/AperturePrism-AI-Review")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.stargazers_count != null) star.textContent = d.stargazers_count.toLocaleString(); })
      .catch(function () { star.textContent = "GitHub"; });
  }
})();