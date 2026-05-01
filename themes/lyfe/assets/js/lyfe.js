const fakeDataInput = {
  seed: 1337,
  rings: [
    {
      entity: [
        {
          posX: 0,
          posY: 0,
          type: "self",
        }
      ]
    },
    {
      entity: [
        {
          posX: 0,
          posY: 0,
          type: "ring1",
        }
      ]
    }
  ],
  environment: {
    c: [{
      value: 450,
      last: 1234678 // timestamp
    }],
    t: [{
      value: 20,
      last: 1234678 // timestamp
    }],
    h: [{
      value: 20,
      last: 1234678 // timestamp
    }],
  },
  capacity: {
    k: {
      "status": "low"
    },
    p: {
      "status": "medium"
    },
    s: {
      "status": "high"
    }
  }
}

var switchCheckbox = document.getElementById("switch-bg");

function Config() {
  this.radius = 50;
  this.hexHeight = ((3 / 2) * this.radius)
  this.hexWidth = (Math.sqrt(3) * this.radius)

  // viewport size, updated on resize
  this.width = 0
  this.height = 0
  // current grid extent in hex units; only ever grows
  this.cols = 0
  this.rows = 0
}

function syncViewport(config) {
  config.width = window.innerWidth
  config.height = window.innerHeight
}

const canvas = document.getElementById('lyfe-canvas');
const ctx = canvas.getContext('2d');
var COLOR_PALETTE = {};
const CAP_COLOR_PALETTE = {
  low: "#531b1b",
  medium: "#331b53",
  high: "#1b3153",
}
const THEME_COLOR = "#78E2A0"

// Add new particules here. The spawn hex is picked dynamically: `offsetCols`
// is the number of hex columns past the container's right edge, and `row` is
// the hex row from the top of the viewport. This keeps particules visible in
// the gutter regardless of viewport width. `speed` is fraction of an edge per
// frame (1/200 ≈ 200 frames per edge at 60fps ≈ ~3.3s per edge).
const PARTICULE_CONFIGS = [
  { name: "l", color: "white", offsetCols: 1, row: 3, speed: 1 / 400 },
  { name: "e", color: THEME_COLOR, offsetCols: 2, row: 2, speed: 1 / 400 },
]

var grid;
var PARTICULES = new Map();

// Hidden debug panel state. Toggled via Shift+D — see initDebug().
const debug = {
  visible: false,
  showValidPaths: false,
  speedMultiplier: 1,
}

function createGrid(config) {
  const Hex = Honeycomb.defineHex({ dimensions: config.radius, origin: 'topLeft' })
  return new Honeycomb.Grid(Hex, Honeycomb.rectangle({ width: config.cols, height: config.rows }))
}

// Grow the grid (if needed) so it covers the current viewport. Hex (col,row)
// positions never change, so existing palette colors and particule positions
// stay valid; only newly added hexes get fresh colors.
function ensureGridCovers(config) {
  const wantCols = Math.ceil(config.width / config.hexWidth) + 1
  const wantRows = Math.ceil(config.height / config.hexHeight) + 1
  if (wantCols <= config.cols && wantRows <= config.rows) return
  config.cols = Math.max(config.cols, wantCols)
  config.rows = Math.max(config.rows, wantRows)
  grid = createGrid(config)
  grid.forEach(generateColorsFromEachHex)
}

function drawHexagonGrid() {
  grid.forEach(drawHex);
}

// Hexes currently colored as cap cells, paired with the color they had before
// we overwrote them. On resize we restore these so old cap-cell positions
// blend back into the background instead of leaving a stale colored hex.
var CAP_CELL_BACKUPS = []

