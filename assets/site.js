/* ==========================================================================
   Sam Sparkling — Website-Interaktion
   Vanilla JS, keine Abhängigkeiten.
   ========================================================================== */
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.documentElement.classList.add("js");

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
      // Anker-Ziel gewaehlt: Sprung selbst ausfuehren, NACHDEM das Menue zu
      // ist — iOS Safari verwirft den nativen Sprung sonst, weil der Body im
      // Moment des Tippens noch scroll-gesperrt ist (overflow:hidden).
      var a = e.target.closest('a[href^="#"]');
      if (a && document.getElementById(a.getAttribute("href").slice(1))) {
        // Erst Menue schliessen (loest die Scroll-Sperre), dann springen
        e.preventDefault();
        e.stopPropagation();
        var zielId = a.getAttribute("href").slice(1);
        setNav(false);
        requestAnimationFrame(function () { jumpTo(zielId); });
        return;
      }
      // Sprachlink, X oder Tipp daneben: Menue zu, Standardverhalten laeuft
      if (e.target.closest("a") || e.target.closest(".nav-close") || e.target === nav) setNav(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) setNav(false);
    });
  }

  /* ------------------------------------------------------- anker-spruenge */
  // Ein Weg fuer alle Sprungziele (Menue, Hero-Knoepfe, Daumenleiste, Fuss).
  // Der native Sprung verhaelt sich je nach Browser unterschiedlich — vor
  // allem auf iOS, wo er bei gesperrtem Body oder waehrend einer Animation
  // stillschweigend verworfen wird. Deshalb scrollen wir selbst, mit
  // Abstand fuer die feste Kopfleiste.
  function jumpTo(id) {
    var ziel = document.getElementById(id);
    if (!ziel) return false;
    var head = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--head"), 10) || 60;
    var y = ziel.getBoundingClientRect().top + window.pageYOffset - head - 12;
    try {
      window.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
    } catch (e) {
      window.scrollTo(0, y);
    }
    // Nachfassen: waehrend des Scrollens geladene Bilder verschieben das Ziel
    setTimeout(function () {
      var y2 = ziel.getBoundingClientRect().top + window.pageYOffset - head - 12;
      if (Math.abs(y2 - window.pageYOffset) > 24) window.scrollTo({ top: y2, behavior: "auto" });
    }, 700);
    if (history.replaceState) history.replaceState(null, "", "#" + id);
    return true;
  }

  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || a.classList.contains("skip")) return;
    var id = a.getAttribute("href").slice(1);
    if (!id) return;
    if (jumpTo(id)) e.preventDefault();
  });

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

  /* Galerie-Bilder erst zeigen, wenn sie geladen sind — kein hartes Aufpoppen */
  Array.prototype.forEach.call(document.querySelectorAll(".gal img"), function (img) {
    if (img.complete && img.naturalWidth) img.classList.add("ld");
    else {
      img.addEventListener("load", function () { img.classList.add("ld"); });
      img.addEventListener("error", function () { img.classList.add("ld"); });
    }
  });

  /* ----------------------------------------- mobile Inhaltsverdichtung */
  // Die lange Künstlergeschichte bleibt auf grossen Bildschirmen vollständig
  // sichtbar. Auf dem Handy startet sie bewusst kurz und lässt sich bei
  // Interesse öffnen — so bleibt der Weg von Sound zu Booking klar.
  var aboutToggle = document.querySelector(".about-toggle");
  var aboutMore = document.getElementById("about-more");
  if (aboutToggle && aboutMore) {
    aboutToggle.addEventListener("click", function () {
      var open = !aboutMore.classList.contains("expanded");
      aboutMore.classList.toggle("expanded", open);
      aboutToggle.setAttribute("aria-expanded", open ? "true" : "false");
      aboutToggle.textContent = aboutToggle.getAttribute(open ? "data-less" : "data-more") || "";
    });
  }

  // Mobil zunächst nur die kuratierte Auswahl zeigen. Weitere Bilder bleiben
  // im Dokument und in der Lightbox vorhanden, verlängern die Seite aber erst
  // nach einer bewussten Entscheidung.
  var galleryToggle = document.querySelector(".gal-more");
  var gallery = document.getElementById("gal");
  if (galleryToggle && gallery) {
    galleryToggle.addEventListener("click", function () {
      var open = !gallery.classList.contains("expanded");
      gallery.classList.toggle("expanded", open);
      galleryToggle.setAttribute("aria-expanded", open ? "true" : "false");
      galleryToggle.textContent =
        galleryToggle.getAttribute(open ? "data-less" : "data-more") || "";
    });
  }

  /* -------------------------------------------- scroll progress + active nav */
  var progress = document.getElementById("progress");
  var toTop = document.querySelector(".totop");
  // Daumen-Leiste: erscheint nach dem ersten Bildschirm, verschwindet, sobald
  // Booking/Kontakt selbst im Bild sind (sonst verdeckt sie das Formular)
  var actbar = document.getElementById("actbar");
  var fullHero = document.querySelector(".hero:not(.hero-compact)");
  var pageHeader = document.querySelector("header");
  var nearAction = false;
  var updateActbar = function () {
    if (!actbar) return;
    var pastHero = fullHero
      ? fullHero.getBoundingClientRect().bottom <= (pageHeader ? pageHeader.offsetHeight : 0)
      : window.scrollY > window.innerHeight;
    var show = pastHero && !nearAction;
    actbar.classList.toggle("show", show);
    actbar.setAttribute("aria-hidden", show ? "false" : "true");
  };
  if (actbar && "IntersectionObserver" in window) {
    var actTargets = ["booking", "contact"].map(function (id) { return document.getElementById(id); }).filter(Boolean);
    var actSeen = {};
    var aio = new IntersectionObserver(function (es) {
      es.forEach(function (e) { actSeen[e.target.id] = e.isIntersecting; });
      nearAction = Object.keys(actSeen).some(function (k) { return actSeen[k]; });
      updateActbar();
    }, { rootMargin: "0px 0px -20% 0px" });
    actTargets.forEach(function (t) { aio.observe(t); });
  }
  updateActbar();
  var subnav = document.querySelector(".subnav");
  var links = Array.prototype.slice.call(
    document.querySelectorAll('.subnav a[href^="#"], header nav a[href^="#"]')
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
      if (toTop) toTop.classList.toggle("show", window.scrollY > 700);
      updateActbar();
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
  if (heroVideo) try {
    // Kann das Geraet das Format gar nicht abspielen (z. B. iPhone-.mov in
    // HEVC auf Android), Video ausblenden — das Poster/Hintergrundbild bleibt.
    var heroFallback = function () {
      var poster = heroVideo.getAttribute("poster");
      if (poster) {
        var still = document.createElement("img");
        still.src = poster;
        still.alt = "";
        still.className = "hero-video";
        heroVideo.replaceWith(still);
      } else {
        heroVideo.remove();
      }
    };
    // Bewusste Entscheidung des Betreibers: das Hero-Video ist Kerninhalt
    // und laeuft auch bei "Bewegung reduzieren" — es ist stumm und dezent;
    // Funken und Filmkorn bleiben unter dieser Einstellung weiterhin aus.
    {
      heroVideo.muted = true;
      heroVideo.defaultMuted = true;
      heroVideo.setAttribute("webkit-playsinline", "");
      var heroTries = 0;
      var kick = function () {
        var pr = heroVideo.play();
        if (pr && typeof pr.catch === "function") pr.catch(function () {});
      };
      kick();
      // Manche Geraete blocken Autoplay (Stromsparmodus, Daten-Sparen):
      // nach dem Laden nochmals anstossen und spaetestens bei der ersten
      // Beruehrung — die gilt als Nutzer-Geste und darf abspielen.
      heroVideo.addEventListener("loadeddata", kick);
      heroVideo.addEventListener("canplay", kick);
      var gesture = function () {
        if (heroVideo.paused && heroTries++ < 3) kick();
        if (heroTries >= 3 || !heroVideo.paused) {
          window.removeEventListener("touchstart", gesture);
          window.removeEventListener("click", gesture);
        }
      };
      window.addEventListener("touchstart", gesture, { passive: true });
      window.addEventListener("click", gesture);
      // Fehler heisst nicht gleich "kaputt": ein kurzer Netz-Abbruch feuert
      // dasselbe Ereignis. Erst neu laden; nur wenn danach wirklich keine
      // abspielbare Quelle uebrig ist (networkState NO_SOURCE oder Decode-/
      // Formatfehler), kommt das Standbild.
      var heroFails = 0;
      heroVideo.addEventListener("error", function () {
        heroFails++;
        if (heroFails === 1) {
          setTimeout(function () {
            try { heroVideo.load(); kick(); } catch (e) {}
          }, 1200);
          return;
        }
        var me = heroVideo.error;
        if (heroVideo.networkState === 3 || (me && (me.code === 3 || me.code === 4))) heroFallback();
      }, true);
      // Im Hintergrund-Tab nicht weiterlaufen lassen
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) heroVideo.pause();
        else kick();
      });
      // Nahtlose Wiederholung: manche Browser lassen die Schleife am Dateiende
      // kurz stocken oder bleiben stehen. Kurz vor Schluss selbst zurueck an
      // den Anfang setzen und weiterlaufen lassen.
      heroVideo.addEventListener("timeupdate", function () {
        var d = heroVideo.duration;
        if (d && isFinite(d) && d - heroVideo.currentTime < 0.25) {
          heroVideo.currentTime = 0;
          kick();
        }
      });
      heroVideo.addEventListener("ended", function () {
        heroVideo.currentTime = 0;
        kick();
      });

      // Beharrlich bleiben: in den ersten Sekunden mehrfach anstossen und
      // nachziehen, sobald das Hero sichtbar ist
      [400, 1200, 3000, 6000].forEach(function (ms) {
        setTimeout(function () { if (heroVideo.paused) kick(); }, ms);
      });
      if ("IntersectionObserver" in window) {
        // Sichtbar: abspielen. Aus dem Bild gescrollt: anhalten (Akku, Daten).
        new IntersectionObserver(function (es) {
          es.forEach(function (e) {
            if (e.isIntersecting) { if (heroVideo.paused) kick(); }
            else if (!heroVideo.paused) heroVideo.pause();
          });
        }).observe(heroVideo);
      }
    }
  } catch (e) { /* Video darf nie den Rest der Seite mitreissen */ }

  // Galerie-Videos nur abspielen, solange sie sichtbar sind
  var galVideos = Array.prototype.slice.call(document.querySelectorAll(".gal-video video"));
  galVideos.forEach(function (v) {
    v.addEventListener("ended", function () { v.currentTime = 0; v.play().catch(function () {}); });
  });
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
          var dow = new Date(iso + "T12:00:00Z").getUTCDay();
          var classes = "cal-day" + (dow === 0 || dow === 6 ? " we" : "");
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

  /* ------------------------------------------------------- cookie-hinweis */
  var cookie = document.getElementById("cookie");
  if (cookie) try {
    var seen = false;
    try { seen = localStorage.getItem("cookie-ok") === "1"; } catch (e) {}
    if (!seen) {
      cookie.hidden = false;
      var okBtn = document.getElementById("cookie-ok");
      okBtn && okBtn.addEventListener("click", function () {
        try { localStorage.setItem("cookie-ok", "1"); } catch (e) {}
        cookie.hidden = true;
      });
    }
  } catch (e) { /* Hinweis ist Beiwerk — nie die Seite gefaehrden */ }

  /* -------------------------------------------- Datumswahl im Formular */
  // Kleiner Monatskalender direkt beim Booking-Formular: Tag antippen setzt
  // das Datumsfeld. Tage mit Show sind belegt, Vergangenheit gesperrt.
  var bcal = document.getElementById("bform-cal");
  var bDate = document.querySelector('.bform input[name="date"]');
  if (bcal && bDate) try {
    var bShowsRaw = document.getElementById("shows-data");
    var bShows = [];
    try { bShows = JSON.parse(bShowsRaw ? bShowsRaw.textContent : "[]") || []; } catch (e) { bShows = []; }
    var bBusy = {};
    bShows.forEach(function (s) { bBusy[s.date] = s; });

    var bWeekdays = (bcal.getAttribute("data-weekdays") || "Mo,Di,Mi,Do,Fr,Sa,So").split(",");
    var busyLabel = bcal.getAttribute("data-busy") || "Belegt";
    var bToday = new Date().toISOString().slice(0, 10);
    var bNow = new Date(bToday + "T12:00:00Z");
    var bYear = bNow.getUTCFullYear();
    var bMonth = bNow.getUTCMonth();
    var bPad = function (n) { return String(n).padStart(2, "0"); };
    var bLang = document.documentElement.lang || "de";

    function bDraw() {
      var first = new Date(Date.UTC(bYear, bMonth, 1));
      var days = new Date(Date.UTC(bYear, bMonth + 1, 0)).getUTCDate();
      var lead = (first.getUTCDay() + 6) % 7;
      var sel = bDate.value || "";
      var html =
        '<p class="mono bcal-hint">' + escapeBc(bcal.getAttribute("data-hint") || "") + "</p>" +
        '<div class="bcal-head">' +
        '<button type="button" class="cal-nav" data-bcal="prev" aria-label="\u2039">\u2039</button>' +
        '<strong>' + first.toLocaleDateString(bLang, { month: "long", year: "numeric", timeZone: "UTC" }) + "</strong>" +
        '<button type="button" class="cal-nav" data-bcal="next" aria-label="\u203a">\u203a</button>' +
        "</div>" +
        '<div class="bcal-grid">' +
        bWeekdays.map(function (d) { return '<span class="bcal-wd">' + d + "</span>"; }).join("");
      for (var i = 0; i < lead; i++) html += "<span></span>";
      for (var day = 1; day <= days; day++) {
        var iso = bYear + "-" + bPad(bMonth + 1) + "-" + bPad(day);
        var busy = bBusy[iso];
        var past = iso < bToday;
        var bDow = new Date(iso + "T12:00:00Z").getUTCDay();
        var cls = "bcal-day" + (bDow === 0 || bDow === 6 ? " we" : "") +
          (iso === sel ? " sel" : "") + (busy ? " busy" : "") + (iso === bToday ? " today" : "");
        if (past || busy) {
          html += '<span class="' + cls + '"' + (busy ? ' title="' + escapeBc(busyLabel) + '"' : "") + "><b>" + day + "</b></span>";
        } else {
          html += '<button type="button" class="' + cls + '" data-day="' + iso + '"><b>' + day + "</b></button>";
        }
      }
      html += "</div>";
      bcal.innerHTML = html;
    }

    function escapeBc(v) {
      return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
      });
    }

    bcal.addEventListener("click", function (e) {
      var nav = e.target.closest("[data-bcal]");
      if (nav) {
        bMonth += nav.getAttribute("data-bcal") === "next" ? 1 : -1;
        if (bMonth > 11) { bMonth = 0; bYear++; }
        if (bMonth < 0) { bMonth = 11; bYear--; }
        bDraw();
        return;
      }
      var dayBtn = e.target.closest("[data-day]");
      if (!dayBtn) return;
      bDate.value = dayBtn.getAttribute("data-day");
      bDraw();
    });

    // Wird das Datum anderswo gesetzt (Feld von Hand, Shows-Kalender),
    // springt der Kalender zum Monat und markiert den Tag.
    bDate.addEventListener("change", function () {
      var v = bDate.value;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        bYear = Number(v.slice(0, 4));
        bMonth = Number(v.slice(5, 7)) - 1;
      }
      bDraw();
    });

    bDraw();
    bcal.hidden = false;
  } catch (e) { /* Kalender ist Komfort — das Datumsfeld bleibt benutzbar */ }

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

    // Anti-Spam: kleine Rechenaufgabe. Wird erst hier erzeugt, damit jede
    // Seitenansicht eine andere Aufgabe zeigt und der Build gleich bleibt.
    var capA = form.querySelector(".captcha-sum [data-a]");
    var capB = form.querySelector(".captcha-sum [data-b]");
    var capSum = 0;
    var newCaptcha = function () {
      if (!capA || !capB) return;
      var a = 2 + Math.floor(Math.random() * 9);
      var b = 2 + Math.floor(Math.random() * 9);
      capA.textContent = String(a);
      capB.textContent = String(b);
      capSum = a + b;
    };
    newCaptcha();

    var setMsg = function (text, cls) {
      if (!msg) return;
      msg.textContent = text;
      msg.className = "bform-msg" + (cls ? " " + cls : "");
    };

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (form.classList.contains("busy")) return;

      var data = {};
      ["name", "email", "phone", "event", "city", "date", "setLength", "message"].forEach(
        function (k) {
          var f = form.elements[k];
          data[k] = f ? String(f.value || "").trim() : "";
        }
      );

      // Pflichtfelder — es sind alle sichtbaren Felder. Die Mindestlängen
      // halten "a" oder "-" als Antwort fern; die E-Mail wird zusätzlich auf
      // ihre Form geprüft.
      var bad = null;
      [
        ["name", 2],
        ["email", 5],
        ["phone", 6],
        ["event", 2],
        ["city", 2],
        ["date", 1],
        ["setLength", 1],
        ["message", 2],
      ].forEach(function (p) {
        var f = form.elements[p[0]];
        if (!f) return;
        var ok =
          data[p[0]].length >= p[1] &&
          (p[0] !== "email" || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email));
        f.setAttribute("aria-invalid", ok ? "false" : "true");
        if (!ok && !bad) bad = f;
      });
      if (bad) {
        setMsg(invalidText, "err");
        bad.focus();
        return;
      }

      // Rechenaufgabe. Falsch beantwortet: neue Aufgabe, Feld leeren.
      var cap = form.elements.captcha;
      if (cap && capA) {
        var solved = Number(String(cap.value || "").trim()) === capSum;
        cap.setAttribute("aria-invalid", solved ? "false" : "true");
        if (!solved) {
          setMsg(form.getAttribute("data-captcha") || invalidText, "err");
          newCaptcha();
          cap.value = "";
          cap.focus();
          return;
        }
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
          form.reset();
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

  /* -------------------------------------------------------- mail kopieren */
  var copyBtn = document.querySelector(".copy-mail");
  if (copyBtn) {
    var copyLabel = copyBtn.textContent;
    var fallbackCopy = function (mail, done) {
      var tmp = document.createElement("textarea");
      tmp.value = mail;
      tmp.setAttribute("readonly", "");
      tmp.style.position = "fixed";
      tmp.style.left = "-9999px";
      tmp.style.opacity = "0";
      document.body.appendChild(tmp);
      tmp.select();
      tmp.setSelectionRange(0, tmp.value.length);
      var copied = false;
      try { copied = document.execCommand("copy"); } catch (e) {}
      tmp.remove();
      if (copied) done();
      return copied;
    };
    copyBtn.addEventListener("click", function () {
      var mail = copyBtn.getAttribute("data-mail") || "";
      if (!mail) return;
      var done = function () {
        copyBtn.classList.add("done");
        copyBtn.textContent = copyBtn.getAttribute("data-done") || "OK";
        setTimeout(function () {
          copyBtn.classList.remove("done");
          copyBtn.textContent = copyLabel;
        }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(mail).then(done, function () {
          fallbackCopy(mail, done);
        });
      } else {
        fallbackCopy(mail, done);
      }
    });
  }

  /* ----------------------------------------------------------- wunsch-modus
     Nur aktiv, wenn die Seite in der Verwaltung als Vorschau eingebettet ist
     (iframe + ?wunsch=1). Dann kann dort auf ein Element getippt werden; die
     Stelle wird an die Verwaltung gemeldet, die daraus eine Quantus-Aufgabe
     macht. Fuer normale Besucher laeuft dieser Block nie an.
  */
  try {
    if (window.top !== window.self && /[?&]wunsch=1(&|$)/.test(location.search)) {
      initWunsch();
    }
  } catch (e) {
    /* cross-origin-Zugriff auf window.top blockiert: dann kein Wunsch-Modus */
  }

  function initWunsch() {
    var NS = "samsparking-wunsch";
    var armed = false;
    var marked = null;

    var stil = document.createElement("style");
    stil.textContent =
      ".wunsch-an, .wunsch-an * { cursor: crosshair !important; }" +
      ".wunsch-ziel { outline: 3px solid #ff3d6e !important; outline-offset: 2px !important;" +
      " background: rgba(255,61,110,.10) !important; }" +
      ".wunsch-hinweis { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);" +
      " z-index: 2147483647; background: #ff3d6e; color: #fff; font: 600 13px/1.3 system-ui, sans-serif;" +
      " padding: 9px 14px; border-radius: 0; letter-spacing: .02em; pointer-events: none;" +
      " box-shadow: 0 6px 24px rgba(0,0,0,.35); }";
    document.head.appendChild(stil);

    var hinweis = document.createElement("div");
    hinweis.className = "wunsch-hinweis";
    hinweis.hidden = true;
    hinweis.textContent = "Auf die Stelle tippen, die geändert werden soll";
    document.body.appendChild(hinweis);

    function senden(nachricht) {
      nachricht.ns = NS;
      try {
        // Ziel ist die eigene Verwaltung; die prueft ihrerseits die Herkunft.
        // Uebertragen werden nur oeffentliche Angaben von dieser Seite.
        window.parent.postMessage(nachricht, "*");
      } catch (e) {}
    }

    function markieren(node) {
      if (marked === node) return;
      if (marked) marked.classList.remove("wunsch-ziel");
      marked = node;
      if (marked) marked.classList.add("wunsch-ziel");
    }

    /** Kurzer, verstaendlicher Name fuer das angetippte Element. */
    function bezeichnung(node) {
      if (!node) return "";
      var t = (node.getAttribute("aria-label") || node.getAttribute("alt") || node.title || "").trim();
      if (!t && node.tagName === "IMG") t = "Bild";
      if (!t && (node.tagName === "VIDEO" || node.querySelector && node.querySelector("video"))) t = "Video";
      if (!t) t = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) t = node.tagName.toLowerCase();
      return t.length > 90 ? t.slice(0, 89) + "…" : t;
    }

    /** Abschnitt, in dem das Element sitzt — passt zu den Ansichten der Verwaltung. */
    function abschnitt(node) {
      var sec = node.closest && node.closest("section[id], header, footer");
      if (!sec) return { id: "", titel: "" };
      var id = sec.id || (sec.tagName === "HEADER" ? "header" : sec.tagName === "FOOTER" ? "footer" : "");
      var h = sec.querySelector && sec.querySelector("h1, h2, h3");
      return { id: id, titel: h ? h.textContent.replace(/\s+/g, " ").trim().slice(0, 80) : "" };
    }

    /** Element statt Textknoten, und keine riesigen Container melden. */
    function ziel(node) {
      if (!node || node.nodeType !== 1) return document.body;
      var n = node;
      // Sehr kleine Huellen (span/strong) auf das Elternelement heben, damit
      // die Meldung greifbar bleibt.
      while (n.parentElement && /^(SPAN|STRONG|EM|B|I|SMALL|PICTURE|SOURCE)$/.test(n.tagName)) {
        n = n.parentElement;
      }
      return n;
    }

    function setArmed(an) {
      armed = !!an;
      document.documentElement.classList.toggle("wunsch-an", armed);
      hinweis.hidden = !armed;
      if (!armed) markieren(null);
    }

    document.addEventListener(
      "mouseover",
      function (e) {
        if (!armed) return;
        markieren(ziel(e.target));
      },
      true
    );

    // Im Wunsch-Modus wird jeder Klick abgefangen: die Seite soll nicht
    // navigieren, sondern die Stelle melden.
    ["click", "submit"].forEach(function (typ) {
      document.addEventListener(
        typ,
        function (e) {
          if (!armed) return;
          e.preventDefault();
          e.stopPropagation();
          if (typ !== "click") return;
          var node = ziel(e.target);
          var sec = abschnitt(node);
          markieren(node);
          senden({
            type: "pick",
            section: sec.id,
            sectionTitle: sec.titel,
            label: bezeichnung(node),
            tag: node.tagName.toLowerCase(),
            url: location.href.replace(/([?&])wunsch=1(&|$)/, "$1").replace(/[?&]$/, ""),
            lang: document.documentElement.lang || "",
          });
        },
        true
      );
    });

    window.addEventListener("message", function (e) {
      var d = e.data;
      if (!d || d.ns !== NS) return;
      if (d.type === "arm") setArmed(true);
      else if (d.type === "disarm") setArmed(false);
      else if (d.type === "clear") markieren(null);
      else if (d.type === "jump" && d.id) jumpTo(d.id);
    });

    senden({
      type: "ready",
      url: location.href,
      lang: document.documentElement.lang || "",
      sections: Array.prototype.map.call(document.querySelectorAll("section[id]"), function (s) {
        var h = s.querySelector("h1, h2, h3");
        return { id: s.id, titel: h ? h.textContent.replace(/\s+/g, " ").trim().slice(0, 60) : s.id };
      }),
    });
  }
})();
