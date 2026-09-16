// Interaction effects only (no maths): ripples, 3D tilt with glare, pointer spotlight, slider bubbles,
// toggle particles, number pops and busy-signal transitions. Styles are in fx.css.
(function () {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "fx.css?v=7";
  document.head.appendChild(css);

  const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FINE = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const TILT = ".stat, .lane, .flow-card, .step";
  const GLARE = ".tile, .step, .glass:not(.topbar)";
  if (REDUCED) return;

  // ------------------------------------------------ glare layers on every card (cards are re-rendered, so keep watching)
  function addGlare(root) {
    root.querySelectorAll(GLARE).forEach(card => {
      if (!card.querySelector(":scope > .glare")) {
        const g = document.createElement("span");
        g.className = "glare";
        card.appendChild(g);
      }
    });
  }

  // ------------------------------------------------ card tilt
  let hovered = null;
  function release(card) {
    card.classList.remove("fx-hover");
    card.style.transition = "";
    card.style.transform = "";
  }
  document.addEventListener("pointermove", e => {
    tx = e.clientX; ty = e.clientY;
    document.body.classList.add("pointer-in");
    if (!FINE) return;
    const card = e.target.closest(GLARE);
    if (card !== hovered) {
      if (hovered) release(hovered);
      hovered = card;
      if (card) card.classList.add("fx-hover");
    }
    if (!card) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
    card.style.setProperty("--mx", px * 100 + "%");
    card.style.setProperty("--my", py * 100 + "%");
    if (card.matches(TILT)) {
      const max = card.matches(".lane") ? 2 : 7;
      card.style.transition = "transform 0.18s ease-out, box-shadow 0.4s ease";
      card.style.transform = `perspective(900px) rotateX(${(0.5 - py) * max}deg) rotateY(${(px - 0.5) * max}deg) translateY(-5px)`;
    }
  });
  document.addEventListener("pointerleave", () => {
    document.body.classList.remove("pointer-in");
    if (hovered) release(hovered);
    hovered = null;
  });

  // ------------------------------------------------ ripples
  document.addEventListener("pointerdown", e => {
    const sw = e.target.closest(".switch");
    const host = sw ? sw.querySelector(".track") : e.target.closest("button, .tile, .plan-card, .shift, .chip");
    if (!host) return;
    const r = host.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.4;
    const x = sw ? r.width / 2 : e.clientX - r.left, y = sw ? r.height / 2 : e.clientY - r.top;
    const onDark = host.matches(".btn") || host.getAttribute("aria-selected") === "true" || !!sw;
    const ripple = document.createElement("span");
    ripple.className = "ripple" + (onDark ? "" : " dark");
    ripple.style.cssText = `width:${size}px;height:${size}px;left:${x - size / 2}px;top:${y - size / 2}px`;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(ripple);
    ripple.addEventListener("animationend", () => ripple.remove());
  });

  // ------------------------------------------------ particles
  function burst(x, y, colours, count = 12) {
    for (let i = 0; i < count; i++) {
      const p = document.createElement("span");
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const dist = 26 + Math.random() * 34;
      p.className = "particle";
      p.style.cssText = `left:${x}px;top:${y}px;background:${colours[i % colours.length]};` +
        `--dx:${Math.cos(angle) * dist}px;--dy:${Math.sin(angle) * dist}px`;
      document.body.appendChild(p);
      p.addEventListener("animationend", () => p.remove());
    }
  }

  const toggle = document.getElementById("emergencyNow");
  toggle.addEventListener("change", () => {
    if (!toggle.checked) return;
    const knob = toggle.parentElement.querySelector(".knob").getBoundingClientRect();
    burst(knob.left + knob.width / 2, knob.top + knob.height / 2, ["#B5543C", "#E6A48F", "#C9A66B"]);
  });

  // ------------------------------------------------ reset button: icon spin + teal burst
  const reset = document.getElementById("reset");
  reset.insertAdjacentHTML("afterbegin",
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>');
  reset.addEventListener("click", e => {
    reset.classList.remove("spin");
    void reset.offsetWidth;
    reset.classList.add("spin");
    burst(e.clientX || reset.getBoundingClientRect().left + 30, e.clientY || reset.getBoundingClientRect().top + 20,
      ["#0F5257", "#7FC4C2", "#C9A66B"], 14);
    document.querySelectorAll('input[type=range]').forEach(r => r.dispatchEvent(new Event("fx:sync")));
  });

  // ------------------------------------------------ slider value bubbles
  document.querySelectorAll('input[type=range]').forEach(range => {
    const wrap = document.createElement("span");
    wrap.className = "range-wrap";
    range.parentNode.insertBefore(wrap, range);
    wrap.appendChild(range);
    const bubble = document.createElement("span");
    bubble.className = "bubble";
    wrap.appendChild(bubble);
    const out = range.closest(".control").querySelector("output");
    const place = () => {
      const f = (range.value - range.min) / (range.max - range.min);
      bubble.style.left = `calc(${f * 100}% + ${(0.5 - f) * 20}px)`;
      bubble.textContent = out.textContent;
    };
    range.addEventListener("input", () => {
      place();
      out.classList.remove("pop");
      void out.offsetWidth;
      out.classList.add("pop");
    });
    range.addEventListener("fx:sync", place);
    ["pointerdown", "focus"].forEach(ev => range.addEventListener(ev, () => { place(); wrap.classList.add("active"); }));
    ["pointerup", "pointercancel", "blur"].forEach(ev => range.addEventListener(ev, () => wrap.classList.remove("active")));
    place();
  });

  // ------------------------------------------------ tab pill shine
  const ink = document.querySelector(".tab-ink");
  document.querySelectorAll(".tabs button").forEach(btn => btn.addEventListener("click", () => {
    ink.classList.remove("flash");
    void ink.offsetWidth;
    ink.classList.add("flash");
  }));

  // ------------------------------------------------ react to re-renders: glare, number pops, busy signal changes
  let lastSignal = null;
  function onRender(root) {
    addGlare(root);
    root.querySelectorAll(".count").forEach(c => {
      if (Math.abs(+c.dataset.from - +c.dataset.to) > 1e-9) {
        const tile = c.closest(".tile");
        if (!tile) return;   // e.g. the dial's centre number is not inside a card
        setTimeout(() => { tile.classList.remove("bump"); void tile.offsetWidth; tile.classList.add("bump"); }, 520);
      }
    });
    const signal = root.querySelector ? root.querySelector(".signal") : null;
    if (signal) {
      const title = signal.querySelector("b").textContent;
      if (lastSignal !== null && title !== lastSignal) {
        signal.classList.add(title === "Emergency" ? "shake" : "morph");
      }
      lastSignal = title;
    }
  }
  // Only real re-renders count; the glare layers and ripples this file adds must not trigger it again.
  const OWN = n => n.nodeType !== 1 || n.classList.contains("glare") || n.classList.contains("ripple");
  new MutationObserver(records => {
    const roots = new Set();
    for (const rec of records) {
      if ([...rec.addedNodes].some(n => !OWN(n))) roots.add(rec.target);
    }
    roots.forEach(onRender);
  }).observe(document.querySelector("main"), { childList: true, subtree: true });
  addGlare(document);
})();
