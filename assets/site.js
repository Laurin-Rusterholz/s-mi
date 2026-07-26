/* ==========================================================================
   Sam Sparking — Website-Interaktion
   Vanilla JS, keine Abhängigkeiten.
   ========================================================================== */
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------ mobile nav */
  var burger = document.getElementById("burger");
  var nav = document.getElementById("nav");
  if (burger && nav) {
    var setNav = function (open) {
      nav.classList.toggle("open", open);
      burger.textContent = open ? "Close" : "Menu";
      burger.setAttribute("aria-expanded", open ? "true" : "false");
      document.body.style.overflow = open ? "hidden" : "";
    };
    burger.addEventListener("click", function () {
      setNav(!nav.classList.contains("open"));
    });
    nav.addEventListener("click", function (e) {
      if (e.target.closest("a")) setNav(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) setNav(false);
    });
  }

  /* --------------------------------------------------------------- reveal */
  var rv = document.querySelectorAll(".rv");
  if ("IntersectionObserver" in window && !reduce) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add("on");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    rv.forEach(function (el) {
      io.observe(el);
    });
  } else {
    rv.forEach(function (el) {
      el.classList.add("on");
    });
  }

  /* -------------------------------------------- scroll progress + active nav */
  var progress = document.getElementById("progress");
  var links = nav ? Array.prototype.slice.call(nav.querySelectorAll('a[href^="#"]')) : [];
  var targets = links
    .map(function (a) {
      return { link: a, el: document.getElementById(a.getAttribute("href").slice(1)) };
    })
    .filter(function (t) {
      return t.el;
    });

  var ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () {
      ticking = false;
      if (progress) {
        var h = document.documentElement.scrollHeight - window.innerHeight;
        progress.style.width = (h > 0 ? (window.scrollY / h) * 100 : 0) + "%";
      }
      var y = window.scrollY + window.innerHeight * 0.32;
      var current = null;
      targets.forEach(function (t) {
        if (t.el.offsetTop <= y) current = t;
      });
      targets.forEach(function (t) {
        if (t === current) t.link.setAttribute("aria-current", "true");
        else t.link.removeAttribute("aria-current");
      });
    });
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* -------------------------------------------------------------- lightbox */
  var lb = document.getElementById("lb");
  if (lb) {
    var lbImg = document.getElementById("lb-img");
    var lbCap = document.getElementById("lb-cap");
    var btns = Array.prototype.slice.call(document.querySelectorAll(".gal-btn"));
    var shots = btns.map(function (b) {
      var img = b.querySelector("img");
      var cap = b.querySelector("figcaption");
      return { src: img ? img.currentSrc || img.src : "", alt: img ? img.alt : "", cap: cap ? cap.textContent : "" };
    });
    var idx = 0;
    var opener = null;

    function show(i) {
      if (!shots.length) return;
      idx = (i + shots.length) % shots.length;
      var s = shots[idx];
      lbImg.src = s.src;
      lbImg.alt = s.alt;
      lbCap.textContent = s.cap + (shots.length > 1 ? "  ·  " + (idx + 1) + " / " + shots.length : "");
    }
    function open(i, from) {
      opener = from || null;
      lb.hidden = false;
      lb.classList.add("open");
      document.body.style.overflow = "hidden";
      show(i);
      var close = document.getElementById("lb-close");
      if (close) close.focus();
    }
    function close() {
      lb.classList.remove("open");
      lb.hidden = true;
      document.body.style.overflow = "";
      lbImg.src = "";
      if (opener) opener.focus();
    }

    btns.forEach(function (b, i) {
      b.addEventListener("click", function () {
        open(i, b);
      });
    });
    var prev = document.getElementById("lb-prev");
    var next = document.getElementById("lb-next");
    if (prev) prev.addEventListener("click", function () { show(idx - 1); });
    if (next) next.addEventListener("click", function () { show(idx + 1); });
    var closeBtn = document.getElementById("lb-close");
    if (closeBtn) closeBtn.addEventListener("click", close);
    lb.addEventListener("click", function (e) {
      if (e.target === lb || e.target.classList.contains("lb-fig")) close();
    });
    document.addEventListener("keydown", function (e) {
      if (lb.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") show(idx - 1);
      else if (e.key === "ArrowRight") show(idx + 1);
      else if (e.key === "Tab") {
        // Fokus im Dialog halten
        var f = lb.querySelectorAll("button");
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
      }
    });
    // Wischen auf Touch
    var x0 = null;
    lb.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener("touchend", function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 45) show(idx + (dx < 0 ? 1 : -1));
      x0 = null;
    }, { passive: true });
  }

  /* ------------------------------------------------- Shows: abgelaufene weg */
  // Die Seite ist statisch generiert. Falls seit dem letzten Build Termine
  // verstrichen sind, werden sie hier clientseitig ausgeblendet.
  var showList = document.getElementById("show-list");
  if (showList) {
    var todayStr = new Date().toISOString().slice(0, 10);
    var visible = 0;
    Array.prototype.slice.call(showList.children).forEach(function (li) {
      var d = li.getAttribute("data-date");
      if (d && d < todayStr) li.hidden = true;
      else visible++;
    });
    if (!visible) showList.hidden = true;
  }

  /* --------------------------------------------------------- booking form */
  var form = document.getElementById("booking-form");
  if (form) {
    var endpoint = form.getAttribute("data-endpoint");
    var msg = form.querySelector(".bform-msg");
    var opened = Date.now();

    var setMsg = function (text, cls) {
      if (!msg) return;
      msg.textContent = text;
      msg.className = "bform-msg" + (cls ? " " + cls : "");
    };

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (form.classList.contains("busy")) return;

      var data = {};
      ["name", "email", "event", "city", "date", "setLength", "message"].forEach(function (k) {
        var f = form.elements[k];
        data[k] = f ? String(f.value || "").trim() : "";
      });

      // Pflichtfelder
      var bad = null;
      [["name", 2], ["email", 5]].forEach(function (p) {
        var f = form.elements[p[0]];
        var ok = data[p[0]].length >= p[1] && (p[0] !== "email" || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email));
        f.setAttribute("aria-invalid", ok ? "false" : "true");
        if (!ok && !bad) bad = f;
      });
      if (bad) {
        setMsg("Please check the highlighted fields.", "err");
        bad.focus();
        return;
      }

      // Spam-Schutz: Honeypot + minimale Ausfüllzeit
      var hp = form.elements.website;
      if ((hp && hp.value) || Date.now() - opened < 2500) {
        form.classList.add("sent");
        setMsg(msg ? msg.getAttribute("data-success") : "Thanks!", "ok");
        return;
      }

      data.createdAt = new Date().toISOString();
      data.status = "new";
      data.source = location.hostname || "website";

      form.classList.add("busy");
      setMsg("Sending …", "");

      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          form.classList.remove("busy");
          form.classList.add("sent");
          setMsg(msg.getAttribute("data-success"), "ok");
        })
        .catch(function () {
          form.classList.remove("busy");
          setMsg(msg.getAttribute("data-error"), "err");
        });
    });
  }

  /* ------------------------------------------------------------------ jahr */
  var yr = document.getElementById("yr");
  if (yr) yr.textContent = new Date().getFullYear();
})();