// Pick anchor points (in viewport pixels) for the 3 cap cells. The .container
// element is opaque and covers the canvas behind it, so we anchor to the
// right gutter (viewport right edge minus container right edge) rather than
// the viewport. Layout downgrades row → triangle → vertical as the gutter
// shrinks; if not even one column of hexes fits, render nothing rather than
// hiding cells under the content card.
function capCellAnchors(config) {
  const w = config.width
  const h = config.height
  const hw = config.hexWidth
  const hh = config.hexHeight
  const statuses = fakeDataInput.capacity

  const container = document.querySelector('.container')
  const containerRight = container ? container.getBoundingClientRect().right : 0
  const gutter = w - containerRight

  // One row of background sits below the cap cells.
  const yBottom = h - hh * 1.5

  // Row: 3 hexes side by side need 3 hexWidths of gutter.
  if (gutter >= hw * 3 && h >= hh * 2.5) {
    return [
      { x: w - hw * 0.5, y: yBottom, status: statuses.k.status },
      { x: w - hw * 1.5, y: yBottom, status: statuses.p.status },
      { x: w - hw * 2.5, y: yBottom, status: statuses.s.status },
    ]
  }

  // Triangle: 2 bottom + 1 top, footprint is 2 hexWidths wide.
  if (gutter >= hw * 2 && h >= hh * 3.5) {
    const yTop = yBottom - hh
    return [
      { x: w - hw * 0.5, y: yBottom, status: statuses.k.status },
      { x: w - hw * 1.5, y: yBottom, status: statuses.p.status },
      { x: w - hw * 1.0, y: yTop, status: statuses.s.status },
    ]
  }

  // Vertical: 1 hexWidth column hugging the right edge. Pointy-top rows
  // alternate horizontal alignment by hw/2, so to land in the *same* column
  // each step needs to skip a row — vertical spacing is 2*hh, not hh.
  if (gutter >= hw && h >= hh * 5.5) {
    const x = w - hw * 0.5
    return [
      { x: x, y: yBottom, status: statuses.k.status },
      { x: x, y: yBottom - hh * 2, status: statuses.p.status },
      { x: x, y: yBottom - hh * 4, status: statuses.s.status },
    ]
  }

  // No visible room — skip rendering rather than draw under the content card.
  return []
}

function applyCapCells(config) {
  for (const b of CAP_CELL_BACKUPS) {
    COLOR_PALETTE[b.hex] = b.color
  }
  CAP_CELL_BACKUPS = []

  for (const a of capCellAnchors(config)) {
    const hex = grid.pointToHex({ x: a.x, y: a.y }, { allowOutside: true })
    CAP_CELL_BACKUPS.push({ hex: hex, color: COLOR_PALETTE[hex] })
    COLOR_PALETTE[hex] = CAP_COLOR_PALETTE[a.status]
  }
}

const HEX_STROKE = "#000"

