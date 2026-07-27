/* ==========================================================================
   Sam Sparkling — Website-Interaktion
   Vanilla JS, keine Abhängigkeiten.
   ========================================================================== */
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------ mobile nav */
  var burger = document.getElementById("burger");
  var nav = document.getElementById("nav");
  if (burger && nav) {
    var openLabel = burger.getAttribute("data-open") || "Menü";
    var closeLabel = burger.getAttribute("data-close") || "Schliessen";
    var setNav = function (open) {
      nav.classList.toggle("open", open);
      burger.textContent = open ? closeLabel : openLabel;
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
        // Elemente, die gemeinsam ins Bild kommen, leicht versetzt einblenden —
        // das wirkt ruhiger als ein gleichzeitiges Aufpoppen.
        var shown = 0;
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var delay = Math.min(shown++, 4) * 70;
          if (delay) e.target.style.transitionDelay = delay + "ms";
          e.target.classList.add("on");
          io.unobserve(e.target);
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -8% 0px" }
    );
    rv.forEach(function (el) {
      io.observe(el);
    });
  } else {
    rv.forEach(function (el) {
      el.classList.add("on");
    });
  }

  /* ------------------------------------------------- seitenwechsel vorladen */
  // Interne Seiten beim Überfahren des Links vorladen: der Wechsel fühlt sich
  // danach an, als wäre die Seite schon da.
  var prefetched = {};
  function prefetch(url) {
    if (!url || prefetched[url]) return;
    prefetched[url] = true;
    var l = document.createElement("link");
    l.rel = "prefetch";
    l.href = url;
    document.head.appendChild(l);
  }
  if (!(navigator.connection && navigator.connection.saveData)) {
    document.addEventListener(
      "pointerover",
      function (e) {
        var a = e.target.closest && e.target.closest('a[href^="/"]');
        if (a && a.origin === location.origin && a.pathname !== location.pathname) {
          prefetch(a.href);
        }
      },
      { passive: true }
    );
  }

  /* -------------------------------------------- scroll progress + active nav */
  var progress = document.getElementById("progress");
  var subnav = document.querySelector(".subnav");
  var links = Array.prototype.slice.call(
    document.querySelectorAll('.subnav a[href^="#"]')
  );
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
      requestAnimationFrame(function () {
        lb.classList.add("shown");
      });
      document.body.style.overflow = "hidden";
      show(i);
      var close = document.getElementById("lb-close");
      if (close) close.focus();
    }
    function close() {
      lb.classList.remove("shown");
      document.body.style.overflow = "";
      var finish = function () {
        lb.classList.remove("open");
        lb.hidden = true;
        lbImg.src = "";
      };
      if (reduce) finish();
      else setTimeout(finish, 200);
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

  /* ----------------------------------------------------------- hero-video */
  // Wer "Bewegung reduzieren" eingestellt hat, sieht das Poster statt des
  // laufenden Videos. Läuft das Autoplay ins Leere (manche Browser blocken es
  // trotz muted), bleibt ebenfalls das Poster stehen.
  var heroVideo = document.querySelector(".hero-video");
  if (heroVideo) {
    if (reduce) {
      heroVideo.removeAttribute("autoplay");
      heroVideo.pause();
    } else {
      var tryPlay = heroVideo.play();
      if (tryPlay && typeof tryPlay.catch === "function") tryPlay.catch(function () {});
      // Im Hintergrund-Tab nicht weiterlaufen lassen
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) heroVideo.pause();
        else heroVideo.play().catch(function () {});
      });
    }
  }

  // Galerie-Videos nur abspielen, solange sie sichtbar sind
  var galVideos = Array.prototype.slice.call(document.querySelectorAll(".gal-video video"));
  if (galVideos.length) {
    if (reduce) {
      galVideos.forEach(function (v) {
        v.removeAttribute("autoplay");
        v.pause();
        v.setAttribute("controls", "");
      });
    } else if ("IntersectionObserver" in window) {
      var vio = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) e.target.play().catch(function () {});
            else e.target.pause();
          });
        },
        { threshold: 0.25 }
      );
      galVideos.forEach(function (v) {
        vio.observe(v);
      });
    }
  }

  /* ------------------------------------------------------------- kalender */
  // Monatsraster über die Termine. Die Liste darunter bleibt die Quelle für
  // Suchmaschinen; der Kalender ist die bequemere Ansicht daneben.
  var calBox = document.getElementById("shows-calendar");
  var showsRaw = document.getElementById("shows-data");
  if (calBox && showsRaw) {
    var shows = [];
    try {
      shows = JSON.parse(showsRaw.textContent) || [];
    } catch (e) {
      shows = [];
    }

    {
      var lang = document.documentElement.lang || "de";
      var weekdays = (calBox.getAttribute("data-weekdays") || "Mo,Di,Mi,Do,Fr,Sa,So").split(",");
      var bookedLabel = calBox.getAttribute("data-booked") || "Gebucht";
      // Freie Tage buchbar machen, wenn es auf der Seite ein Formular gibt
      var bookLabel = calBox.getAttribute("data-book") || "";
      var bookingForm = document.querySelector('.bform input[name="date"]');
      var grid = document.getElementById("cal-grid");
      var monthLabel = document.getElementById("cal-month");
      var byDate = {};
      shows.forEach(function (s) {
        (byDate[s.date] = byDate[s.date] || []).push(s);
      });

      var todayStr = new Date().toISOString().slice(0, 10);
      var next = shows
        .filter(function (s) { return s.date >= todayStr; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; })[0];
      var start = new Date((next ? next.date : todayStr) + "T12:00:00Z");
      var year = start.getUTCFullYear();
      var month = start.getUTCMonth();

      var pad = function (n) { return String(n).padStart(2, "0"); };

      function draw() {
        var first = new Date(Date.UTC(year, month, 1));
        var days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
        var lead = (first.getUTCDay() + 6) % 7; // Woche beginnt am Montag

        monthLabel.textContent = first.toLocaleDateString(lang, {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        });

        var html = weekdays
          .map(function (d) { return '<span class="cal-wd" role="columnheader">' + d + "</span>"; })
          .join("");
        for (var i = 0; i < lead; i++) html += '<span class="cal-day empty"></span>';

        for (var day = 1; day <= days; day++) {
          var iso = year + "-" + pad(month + 1) + "-" + pad(day);
          var list = byDate[iso];
          var classes = "cal-day";
          if (iso === todayStr) classes += " today";
          if (iso < todayStr) classes += " past";
          if (list) {
            classes += " has-show";
            if (list.some(function (x) { return x.status === "booked"; })) classes += " booked";
            if (list.every(function (x) { return x.status === "soldout"; })) classes += " soldout";
          }
          if (list) {
            var s = list[0];
            var label = [s.name, s.city].filter(Boolean).join(", ");
            if (s.status === "booked") label += " · " + bookedLabel;
            var inner =
              '<b>' + day + "</b><span class=\"cal-dot\"></span>" +
              '<span class="cal-tip">' + escapeHtml(label) +
              (list.length > 1 ? " +" + (list.length - 1) : "") + "</span>";
            html += s.url
              ? '<a class="' + classes + '" href="' + escapeHtml(s.url) +
                '" target="_blank" rel="noopener" title="' + escapeHtml(label) + '">' + inner + "</a>"
              : '<span class="' + classes + '" role="gridcell" title="' + escapeHtml(label) + '">' + inner + "</span>";
          } else if (iso >= todayStr && bookLabel && bookingForm) {
            html +=
              '<a class="' + classes + ' bookable" href="#booking" data-date="' + iso +
              '" title="' + escapeHtml(bookLabel) + '" role="gridcell"><b>' + day + "</b></a>";
          } else {
            html += '<span class="' + classes + '" role="gridcell"><b>' + day + "</b></span>";
          }
        }
        grid.innerHTML = html;
      }

      function escapeHtml(v) {
        return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
          return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
      }

      calBox.addEventListener("click", function (e) {
        // Klick auf einen freien Tag: Datum ins Booking-Formular uebernehmen
        var dayLink = e.target.closest("a.bookable");
        if (dayLink && bookingForm) {
          bookingForm.value = dayLink.getAttribute("data-date") || "";
          bookingForm.dispatchEvent(new Event("change", { bubbles: true }));
          var nameField = document.querySelector('.bform input[name="name"]');
          setTimeout(function () { nameField && nameField.focus({ preventScroll: true }); }, 450);
          return; // der Anker scrollt selbst zu #booking
        }
        var btn = e.target.closest("[data-cal]");
        if (!btn) return;
        month += btn.getAttribute("data-cal") === "next" ? 1 : -1;
        if (month > 11) { month = 0; year++; }
        if (month < 0) { month = 11; year--; }
        draw();
      });

      draw();
      calBox.hidden = false;
    }
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
    var sendingText = form.getAttribute("data-sending") || "…";
    var invalidText = form.getAttribute("data-invalid") || "";
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
        setMsg(invalidText, "err");
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
      setMsg(sendingText, "");

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
