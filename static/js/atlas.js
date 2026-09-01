/* ASCII bikepacking atlas — renders window.ATLAS_DATA (see
   scripts/atlas/build-data.py) into a grid of monospace characters.

   Everything is pre-projected into a GW x GH "coverage" grid, so this file
   only has to: pick a character grid that fits the container, average the
   coverage under each cell, pick a glyph, and rasterise the ride polylines
   on top. Layers are stacked <pre> elements, one colour each, so no per-cell
   spans are needed. */
(function () {
  "use strict";

  const D = window.ATLAS_DATA;
  const atlasEl = document.getElementById("atlas");
  const mapEl = document.getElementById("atlas-map");
  const statusEl = document.getElementById("atlas-status");
  const tripsEl = document.getElementById("atlas-trips");
  if (!D || !mapEl) return;

  const GW = D.gw, GH = D.gh;
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CHAR_ASPECT_FALLBACK = 0.6;

  /* ---- decode the coverage grids into summed-area tables ---------------- */

  function decodeRLE(runs) {
    const out = new Uint8Array(GW * GH);
    let i = 0;
    for (let k = 0; k < runs.length; k += 2) {
      out.fill(runs[k], i, i + runs[k + 1]);
      i += runs[k + 1];
    }
    return out;
  }

  // Returns mean(x0..x1, y0..y1) / 15 as a 0..1 float, integer bounds.
  function summed(grid) {
    const W = GW + 1;
    const s = new Uint32Array(W * (GH + 1));
    for (let y = 1; y <= GH; y++) {
      let row = 0;
      for (let x = 1; x <= GW; x++) {
        row += grid[(y - 1) * GW + (x - 1)];
        s[y * W + x] = s[(y - 1) * W + x] + row;
      }
    }
    return function (x0, y0, x1, y1) {
      x0 = Math.max(0, x0); y0 = Math.max(0, y0);
      x1 = Math.min(GW, x1); y1 = Math.min(GH, y1);
      const area = (x1 - x0) * (y1 - y0);
      if (area <= 0) return 0;
      return (s[y1 * W + x1] - s[y0 * W + x1] - s[y1 * W + x0] + s[y0 * W + x0]) / (area * 15);
    };
  }

  const landAt = summed(decodeRLE(D.land));
  const borderAt = summed(decodeRLE(D.border || D.borders));

  /* ---- layers ------------------------------------------------------------ */

  const LAYER_NAMES = ["grat", "land", "border", "coast", "city", "frame", "route", "hi", "label", "cursor"];
  const layers = {};
  for (const name of LAYER_NAMES) {
    const pre = document.createElement("pre");
    pre.className = "l-" + name;
    pre.setAttribute("aria-hidden", "true");
    mapEl.appendChild(pre);
    layers[name] = { el: pre, cells: null };
  }

  let cols = 0, rows = 0, mapCols = 0, mapRows = 0, cw = 0, ch = 0;
  let cellRide = null;        // Int16Array: ride index + 1 per cell, 0 = none
  let routeCells = [];        // [{i, ch, ride}] in chronological order
  let rideCellRange = [];     // per ride: [start, end) into routeCells
  let shown = 0;              // animation progress (cells)
  let hoverRide = -1;
  let selectedTrip = -1;      // trip highlighted from the table (click)
  let hoverTrip = -1;         // trip under the mouse in the table

  function newCells() { return new Uint16Array(cols * rows); }

  function textOf(cells) {
    let out = "";
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) {
        const v = cells[r * cols + c];
        line += v ? String.fromCharCode(v) : " ";
      }
      out += line.replace(/\s+$/, "") + (r < rows - 1 ? "\n" : "");
    }
    return out;
  }

  function flush(name) {
    layers[name].el.textContent = textOf(layers[name].cells);
  }

  function put(name, c, r, s) {
    if (r < 0 || r >= rows) return;
    const cells = layers[name].cells;
    for (let k = 0; k < s.length; k++) {
      const cc = c + k;
      if (cc < 0 || cc >= cols) continue;
      cells[r * cols + cc] = s.charCodeAt(k);
    }
  }

  // Text that must stay readable: blank the base layers beneath it (+1 pad).
  function stamp(name, c, r, s) {
    for (const base of ["grat", "land", "border", "coast", "city"]) {
      const cells = layers[base].cells;
      for (let k = -1; k <= s.length; k++) {
        const cc = c + k;
        if (cc >= 0 && cc < cols && r >= 0 && r < rows) cells[r * cols + cc] = 0;
      }
    }
    put(name, c, r, s);
  }

  // Blank every base layer inside a rectangle (for boxes drawn over the map).
  function clearRect(c0, r0, w, h) {
    for (const base of ["grat", "land", "border", "coast", "city"]) {
      const cells = layers[base].cells;
      for (let r = r0; r < r0 + h; r++) {
        if (r < 0 || r >= rows) continue;
        for (let c = c0; c < c0 + w; c++) {
          if (c >= 0 && c < cols) cells[r * cols + c] = 0;
        }
      }
    }
  }

  function box(name, c0, r0, w, h, title) {
    const top = "+" + "-".repeat(w - 2) + "+";
    put(name, c0, r0, top);
    put(name, c0, r0 + h - 1, top);
    for (let r = r0 + 1; r < r0 + h - 1; r++) {
      put(name, c0, r, "|");
      put(name, c0 + w - 1, r, "|");
    }
    if (title) put("label", c0 + 2, r0, "[ " + title + " ]");
  }

  /* ---- measuring --------------------------------------------------------- */

  function measure() {
    const probe = document.createElement("pre");
    probe.style.cssText = "position:absolute;visibility:hidden;left:0;top:0";
    probe.textContent = ("X".repeat(100) + "\n").repeat(10).trimEnd();
    mapEl.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    mapEl.removeChild(probe);
    const w = rect.width / 100, h = rect.height / 10;
    return { cw: w || 6, ch: h || w / CHAR_ASPECT_FALLBACK || 10 };
  }

  function layout() {
    const W = mapEl.clientWidth || 600;
    // aim for ~170 columns, but stay within a readable font range
    const fs = Math.max(6, Math.min(11, W / (170 * 0.6)));
    atlasEl.style.setProperty("--atlas-fs", fs.toFixed(2) + "px");
    const m = measure();
    cw = m.cw; ch = m.ch;
    cols = Math.max(40, Math.floor(W / cw));
    mapCols = cols - 2;
    mapRows = Math.round(mapCols * (cw / ch) * (GH / GW));
    rows = mapRows + 2;
    mapEl.style.height = Math.ceil(rows * ch) + "px";
    for (const name of LAYER_NAMES) layers[name].cells = newCells();
  }

  /* ---- coordinate helpers ------------------------------------------------ */

  // grid px -> cell column/row (map area starts at col 1, row 1 inside frame)
  function gx2c(x) { return Math.floor(x / GW * mapCols) + 1; }
  function gy2r(y) { return Math.floor(y / GH * mapRows) + 1; }

  /* ---- land / coast / borders ------------------------------------------- */

  function drawLand() {
    const cov = new Float32Array(mapCols * mapRows);
    const bord = new Float32Array(mapCols * mapRows);
    const sx = GW / mapCols, sy = GH / mapRows;
    for (let r = 0; r < mapRows; r++) {
      const y0 = Math.floor(r * sy), y1 = Math.max(y0 + 1, Math.floor((r + 1) * sy));
      for (let c = 0; c < mapCols; c++) {
        const x0 = Math.floor(c * sx), x1 = Math.max(x0 + 1, Math.floor((c + 1) * sx));
        cov[r * mapCols + c] = landAt(x0, y0, x1, y1);
        bord[r * mapCols + c] = borderAt(x0, y0, x1, y1);
      }
    }
    const LAND = 0.5;
    const at = (c, r) => (c < 0 || r < 0 || c >= mapCols || r >= mapRows) ? 1 : cov[r * mapCols + c];
    for (let r = 0; r < mapRows; r++) {
      for (let c = 0; c < mapCols; c++) {
        const v = cov[r * mapCols + c];
        if (v < 0.2) continue; // sea
        if (v < LAND) {
          // fragments: small islands, thin peninsulas
          put("coast", c + 1, r + 1, ".");
          continue;
        }
        const seaNext = at(c - 1, r) < LAND || at(c + 1, r) < LAND || at(c, r - 1) < LAND || at(c, r + 1) < LAND;
        if (seaNext) {
          put("coast", c + 1, r + 1, v >= 0.8 ? "#" : "+");
        } else if (bord[r * mapCols + c] > 0.12) {
          put("border", c + 1, r + 1, "'");
        } else {
          put("land", c + 1, r + 1, ".");
        }
      }
    }
  }

  function drawGraticule() {
    const sx = mapCols / GW, sy = mapRows / GH;
    for (const line of D.grat || []) {
      for (let i = 0; i + 1 < line.length; i++) {
        let x = Math.floor(line[i][0] * sx) + 1, y = Math.floor(line[i][1] * sy) + 1;
        const x1 = Math.floor(line[i + 1][0] * sx) + 1, y1 = Math.floor(line[i + 1][1] * sy) + 1;
        const dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y);
        const stx = x < x1 ? 1 : -1, sty = y < y1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
          if (x > 0 && x < cols - 1 && y > 0 && y < rows - 1 && (x + y) % 2 === 0) put("grat", x, y, ".");
          if (x === x1 && y === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x += stx; }
          if (e2 <= dx) { err += dx; y += sty; }
        }
      }
    }
  }

  /* ---- frame + legend ---------------------------------------------------- */

  function drawFrame() {
    const top = "+" + "-".repeat(cols - 2) + "+";
    put("frame", 0, 0, top);
    put("frame", 0, rows - 1, top);
    for (let r = 1; r < rows - 1; r++) {
      put("frame", 0, r, "|");
      put("frame", cols - 1, r, "|");
    }
    const title = "[ " + (D.collection || "atlas").toUpperCase() + " ]";
    put("label", 2, 0, title);
    const totals = D.trips.reduce((a, t) => ({ km: a.km + t.km, days: a.days + t.days }), { km: 0, days: 0 });
    const right = "[ " + D.trips.length + " trips / " + totals.days + " days / " + fmtInt(totals.km) + " km ]";
    if (cols > title.length + right.length + 8) put("label", cols - 2 - right.length, 0, right);
    const foot = "[ natural earth 50m / lambert conic 43N 62N ]";
    if (cols >= 120) put("frame", cols - 2 - foot.length, rows - 1, foot);
    const hint = "[ hover: ride / click: strava ]";
    if (cols >= 120 && matchMedia("(hover: hover)").matches) put("frame", 2, rows - 1, hint);
  }

  function drawLegend() {
    if (mapCols < 110) return;
    const lines = D.trips.map((t) => {
      const route = (t.from && t.to) ? t.from + " -> " + t.to : t.title;
      return t.year + "  " + route.padEnd(23) + fmtInt(t.km).padStart(6) + " km";
    });
    const inner = Math.max(...lines.map((l) => l.length));
    // one blank row between entries and above/below them so it breathes
    const c0 = 3, r0 = 2, w = inner + 6, h = lines.length * 2 + 3;
    clearRect(c0 - 1, r0 - 1, w + 2, h + 2);
    box("frame", c0, r0, w, h, "solo bikepacking");
    lines.forEach((l, i) => put("label", c0 + 3, r0 + 2 + i * 2, l));
  }

  function drawCities() {
    for (const city of D.cities) {
      if (city.p > 1 && mapCols < 150) continue;
      const c = gx2c(city.x), r = gy2r(city.y);
      if (c < 1 || c >= cols - 1 || r < 1 || r >= rows - 1) continue;
      const name = city.name;
      const left = city.side === "l" || c + 2 + name.length >= cols - 1;
      stamp("city", left ? c - 1 - name.length : c + 2, r, name);
      put("city", c, r, "+");
    }
  }

  /* ---- routes ------------------------------------------------------------ */

  function dirChar(dc, dr) {
    // visual angle, accounting for cells being taller than wide
    const a = Math.atan2(dr * ch, dc * cw) * 180 / Math.PI;
    const t = ((a % 180) + 180) % 180; // 0..180
    if (t < 22.5 || t >= 157.5) return "-";
    if (t < 67.5) return "\\";
    if (t < 112.5) return "|";
    return "/";
  }

  function drawRoutes() {
    cellRide = new Int16Array(cols * rows);
    routeCells = [];
    rideCellRange = [];
    const sx = mapCols / GW, sy = mapRows / GH;
    D.rides.forEach((ride, ri) => {
      const start = routeCells.length;
      let lastIdx = -1;
      const pts = ride.pts;
      for (let i = 0; i + 1 < pts.length; i++) {
        const c0 = Math.floor(pts[i][0] * sx) + 1, r0 = Math.floor(pts[i][1] * sy) + 1;
        const c1 = Math.floor(pts[i + 1][0] * sx) + 1, r1 = Math.floor(pts[i + 1][1] * sy) + 1;
        const g = dirChar(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
        // Bresenham
        let x = c0, y = r0;
        const dx = Math.abs(c1 - c0), dy = -Math.abs(r1 - r0);
        const stx = c0 < c1 ? 1 : -1, sty = r0 < r1 ? 1 : -1;
        let err = dx + dy;
        for (;;) {
          const idx = y * cols + x;
          if (idx !== lastIdx && x > 0 && x < cols - 1 && y > 0 && y < rows - 1) {
            routeCells.push({ i: idx, ch: g.charCodeAt(0), ride: ri });
            cellRide[idx] = ri + 1;
            lastIdx = idx;
          }
          if (x === c1 && y === r1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x += stx; }
          if (e2 <= dx) { err += dx; y += sty; }
        }
      }
      rideCellRange.push([start, routeCells.length]);
    });
    // trip start/end markers and end labels. Markers are spliced into the
    // chronological cell list next to the ride they belong to (so the
    // animation draws them in order) and the per-ride ranges shift with them.
    const insertCell = (pos, cell, owner) => {
      routeCells.splice(pos, 0, cell);
      rideCellRange.forEach((rg, k) => {
        if (k === owner) { if (pos <= rg[1]) rg[1]++; }
        else if (rg[0] >= pos) { rg[0]++; rg[1]++; }
      });
    };
    D.trips.forEach((t) => {
      const s = t.startPt, e = t.endPt;
      const sc = gx2c(s[0]), sr = gy2r(s[1]), ec = gx2c(e[0]), er = gy2r(e[1]);
      const first = t.rides[0];
      insertCell(rideCellRange[first][0], { i: sr * cols + sc, ch: "o".charCodeAt(0), ride: first, marker: true }, first);
      insertCell(rideCellRange[t.endRide][1], { i: er * cols + ec, ch: "@".charCodeAt(0), ride: t.endRide, marker: true }, t.endRide);
      const endLabel = t.year + " " + (t.to || t.title);
      if (ec + 2 + endLabel.length < cols - 1) stamp("label", ec + 2, er, endLabel);
      else stamp("label", ec - 1 - endLabel.length, er, endLabel);
    });
  }

  function renderRoute(count) {
    const cells = layers.route.cells;
    cells.fill(0);
    const n = Math.min(count, routeCells.length);
    for (let k = 0; k < n; k++) cells[routeCells[k].i] = routeCells[k].ch;
    flush("route");
    const cur = layers.cursor.cells;
    cur.fill(0);
    if (n < routeCells.length && n > 0) {
      cur[routeCells[n - 1].i] = 0x2588; // █
    }
    flush("cursor");
  }

  function renderHighlight(rideIdx) {
    const cells = layers.hi.cells;
    cells.fill(0);
    for (const ri of rideIdx) {
      const [a, b] = rideCellRange[ri];
      for (let k = a; k < b; k++) cells[routeCells[k].i] = routeCells[k].ch;
    }
    flush("hi");
    layers.route.el.classList.toggle("is-dimmed", rideIdx.length > 0);
  }

  // What should be lit right now: the hovered ride wins, else the selected trip.
  function refreshHighlight() {
    if (hoverRide >= 0) renderHighlight([hoverRide]);
    else if (hoverTrip >= 0) renderHighlight(D.trips[hoverTrip].rides);
    else if (selectedTrip >= 0) renderHighlight(D.trips[selectedTrip].rides);
    else renderHighlight([]);
  }

  /* ---- status + trips table ---------------------------------------------- */

  function fmtInt(n) { return Math.round(n).toLocaleString("en-US").replace(/,/g, " "); }
  function fmtDur(secs) {
    const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
    return h + "h" + String(m).padStart(2, "0");
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function statusIdle() {
    const totals = D.trips.reduce((a, t) => ({ km: a.km + t.km, elev: a.elev + t.elev, days: a.days + t.days, secs: a.secs + t.secs }), { km: 0, elev: 0, days: 0, secs: 0 });
    statusEl.innerHTML = "&gt; <span class=k>" + D.trips.length + " trips</span> · " + totals.days + " days · " +
      fmtInt(totals.km) + " km · " + fmtInt(totals.elev) + " m↑ · " + fmtDur(totals.secs) + " moving" +
      "<span class=d>  —  hover the line for the day</span>";
  }

  function statusTrip(ti) {
    const t = D.trips[ti];
    statusEl.innerHTML = "&gt; <span class=k>" + t.year + "</span> · " + esc(t.title) + " · " +
      esc(t.from) + " -&gt; " + esc(t.to) + " · " + t.days + " days · " + fmtInt(t.km) + " km · " +
      fmtInt(t.elev) + " m↑ · " + fmtDur(t.secs);
  }

  function statusDefault() {
    if (hoverTrip >= 0) statusTrip(hoverTrip);
    else if (selectedTrip >= 0) statusTrip(selectedTrip);
    else statusIdle();
  }

  function statusRide(ri, drawing) {
    const r = D.rides[ri];
    statusEl.innerHTML = "&gt; " + (drawing ? "<span class=d>drawing</span> " : "") +
      "<span class=k>" + r.date + "</span> · " + esc(r.name) + " · " + r.km + " km · " +
      fmtInt(r.elev) + " m↑ · " + fmtDur(r.secs);
  }

  function renderTrips() {
    // An ASCII table, drawn in the same +-| style as the map frame. Rows are
    // spans so they can be highlighted; text stays selectable.
    const len = (t) => [...t].length;
    const head = ["year", "trip", "days", "km", "m\u2191", "moving"];
    const right = [false, false, true, true, true, true];
    const body = D.trips.map((t) => [String(t.year), t.title, String(t.days), fmtInt(t.km), fmtInt(t.elev), fmtDur(t.secs)]);
    const widths = head.map((h, i) => Math.max(len(h), ...body.map((r) => len(r[i]))));
    const rule = '<span class=b>+' + widths.map((w) => "-".repeat(w + 2)).join("+") + "+</span>";
    const line = (cells, t) => {
      const parts = cells.map((c, i) => {
        const fill = " ".repeat(widths[i] - len(c));
        let txt = esc(c);
        if (t && i === 1 && t.post) txt = '<a href="' + esc(t.post) + '">' + txt + "</a>";
        return " " + (right[i] ? fill + txt : txt + fill) + " ";
      });
      return '<span class=b>|</span>' + parts.join('<span class=b>|</span>') + '<span class=b>|</span>';
    };
    let html = rule + "\n" + '<span class=h>' + line(head) + "</span>\n" + rule + "\n";
    const blank = line(widths.map(() => ""));
    body.forEach((r, i) => {
      html += blank + "\n" + '<span class=row data-trip="' + i + '">' + line(r, D.trips[i]) + "</span>\n";
    });
    html += blank + "\n" + rule;
    tripsEl.innerHTML = '<pre class="atlas-table">' + html + "</pre>";
    tableChars = len(rule.replace(/<[^>]+>/g, ""));
    fitTable();
  }

  // Never scroll the table: shrink its font until the whole width fits.
  let tableChars = 0;
  function fitTable() {
    const pre = tripsEl.firstElementChild;
    if (!pre || !tableChars) return;
    const base = parseFloat(getComputedStyle(atlasEl).fontSize) * 0.85;
    pre.style.fontSize = "";
    const avail = tripsEl.clientWidth;
    const need = pre.scrollWidth;
    if (need > avail) pre.style.setProperty("font-size", (base * avail / need * 0.99).toFixed(2) + "px", "important");
  }

  function markTrip(hover) {
    tripsEl.querySelectorAll(".row[data-trip]").forEach((tr) => {
      const i = +tr.dataset.trip;
      tr.classList.toggle("is-hover", i === hover);
      tr.classList.toggle("is-selected", i === selectedTrip);
    });
  }

  function selectTrip(i) {
    selectedTrip = selectedTrip === i ? -1 : i;
    markTrip(hoverTrip);
    refreshHighlight();
    statusDefault();
    if (selectedTrip >= 0) {
      // only when the map is entirely off screen (phones: table below the map)
      const r = mapEl.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) mapEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  // Hovering a row previews the trip on the map until the mouse leaves;
  // clicking toggles it as the selection. Touch devices only get the click.
  const CAN_HOVER = matchMedia("(hover: hover)").matches;
  const setHoverTrip = (i) => {
    if (!CAN_HOVER || i === hoverTrip) return;
    hoverTrip = i;
    markTrip(i);
    refreshHighlight();
    statusDefault();
  };
  tripsEl.addEventListener("mouseover", (ev) => {
    const row = ev.target.closest(".row[data-trip]");
    setHoverTrip(row ? +row.dataset.trip : -1);
  });
  tripsEl.addEventListener("mouseleave", () => setHoverTrip(-1));

  tripsEl.addEventListener("click", (ev) => {
    if (ev.target.closest("a")) return;
    const row = ev.target.closest(".row[data-trip]");
    if (row) selectTrip(+row.dataset.trip);
  });

  /* ---- interaction ------------------------------------------------------- */

  function rideAt(ev) {
    const rect = mapEl.getBoundingClientRect();
    const c = Math.floor((ev.clientX - rect.left) / cw), r = Math.floor((ev.clientY - rect.top) / ch);
    let best = -1;
    for (let dr = -1; dr <= 1 && best < 0; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
        const v = cellRide[rr * cols + cc];
        if (v && (dc === 0 && dr === 0 || best < 0)) { best = v - 1; if (dc === 0 && dr === 0) break; }
      }
    }
    return best;
  }

  mapEl.addEventListener("mousemove", (ev) => {
    if (shown < routeCells.length) return; // still drawing
    const ri = rideAt(ev);
    if (ri === hoverRide) return;
    hoverRide = ri;
    refreshHighlight();
    if (ri >= 0) { statusRide(ri, false); markTrip(D.rides[ri].trip); }
    else { statusDefault(); markTrip(-1); }
    mapEl.style.cursor = ri >= 0 ? "pointer" : "crosshair";
  });
  mapEl.addEventListener("mouseleave", () => {
    if (hoverRide < 0) return;
    hoverRide = -1;
    refreshHighlight();
    statusDefault();
    markTrip(-1);
  });
  mapEl.addEventListener("click", (ev) => {
    const ri = rideAt(ev);
    if (ri >= 0) window.open("https://www.strava.com/activities/" + D.rides[ri].id, "_blank", "noopener");
  });

  /* ---- animation --------------------------------------------------------- */

  let animId = 0;
  function animate() {
    cancelAnimationFrame(animId);
    if (REDUCED || shown >= routeCells.length) {
      shown = routeCells.length;
      renderRoute(shown);
      statusDefault();
      return;
    }
    const total = routeCells.length;
    const duration = 5000; // ms for the whole line
    let last = performance.now();
    let acc = shown;
    let lastRide = -1;
    const step = (now) => {
      acc += (now - last) / duration * total;
      last = now;
      shown = Math.min(total, Math.floor(acc));
      renderRoute(shown);
      const ride = routeCells[Math.max(0, shown - 1)].ride;
      if (ride !== lastRide) { lastRide = ride; statusRide(ride, true); }
      if (shown < total) animId = requestAnimationFrame(step);
      else statusDefault();
    };
    animId = requestAnimationFrame(step);
  }

  /* ---- main -------------------------------------------------------------- */

  function render() {
    layout();
    drawGraticule();
    drawLand();
    drawFrame();
    drawLegend();
    drawCities();
    drawRoutes();
    for (const name of ["grat", "land", "border", "coast", "city", "frame", "label"]) flush(name);
    refreshHighlight();
    renderRoute(shown);
  }

  render();
  renderTrips();
  animate();

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const wasDone = shown >= routeCells.length;
      render();
      fitTable();
      if (wasDone) { shown = routeCells.length; renderRoute(shown); }
    }, 150);
  });
})();
