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

function Config(){
  this.radius = 50;
  this.hexHeight = ((3/2)*this.radius)
  this.hexWidth = (Math.sqrt(3)*this.radius)

  // viewport size, updated on resize
  this.width = 0
  this.height = 0
  // current grid extent in hex units; only ever grows
  this.cols = 0
  this.rows = 0
}

function syncViewport(config){
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
const THEME_COLOR =  "#78E2A0"

// Add new particules here. `hex` is the {col, row} of the hex whose top
// vertex the particule starts on. `speed` is fraction of an edge per frame
// (1/200 ≈ 200 frames per edge at 60fps ≈ ~3.3s per edge).
const PARTICULE_CONFIGS = [
  { name: "l", color: "white",       hex: { col: 2, row: 3 }, speed: 1/200 },
  { name: "e", color: THEME_COLOR,   hex: { col: 4, row: 2 }, speed: 1/200 },
]

var grid;
var PARTICULES = new Map();

function createGrid(config) {
  const Hex = Honeycomb.defineHex({ dimensions: config.radius, origin: 'topLeft' })
  return new Honeycomb.Grid(Hex, Honeycomb.rectangle({ width: config.cols, height: config.rows }))
}

// Grow the grid (if needed) so it covers the current viewport. Hex (col,row)
// positions never change, so existing palette colors and particule positions
// stay valid; only newly added hexes get fresh colors.
function ensureGridCovers(config) {
  const wantCols = Math.ceil(config.width  / config.hexWidth)  + 1
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

// Cap-status cells are pinned to the bottom-right of the *initial* viewport
// and don't track resizes — that matches the "layout doesn't change" rule.
function initCapCells(config) {
  const y = config.height - config.hexHeight
  const overrides = [
    { x: config.width - config.hexWidth,     status: fakeDataInput.capacity.k.status },
    { x: config.width - config.hexWidth * 2, status: fakeDataInput.capacity.p.status },
    { x: config.width - config.hexWidth * 3, status: fakeDataInput.capacity.s.status },
  ]
  for (const o of overrides) {
    const hex = grid.pointToHex({ x: o.x, y: y }, { allowOutside: true })
    COLOR_PALETTE[hex] = CAP_COLOR_PALETTE[o.status]
  }
}

const HEX_STROKE = "#000"

function drawHex(hex){
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

function drawParticuleAt(p){
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
  [VertexType.TOP]:    [Direction.UP,   Direction.DOWN_LEFT, Direction.DOWN_RIGHT],
  [VertexType.BOTTOM]: [Direction.DOWN, Direction.UP_LEFT,   Direction.UP_RIGHT],
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
    case Direction.UP:         return { x:   0, y:  -R }
    case Direction.DOWN:       return { x:   0, y:   R }
    case Direction.UP_LEFT:    return { x: -sx, y: -sy }
    case Direction.UP_RIGHT:   return { x:  sx, y: -sy }
    case Direction.DOWN_LEFT:  return { x: -sx, y:  sy }
    case Direction.DOWN_RIGHT: return { x:  sx, y:  sy }
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
    endPos:   { x: x, y: y },
    position: { x: x, y: y },
    // start at end-of-edge so the very first move picks a fresh edge
    t: 1,
  }
}

function isInBounds(point, config) {
  return point.x >= 0 && point.x <= config.width
      && point.y >= 0 && point.y <= config.height
}

function pickNextEdge(p, config) {
  const allowed = ALLOWED_DIRECTIONS[p.vertexType].map(d => edgeVector(d, config.radius))
  const inBounds = allowed.filter(v => isInBounds({ x: p.endPos.x + v.x, y: p.endPos.y + v.y }, config))
  // If every move would leave the canvas (corner case), fall back to all
  // allowed directions so the particule still moves rather than freezing.
  const choices = inBounds.length > 0 ? inBounds : allowed

  const v = choices[Math.floor(Math.random() * choices.length)]
  p.startPos = { x: p.endPos.x, y: p.endPos.y }
  p.endPos   = { x: p.startPos.x + v.x, y: p.startPos.y + v.y }
  p.vertexType = flipVertexType(p.vertexType)
  p.t = 0
}

function moveParticule(p, config) {
  p.t += p.speed
  if (p.t >= 1) {
    p.t = 0
    pickNextEdge(p, config)
  }
  p.position.x = p.startPos.x + (p.endPos.x - p.startPos.x) * p.t
  p.position.y = p.startPos.y + (p.endPos.y - p.startPos.y) * p.t
}

function drawParticules(config){
  PARTICULES.forEach(function(p){
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
  for (const cfg of PARTICULE_CONFIGS) {
    const hex = grid.getHex({ col: cfg.hex.col, row: cfg.hex.row })
    if (!hex) {
      console.warn("particule", cfg.name, "skipped: hex", cfg.hex, "not in grid")
      continue
    }
    const v = topVertexOf(hex)
    PARTICULES.set(cfg.name, makeParticule(cfg.name, cfg.color, v.x, v.y, VertexType.TOP, cfg.speed))
  }
}

function generateColors(currentHex, mapping){
  // generate only the background color once
  if(mapping[currentHex]){
    return mapping[currentHex]
  }
  colorA = "#1D1E28"
  colorB = "#1D1D1D"

  color=colorA;
  if(Math.random() > 0.8){
    color = colorB
  }
  mapping[currentHex] = color
}

function main(){
  const config = new Config()
  syncViewport(config)
  ensureGridCovers(config)
  syncCanvas(config)
  initCapCells(config)
  initParticules(config)

  window.addEventListener('resize', () => {
    syncViewport(config)
    ensureGridCovers(config)
    syncCanvas(config)
  })

  window.requestAnimationFrame(() => draw(config))
}

// Setting canvas.width/height resizes the bitmap *and* clears it, so we only
// touch it on init and on resize — not every frame.
function syncCanvas(config){
  canvas.width = config.width
  canvas.height = config.height
}

function draw(cfg){
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawHexagonGrid()
  drawParticules(cfg)
  window.requestAnimationFrame(() => draw(cfg))
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