function drawHex(hex) {
  ctx.beginPath();
  ctx.moveTo(hex.corners[0].x, hex.corners[0].y);
  for (let i = 1; i < 6; i++) {
    ctx.lineTo(hex.corners[i].x, hex.corners[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = getColorOfHex(hex)
  ctx.fill();
  ctx.strokeStyle = HEX_STROKE
  ctx.stroke();
}

function getColorOfHex(hex) {
  return getColorOfHexByPalette(hex, COLOR_PALETTE)
}

function getColorOfHexByPalette(hex, pallette) {
  return pallette[hex]
}

function generateColorsFromEachHex(currentHex) {
  generateColors(currentHex, COLOR_PALETTE)
}

function drawParticuleAt(p) {
  ctx.beginPath();
  ctx.arc(p.position.x, p.position.y, p.radius, 0, Math.PI * 2, false);
  ctx.strokeStyle = p.color;
  ctx.stroke();
  ctx.closePath();
}

// In a pointy-top honeycomb, every vertex is shared by 3 hexes and has
// exactly 3 edges leaving it. Each vertex is one of two types based on
// which way its Y-shape points:
//   TOP    : single edge UP, two edges DOWN_LEFT / DOWN_RIGHT
//   BOTTOM : single edge DOWN, two edges UP_LEFT / UP_RIGHT
// Walking any allowed edge always lands on the opposite type.
const VertexType = {
  TOP: "top",
  BOTTOM: "bottom",
}

const Direction = {
  UP: "up",
  DOWN: "down",
  UP_LEFT: "upLeft",
  UP_RIGHT: "upRight",
  DOWN_LEFT: "downLeft",
  DOWN_RIGHT: "downRight",
}

const ALLOWED_DIRECTIONS = {
  [VertexType.TOP]: [Direction.UP, Direction.DOWN_LEFT, Direction.DOWN_RIGHT],
  [VertexType.BOTTOM]: [Direction.DOWN, Direction.UP_LEFT, Direction.UP_RIGHT],
}

function flipVertexType(t) {
  return t === VertexType.TOP ? VertexType.BOTTOM : VertexType.TOP
}

const SQRT3 = Math.sqrt(3)

// Edge vector for a hex of circumradius R. All hex edges have length R.
// Diagonals split into (±R√3/2, ±R/2); verticals are (0, ±R).
function edgeVector(direction, R) {
  const sx = R * SQRT3 / 2
  const sy = R / 2
  switch (direction) {
    case Direction.UP: return { x: 0, y: -R }
    case Direction.DOWN: return { x: 0, y: R }
    case Direction.UP_LEFT: return { x: -sx, y: -sy }
    case Direction.UP_RIGHT: return { x: sx, y: -sy }
    case Direction.DOWN_LEFT: return { x: -sx, y: sy }
    case Direction.DOWN_RIGHT: return { x: sx, y: sy }
  }
}

function makeParticule(name, color, x, y, vertexType, speed) {
  return {
    name: name,
    color: color,
    radius: 2,
    speed: speed,
    vertexType: vertexType,
    startPos: { x: x, y: y },
    endPos: { x: x, y: y },
    position: { x: x, y: y },
    // start at end-of-edge so the very first move picks a fresh edge
    t: 1,
  }
}

// The .container is opaque and sits in front of the canvas, so a particule
// inside its rect is hidden. Treat the container as out-of-bounds so particules
// stay in the visible area. Read live each call: when Sim Viz hides the
// content the container shrinks, freeing that space for particules naturally.
function getContainerRect() {
  const c = document.querySelector('.container')
  return c ? c.getBoundingClientRect() : null
}

function isInBounds(point, config) {
  if (point.x < 0 || point.x > config.width) return false
  if (point.y < 0 || point.y > config.height) return false
  const r = getContainerRect()
  if (r && point.x > r.left && point.x < r.right
        && point.y > r.top && point.y < r.bottom) return false
  return true
}

function pickNextEdge(p, config) {
  const allowed = ALLOWED_DIRECTIONS[p.vertexType].map(d => edgeVector(d, config.radius))
  const inBounds = allowed.filter(v => isInBounds({ x: p.endPos.x + v.x, y: p.endPos.y + v.y }, config))
  // If every move would leave the canvas (corner case), fall back to all
  // allowed directions so the particule still moves rather than freezing.
  const choices = inBounds.length > 0 ? inBounds : allowed

  const v = choices[Math.floor(Math.random() * choices.length)]
  p.startPos = { x: p.endPos.x, y: p.endPos.y }
  p.endPos = { x: p.startPos.x + v.x, y: p.startPos.y + v.y }
  p.vertexType = flipVertexType(p.vertexType)
  p.t = 0
}

function moveParticule(p, config) {
  p.t += p.speed * debug.speedMultiplier
  if (p.t >= 1) {
    p.t = 0
    pickNextEdge(p, config)
  }
  p.position.x = p.startPos.x + (p.endPos.x - p.startPos.x) * p.t
  p.position.y = p.startPos.y + (p.endPos.y - p.startPos.y) * p.t
}

function drawParticules(config) {
  PARTICULES.forEach(function (p) {
    moveParticule(p, config)
    drawParticuleAt(p)
  })
}

// The TOP vertex of a pointy-top hex is the corner with the smallest y.
function topVertexOf(hex) {
  let top = hex.corners[0]
  for (let i = 1; i < hex.corners.length; i++) {
    if (hex.corners[i].y < top.y) top = hex.corners[i]
  }
  return top
}

function initParticules(config) {
  PARTICULES.clear()
  const r = getContainerRect()
  const baseX = r ? r.right : 0
  for (const cfg of PARTICULE_CONFIGS) {
    const x = baseX + cfg.offsetCols * config.hexWidth
    const y = cfg.row * config.hexHeight
    const hex = grid.pointToHex({ x, y }, { allowOutside: true })
    if (!hex) {
      console.warn("particule", cfg.name, "skipped: no hex at", { x, y })
      continue
    }
    const v = topVertexOf(hex)
    PARTICULES.set(cfg.name, makeParticule(cfg.name, cfg.color, v.x, v.y, VertexType.TOP, cfg.speed))
  }
}

function generateColors(currentHex, mapping) {
  // generate only the background color once
  if (mapping[currentHex]) {
    return mapping[currentHex]
  }
  colorA = "#1D1E28"
  colorB = "#1D1D1D"

  color = colorA;
  if (Math.random() > 0.8) {
    color = colorB
  }
  mapping[currentHex] = color
}

function main() {
  const config = new Config()
  syncViewport(config)
  ensureGridCovers(config)
  syncCanvas(config)
  applyCapCells(config)
  initParticules(config)
  initDebug(config)

  window.addEventListener('resize', () => {
    syncViewport(config)
    ensureGridCovers(config)
    syncCanvas(config)
    applyCapCells(config)
  })

  window.requestAnimationFrame(() => draw(config))
}

// Setting canvas.width/height resizes the bitmap *and* clears it, so we only
// touch it on init and on resize — not every frame.
function syncCanvas(config) {
  canvas.width = config.width
  canvas.height = config.height
}

function drawDebugOverlay(config) {
  if (!debug.showValidPaths) return

  const r = getContainerRect()
  if (r) {
    ctx.save()
    ctx.strokeStyle = "#E2787A"
    ctx.setLineDash([6, 4])
    ctx.lineWidth = 2
    ctx.strokeRect(r.left, r.top, r.width, r.height)
    ctx.restore()
  }

  PARTICULES.forEach(p => {
    const allowed = ALLOWED_DIRECTIONS[p.vertexType].map(d => edgeVector(d, config.radius))
    for (const v of allowed) {
      const dst = { x: p.endPos.x + v.x, y: p.endPos.y + v.y }
      const ok = isInBounds(dst, config)
      const color = ok ? "#78E2A0" : "#E2787A"
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(p.endPos.x, p.endPos.y)
      ctx.lineTo(dst.x, dst.y)
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      if (!ok) ctx.setLineDash([4, 4])
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(dst.x, dst.y, 4, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.restore()
    }
  })
}

function draw(cfg) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawHexagonGrid()
  drawParticules(cfg)
  drawDebugOverlay(cfg)
  window.requestAnimationFrame(() => draw(cfg))
}

// Hidden debug panel: Shift+D toggles a small control surface to tweak
// particule speed, toggle the path-validity overlay, change colors, and
// add/remove particules at runtime. Not part of the public UI.
function initDebug(config) {
  const panel = document.createElement('div')
  panel.id = 'debug-panel'
  panel.innerHTML = `
    <style>
      #debug-panel {
        position: fixed; top: 16px; right: 16px; z-index: 9999;
        background: #1d1e28; color: #d8dee9; border: 1px solid #78E2A0;
        padding: 12px; font-family: monospace; font-size: 12px;
        width: 280px; max-height: 80vh; overflow-y: auto;
        box-shadow: 4px 4px 0 rgba(0,0,0,0.5);
      }
      #debug-panel.hidden { display: none; }
      #debug-panel h3 { margin: 0 0 8px 0; font-size: 13px; color: #78E2A0; }
      #debug-panel label { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin: 6px 0; }
      #debug-panel .row { display: flex; gap: 6px; align-items: center; margin: 4px 0; padding: 4px 0; border-top: 1px dashed #555; }
      #debug-panel input[type="range"] { flex: 1; }
      #debug-panel input[type="color"] { width: 28px; height: 22px; padding: 0; border: 0; background: transparent; }
      #debug-panel input[type="number"] { width: 72px; background: #111; color: #d8dee9; border: 1px solid #444; padding: 2px 4px; }
      #debug-panel button { background: #2a2b35; color: #d8dee9; border: 1px solid #78E2A0; padding: 4px 8px; cursor: pointer; font-family: inherit; font-size: 11px; }
      #debug-panel button:hover { background: #78E2A0; color: #1d1e28; }
      #debug-panel .name { font-weight: bold; min-width: 24px; text-align: center; }
      #debug-panel .hint { opacity: .6; margin-top: 10px; font-size: 11px; }
    </style>
    <h3>Debug — particules</h3>
    <label>
      <span>Speed × <span id="dbg-speed-val">1.00</span></span>
      <input id="dbg-speed" type="range" min="0" max="100" step="0.1" value="1" />
    </label>
    <label>
      <span>Show valid paths</span>
      <input id="dbg-paths" type="checkbox" />
    </label>
    <div id="dbg-particles"></div>
    <button id="dbg-add">+ Add particule</button>
    <p class="hint">Toggle: Shift+D</p>
  `
  panel.classList.add('hidden')
  document.body.appendChild(panel)

  const speedEl = panel.querySelector('#dbg-speed')
  const speedVal = panel.querySelector('#dbg-speed-val')
  speedEl.addEventListener('input', e => {
    debug.speedMultiplier = parseFloat(e.target.value)
    speedVal.textContent = debug.speedMultiplier.toFixed(2)
  })
  panel.querySelector('#dbg-paths').addEventListener('change', e => {
    debug.showValidPaths = e.target.checked
  })
  panel.querySelector('#dbg-add').addEventListener('click', () => {
    addParticuleAtDefault(config)
    renderParticulesList()
  })

  renderParticulesList()

  window.addEventListener('keydown', e => {
    if (!e.shiftKey || (e.key !== 'D' && e.key !== 'd')) return
    const t = e.target
    const tag = (t && t.tagName || '').toUpperCase()
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return
    e.preventDefault()
    debug.visible = !debug.visible
    panel.classList.toggle('hidden', !debug.visible)
    if (debug.visible) renderParticulesList()
  })
}

function renderParticulesList() {
  const list = document.querySelector('#dbg-particles')
  if (!list) return
  list.innerHTML = ''
  PARTICULES.forEach((p, name) => {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `
      <span class="name">${name}</span>
      <input type="color" data-action="color" />
      <input type="number" min="0.0001" max="0.05" step="0.0001" data-action="speed" />
      <button data-action="remove" title="remove">×</button>
    `
    const colorEl = row.querySelector('[data-action=color]')
    colorEl.value = toHexColor(p.color)
    colorEl.addEventListener('input', e => { p.color = e.target.value })

    const speedEl = row.querySelector('[data-action=speed]')
    speedEl.value = p.speed.toFixed(4)
    speedEl.addEventListener('input', e => {
      const v = parseFloat(e.target.value)
      if (!isNaN(v) && v > 0) p.speed = v
    })

    row.querySelector('[data-action=remove]').addEventListener('click', () => {
      PARTICULES.delete(name)
      renderParticulesList()
    })
    list.appendChild(row)
  })
}

// <input type="color"> only accepts #rrggbb. Round-trip through canvas to
// normalize named/short-hex colors.
function toHexColor(c) {
  const probe = document.createElement('canvas').getContext('2d')
  probe.fillStyle = "#000"
  probe.fillStyle = c
  return probe.fillStyle
}

function addParticuleAtDefault(config) {
  const r = getContainerRect()
  const baseX = r ? r.right : 0
  const x = baseX + config.hexWidth * (1 + Math.floor(Math.random() * 3))
  const y = config.hexHeight * (1 + Math.floor(Math.random() * 6))
  const hex = grid.pointToHex({ x, y }, { allowOutside: true })
  if (!hex) return
  const v = topVertexOf(hex)
  let name = 'p' + Math.random().toString(36).slice(2, 5)
  while (PARTICULES.has(name)) name = 'p' + Math.random().toString(36).slice(2, 5)
  const color = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')
  PARTICULES.set(name, makeParticule(name, color, v.x, v.y, VertexType.TOP, 1 / 400))
}

main()

document.addEventListener('click', (e) => {
  console.log("click", e.clientX, e.clientY)
  clickedHex = grid.pointToHex(
    { x: e.clientX, y: e.clientY },
    { allowOutside: false }
  )
  console.log(clickedHex)
})


// This enables the "visualisation mode" where the content is hidden but some
// simulation operations are shown and explained
switchCheckbox.addEventListener("click", (e) => {
  console.log(e.target.checked)
  document.getElementsByClassName("posts")[0].style.display = e.target.checked ? "none" : "block"
  document.getElementsByClassName("footer")[0].style.display = e.target.checked ? "none" : "block"
  document.getElementsByClassName("navigation-menu")[0].style.display = e.target.checked ? "none" : "block"
  document.getElementsByClassName("sim-viz-text")[0].style.display = e.target.checked ? "block" : "none"
});
