// The whole file is wrapped in a function so it can ALSO be loaded inside the
// browser (game.html does this automatically when no server is reachable) to
// run an offline single-player DEBUG mode with the exact same game logic.
(function () {
const IS_NODE = typeof window === "undefined";
const http = IS_NODE ? require("http") : null;
const fs = IS_NODE ? require("fs") : null;
const path = IS_NODE ? require("path") : null;
const WebSocket = IS_NODE ? require("ws") : null;

const PORT = 8000;

const MIME_TYPES = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml" };

// ---------- static file server ----------
let server = null, wss = null;
if (IS_NODE) {
server = http.createServer((req, res) => {
    let filePath = req.url === "/"
        ? path.join(__dirname, "game.html")
        : path.join(__dirname, req.url);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "text/html";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
    });
});

wss = new WebSocket.Server({ server });
}

// ---------- arena / maze setup ----------
const ARENA_W = 1000, ARENA_H = 650;
const COLS = 9, ROWS = 6;
const MARGIN_X = 50, MARGIN_Y = 40;
const CELL_W = (ARENA_W - MARGIN_X * 2) / COLS;
const CELL_H = (ARENA_H - MARGIN_Y * 2) / ROWS;
const WALL_T = 10;

// Center point of every maze cell - always open space, used for spawns & powerups.
const CELL_CENTERS = [];
for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
        CELL_CENTERS.push({ col: c, row: r, x: MARGIN_X + c * CELL_W + CELL_W / 2, y: MARGIN_Y + r * CELL_H + CELL_H / 2 });

function wallsToGeometry(hWalls, vWalls) {
    const rects = [];
    const segments = []; // centerlines, used for physically-correct bullet reflection
    for (let r = 0; r <= ROWS; r++)
        for (let c = 0; c < COLS; c++)
            if (hWalls[r][c]) {
                rects.push({
                    x: MARGIN_X + c * CELL_W - WALL_T / 2, y: MARGIN_Y + r * CELL_H - WALL_T / 2,
                    w: CELL_W + WALL_T, h: WALL_T
                });
                const y = MARGIN_Y + r * CELL_H;
                segments.push({ x1: MARGIN_X + c * CELL_W - WALL_T / 2, y1: y, x2: MARGIN_X + (c + 1) * CELL_W + WALL_T / 2, y2: y });
            }
    for (let r = 0; r < ROWS; r++)
        for (let c = 0; c <= COLS; c++)
            if (vWalls[r][c]) {
                rects.push({
                    x: MARGIN_X + c * CELL_W - WALL_T / 2, y: MARGIN_Y + r * CELL_H - WALL_T / 2,
                    w: WALL_T, h: CELL_H + WALL_T
                });
                const x = MARGIN_X + c * CELL_W;
                segments.push({ x1: x, y1: MARGIN_Y + r * CELL_H - WALL_T / 2, x2: x, y2: MARGIN_Y + (r + 1) * CELL_H + WALL_T / 2 });
            }
    return { rects, segments };
}

// True iff every one of the ROWS*COLS cells can reach every other cell by
// walking through gaps in hWalls/vWalls. Used as a hard guarantee against
// closed-off pockets, regardless of which layout generator produced the walls.
function isFullyConnected(hWalls, vWalls) {
    const visited = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    visited[0][0] = true;
    const stack = [[0, 0]];
    let count = 1;
    while (stack.length) {
        const [r, c] = stack.pop();
        if (r > 0 && !hWalls[r][c] && !visited[r - 1][c]) { visited[r - 1][c] = true; count++; stack.push([r - 1, c]); }
        if (r < ROWS - 1 && !hWalls[r + 1][c] && !visited[r + 1][c]) { visited[r + 1][c] = true; count++; stack.push([r + 1, c]); }
        if (c > 0 && !vWalls[r][c] && !visited[r][c - 1]) { visited[r][c - 1] = true; count++; stack.push([r, c - 1]); }
        if (c < COLS - 1 && !vWalls[r][c + 1] && !visited[r][c + 1]) { visited[r][c + 1] = true; count++; stack.push([r, c + 1]); }
    }
    return count === ROWS * COLS;
}

function blankWalls() {
    // hWalls/vWalls start with only the outer frame closed, everything
    // interior open - callers add interior walls on top of this.
    const hWalls = Array.from({ length: ROWS + 1 }, (_, r) => Array(COLS).fill(r === 0 || r === ROWS));
    const vWalls = Array.from({ length: ROWS }, () => Array(COLS + 1).fill(false));
    for (let r = 0; r < ROWS; r++) { vWalls[r][0] = true; vWalls[r][COLS] = true; }
    return { hWalls, vWalls };
}

// Classic recursive-backtracker maze (spanning tree => always fully
// connected) plus some extra loop-openings so it isn't a pure dead-end tree.
function generateMazeType(loopChance = 0.15) {
    const hWalls = Array.from({ length: ROWS + 1 }, () => Array(COLS).fill(true));
    const vWalls = Array.from({ length: ROWS }, () => Array(COLS + 1).fill(true));
    const visited = Array.from({ length: ROWS }, () => Array(COLS).fill(false));

    function carve(r, c) {
        visited[r][c] = true;
        const dirs = [[-1, 0, "up"], [1, 0, "down"], [0, -1, "left"], [0, 1, "right"]];
        for (let i = dirs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
        }
        for (const [dr, dc, dir] of dirs) {
            const nr = r + dr, nc = c + dc;
            if (nr < 0 || nr >= ROWS || nc < 0 || nc >= COLS || visited[nr][nc]) continue;
            if (dir === "up") hWalls[r][c] = false;
            else if (dir === "down") hWalls[r + 1][c] = false;
            else if (dir === "left") vWalls[r][c] = false;
            else if (dir === "right") vWalls[r][c + 1] = false;
            carve(nr, nc);
        }
    }
    carve(Math.floor(Math.random() * ROWS), Math.floor(Math.random() * COLS));

    // open up some extra loops so it's not a pure dead-end tree maze
    for (let r = 1; r < ROWS; r++)
        for (let c = 0; c < COLS; c++)
            if (hWalls[r][c] && Math.random() < loopChance) hWalls[r][c] = false;
    for (let r = 0; r < ROWS; r++)
        for (let c = 1; c < COLS; c++)
            if (vWalls[r][c] && Math.random() < loopChance) vWalls[r][c] = false;

    return { hWalls, vWalls };
}

// Wide open field, only a handful of scattered wall segments (mixed
// horizontal/vertical). Each candidate wall is only kept if it doesn't cut
// off any pocket of cells - with just 10 walls in ~93 possible slots this
// almost never has to reject one, but the check keeps the guarantee airtight.
function generateEmptyLandsType() {
    const { hWalls, vWalls } = blankWalls();
    const TARGET_WALLS = 10;
    let placed = 0, attempts = 0;
    while (placed < TARGET_WALLS && attempts < 400) {
        attempts++;
        const horizontal = Math.random() < 0.5;
        if (horizontal) {
            const r = 1 + Math.floor(Math.random() * (ROWS - 1));
            const c = Math.floor(Math.random() * COLS);
            if (hWalls[r][c]) continue;
            hWalls[r][c] = true;
            if (isFullyConnected(hWalls, vWalls)) placed++;
            else hWalls[r][c] = false;
        } else {
            const r = Math.floor(Math.random() * ROWS);
            const c = 1 + Math.floor(Math.random() * (COLS - 1));
            if (vWalls[r][c]) continue;
            vWalls[r][c] = true;
            if (isFullyConnected(hWalls, vWalls)) placed++;
            else vWalls[r][c] = false;
        }
    }
    return { hWalls, vWalls };
}

// Only horizontal wall segments (no interior vertical walls at all), laid
// out as near-full lines across a row with one or two random gaps so every
// row always stays reachable from its neighbors.
function generateHorizontalLinesType() {
    const { hWalls, vWalls } = blankWalls(); // vWalls interior stays false: no vertical walls
    for (let r = 1; r < ROWS; r++) {
        if (Math.random() < 0.65) {
            for (let c = 0; c < COLS; c++) hWalls[r][c] = true;
            const gaps = Math.random() < 0.7 ? 1 : 2;
            const cols = [...Array(COLS).keys()];
            for (let i = 0; i < gaps; i++) {
                const idx = Math.floor(Math.random() * cols.length);
                hWalls[r][cols[idx]] = false;
                cols.splice(idx, 1);
            }
        }
    }
    // Safety net: by construction every row boundary keeps >=1 gap, so this
    // should always already be true - but if it somehow isn't, force it open
    // rather than ship a broken map.
    if (!isFullyConnected(hWalls, vWalls)) {
        for (let r = 1; r < ROWS; r++) hWalls[r][Math.floor(Math.random() * COLS)] = false;
    }
    return { hWalls, vWalls };
}

// ---------- extra arena types: solid blocks, mixed, islands ----------
const MAX_SOLID_FRAC_BLOCKS = 0.40; // "solid blocks" map: at most 40% of tiles
const MAX_SOLID_FRAC_MIXED = 0.15;  // "mixed" map: at most 15% of tiles
const ISLAND_COUNT = 4;

// Connectivity over CELLS, treating solid-block cells as removed. Walls still
// separate neighbours. Guarantees every non-block tile can reach every other.
function cellsConnected(hWalls, vWalls, blk) {
    let start = null, total = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (!blk[r][c]) { total++; if (!start) start = [r, c]; }
    if (!start) return false;
    const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    seen[start[0]][start[1]] = true;
    const stack = [start];
    let count = 1;
    const visit = (r, c) => { if (!blk[r][c] && !seen[r][c]) { seen[r][c] = true; count++; stack.push([r, c]); } };
    while (stack.length) {
        const [r, c] = stack.pop();
        if (r > 0 && !hWalls[r][c]) visit(r - 1, c);
        if (r < ROWS - 1 && !hWalls[r + 1][c]) visit(r + 1, c);
        if (c > 0 && !vWalls[r][c]) visit(r, c - 1);
        if (c < COLS - 1 && !vWalls[r][c + 1]) visit(r, c + 1);
    }
    return count === total;
}

// Adds up to `count` solid blocks one at a time, rejecting any that would
// split the remaining open tiles into separate pockets.
function placeSolidBlocks(hWalls, vWalls, blk, count, cluster) {
    let placed = 0, attempts = 0;
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (placed < count && attempts < 800) {
        attempts++;
        let r, c;
        const existing = [];
        for (let rr = 0; rr < ROWS; rr++) for (let cc = 0; cc < COLS; cc++) if (blk[rr][cc]) existing.push([rr, cc]);
        if (cluster && existing.length && Math.random() < 0.6) {
            const e = existing[Math.floor(Math.random() * existing.length)];
            const d = dirs[Math.floor(Math.random() * 4)];
            r = e[0] + d[0]; c = e[1] + d[1];
            if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
        } else {
            r = Math.floor(Math.random() * ROWS); c = Math.floor(Math.random() * COLS);
        }
        if (blk[r][c]) continue;
        blk[r][c] = true;
        if (cellsConnected(hWalls, vWalls, blk)) placed++; else blk[r][c] = false;
    }
}

function blocksFromGrid(blk) {
    const out = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (blk[r][c]) out.push({ col: c, row: r });
    return out;
}

// No line walls at all - only solid blocks (up to 40% of the tiles).
function generateSolidBlocksType() {
    const { hWalls, vWalls } = blankWalls();
    const blk = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    const maxBlocks = Math.floor(ROWS * COLS * MAX_SOLID_FRAC_BLOCKS);
    const count = Math.max(10, maxBlocks - Math.floor(Math.random() * 10)); // 12..21 of 54
    placeSolidBlocks(hWalls, vWalls, blk, count, true);
    return { hWalls, vWalls, blocks: blocksFromGrid(blk) };
}

// Regular maze walls plus a few solid blocks (up to 15% of the tiles).
function generateMixedType() {
    const { hWalls, vWalls } = generateMazeType(0.28);
    const blk = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    const maxBlocks = Math.floor(ROWS * COLS * MAX_SOLID_FRAC_MIXED);
    const count = Math.max(4, maxBlocks - Math.floor(Math.random() * 3)); // 6..8 of 54
    placeSolidBlocks(hWalls, vWalls, blk, count, false);
    // drop line walls that touch a block so the two wall styles don't clutter each other
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (!blk[r][c]) continue;
        for (const rr of [r, r + 1]) if (rr !== 0 && rr !== ROWS) hWalls[rr][c] = false;
        for (const cc of [c, c + 1]) if (cc !== 0 && cc !== COLS) vWalls[r][cc] = false;
    }
    return { hWalls, vWalls, blocks: blocksFromGrid(blk) };
}

// Water everywhere except ISLAND_COUNT separate land blobs. Islands never
// touch each other (not even diagonally), so each is ringed by water.
function generateIslandsType() {
    const { hWalls, vWalls } = blankWalls();
    const dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let land = null;
    for (let attempt = 0; attempt < 400 && !land; attempt++) {
        const id = Array.from({ length: ROWS }, () => Array(COLS).fill(-1));
        const cells = [];
        let ok = true;
        const touchesOther = (r, c, me) => {
            for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                const rr = r + dr, cc = c + dc;
                if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) continue;
                if (id[rr][cc] !== -1 && id[rr][cc] !== me) return true;
            }
            return false;
        };
        for (let i = 0; i < ISLAND_COUNT && ok; i++) {
            const opts = [];
            for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
                if (id[r][c] !== -1) continue;
                let far = true;
                for (let j = 0; j < i; j++) if (Math.max(Math.abs(cells[j][0][0] - r), Math.abs(cells[j][0][1] - c)) < 3) far = false;
                if (far) opts.push([r, c]);
            }
            if (!opts.length) { ok = false; break; }
            const s0 = opts[Math.floor(Math.random() * opts.length)];
            id[s0[0]][s0[1]] = i;
            cells.push([s0]);
        }
        if (!ok) continue;
        const targets = cells.map(() => 3 + Math.floor(Math.random() * 4)); // 3..6 tiles each
        for (let i = 0; i < ISLAND_COUNT; i++) {
            for (let tries = 0; tries < 60 && cells[i].length < targets[i]; tries++) {
                const base = cells[i][Math.floor(Math.random() * cells[i].length)];
                const d = dirs4[Math.floor(Math.random() * 4)];
                const r = base[0] + d[0], c = base[1] + d[1];
                if (r < 0 || r >= ROWS || c < 0 || c >= COLS || id[r][c] !== -1 || touchesOther(r, c, i)) continue;
                id[r][c] = i; cells[i].push([r, c]);
            }
            if (cells[i].length < 3) ok = false;
        }
        if (ok) land = id;
    }
    if (!land) { // guaranteed fallback: four 2x2 islands
        land = Array.from({ length: ROWS }, () => Array(COLS).fill(-1));
        [[0, 1], [0, 6], [3, 1], [3, 6]].forEach(([r0, c0], i) => { for (let r = r0; r < r0 + 2; r++) for (let c = c0; c < c0 + 2; c++) land[r][c] = i; });
    }
    const water = land.map(row => row.map(v => v === -1));
    return { hWalls, vWalls, water };
}

// Two big landmasses split by a winding river (max 30% water) plus a few regular walls.
function generateWaterWallsType() {
    const maxWater = Math.floor(ROWS * COLS * 0.30);
    const comps = (water) => {
        const seen = Array.from({ length: ROWS }, () => Array(COLS).fill(false)); const sizes = [];
        for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
            if (water[r][c] || seen[r][c]) continue;
            let n = 0; const st = [[r, c]]; seen[r][c] = true;
            while (st.length) { const [a, b] = st.pop(); n++;
                for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const x = a + dr, y = b + dc;
                    if (x < 0 || y < 0 || x >= ROWS || y >= COLS || water[x][y] || seen[x][y]) continue; seen[x][y] = true; st.push([x, y]); } }
            sizes.push(n);
        }
        return sizes;
    };
    let water = null;
    for (let attempt = 0; attempt < 500 && !water; attempt++) {
        const w = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
        const step = () => { const v = Math.random(); return v < 0.35 ? -1 : v < 0.7 ? 1 : 0; };
        if (Math.random() < 0.5) { // river runs top to bottom
            let c = 3 + Math.floor(Math.random() * 3);
            for (let r = 0; r < ROWS; r++) {
                w[r][c] = true;
                const nc = Math.min(COLS - 3, Math.max(2, c + step()));
                for (let k = Math.min(c, nc); k <= Math.max(c, nc); k++) w[r][k] = true;
                c = nc;
            }
        } else { // river runs left to right
            let r = 2 + Math.floor(Math.random() * 2);
            for (let c = 0; c < COLS; c++) {
                w[r][c] = true;
                const nr = Math.min(ROWS - 2, Math.max(1, r + step()));
                for (let k = Math.min(r, nr); k <= Math.max(r, nr); k++) w[k][c] = true;
                r = nr;
            }
        }
        let count = 0; for (const row of w) for (const v of row) if (v) count++;
        const sizes = comps(w);
        if (count <= maxWater && sizes.length === 2 && Math.min(...sizes) >= 12) water = w;
    }
    if (!water) { water = Array.from({ length: ROWS }, () => Array(COLS).fill(false)); for (let r = 0; r < ROWS; r++) water[r][4] = true; }
    const { hWalls, vWalls } = generateEmptyLandsType(); // low density regular walls
    return { hWalls, vWalls, water };
}

// Medium-density maze walls plus 2-3 small separate lakes (under 15% water).
function generateLakesType() {
    const { hWalls, vWalls } = generateMazeType(0.4);
    const maxWater = Math.min(Math.floor(ROWS * COLS * 0.15), 8);
    const dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let water = null;
    for (let attempt = 0; attempt < 300 && !water; attempt++) {
        const id = Array.from({ length: ROWS }, () => Array(COLS).fill(-1));
        const lakes = 2 + Math.floor(Math.random() * 2);
        const near = (r, c, me) => { for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
            const x = r + dr, y = c + dc; if (x < 0 || y < 0 || x >= ROWS || y >= COLS) continue;
            if (id[x][y] !== -1 && id[x][y] !== me) return true; } return false; };
        let total = 0, ok = true;
        for (let i = 0; i < lakes && ok; i++) {
            const size = 1 + Math.floor(Math.random() * 3); // 1..3 tiles
            let seed = null;
            for (let t = 0; t < 60 && !seed; t++) {
                const r = Math.floor(Math.random() * ROWS), c = Math.floor(Math.random() * COLS);
                if (id[r][c] === -1 && !near(r, c, i)) seed = [r, c];
            }
            if (!seed) { ok = false; break; }
            const cells = [seed]; id[seed[0]][seed[1]] = i;
            for (let t = 0; t < 40 && cells.length < size; t++) {
                const b = cells[Math.floor(Math.random() * cells.length)], d = dirs4[Math.floor(Math.random() * 4)];
                const r = b[0] + d[0], c = b[1] + d[1];
                if (r < 0 || c < 0 || r >= ROWS || c >= COLS || id[r][c] !== -1 || near(r, c, i)) continue;
                id[r][c] = i; cells.push([r, c]);
            }
            total += cells.length;
        }
        if (ok && total <= maxWater && total >= 4) water = id.map(row => row.map(v => v !== -1));
    }
    if (!water) { water = Array.from({ length: ROWS }, () => Array(COLS).fill(false)); water[1][1] = water[1][2] = water[4][6] = water[4][7] = true; }
    return { hWalls, vWalls, water };
}

function generateMaze() {
    const types = ["empty", "horizontal", "maze", "blocks", "mixed", "islands", "waterwalls", "lakes"];
    const type = types[Math.floor(Math.random() * types.length)];
    const gen = type === "empty" ? generateEmptyLandsType
        : type === "horizontal" ? generateHorizontalLinesType
        : type === "maze" ? generateMazeType
        : type === "blocks" ? generateSolidBlocksType
        : type === "mixed" ? generateMixedType
        : type === "waterwalls" ? generateWaterWallsType
        : type === "lakes" ? generateLakesType
        : generateIslandsType;
    const out = gen();
    const geo = wallsToGeometry(out.hWalls, out.vWalls);
    geo.blocks = out.blocks || [];
    geo.water = out.water || null;
    geo.type = type;
    return geo;
}

// Solid blocks: whole-tile obstacles with no health. Only a black hole removes them.
let solidBlocks = [];   // {col,row,rect}
let solidSegments = []; // exposed block edges (bullet bounce centerlines)
let waterGrid = null;   // waterGrid[row][col] === true for water tiles (null = no water this round)
let mapType = "empty";

function rebuildSolidSegments() {
    const has = (c, r) => solidBlocks.some(b => b.col === c && b.row === r);
    solidSegments = [];
    for (const b of solidBlocks) {
        const x0 = MARGIN_X + b.col * CELL_W, y0 = MARGIN_Y + b.row * CELL_H, x1 = x0 + CELL_W, y1 = y0 + CELL_H;
        if (!has(b.col, b.row - 1)) solidSegments.push({ x1: x0, y1: y0, x2: x1, y2: y0 });
        if (!has(b.col + 1, b.row)) solidSegments.push({ x1: x1, y1: y0, x2: x1, y2: y1 });
        if (!has(b.col, b.row + 1)) solidSegments.push({ x1: x1, y1: y1, x2: x0, y2: y1 });
        if (!has(b.col - 1, b.row)) solidSegments.push({ x1: x0, y1: y1, x2: x0, y2: y0 });
    }
}
function applyMap(m) {
    mazeWalls = m.rects; mazeSegments = m.segments;
    solidBlocks = (m.blocks || []).map(b => ({ col: b.col, row: b.row, rect: tileRectOf(b.col, b.row) }));
    rebuildSolidSegments();
    waterGrid = m.water || null;
    mapType = m.type || "empty";
}
function isBlockCell(c, r) { return solidBlocks.some(b => b.col === c && b.row === r); }
function isWaterCell(c, r) { return !!(waterGrid && waterGrid[r] && waterGrid[r][c]); }
function isWaterAt(x, y) {
    if (!waterGrid) return false;
    const c = Math.min(COLS - 1, Math.max(0, Math.floor((x - MARGIN_X) / CELL_W)));
    const r = Math.min(ROWS - 1, Math.max(0, Math.floor((y - MARGIN_Y) / CELL_H)));
    return waterGrid[r][c];
}
// tiles tanks may spawn on: not a block, not water
function landCells() { return CELL_CENTERS.filter(cc => !isBlockCell(cc.col, cc.row) && !isWaterCell(cc.col, cc.row)); }

const WATER_TANK_SPEED = 0.3;   // fraction of base speed in water (nitro restores regular speed)
const WATER_BULLET_SPEED = 0.5; // bullets slow to this in water
const WATER_GRACE_MS = 6000;    // time in water before drowning starts
const WATER_DAMAGE = 10, WATER_DAMAGE_INTERVAL = 1000;

let mazeWalls = [], mazeSegments = [];
applyMap(generateMaze());

function pickDistinctSpawns(n) {
    const arr = landCells();
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, n);
}

// ---------- collision helpers ----------
function circleRectCollide(x, y, radius, rect) {
    const closestX = Math.max(rect.x, Math.min(x, rect.x + rect.w));
    const closestY = Math.max(rect.y, Math.min(y, rect.y + rect.h));
    const dx = x - closestX, dy = y - closestY;
    return (dx * dx + dy * dy) < radius * radius;
}

// Squared distance from point (px,py) to the nearest point on segment (x1,y1)-(x2,y2).
// Used to test a tank against one leg of the bouncing laser's drawn trail.
function pointSegmentDistSq(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 0 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    const ddx = px - cx, ddy = py - cy;
    return ddx * ddx + ddy * ddy;
}
function pointInRect(x, y, rect) {
    return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

// True if a circle (targetX,targetY,targetRadius) overlaps the flamethrower's
// cone: a rectangle running from the tank's edge out to `length`, as wide as
// the tank, aligned with the tank's current facing angle. Works by rotating
// the target into the cone's local frame, then doing a plain circle-vs-AABB
// check there.
function inFlameCone(p, targetX, targetY, targetRadius, length) {
    if (length <= 0) return false;
    const cosA = Math.cos(p.a), sinA = Math.sin(p.a);
    const dx = targetX - p.x, dy = targetY - p.y;
    const localX = dx * cosA + dy * sinA;
    const localY = -dx * sinA + dy * cosA;
    const halfWidth = TANK_RADIUS;
    const closestX = Math.max(TANK_RADIUS, Math.min(localX, TANK_RADIUS + length));
    const closestY = Math.max(-halfWidth, Math.min(localY, halfWidth));
    const ddx = localX - closestX, ddy = localY - closestY;
    return (ddx * ddx + ddy * ddy) < targetRadius * targetRadius;
}

function tileRectOf(col, row) {
    return { x: MARGIN_X + col * CELL_W, y: MARGIN_Y + row * CELL_H, w: CELL_W, h: CELL_H };
}

// The 4 boundary edges of a tile, used as bounce-physics centerlines for a
// player-placed wall (which fills the whole cell, unlike a normal maze wall).
function wallSegmentsForTile(col, row) {
    const x0 = MARGIN_X + col * CELL_W, y0 = MARGIN_Y + row * CELL_H;
    const x1 = x0 + CELL_W, y1 = y0 + CELL_H;
    return [
        { x1: x0, y1: y0, x2: x1, y2: y0 },
        { x1: x1, y1: y0, x2: x1, y2: y1 },
        { x1: x1, y1: y1, x2: x0, y2: y1 },
        { x1: x0, y1: y1, x2: x0, y2: y0 }
    ];
}

function damageWall(wall, amount) {
    wall.hp -= amount;
    if (wall.hp <= 0) placedWalls = placedWalls.filter(w => w.id !== wall.id);
}

// After a bullet bounces, check whether it was a player-placed wall it just
// bounced off (rather than a permanent maze wall) and damage it if so. Uses
// a slightly generous radius since resolveBulletAgainstSegments pushes the
// bullet just outside its exact collision radius after resolving.
function checkWallBounceDamage(b, radius, bouncesBefore, damageAmount) {
    if (b.bounces <= bouncesBefore) return;
    const effRadius = radius + WALL_T / 2 + 2;
    for (const w of placedWalls) {
        if (circleRectCollide(b.x, b.y, effRadius, w.rect)) {
            damageWall(w, damageAmount);
            break;
        }
    }
}

// Marches outward from a tank along its facing direction to find the
// nearest grid cell that the tank's own body doesn't currently overlap -
// used for the "black hole" powerup's always-on target reticle.
function computeFrontTile(p) {
    const cosA = Math.cos(p.a), sinA = Math.sin(p.a);
    const maxD = TILE_SIZE * 6;
    for (let d = 0; d < maxD; d += 8) {
        const px = p.x + cosA * d, py = p.y + sinA * d;
        const col = Math.min(COLS - 1, Math.max(0, Math.floor((px - MARGIN_X) / CELL_W)));
        const row = Math.min(ROWS - 1, Math.max(0, Math.floor((py - MARGIN_Y) / CELL_H)));
        if (!circleRectCollide(p.x, p.y, TANK_RADIUS, tileRectOf(col, row))) return { col, row };
    }
    return null;
}

// Removes the (up to) 4 wall segments bordering a tile, both from the
// collision rects and the bounce-physics centerlines, skipping any that are
// part of the indestructible outer frame.
function destroyNeighboringWalls(col, row) {
    const rectCandidates = [];
    const segCandidates = [];
    if (row !== 0) {
        rectCandidates.push({ x: MARGIN_X + col * CELL_W - WALL_T / 2, y: MARGIN_Y + row * CELL_H - WALL_T / 2, w: CELL_W + WALL_T, h: WALL_T });
        const y = MARGIN_Y + row * CELL_H;
        segCandidates.push({ x1: MARGIN_X + col * CELL_W - WALL_T / 2, y1: y, x2: MARGIN_X + (col + 1) * CELL_W + WALL_T / 2, y2: y });
    }
    if (row + 1 !== ROWS) {
        rectCandidates.push({ x: MARGIN_X + col * CELL_W - WALL_T / 2, y: MARGIN_Y + (row + 1) * CELL_H - WALL_T / 2, w: CELL_W + WALL_T, h: WALL_T });
        const y = MARGIN_Y + (row + 1) * CELL_H;
        segCandidates.push({ x1: MARGIN_X + col * CELL_W - WALL_T / 2, y1: y, x2: MARGIN_X + (col + 1) * CELL_W + WALL_T / 2, y2: y });
    }
    if (col !== 0) {
        rectCandidates.push({ x: MARGIN_X + col * CELL_W - WALL_T / 2, y: MARGIN_Y + row * CELL_H - WALL_T / 2, w: WALL_T, h: CELL_H + WALL_T });
        const x = MARGIN_X + col * CELL_W;
        segCandidates.push({ x1: x, y1: MARGIN_Y + row * CELL_H - WALL_T / 2, x2: x, y2: MARGIN_Y + (row + 1) * CELL_H + WALL_T / 2 });
    }
    if (col + 1 !== COLS) {
        rectCandidates.push({ x: MARGIN_X + (col + 1) * CELL_W - WALL_T / 2, y: MARGIN_Y + row * CELL_H - WALL_T / 2, w: WALL_T, h: CELL_H + WALL_T });
        const x = MARGIN_X + (col + 1) * CELL_W;
        segCandidates.push({ x1: x, y1: MARGIN_Y + row * CELL_H - WALL_T / 2, x2: x, y2: MARGIN_Y + (row + 1) * CELL_H + WALL_T / 2 });
    }
    const closeRect = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01;
    const closeSeg = (a, b) => Math.abs(a.x1 - b.x1) < 0.01 && Math.abs(a.y1 - b.y1) < 0.01 && Math.abs(a.x2 - b.x2) < 0.01 && Math.abs(a.y2 - b.y2) < 0.01;
    mazeWalls = mazeWalls.filter(w => !rectCandidates.some(c => closeRect(w, c)));
    mazeSegments = mazeSegments.filter(s => !segCandidates.some(c => closeSeg(s, c)));
}

function safeTileHit(x, y, radius) {
    for (const st of safeTiles) if (circleRectCollide(x, y, radius, st.rect)) return true;
    return false;
}
function rectTouchesSafeTile(cx, cy, half) {
    for (const st of safeTiles) {
        const r = st.rect;
        if (cx + half > r.x && cx - half < r.x + r.w && cy + half > r.y && cy - half < r.y + r.h) return true;
    }
    return false;
}

function collidesAny(x, y, radius) {
    for (const w of mazeWalls) if (circleRectCollide(x, y, radius, w)) return true;
    for (const b of solidBlocks) if (circleRectCollide(x, y, radius, b.rect)) return true;
    for (const w of placedWalls) if (circleRectCollide(x, y, radius, w.rect)) return true;
    return false;
}

// Applies the same rotation + forward/back movement math as a normal tank's
// own input, but onto `target` using someone else's (ctrl's) up/down/left/right
// - used while "hacking" powerup control is redirected to an enemy tank.
function driveTankMovement(target, ctrl, nitroActive) {
    const speed = isWaterAt(target.x, target.y) ? (nitroActive ? BASE_SPEED : BASE_SPEED * WATER_TANK_SPEED) : BASE_SPEED * (nitroActive ? NITRO_MULT : 1);
    const rot = BASE_ROT * (nitroActive ? NITRO_MULT : 1);
    if (ctrl.left) target.a -= rot;
    if (ctrl.right) target.a += rot;
    let nx = target.x, ny = target.y;
    if (ctrl.up) { nx += Math.cos(target.a) * speed; ny += Math.sin(target.a) * speed; }
    if (ctrl.down) { nx -= Math.cos(target.a) * speed; ny -= Math.sin(target.a) * speed; }
    if (!collidesAny(nx, target.y, TANK_RADIUS)) target.x = nx;
    if (!collidesAny(target.x, ny, TANK_RADIUS)) target.y = ny;
}

// Ray (ox,oy)+t*(dx,dy) vs an axis-aligned rect, standard slab method.
// Returns the entry distance t, or null if the ray misses the rect entirely.
function rayRectIntersect(ox, oy, dx, dy, rect) {
    const invDx = dx !== 0 ? 1 / dx : Infinity;
    const invDy = dy !== 0 ? 1 / dy : Infinity;
    let tx1 = (rect.x - ox) * invDx, tx2 = (rect.x + rect.w - ox) * invDx;
    let tmin = Math.min(tx1, tx2), tmax = Math.max(tx1, tx2);
    let ty1 = (rect.y - oy) * invDy, ty2 = (rect.y + rect.h - oy) * invDy;
    tmin = Math.max(tmin, Math.min(ty1, ty2));
    tmax = Math.min(tmax, Math.max(ty1, ty2));
    if (tmax < 0 || tmin > tmax) return null;
    return tmin >= 0 ? tmin : 0;
}

// Distance from (x,y) along direction (dx,dy) to the nearest wall, capped at
// maxDist. Used so beam weapons stop dead at a wall instead of passing
// through it.
// Returns the stopping distance for a ray, and (if the closest thing hit was
// a player-placed wall rather than a permanent maze wall) the wall itself,
// so the caller can damage it.
function raycastWalls(x, y, dx, dy, maxDist) {
    let closest = maxDist;
    let hitWall = null;
    for (const w of mazeWalls) {
        const t = rayRectIntersect(x, y, dx, dy, w);
        if (t !== null && t < closest) { closest = t; hitWall = null; }
    }
    for (const b of solidBlocks) {
        const t = rayRectIntersect(x, y, dx, dy, b.rect);
        if (t !== null && t < closest) { closest = t; hitWall = null; }
    }
    for (const w of placedWalls) {
        const t = rayRectIntersect(x, y, dx, dy, w.rect);
        if (t !== null && t < closest) { closest = t; hitWall = w; }
    }
    for (const st of safeTiles) {
        const t = rayRectIntersect(x, y, dx, dy, st.rect);
        if (t !== null && t < closest) { closest = t; hitWall = null; }
    }
    return { dist: closest, wall: hitWall };
}
function normalizeAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

// Closest point on a line segment to (px,py) - the standard, exact building
// block for circle-vs-segment collision. Unlike testing against a rectangle,
// this handles a flat wall face AND a wall's corner/end point with the same
// formula: if the closest point falls strictly between the two endpoints the
// normal is perpendicular to the wall (a normal bounce); if it falls at an
// endpoint the normal points radially away from that point (a correct corner
// bounce). No shape-guessing, so grazing/sharp angles and corners all behave
// physically instead of needing special-cased heuristics.
function closestPointOnSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq > 1e-9 ? ((px - x1) * dx + (py - y1) * dy) / lenSq : 0;
    t = Math.max(0, Math.min(1, t));
    return { x: x1 + t * dx, y: y1 + t * dy };
}

// Resolves any wall(s) currently overlapping the bullet at its exact current
// position, reflecting about the true geometric normal each time. Runs a
// couple of iterations so a bullet touching two segments at once (a real
// corner) settles in place rather than oscillating between them.
// Resolves any wall(s) currently overlapping the bullet at its exact current
// position. Only reflects (flips velocity) when the bullet is actually
// moving INTO the wall along the surface normal (dot < 0); if it's grazing
// alongside a wall or already moving away from it but still geometrically
// touching (common when traveling nearly parallel to a wall), it's just
// gently pushed clear without touching velocity. Without this distinction,
// a shallow graze re-triggers "collision" on every sub-step even though the
// bullet isn't actually hitting anything new, which is what made bullets
// look "stuck sliding along the wall" and burn through all their bounces
// in a fraction of a second.
function resolveBulletAgainstSegments(b, effRadius) {
    let bounced = false;
    for (let iter = 0; iter < 3; iter++) {
        let best = null, bestDist = Infinity;
        for (const seg of mazeSegments) {
            const cp = closestPointOnSegment(b.x, b.y, seg.x1, seg.y1, seg.x2, seg.y2);
            const dx = b.x - cp.x, dy = b.y - cp.y;
            const dist = Math.hypot(dx, dy);
            if (dist < effRadius && dist < bestDist) { bestDist = dist; best = { dx, dy, dist }; }
        }
        for (const seg of solidSegments) {
            const cp = closestPointOnSegment(b.x, b.y, seg.x1, seg.y1, seg.x2, seg.y2);
            const dx = b.x - cp.x, dy = b.y - cp.y;
            const dist = Math.hypot(dx, dy);
            if (dist < effRadius && dist < bestDist) { bestDist = dist; best = { dx, dy, dist }; }
        }
        for (const w of placedWalls) {
            for (const seg of w.segments) {
                const cp = closestPointOnSegment(b.x, b.y, seg.x1, seg.y1, seg.x2, seg.y2);
                const dx = b.x - cp.x, dy = b.y - cp.y;
                const dist = Math.hypot(dx, dy);
                if (dist < effRadius && dist < bestDist) { bestDist = dist; best = { dx, dy, dist }; }
            }
        }
        if (!best) break;
        let nx, ny;
        if (best.dist < 1e-6) {
            const spd = Math.hypot(b.vx, b.vy) || 1;
            nx = -b.vx / spd; ny = -b.vy / spd;
        } else {
            nx = best.dx / best.dist; ny = best.dy / best.dist;
        }
        const penetration = effRadius - best.dist;
        const dot = b.vx * nx + b.vy * ny;
        if (dot < -0.01) {
            // genuinely approaching this surface - real bounce
            b.x += nx * (penetration + 0.1);
            b.y += ny * (penetration + 0.1);
            b.vx -= 2 * dot * nx;
            b.vy -= 2 * dot * ny;
            bounced = true;
        } else {
            // grazing / already moving away - just stay clear, no reflection
            b.x += nx * (penetration + 0.1);
            b.y += ny * (penetration + 0.1);
        }
    }
    return bounced;
}

// Moves a normal bullet for one tick, split into short sub-steps so a fast
// bullet crossing a thin wall at a shallow/grazing angle can't skip past it
// between one frame and the next (tunneling) - each sub-step is small enough
// that the bullet is only ever touching a wall by a little bit when contact
// is first detected, which keeps the reflection normal accurate.
function moveBulletWithBounce(b, radius, ignoreWater) {
    const effRadius = radius + WALL_T / 2; // walls are collided against their centerline
    const SUBSTEPS = Math.max(4, Math.ceil(Math.hypot(b.vx, b.vy) / 3.5)); // faster bullets get more sub-steps
    const wm = (!ignoreWater && isWaterAt(b.x, b.y)) ? WATER_BULLET_SPEED : 1; // bullets crawl through water
    const stepX = b.vx * wm / SUBSTEPS, stepY = b.vy * wm / SUBSTEPS;
    let bouncedThisTick = false;
    for (let s = 0; s < SUBSTEPS; s++) {
        b.x += stepX; b.y += stepY;
        if (resolveBulletAgainstSegments(b, effRadius)) bouncedThisTick = true;
    }
    if (bouncedThisTick) b.bounces++;
    // final safety net: a bullet must never end up outside the playfield
    if (b.x < radius) { b.x = radius; b.vx = Math.abs(b.vx); }
    if (b.x > ARENA_W - radius) { b.x = ARENA_W - radius; b.vx = -Math.abs(b.vx); }
    if (b.y < radius) { b.y = radius; b.vy = Math.abs(b.vy); }
    if (b.y > ARENA_H - radius) { b.y = ARENA_H - radius; b.vy = -Math.abs(b.vy); }
}

// ---------- tuning ----------
const COLORS = ["#e63946", "#2ecc71", "#3a86ff", "#ffd60a", "#fb8500", "#8338ec", "#ff5da2", "#8d5524"];
const COLOR_NAMES = {
    "#e63946": "Red", "#2ecc71": "Green", "#3a86ff": "Blue", "#ffd60a": "Yellow",
    "#fb8500": "Orange", "#8338ec": "Purple", "#ff5da2": "Pink", "#8d5524": "Brown"
};
const MAX_PLAYERS = 4;
const TANK_RADIUS = 15;
const BULLET_RADIUS = 4;
const BULLET_SPEED = 7;
const SHOT_COOLDOWN = 1200;
const MAX_BOUNCES = 20;
const BASE_SPEED = 3.2;
const BASE_ROT = 0.055 * 1.15 * 1.10;

const NITRO_DURATION = 20000, NITRO_MULT = 1.6;
const LASER_CHARGE_TIME = 1500, LASER_VISUAL_TIME = 220, LASER_RANGE = 1600;
const LASER_HALF_WIDTH = 11; // wide, easy-to-aim beam (~ a tank's width across)

const POWER_BEAM_SHOTS = 8; // shots granted per pickup - change this one number to rebalance
const POWER_BEAM_RANGE = 1600;
const POWER_BEAM_HALF_WIDTH = 6; // thin beam, much tighter than the regular laser
const POWER_BEAM_VISUAL_TIME = 200; // 0.2s
const POWER_BEAM_KNOCKBACK = 8; // px the tank is shoved backward on each shot

const MG_RADIUS = BULLET_RADIUS * 0.6; // 40% smaller than a regular bullet
const MG_SHOTS = 15; // bullets granted per pickup - change this one number to rebalance
const SHOTGUN_SHOTS = 5; // volleys granted per pickup
const SHOTGUN_SPREAD_DEG = 5; // side pellets are fired at +/- this angle
const MG_SPREAD_DEG = 2; // each shot's angle is randomized by +/- this many degrees

const TELEPORT_CURSOR_SPEED = 10; // px/tick the selection cursor moves while targeting (fast, ~3x tank speed)

const STARBULLET_BURST_COUNT = 8; // regular bullets spawned when the star bullet is detonated mid-flight
// time shield: held-space shield with 100 ammo. Blocks all damage except the "pierce" kinds
// (shock / airstrike / black hole), which still deal (1 - reduction) of their damage.
const TIMESHIELD_AMMO = 100;
const TIMESHIELD_TICK = 10; // ms between ammo drains while space is held
const TIMESHIELD_AMMO_PER_TICK = 1;
const TIMESHIELD_PIERCE_MULT = 0.7; // 30% less damage from shock / airstrike / black hole

// health orb: slow, huge, wall-ignoring projectile that heals whichever tank is closest to it
const HEALORB_RADIUS = 4 * 3; // 300% of a regular bullet (BULLET_RADIUS = 4)
const HEALORB_SPEED_MULT = 0.4; // of regular bullet speed
const HEALORB_TICK = 150; // ms between heals
const HEALORB_HP_PER_TICK = 1; // 1hp / 200ms = 5hp per second
const SUPERBULLET_SHOTS = 10; // bullets granted per pickup - change this one number to rebalance

const FASTBULLET_SHOTS = 10; // fast bullets granted per pickup
const FASTBULLET_SPEED_MULT = 2; // fast bullet speed = BULLET_SPEED * this - change this one number to adjust

const SUPERHEALTH_AMOUNT = 60; // HP every living player gets when someone picks up superhealth

const DRONE_SHOTS = 3; // shots the drone gets before it disappears
const DRONE_SPEED_MULT = 0.6; // drone speed = BASE_SPEED * this
const DRONE_SIZE = 22; // square side, same as the tank's shorter side
const DRONE_MAX_BOUNCES = 4; // drone bullets only bounce this many times

const CLEAN_ANIMATION_TIME = 1000; // 1s growing red wave; the actual wipe happens right as it finishes

const AIRSTRIKE_CURSOR_SPEED = 10; // same fast cursor movement as teleport
const AIRSTRIKE_FADE_TIME = 1000; // 1s tile fade-to-red; damage resolves the instant this ends
const AIRSTRIKE_EXPLOSION_TIME = 500; // 0.5s explosion visual after the fade
const AIRSTRIKE_DAMAGE = 90;

const BOUNCE_LASER_SPEED = BULLET_SPEED * 4; // 4x a regular bullet
const BOUNCE_LASER_RADIUS = 4; // thin beam - small collision radius for wall bounce physics
const BOUNCE_LASER_MAX_BOUNCES = 10;
const BOUNCE_LASER_DAMAGE = 60;

const HACK_CURSOR_SPEED = 10; // same fast free-flying cursor speed as teleport/airstrike
const HACK_DURATION = 7000; // 7s of controlling the enemy tank - change this one number to adjust
const SWAP_CURSOR_SPEED = 10;

const FREEZE_DURATION = 13000; // 13s - change this one number to adjust
const FREEZE_SPEED_MULT = 0.41; // movement & rotation speed while frozen (41% of normal)
const FREEZE_SHOT_MULT = 2; // regular-bullet cooldown multiplier while frozen (2x = half fire rate)

const SLIDE_DURATION = 17000; // 17s - change this one number to adjust
const SLIDE_FRICTION = 0.982; // per-tick velocity retention while sliding (higher = glides longer)
const SLIDE_MAX_SPEED_MULT = 0.9; // cap on glide speed, slightly slower than normal driving
const SLIDE_ROT_FRICTION = 0.9; // per-tick spin retention - steering overshoots and keeps turning
const SLIDE_MAX_ROT_MULT = 0.9; // cap on spin rate, slightly slower than normal turning

const CLONE_SPAWN_TIME = 200; // ms blue fade-in before the clone becomes controllable
const CLONE_HP = 30;

const SHOCK_STEP_TIME = 160; // ms per tile as the bolt travels
const SHOCK_DAMAGE = 50;

const DARKNESS_DURATION = 15000; // 15s
const CANNON_CAP_DURATION = 15000; // 15s of no regular bullets - change this one number to adjust
const TIME_STOP_DURATION = 15000; // 15s - change this one number to adjust

const BLACKHOLE_SHOTS = 4; // change this one number to rebalance
const BLACKHOLE_DAMAGE = 30;
const BLACKHOLE_COOLDOWN = 300; // ms - matches the 0.3s fade animation; can't fire again until it's done

const FLAMETHROWER_FUEL = 30; // change this one number to rebalance
const FLAME_GROW_TIME = 800; // ms to reach full length
const FLAME_TICK_INTERVAL = 100; // ms - shared cadence for both fuel drain and damage
const FLAME_FUEL_PER_TICK = 1;
const FLAME_DAMAGE_PER_TICK = 3;

const WATER_SHOTS = 5; // water powerup ammo
const WALL_SHOTS = 3; // change this one number to rebalance
const WALL_HP = 600;

const MAGNET_AMMO = 100; // ammo per magnet / antimagnet pickup
const MAGNET_TICK = 40; // ms between ammo drains while the beam is held
const MAGNET_AMMO_PER_TICK = 1;
const MAGNET_RANGE = 1500; // longer than the arena diagonal
const MAGNET_HALF_WIDTH = ((CELL_W + CELL_H) / 2) / 2; // beam is 1 tile thick
const JOKER_COLS = 6; // columns in the joker picker grid (client lays the grid out with this)

const MAX_HP = 100;const HEALTH_PACK_AMOUNT = 60;
const GHOST_DURATION = 30000; // 30s invisibility - change this one number to adjust
const DAMAGE = {
    bullet: 20,
    normal: 20, // alias - bullets fired without a special powerup carry type "normal"
    mg: 25,
    laser: 80,
    powerbeam: 40,
    homing: 50,
    rc: 60,
    abomb: 100,
    superbullet: 50,
    starbullet: 50,
    airstrike: 90,
    bouncelaser: 60,
    fastbullet: 30,
    drone: 20
};
// ---------- fun end-of-game stats (per real player, whole game) ----------
function statOwner(p) { return p && p.isClone ? (players[p.cloneOwnerId] || null) : p; } // clones count for their owner
function resetStats(p) { p.statShots = 0; p.statPowerups = 0; p.statDamage = 0; p.statDealt = 0; p.statSelfDamage = 0; p.statTiles = new Set(); }
function statAdd(p, key, n = 1) { const o = statOwner(p); if (o) o[key] = (o[key] || 0) + n; }
// attackerId = id of whoever caused it (player id, or the owner id of a clone); used for the
// "most damage dealt" / "most suicidal" stats. Damage to your own tank (or your own clone) is
// "self damage"; anything else counts as damage dealt by the attacker.
function applyDamage(pl, amount, attackerId, pierce) {
    if (pl.timeShieldActive) {
        if (!pierce) return; // time shield soaks everything else
        amount *= TIMESHIELD_PIERCE_MULT;
    }
    const real = Math.min(pl.hp, amount);
    statAdd(pl, "statDamage", real);
    const att = statOwner(players[attackerId]), vic = statOwner(pl);
    if (att && vic) { if (att === vic) att.statSelfDamage = (att.statSelfDamage || 0) + real; else att.statDealt = (att.statDealt || 0) + real; }
    pl.hp = Math.max(0, pl.hp - amount);
    if (pl.hp <= 0) pl.alive = false;
}
const HOMING_STRAIGHT_TIME = 2000, HOMING_CHASE_TIME = 10000;
const HOMING_SPEED = BASE_SPEED * 1.02, HOMING_TURN_RATE = 0.08, HOMING_RADIUS = 5;

const RC_SPEED = HOMING_SPEED * 1.3, RC_TURN_RATE = 0.12, RC_RADIUS = 6, RC_MAX_LIFETIME = 20000;

const ABOMB_RADIUS = BULLET_RADIUS * 2; // 200% scale bomb bullet
const ABOMB_FUSE_TIME = 8000; // explodes 8s after firing, regardless of bounces
const TILE_SIZE = (CELL_W + CELL_H) / 2;
const FLAME_MAX_LENGTH = TILE_SIZE * 3; // "3 tile long"
const SHRAPNEL_COUNT = 8;
const SHRAPNEL_MIN_DIST = TILE_SIZE * 0.5, SHRAPNEL_MAX_DIST = TILE_SIZE * 1.5;
const SHRAPNEL_BURST_TIME = 350; // ms to reach full distance
const SHRAPNEL_TOTAL_LIFE = 900; // ms the debris stays deadly for (~1s explosion)
const SHRAPNEL_RADIUS = 7; // collision radius of each shrapnel piece

const POWERUP_RADIUS = 10;
const POWERUP_FIRST_DELAY = 4000, POWERUP_INTERVAL = 12500, POWERUP_EXPIRE = 60000;
const POWERUP_MIN_GAP = 60; // don't spawn a new powerup this close to an existing one
const POWERUP_MIN_PLAYER_DIST = TILE_SIZE * 3; // powerups must spawn at least 3 tiles from every tank

const ROUND_LONELY_TIME = 3000, ROUND_END_PAUSE = 2000;
const WIN_SCORE = 10;

// ---------- game state ----------
let players = {};
let bullets = [];
let healthOrbs = []; // {id,x,y,vx,vy,owner,nextHealAt,targetId} - fly through everything, heal the closest tank
let nextHealthOrbId = 1;
let powerups = [];
let lasers = [];
let shrapnel = [];
let cleanEvents = []; // {id,x,y,spawnTime} - purely visual, broadcast to every client for the growing red wave
let pendingCleanses = []; // {triggerAt, activatorId} - the actual gameplay effect, applied once the wave finishes
let airstrikes = []; // {id,col,row,cx,cy,activatorId,confirmTime,damageApplied} - broadcast to everyone for the tile fade + explosion
let bounceLasers = []; // {id,ownerId,x,y,vx,vy,bounces,points,hitIds,done} - growing/bouncing damage trail
let blackHoles = []; // {id,col,row,triggerTime} - purely visual, broadcast for the 0.3s fade-out
let shocks = []; // {id,tiles,startTime,damagedUpTo} - travelling row/column bolt
let darknessUntil = 0, darknessOwnerId = null;
let nextShockId = 1, nextCloneSeq = 1;
let timeStopUntil = 0, timeStopOwnerId = null, simTimeOffset = 0, lastTickRealNow = null;
let placedWalls = []; // {id,col,row,hp,rect} - player-placed destructible obstacles
let safeTiles = []; // {id,col,row,rect,ownerId} - safetile zones
let nextSafeTileId = 1;
let nextPlayerId = 1, nextBulletId = 1, nextPowerupId = 1, nextExplosionId = 1, nextCleanEventId = 1, nextAirstrikeId = 1, nextBounceLaserId = 1, nextBlackHoleId = 1, nextWallId = 1;

let gamePhase = "lobby"; // lobby | round | roundend | gameover
let roundNumber = 0;
let roundEndTime = 0;
let roundEndInfo = null;
let lonelyStart = null;
let powerupNextSpawnAt = 0;
let gameWinner = null;
let paused = false;

// ---------- debug mode (browser-only, offline) ----------
// Activated by game.html when no server is reachable: empty arena, one
// player tank, a stationary training dummy, and every powerup laid out on
// its own tile. Picked/destroyed boxes restock on the same tile, and dead
// tanks respawn, so everything can be tested over and over.
let DEBUG = false;
const DEBUG_DUMMY = true; // stationary target tank - set false to test truly alone
const DEBUG_PLAYER_TILE = { col: 1, row: 5 };
const DEBUG_DUMMY_TILE = { col: 7, row: 4 };
const DEBUG_RESPAWN_DELAY = 2000; // ms after death before a tank comes back
const DEBUG_POWERUP_RESTOCK = 3000; // ms after a box disappears before it reappears
const debugSockets = new Set();
let debugSlots = []; // {type,x,y,puId,respawnAt}

const ALL_POWERUP_TYPES = ["nitro", "laser", "homing", "shield", "rc", "abomb", "powerbeam", "mg", "health", "teleport", "superbullet", "clean", "airstrike", "ghost", "bouncelaser", "hacking", "freeze", "blackhole", "flamethrower", "wall", "slide", "cannoncap", "clone", "shock", "darkness", "timestop", "swap", "fastbullet", "superhealth", "drone", "safetile", "joker", "magnet", "antimagnet", "slotmachine", "shotgun", "starbullet", "timeshield", "healthorb", "water"];
// everything the joker can hand out (all powerups except the joker itself) - add a type to ALL_POWERUP_TYPES and it shows up here automatically
const JOKER_CHOICES = ALL_POWERUP_TYPES.filter(t => t !== "joker");
// slot machine: 3 random picks out of everything except the slot machine itself
const SLOT_POOL = ALL_POWERUP_TYPES.filter(t => t !== "slotmachine");
const SLOT_CHOICE_COUNT = 3;
function rollSlotChoices() {
    const pool = SLOT_POOL.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    return pool.slice(0, SLOT_CHOICE_COUNT);
}

function tileCenter(col, row) {
    return { x: MARGIN_X + (col + 0.5) * CELL_W, y: MARGIN_Y + (row + 0.5) * CELL_H };
}
function debugMaze() {
    const { hWalls, vWalls } = blankWalls(); // only the outer frame
    return wallsToGeometry(hWalls, vWalls);
}
function debugPlacePowerup(slot) {
    const pu = { id: nextPowerupId++, type: slot.type, x: slot.x, y: slot.y, expiresAt: Infinity };
    powerups.push(pu);
    slot.puId = pu.id;
    slot.respawnAt = null;
}
function debugPlaceTank(p) {
    const t = p.isDummy ? DEBUG_DUMMY_TILE : DEBUG_PLAYER_TILE;
    const c = tileCenter(t.col, t.row);
    p.x = c.x; p.y = c.y;
    p.a = p.isDummy ? Math.PI : -Math.PI / 2;
}
function debugSetupRound(now) {
    powerupNextSpawnAt = Infinity; // no random spawns in debug
    for (const p of playersArray()) if (!p.isClone) debugPlaceTank(p);
    debugSlots = [];
    let i = 0;
    for (let r = 0; r < ROWS && i < ALL_POWERUP_TYPES.length; r++) {
        for (let c = 0; c < COLS && i < ALL_POWERUP_TYPES.length; c++) {
            const ctr = tileCenter(c, r);
            const slot = { type: ALL_POWERUP_TYPES[i++], x: ctr.x, y: ctr.y, puId: null, respawnAt: null };
            debugPlacePowerup(slot);
            debugSlots.push(slot);
        }
    }
}
function debugUpdate(now) {
    for (const p of realPlayers()) {
        if (p.alive) { p.debugRespawnAt = null; continue; }
        if (p.debugRespawnAt == null) { p.debugRespawnAt = now + DEBUG_RESPAWN_DELAY; continue; }
        if (now < p.debugRespawnAt) continue;
        resetPlayerState(p);
        debugPlaceTank(p);
        p.alive = true;
        p.debugRespawnAt = null;
    }
    for (const slot of debugSlots) {
        if (powerups.some(pu => pu.id === slot.puId)) continue;
        if (slot.respawnAt == null) { slot.respawnAt = now + DEBUG_POWERUP_RESTOCK; continue; }
        if (now < slot.respawnAt) continue;
        if (playersArray().some(pl => pl.alive && Math.hypot(pl.x - slot.x, pl.y - slot.y) < TANK_RADIUS + POWERUP_RADIUS + 10)) continue;
        debugPlacePowerup(slot);
    }
}

function usedColors() { return new Set(realPlayers().map(p => p.color)); }
function pickColor() {
    const used = usedColors();
    for (const c of COLORS) if (!used.has(c)) return c;
    return COLORS[0];
}
function playersArray() { return Object.values(players); }
// Clones live in `players` so every existing damage/collision system just
// works on them, but they must be invisible to lobby/host/colour/scoring logic.
function realPlayers() { return Object.values(players).filter(p => !p.isClone); }
function removeAllClones() {
    for (const id of Object.keys(players)) {
        if (players[id].isClone) delete players[id];
    }
    for (const p of Object.values(players)) p.cloneId = null;
}
function teamIdOf(p) { return p.isClone ? p.cloneOwnerId : p.id; }
function currentHostId() {
    const ids = realPlayers().map(p => p.id);
    return ids.length ? Math.min(...ids) : null;
}

function handleConnection(ws) {
    if (realPlayers().length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: "full" }));
        ws.close();
        return;
    }

    const id = nextPlayerId++;
    const spawnPool = landCells();
    const spawn = spawnPool[Math.floor(Math.random() * spawnPool.length)];

    players[id] = {
        id, x: spawn.x, y: spawn.y, a: 0,
        color: pickColor(),
        name: "",
        alive: gamePhase !== "round", // joiners mid-round wait as spectators for the next round
        hp: MAX_HP,
        score: 0,
        ready: false,
        up: false, down: false, left: false, right: false, shoot: false, prevShoot: false,
        lastShot: 0,
        nitroUntil: 0,
        ghostUntil: 0,
        frozenUntil: 0,
        slideUntil: 0, vx: 0, vy: 0, va: 0,
        cannonCapUntil: 0,
        cloneId: null, isClone: false, cloneOwnerId: null, cloneSpawnedAt: 0,
        powerup: null, // null | 'laser' | 'homing' | 'shield' | 'rc' | 'abomb' | 'powerbeam' | 'mg' | 'teleport' | 'superbullet' | 'clean' | 'airstrike' | 'ghost' | 'bouncelaser' | 'hacking' | 'freeze' | 'blackhole' | 'flamethrower' | 'wall' | 'slide' | 'cannoncap' | 'clone' | 'shock' | 'darkness' | 'timestop' | 'swap'
        laserCharging: false, laserChargeStart: 0,
        powerBeamShots: 0,
        mgShots: 0, shotgunShots: 0,
        superBulletShots: 0,
        fastBulletShots: 0,
        droneActive: false, droneX: 0, droneY: 0, droneShots: 0, droneArmed: false,
        blackHoleShots: 0,
        wallShots: 0,
        waterShots: 0,
        flameFuel: 0,
        flameStartTime: 0, // 0 = not currently holding fire; else when the current hold began
        flameNextTick: 0,
        timeShieldAmmo: 0, timeShieldNextTick: 0, timeShieldActive: false,
        starBulletId: null, // bullet id of this player's own live star bullet, if any - lets them burst it
        abombId: null, // bullet id of this player's own live a-bomb, if any - lets them detonate it early
        teleportTargeting: false, teleportCursorX: 0, teleportCursorY: 0,
        airstrikeTargeting: false, airstrikeCursorX: 0, airstrikeCursorY: 0, airstrikePending: false,
        hackTargeting: false, hackCursorX: 0, hackCursorY: 0,
        swapTargeting: false, swapCursorX: 0, swapCursorY: 0,
        hackingTargetId: null, // set on the hacker while actively driving someone else's tank
        hackedById: null, // set on the victim while someone else is driving their tank
        hackEndsAt: 0, // when the current hack session ends (meaningful on the hacker)
        jokerSelecting: false, jokerIndex: 0, jokerPrevDirs: null, slotChoices: null,
        statShots: 0, statPowerups: 0, statDamage: 0, statDealt: 0, statSelfDamage: 0, statTiles: new Set(), powerupCounted: false,
        magnetAmmo: 0, magnetNextTick: 0, magnetActive: false,
        rcRocketId: null,
        ws
    };

    console.log("Player " + id + " connected");
    ws.send(JSON.stringify({ type: "welcome", id }));

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message);
            const p = players[id];
            if (!p) return;
            if (data.type === "input" && data.input) {
                p.up = !!data.input.up;
                p.down = !!data.input.down;
                p.left = !!data.input.left;
                p.right = !!data.input.right;
                p.shoot = !!data.input.shoot;
            } else if (data.type === "ready") {
                if (!p.ready && (!p.name || p.name.length < 1)) {
                    // can't ready up without a name
                } else {
                    p.ready = !p.ready;
                }
            } else if (data.type === "setColor") {
                const color = String(data.color || "");
                if (COLORS.includes(color) && !realPlayers().some(pl => pl.id !== id && pl.color === color)) {
                    p.color = color;
                }
            } else if (data.type === "setName") {
                const name = String(data.name || "").trim().slice(0, 6);
                p.name = name;
            } else if (data.type === "selfdestruct") {
                // host only, mid-round: the host's own tank blows up
                if (id === currentHostId() && gamePhase === "round" && p.alive) { p.hp = 0; p.alive = false; }
            } else if (data.type === "pause") {
                if (id === currentHostId()) paused = !paused;
            } else if (data.type === "reset") {
                if (gamePhase === "gameover") {
                    for (const pl of playersArray()) { pl.score = 0; pl.ready = false; pl.alive = false; resetStats(pl); }
                    bullets = []; healthOrbs = []; powerups = []; lasers = []; shrapnel = []; cleanEvents = []; pendingCleanses = []; airstrikes = []; bounceLasers = []; blackHoles = []; placedWalls = []; safeTiles = []; shocks = []; darknessUntil = 0; darknessOwnerId = null; removeAllClones(); timeStopUntil = 0; timeStopOwnerId = null; simTimeOffset = 0;
                    gamePhase = "lobby";
                    gameWinner = null;
                }
            }
        } catch (e) {
            console.log("Bad message");
        }
    });

    ws.on("close", () => {
        console.log("Player " + id + " disconnected");
        if (players[id] && players[id].rcRocketId) {
            bullets = bullets.filter(b => b.id !== players[id].rcRocketId);
        }
        delete players[id];
        if (Object.keys(players).length === 0) {
            gamePhase = "lobby";
            bullets = []; healthOrbs = []; powerups = []; lasers = []; shrapnel = []; cleanEvents = []; pendingCleanses = []; airstrikes = []; bounceLasers = []; blackHoles = []; placedWalls = []; safeTiles = []; shocks = []; darknessUntil = 0; darknessOwnerId = null; removeAllClones(); timeStopUntil = 0; timeStopOwnerId = null; simTimeOffset = 0;
            paused = false;
        }
    });
    return id;
}
if (IS_NODE) wss.on("connection", handleConnection);

// ---------- round management ----------
function startRound(now) {
    applyMap(DEBUG ? debugMaze() : generateMaze());
    const list = playersArray();
    if (list.length === 0) { gamePhase = "lobby"; return; }
    const spawns = pickDistinctSpawns(list.length);
    list.forEach((p, i) => {
        p.alive = true;
        p.x = spawns[i].x; p.y = spawns[i].y;
        p.a = Math.random() * Math.PI * 2;
        resetPlayerState(p);
    });
    bullets = []; healthOrbs = []; powerups = []; lasers = []; shrapnel = []; cleanEvents = []; pendingCleanses = []; airstrikes = []; bounceLasers = []; blackHoles = []; placedWalls = []; safeTiles = []; shocks = []; darknessUntil = 0; darknessOwnerId = null; removeAllClones(); timeStopUntil = 0; timeStopOwnerId = null; simTimeOffset = 0;
    roundNumber++;
    gamePhase = "round";
    lonelyStart = null;
    powerupNextSpawnAt = now + POWERUP_FIRST_DELAY;
    if (DEBUG) debugSetupRound(now);
}

// Clears every per-round/per-life status on a tank (used at round start and for debug respawns).
function resetPlayerState(p) {
    p.waterSince = null; p.waterNextDmg = 0;
    p.nitroUntil = 0;
    p.ghostUntil = 0;
    p.frozenUntil = 0;
    p.slideUntil = 0;
    p.vx = 0;
    p.vy = 0;
    p.va = 0;
    p.cannonCapUntil = 0;
    p.cloneId = null;
    p.powerup = null;
    p.powerBeamShots = 0;
    p.mgShots = 0;
    p.shotgunShots = 0;
    p.superBulletShots = 0;
    p.fastBulletShots = 0;
    p.droneActive = false;
    p.droneShots = 0;
    p.blackHoleShots = 0;
    p.wallShots = 0;
    p.waterShots = 0;
    p.flameFuel = 0;
    p.flameStartTime = 0;
    p.flameNextTick = 0;
    p.abombId = null;
    p.starBulletId = null;
    p.timeShieldAmmo = 0; p.timeShieldNextTick = 0; p.timeShieldActive = false;
    p.teleportTargeting = false;
    p.airstrikeTargeting = false;
    p.airstrikePending = false;
    p.hackTargeting = false;
    p.hackingTargetId = null;
    p.hackedById = null;
    p.hackEndsAt = 0;
    p.swapTargeting = false;
    p.hp = MAX_HP;
    p.laserCharging = false;
    p.prevShoot = false;
    p.lastShot = 0;
    p.ready = false;
    p.rcRocketId = null;
    p.jokerSelecting = false;
    p.magnetAmmo = 0;
    p.magnetNextTick = 0;
    p.magnetActive = false;
    p.dragged = false;
    p.dragFull = false;
    p.droneDragged = false;
}

function computeGameStats() {
    const list = realPlayers().filter(q => q.statTiles);
    if (!list.length) return null;
    const most = (key) => {
        const q = list.reduce((a, b) => ((b[key] || 0) > (a[key] || 0) ? b : a));
        const value = Math.round(q[key] || 0);
        const others = list.filter(o => o !== q).map(o => ({ color: o.color, value: Math.round(o[key] || 0) })).sort((a, b) => b.value - a.value);
        return value > 0 ? { name: q.name || ("P" + q.id), color: q.color, value, others } : { name: "nobody", color: "#ffffff", value: 0, others: [] };
    };
    const lazy = list.reduce((a, b) => (b.statTiles.size < a.statTiles.size ? b : a));
    return {
        shots: most("statShots"),
        powerups: most("statPowerups"),
        dealt: most("statDealt"),
        damage: most("statDamage"),
        suicidal: most("statSelfDamage"),
        lazy: { name: lazy.name || ("P" + lazy.id), color: lazy.color, value: lazy.statTiles.size,
            others: list.filter(o => o !== lazy).map(o => ({ color: o.color, value: o.statTiles.size })).sort((a, b) => a.value - b.value) }
    };
}

function endRound(winnerId, now) {
    gamePhase = "roundend";
    roundEndTime = now;
    let winnerColor = null;
    if (winnerId != null && players[winnerId]) {
        const p = players[winnerId];
        p.score = (p.score || 0) + 1;
        winnerColor = p.color;
        if (p.score >= WIN_SCORE) {
            gamePhase = "gameover";
            gameWinner = { id: winnerId, color: p.color, colorName: COLOR_NAMES[p.color] || "Mystery", score: p.score, name: p.name || ("P" + winnerId), stats: computeGameStats() };
        }
    }
    roundEndInfo = { winnerId: winnerId || null, winnerColor };
}

function spawnPowerup(now) {
    powerupNextSpawnAt = now + POWERUP_INTERVAL; // schedule the next one regardless of outcome below
    const alive = playersArray().filter(p => p.alive);
    if (alive.length === 0) return;
    const candidates = [];
    for (const cell of CELL_CENTERS) {
        if (isBlockCell(cell.col, cell.row)) continue; // solid block tile (water tiles are fine)
        // don't stack a new powerup on top of one that's still sitting on the map
        if (powerups.some(pu => Math.hypot(pu.x - cell.x, pu.y - cell.y) < POWERUP_MIN_GAP)) continue;
        let minD = Infinity;
        for (const pl of alive) { const d = Math.hypot(cell.x - pl.x, cell.y - pl.y); if (d < minD) minD = d; }
        if (minD >= POWERUP_MIN_PLAYER_DIST) candidates.push(cell);
    }
    if (candidates.length === 0) return; // no free spot 3+ tiles from everyone this cycle, try again next interval
    const best = candidates[Math.floor(Math.random() * candidates.length)];
    const types = ALL_POWERUP_TYPES;
    const type = types[Math.floor(Math.random() * types.length)];
    powerups.push({ id: nextPowerupId++, type, x: best.x, y: best.y, expiresAt: now + POWERUP_EXPIRE });
}

// Finds how far along the tank's facing direction a projectile can spawn
// before it would already be touching a wall - prevents muzzle offsets from
// placing a bullet's spawn point past/inside a wall the tank is pressed up
// against (which was letting shots skip the wall entirely, since a bullet
// that spawns already clipped through never gets the chance to bounce off
// it). Doesn't touch the bounce physics itself, just clamps where a shot starts.
function safeMuzzleDistance(p, desired, radius) {
    const STEP = 3;
    let dist = 0;
    while (dist < desired) {
        const next = Math.min(dist + STEP, desired);
        const tx = p.x + Math.cos(p.a) * next, ty = p.y + Math.sin(p.a) * next;
        if (collidesAny(tx, ty, radius)) return dist;
        dist = next;
    }
    return desired;
}

function fireBullet(p, now) {
    statAdd(p, "statShots");
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, BULLET_RADIUS + WALL_T / 2);
    bullets.push({
        id: nextBulletId++, type: "normal",
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        vx: Math.cos(p.a) * BULLET_SPEED, vy: Math.sin(p.a) * BULLET_SPEED,
        owner: p.id, bounces: 0
    });
}

// Same physics as a regular bullet (see the shared "normal bullet" handling
// in updateRound), just smaller and each shot's angle is jittered a little
// for inaccuracy. One shot per key-press edge, not a hold-to-fire stream -
// that's enforced by the caller checking p.shoot && !p.prevShoot.
// One volley = 3 regular bullets (same type/damage/size as the default shot):
// straight ahead plus one rotated +5 and one -5 degrees.
function fireShotgun(p, now) {
    const baseA = p.a, spread = SHOTGUN_SPREAD_DEG * Math.PI / 180;
    for (const off of [0, spread, -spread]) {
        statAdd(p, "statShots");
        const a = baseA + off;
        p.a = a; // safeMuzzleDistance measures along p.a
        const d = safeMuzzleDistance(p, TANK_RADIUS + 6, BULLET_RADIUS + WALL_T / 2);
        p.a = baseA;
        bullets.push({
            id: nextBulletId++, type: "normal",
            x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d,
            vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
            owner: p.id, bounces: 0
        });
    }
}

function fireMG(p, now) {
    statAdd(p, "statShots");
    const spread = (Math.random() * 2 - 1) * (MG_SPREAD_DEG * Math.PI / 180);
    const a = p.a + spread;
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, MG_RADIUS + WALL_T / 2);
    bullets.push({
        id: nextBulletId++, type: "mg",
        x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d,
        vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
        owner: p.id, bounces: 0
    });
}

// Same size, speed, and firing rate as a regular bullet - just hits harder
// and flickers yellow/blue/black client-side. Uses the same cooldown-based
// auto-fire as fireBullet (not a single edge-triggered shot like MG/beam).
function fireSuperBullet(p, now) {
    statAdd(p, "statShots");
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, BULLET_RADIUS + WALL_T / 2);
    bullets.push({
        id: nextBulletId++, type: "superbullet",
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        vx: Math.cos(p.a) * BULLET_SPEED, vy: Math.sin(p.a) * BULLET_SPEED,
        owner: p.id, bounces: 0
    });
}

function fireHealthOrb(p, now) {
    statAdd(p, "statShots");
    const d = TANK_RADIUS + HEALORB_RADIUS * 0.5; // walls don't matter for the orb, no safe-muzzle clamp
    const spd = BULLET_SPEED * HEALORB_SPEED_MULT;
    healthOrbs.push({
        id: nextHealthOrbId++, owner: p.id,
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        vx: Math.cos(p.a) * spd, vy: Math.sin(p.a) * spd,
        nextHealAt: now + HEALORB_TICK, targetId: null
    });
}

// Star bullet: one regular-speed/size bullet (drawn blue, 50 damage) that bounces
// like a normal one. Pressing space again while it is alive calls burstStarBullet.
function fireStarBullet(p, now) {
    statAdd(p, "statShots");
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, BULLET_RADIUS + WALL_T / 2);
    const id = nextBulletId++;
    bullets.push({
        id, type: "starbullet",
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        vx: Math.cos(p.a) * BULLET_SPEED, vy: Math.sin(p.a) * BULLET_SPEED,
        owner: p.id, bounces: 0
    });
    return id;
}

// Removes the star bullet and replaces it with 8 regular bullets fired outward
// in an even circle from the star bullet's exact position.
function burstStarBullet(b) {
    const base = Math.atan2(b.vy, b.vx);
    bullets = bullets.filter(bb => bb.id !== b.id);
    for (let i = 0; i < STARBULLET_BURST_COUNT; i++) {
        const a = base + i * (Math.PI * 2 / STARBULLET_BURST_COUNT);
        bullets.push({
            id: nextBulletId++, type: "normal",
            x: b.x, y: b.y,
            vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
            owner: b.owner, bounces: 0
        });
    }
}

// Same as a regular bullet, just faster (BULLET_SPEED * FASTBULLET_SPEED_MULT)
// and drawn pink client-side. Uses the same cooldown-based auto-fire.
function fireFastBullet(p, now) {
    statAdd(p, "statShots");
    const spd = BULLET_SPEED * FASTBULLET_SPEED_MULT;
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, BULLET_RADIUS + WALL_T / 2);
    bullets.push({
        id: nextBulletId++, type: "fastbullet",
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        vx: Math.cos(p.a) * spd, vy: Math.sin(p.a) * spd,
        owner: p.id, bounces: 0
    });
}

// Drone: closest living enemy (not its own team, not an invisible ghost).
function findDroneTarget(p, now) {
    let best = null, bestD = Infinity;
    for (const pl of playersArray()) {
        if (!pl.alive || teamIdOf(pl) === teamIdOf(p)) continue;
        if (now < pl.ghostUntil) continue;
        const d = Math.hypot(pl.x - p.droneX, pl.y - p.droneY);
        if (d < bestD) { bestD = d; best = pl; }
    }
    return best;
}

// Regular bullet fired from the drone toward its auto-aimed target, but it
// only survives DRONE_MAX_BOUNCES bounces instead of MAX_BOUNCES.
function fireDroneBullet(p, target) {
    statAdd(p, "statShots");
    const a = Math.atan2(target.y - p.droneY, target.x - p.droneX);
    const off = DRONE_SIZE / 2 + BULLET_RADIUS + 1;
    bullets.push({
        id: nextBulletId++, type: "drone",
        x: p.droneX + Math.cos(a) * off, y: p.droneY + Math.sin(a) * off,
        vx: Math.cos(a) * BULLET_SPEED, vy: Math.sin(a) * BULLET_SPEED,
        owner: p.id, bounces: 0, maxBounces: DRONE_MAX_BOUNCES
    });
}

function endDrone(p) {
    p.droneActive = false;
    p.droneShots = 0;
    p.droneArmed = false;
    if (p.powerup === "drone") p.powerup = null;
}

// Fast thin beam that bounces off walls like a normal bullet (reuses
// moveBulletWithBounce) but leaves its whole traveled path drawn and
// dangerous behind it - lives in its own list (bounceLasers), not `bullets`,
// since it needs a growing polyline, not a single point.
function fireBouncingLaser(p, now) {
    statAdd(p, "statShots");
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, BOUNCE_LASER_RADIUS + WALL_T / 2);
    const startX = p.x + Math.cos(p.a) * d, startY = p.y + Math.sin(p.a) * d;
    bounceLasers.push({
        id: nextBounceLaserId++,
        ownerId: p.id,
        x: startX, y: startY,
        vx: Math.cos(p.a) * BOUNCE_LASER_SPEED, vy: Math.sin(p.a) * BOUNCE_LASER_SPEED,
        bounces: 0,
        points: [{ x: startX, y: startY }],
        hitIds: new Set(),
        done: false
    });
}

// Instant area effect on the tile the shooter's targeting reticle is
// currently over (see computeFrontTile): clears any bullets/rockets/powerup
// boxes sitting on it, damages any tank touching it, and knocks out the
// tile's bordering walls (never the indestructible outer frame). All of
// this happens immediately - the 0.3s animation the client plays is purely
// cosmetic feedback, not a delay before the effect applies.
function clearTileProjectilesAndPowerups(rect) {
    const removed = bullets.filter(b => pointInRect(b.x, b.y, rect));
    bullets = bullets.filter(b => !pointInRect(b.x, b.y, rect));
    for (const b of removed) {
        if (b.type === "rc") {
            const owner = players[b.owner];
            if (owner && owner.rcRocketId === b.id) owner.rcRocketId = null;
        } else if (b.type === "abomb") {
            const owner = players[b.owner];
            if (owner && owner.abombId === b.id) {
                owner.abombId = null;
                if (owner.powerup === "abomb") owner.powerup = null;
            }
        }
    }
    shrapnel = shrapnel.filter(s => !pointInRect(s.x, s.y, rect));
    bounceLasers = bounceLasers.filter(bl => !pointInRect(bl.x, bl.y, rect));
    powerups = powerups.filter(pu => !pointInRect(pu.x, pu.y, rect));
}

// The clone is a full entry in `players` (flagged isClone) so every existing
// bullet/laser/powerup/damage system treats it as a real tank with no extra
// wiring. Its input is copied from its owner each tick.
function spawnClone(p, now) {
    const id = "c" + p.id + "_" + (nextCloneSeq++);
    players[id] = {
        id, x: p.x, y: p.y, a: p.a,
        color: p.color, name: p.name || "",
        alive: true, hp: CLONE_HP, score: 0, ready: false,
        up: false, down: false, left: false, right: false, shoot: false, prevShoot: true,
        lastShot: now, nitroUntil: 0, ghostUntil: 0, frozenUntil: 0,
        slideUntil: 0, vx: 0, vy: 0, va: 0, cannonCapUntil: 0,
        powerup: null, laserCharging: false, laserChargeStart: 0,
        powerBeamShots: 0, mgShots: 0, superBulletShots: 0, blackHoleShots: 0, wallShots: 0, waterShots: 0,
        fastBulletShots: 0, droneActive: false, droneX: 0, droneY: 0, droneShots: 0, droneArmed: false,
        flameFuel: 0, flameStartTime: 0, flameNextTick: 0,
        abombId: null, rcRocketId: null,
        teleportTargeting: false, teleportCursorX: 0, teleportCursorY: 0,
        airstrikeTargeting: false, airstrikeCursorX: 0, airstrikeCursorY: 0, airstrikePending: false,
        hackTargeting: false, hackCursorX: 0, hackCursorY: 0,
        swapTargeting: false, swapCursorX: 0, swapCursorY: 0,
        hackingTargetId: null, hackedById: null, hackEndsAt: 0,
        cloneId: null, isClone: true, cloneOwnerId: p.id, cloneSpawnedAt: now + CLONE_SPAWN_TIME
    };
    p.cloneId = id;
}

// Straight line of tiles from the tank's own tile to the arena edge, snapped
// to whichever of the 4 axes its cannon is closest to (never diagonal).
function computeShockTiles(p) {
    let col = Math.floor((p.x - MARGIN_X) / CELL_W);
    let row = Math.floor((p.y - MARGIN_Y) / CELL_H);
    col = Math.min(COLS - 1, Math.max(0, col));
    row = Math.min(ROWS - 1, Math.max(0, row));
    const cosA = Math.cos(p.a), sinA = Math.sin(p.a);
    let dc = 0, dr = 0;
    if (Math.abs(cosA) >= Math.abs(sinA)) dc = cosA >= 0 ? 1 : -1;
    else dr = sinA >= 0 ? 1 : -1;
    const tiles = [];
    let c = col, r = row;
    while (c >= 0 && c < COLS && r >= 0 && r < ROWS) {
        tiles.push({ col: c, row: r });
        c += dc; r += dr;
    }
    return tiles;
}

function triggerWallPlacement(p, now) {
    const tile = computeFrontTile(p);
    if (!tile) return false;
    const rect = tileRectOf(tile.col, tile.row);
    const blocked = playersArray().some(pl => pl.alive && circleRectCollide(pl.x, pl.y, TANK_RADIUS, rect))
        || placedWalls.some(w => w.col === tile.col && w.row === tile.row)
        || isBlockCell(tile.col, tile.row); // walls may be built on water
    if (blocked) return false;
    clearTileProjectilesAndPowerups(rect);
    placedWalls.push({ id: nextWallId++, col: tile.col, row: tile.row, hp: WALL_HP, rect, segments: wallSegmentsForTile(tile.col, tile.row) });
    return true;
}

// Water powerup: toggles the tile in front. Works on anything: a solid block is replaced,
// regular/placed walls stay, tanks on the tile are fine. Water already there is removed.
function triggerWaterPlacement(p, now) {
    const tile = computeFrontTile(p);
    if (!tile) return false;
    if (!waterGrid) waterGrid = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    if (waterGrid[tile.row][tile.col]) { waterGrid[tile.row][tile.col] = false; return true; }
    if (isBlockCell(tile.col, tile.row)) {
        solidBlocks = solidBlocks.filter(b => !(b.col === tile.col && b.row === tile.row));
        rebuildSolidSegments();
    }
    waterGrid[tile.row][tile.col] = true;
    return true;
}

function safetileBlocked(tile) {
    return placedWalls.some(w => w.col === tile.col && w.row === tile.row)
        || safeTiles.some(st => st.col === tile.col && st.row === tile.row)
        || isWaterCell(tile.col, tile.row) || isBlockCell(tile.col, tile.row);
}
function triggerSafetilePlacement(p, now) {
    const tile = computeFrontTile(p);
    if (!tile || safetileBlocked(tile)) return false;
    safeTiles.push({ id: nextSafeTileId++, col: tile.col, row: tile.row, rect: tileRectOf(tile.col, tile.row), ownerId: teamIdOf(p) });
    return true;
}

function triggerBlackHole(p, now) {
    const tile = computeFrontTile(p);
    if (!tile) return;
    const rect = tileRectOf(tile.col, tile.row);

    clearTileProjectilesAndPowerups(rect);
    placedWalls = placedWalls.filter(w => !(w.col === tile.col && w.row === tile.row)); // black hole can also remove a wall block
    safeTiles = safeTiles.filter(st => !(st.col === tile.col && st.row === tile.row));
    if (isWaterCell(tile.col, tile.row)) waterGrid[tile.row][tile.col] = false; // black hole turns water into normal ground
    if (isBlockCell(tile.col, tile.row)) { // black hole is the only thing that can remove a solid block
        solidBlocks = solidBlocks.filter(b => !(b.col === tile.col && b.row === tile.row));
        rebuildSolidSegments();
    }

    for (const pl of playersArray()) {
        if (!pl.alive) continue;
        if (circleRectCollide(pl.x, pl.y, TANK_RADIUS, rect)) {
            if (pl.powerup === "shield") pl.powerup = null;
            else applyDamage(pl, BLACKHOLE_DAMAGE, p.id, true);
        }
    }

    destroyNeighboringWalls(tile.col, tile.row);
    blackHoles.push({ id: nextBlackHoleId++, col: tile.col, row: tile.row, triggerTime: now });
}

function fireHoming(p, now) {
    statAdd(p, "statShots");
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, HOMING_RADIUS + WALL_T / 2);
    bullets.push({
        id: nextBulletId++, type: "homing",
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        vx: Math.cos(p.a) * HOMING_SPEED, vy: Math.sin(p.a) * HOMING_SPEED,
        owner: p.id, spawnTime: now, phase: "straight", target: null, color: "#111"
    });
}

function fireRC(p, now) {
    statAdd(p, "statShots");
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, RC_RADIUS + WALL_T / 2);
    const rid = nextBulletId++;
    bullets.push({
        id: rid, type: "rc",
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        a: p.a, owner: p.id, spawnTime: now
    });
    p.rcRocketId = rid;
}

function fireAbomb(p, now) {
    statAdd(p, "statShots");
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, ABOMB_RADIUS + WALL_T / 2);
    const id = nextBulletId++;
    bullets.push({
        id, type: "abomb",
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        vx: Math.cos(p.a) * BULLET_SPEED, vy: Math.sin(p.a) * BULLET_SPEED,
        owner: p.id, bounces: 0, spawnTime: now
    });
    return id;
}

// Detonates an a-bomb at (x,y): scatters SHRAPNEL_COUNT deadly debris pieces
// outward on evenly-spaced (lightly jittered) angles so the burst reads as a
// clean radial blast rather than clumped randomness. Each piece's position
// is recomputed every tick in updateRound() and is live/collidable for
// SHRAPNEL_TOTAL_LIFE ms - the client renders these same server positions
// as small triangles, and separately plays a cosmetic monochrome fireball
// the first time it sees this explosionId.
function createAbombExplosion(x, y, now, ownerId) {
    const explosionId = nextExplosionId++;
    for (let i = 0; i < SHRAPNEL_COUNT; i++) {
        const angle = (Math.PI * 2 * i) / SHRAPNEL_COUNT + (Math.random() - 0.5) * 0.35;
        const dist = SHRAPNEL_MIN_DIST + Math.random() * (SHRAPNEL_MAX_DIST - SHRAPNEL_MIN_DIST);
        shrapnel.push({ id: nextBulletId++, explosionId, cx: x, cy: y, angle, dist, x, y, spawnTime: now, ownerId });
    }
}

function fireLaser(p, now) {
    statAdd(p, "statShots");
    const cosA = Math.cos(p.a), sinA = Math.sin(p.a);
    for (const q of playersArray()) {
        if (q.id === p.id || !q.alive) continue;
        const t = (q.x - p.x) * cosA + (q.y - p.y) * sinA;
        if (t < 0) continue;
        const cx = p.x + cosA * t, cy = p.y + sinA * t;
        const dist = Math.hypot(q.x - cx, q.y - cy);
        if (dist < TANK_RADIUS + LASER_HALF_WIDTH) {
            if (q.powerup === "shield") q.powerup = null;
            else applyDamage(q, DAMAGE.laser, p.id);
        }
    }
    lasers.push({
        x1: p.x, y1: p.y, x2: p.x + cosA * LASER_RANGE, y2: p.y + sinA * LASER_RANGE,
        color: p.color, expires: now + LASER_VISUAL_TIME, kind: "laser"
    });
}

// Instant thin beam: unlike fireLaser, it's clipped at the first wall it
// hits (raycastWalls) so it never damages through a wall, and it only
// reaches players standing before that clip point. Also shoves the shooter
// backward a little (recoil) and is capped by the shot counter, not a cooldown.
function firePowerBeam(p, now) {
    statAdd(p, "statShots");
    const cosA = Math.cos(p.a), sinA = Math.sin(p.a);
    const ray = raycastWalls(p.x, p.y, cosA, sinA, POWER_BEAM_RANGE);
    const wallDist = ray.dist;
    for (const q of playersArray()) {
        if (q.id === p.id || !q.alive) continue;
        const t = (q.x - p.x) * cosA + (q.y - p.y) * sinA;
        if (t < 0 || t > wallDist) continue;
        const cx = p.x + cosA * t, cy = p.y + sinA * t;
        const dist = Math.hypot(q.x - cx, q.y - cy);
        if (dist < TANK_RADIUS + POWER_BEAM_HALF_WIDTH) {
            if (q.powerup === "shield") q.powerup = null;
            else applyDamage(q, DAMAGE.powerbeam, p.id);
        }
    }
    if (ray.wall) damageWall(ray.wall, DAMAGE.powerbeam);
    lasers.push({
        x1: p.x, y1: p.y, x2: p.x + cosA * wallDist, y2: p.y + sinA * wallDist,
        color: p.color, expires: now + POWER_BEAM_VISUAL_TIME, kind: "powerbeam"
    });
    const kx = p.x - cosA * POWER_BEAM_KNOCKBACK, ky = p.y - sinA * POWER_BEAM_KNOCKBACK;
    if (!collidesAny(kx, p.y, TANK_RADIUS)) p.x = kx;
    if (!collidesAny(p.x, ky, TANK_RADIUS)) p.y = ky;
}

// Gives a powerup to a tank. Used by normal pickups AND by the joker's choice,
// so every powerup type is set up in exactly one place.
function grantPowerup(p, type, now) {
    if (type === "nitro" || type === "health" || type === "superhealth") statAdd(p, "statPowerups"); // instant ones are used on pickup
    if (type === "nitro") {
        p.nitroUntil = now + NITRO_DURATION;
    } else if (type === "health") {
        p.hp = Math.min(MAX_HP, p.hp + HEALTH_PACK_AMOUNT);
    } else if (type === "superhealth") {
        // instant: every living (real) player gets healed, plus a green wave everyone sees
        for (const pl of realPlayers()) {
            if (pl.alive) pl.hp = Math.min(MAX_HP, pl.hp + SUPERHEALTH_AMOUNT);
        }
        cleanEvents.push({ id: nextCleanEventId++, x: p.x, y: p.y, spawnTime: now, kind: "heal" });
    } else {
        p.droneActive = false;
        p.droneShots = 0;
        p.jokerSelecting = false;
        p.slotChoices = null;
        p.powerupCounted = (type === "shield"); // shield is passive: counted on pickup, everything else on first use
        if (type === "shield") statAdd(p, "statPowerups");
        p.powerup = type; // replaces prior one, if any
        p.laserCharging = false;
        p.powerBeamShots = type === "powerbeam" ? POWER_BEAM_SHOTS : 0;
        p.mgShots = type === "mg" ? MG_SHOTS : 0;
        p.shotgunShots = type === "shotgun" ? SHOTGUN_SHOTS : 0;
        p.superBulletShots = type === "superbullet" ? SUPERBULLET_SHOTS : 0;
        p.fastBulletShots = type === "fastbullet" ? FASTBULLET_SHOTS : 0;
        p.blackHoleShots = type === "blackhole" ? BLACKHOLE_SHOTS : 0;
        p.wallShots = type === "wall" ? WALL_SHOTS : 0;
        p.waterShots = type === "water" ? WATER_SHOTS : 0;
        p.flameFuel = type === "flamethrower" ? FLAMETHROWER_FUEL : 0;
        p.flameStartTime = 0;
        p.flameNextTick = 0;
        p.abombId = null;
        p.starBulletId = null;
        p.timeShieldAmmo = type === "timeshield" ? TIMESHIELD_AMMO : 0; p.timeShieldNextTick = 0; p.timeShieldActive = false;
        p.teleportTargeting = false;
        p.airstrikeTargeting = false;
        p.airstrikePending = false;
        p.hackTargeting = false;
        p.magnetAmmo = (type === "magnet" || type === "antimagnet") ? MAGNET_AMMO : 0;
        p.magnetNextTick = 0;
    }
}

// Magnet / antimagnet. Runs once per tick BEFORE the movement loop. Finds every
// active beam, then for everything standing in a beam it overrides that thing's
// own movement: tanks/drones/powerup boxes are moved right here, bullets and
// rockets get a `magnetDir` that the bullet loop below applies (keeping their speed).
function runMagnets(now, timeStopped) {
    const all = playersArray();
    for (const q of all) { q.dragged = false; q.dragFull = false; q.droneDragged = false; q.magnetActive = false; }
    for (const b of bullets) delete b.magnetDir;
    if (timeStopped) { for (const q of all) q.magnetNextTick = 0; return; }

    const beams = [];
    for (const p of all) {
        const isMag = p.powerup === "magnet" || p.powerup === "antimagnet";
        const active = isMag && p.alive && p.magnetAmmo > 0 && p.shoot
            && p.hackedById == null && p.hackingTargetId == null && !p.droneActive && !p.rcRocketId
            && !(p.cloneId != null && players[p.cloneId]) && !(p.isClone && now < p.cloneSpawnedAt);
        if (!active) { p.magnetNextTick = 0; continue; }
        if (!p.magnetNextTick) p.magnetNextTick = now + MAGNET_TICK;
        if (now >= p.magnetNextTick) {
            p.magnetNextTick += MAGNET_TICK;
            p.magnetAmmo -= MAGNET_AMMO_PER_TICK;
            if (p.magnetAmmo <= 0) {
                p.magnetAmmo = 0; p.powerup = null; p.magnetNextTick = 0;
                p.lastShot = now; // don't instantly fire a normal bullet with the still-held key
                continue;
            }
        }
        p.magnetActive = true;
        const cx = Math.cos(p.a), cy = Math.sin(p.a);
        beams.push({ p, cx, cy, ox: p.x + cx * (TANK_RADIUS + 7), oy: p.y + cy * (TANK_RADIUS + 7), push: p.powerup === "antimagnet" });
    }
    if (beams.length === 0) return;

    const find = (x, y, radius, exclude) => {
        for (const bm of beams) {
            if (exclude && bm.p === exclude) continue;
            const dx = x - bm.ox, dy = y - bm.oy;
            const t = dx * bm.cx + dy * bm.cy;
            if (t < 0 || t > MAGNET_RANGE) continue;
            if (Math.abs(-dx * bm.cy + dy * bm.cx) < MAGNET_HALF_WIDTH + radius) return bm;
        }
        return null;
    };
    // unit direction the object is forced to travel: toward the beam user (magnet) or away (antimagnet)
    const dirFrom = (bm, x, y) => {
        let dx = bm.p.x - x, dy = bm.p.y - y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return null;
        dx /= len; dy /= len;
        if (bm.push) { dx = -dx; dy = -dy; }
        return { x: dx, y: dy, len };
    };

    for (const pl of all) {
        if (!pl.alive) continue;
        const bm = find(pl.x, pl.y, TANK_RADIUS, pl);
        if (!bm) continue;
        const d = dirFrom(bm, pl.x, pl.y);
        if (!d) continue;
        pl.dragged = true; // movement is overridden; enemy tanks keep rotation
        if (teamIdOf(pl) === teamIdOf(bm.p)) pl.dragFull = true; // own clone: no control at all while dragged
        if (!bm.push && d.len <= TANK_RADIUS * 2) continue; // already touching the beam user
        const nx = pl.x + d.x * BASE_SPEED, ny = pl.y + d.y * BASE_SPEED;
        if (!collidesAny(nx, pl.y, TANK_RADIUS)) pl.x = nx;
        if (!collidesAny(pl.x, ny, TANK_RADIUS)) pl.y = ny;
    }

    for (const pl of all) {
        if (!pl.alive || !pl.droneActive) continue;
        const bm = find(pl.droneX, pl.droneY, DRONE_SIZE / 2);
        if (!bm) continue;
        const d = dirFrom(bm, pl.droneX, pl.droneY);
        if (!d) continue;
        pl.droneDragged = true;
        if (!bm.push && d.len <= TANK_RADIUS + DRONE_SIZE / 2) continue;
        const sp = BASE_SPEED * DRONE_SPEED_MULT;
        pl.droneX += d.x * sp; pl.droneY += d.y * sp;
    }

    for (const b of bullets) {
        const bm = find(b.x, b.y, 4);
        if (!bm) continue;
        const d = dirFrom(bm, b.x, b.y);
        if (!d) continue;
        b.magnetDir = { x: d.x, y: d.y };
    }

    for (const pu of powerups) {
        const bm = find(pu.x, pu.y, POWERUP_RADIUS);
        if (!bm) continue;
        const d = dirFrom(bm, pu.x, pu.y);
        if (!d) continue;
        const nx = pu.x + d.x * BASE_SPEED, ny = pu.y + d.y * BASE_SPEED;
        if (!collidesAny(nx, pu.y, POWERUP_RADIUS)) pu.x = nx;
        if (!collidesAny(pu.x, ny, POWERUP_RADIUS)) pu.y = ny;
    }
}

function updateRound(now, realNow) {
    const timeStopped = realNow < timeStopUntil;
    // clones mirror their owner's input, and hand control back when they die
    for (const p of playersArray()) {
        if (!p.isClone) continue;
        const owner = players[p.cloneOwnerId];
        if (!owner || !p.alive) {
            if (owner && owner.cloneId === p.id) owner.cloneId = null;
            delete players[p.id];
            continue;
        }
        p.up = owner.up; p.down = owner.down; p.left = owner.left; p.right = owner.right;
        p.shoot = owner.shoot;
    }

    // safetile: space presses are ignored while a tank touches one (unless it is
    // mid-targeting/mid-selection, so it can never get stuck in a picker)
    if (safeTiles.length) {
        for (const p of playersArray()) {
            if (!p.alive) continue;
            if (p.teleportTargeting || p.airstrikeTargeting || p.hackTargeting || p.swapTargeting || p.jokerSelecting) continue;
            if (safeTileHit(p.x, p.y, TANK_RADIUS)) p.shoot = false;
        }
    }
    runMagnets(now, timeStopped);

    // water: 6s grace after diving in, then 10 hp per second. Leaving the water resets the timer.
    for (const p of playersArray()) {
        if (!p.alive || !waterGrid || (timeStopped && teamIdOf(p) !== timeStopOwnerId)) { p.waterSince = null; continue; }
        if (!isWaterAt(p.x, p.y)) { p.waterSince = null; continue; }
        if (p.waterSince == null) { p.waterSince = now; p.waterNextDmg = now + WATER_GRACE_MS; }
        while (p.alive && now >= p.waterNextDmg) {
            p.waterNextDmg += WATER_DAMAGE_INTERVAL;
            const real = Math.min(p.hp, WATER_DAMAGE);
            statAdd(p, "statDamage", real);
            p.hp = Math.max(0, p.hp - WATER_DAMAGE);
            if (p.hp <= 0) p.alive = false;
        }
    }

    // movement + shooting
    for (const p of playersArray()) {
        if (!p.alive) { p.jokerSelecting = false; p.slotChoices = null; if (p.droneActive) endDrone(p); continue; }
        if (p.dragFull) { p.prevShoot = p.shoot; continue; } // own clone caught in the beam: no control
        if (p.rcRocketId) { p.prevShoot = p.shoot; continue; } // frozen while piloting an RC rocket
        if (p.cloneId != null && players[p.cloneId]) { p.prevShoot = p.shoot; continue; } // frozen while a clone is out
        if (p.isClone && now < p.cloneSpawnedAt) { p.prevShoot = p.shoot; continue; } // still fading in
        if (timeStopped && teamIdOf(p) !== timeStopOwnerId) { p.prevShoot = p.shoot; continue; } // completely frozen by time stop
        const iAmTimeStopOwner = timeStopped && teamIdOf(p) === timeStopOwnerId;

        if (p.hackedById != null) {
            // being controlled by someone else - own input does nothing.
            // Double-check the hacker is still valid every tick (not just
            // trust the pointer) so a hacker dying mid-session can never
            // leave the victim stuck forever waiting for a release that
            // would otherwise never come.
            const hacker = players[p.hackedById];
            if (!hacker || !hacker.alive || now >= (hacker.hackEndsAt || 0)) {
                p.hackedById = null; // stale/expired - release, fall through to normal control below
            } else {
                p.prevShoot = p.shoot;
                continue;
            }
        }

        if (p.hackingTargetId != null) {
            // actively driving someone else's tank - frozen from our own
            // perspective, exactly like RC piloting.
            const victim = players[p.hackingTargetId];
            if (!victim || !victim.alive || now >= p.hackEndsAt) {
                if (victim) victim.hackedById = null;
                p.hackingTargetId = null;
                p.prevShoot = p.shoot;
                continue; // idle this tick; normal control resumes next tick
            }
            driveTankMovement(victim, p, now < victim.nitroUntil);
            p.prevShoot = p.shoot;
            continue;
        }

        if (p.droneActive) {
            // Tank is frozen and can't fire; WASD/arrows fly the drone in
            // screen directions (up = up), straight over walls.
            const droneFrozen = now < p.frozenUntil;
            const dSpeed = BASE_SPEED * DRONE_SPEED_MULT * (droneFrozen ? FREEZE_SPEED_MULT : 1);
            if (!p.droneDragged) {
                if (p.up) p.droneY -= dSpeed;
                if (p.down) p.droneY += dSpeed;
                if (p.left) p.droneX -= dSpeed;
                if (p.right) p.droneX += dSpeed;
            }
            const half = DRONE_SIZE / 2;
            if (p.droneX - half <= MARGIN_X || p.droneX + half >= MARGIN_X + COLS * CELL_W ||
                p.droneY - half <= MARGIN_Y || p.droneY + half >= MARGIN_Y + ROWS * CELL_H) {
                endDrone(p); // touched the arena boundary - gone
                p.prevShoot = p.shoot;
                continue;
            }
            if (rectTouchesSafeTile(p.droneX, p.droneY, DRONE_SIZE / 2)) {
                endDrone(p); // drones disappear on touching a safetile
                p.prevShoot = p.shoot;
                continue;
            }
            if (!p.shoot) p.droneArmed = true; // the key press that spawned it must be released first
            const droneCooldown = droneFrozen ? SHOT_COOLDOWN * FREEZE_SHOT_MULT : SHOT_COOLDOWN;
            if (p.droneArmed && !iAmTimeStopOwner && now >= p.cannonCapUntil && p.shoot && now - p.lastShot >= droneCooldown) {
                const target = findDroneTarget(p, now);
                if (target) {
                    p.lastShot = now;
                    fireDroneBullet(p, target);
                    p.droneShots--;
                    if (p.droneShots <= 0) endDrone(p);
                }
            }
            p.prevShoot = p.shoot;
            continue;
        }

        if ((p.powerup === "joker" || p.powerup === "slotmachine") && p.jokerSelecting) {
            // Tank is frozen while choosing. Direction keys step through the grid
            // one cell per key press; space confirms.
            const isSlot = p.powerup === "slotmachine";
            const choiceList = (isSlot && p.slotChoices) ? p.slotChoices : JOKER_CHOICES;
            const n = choiceList.length, cols = isSlot ? SLOT_CHOICE_COUNT : JOKER_COLS;
            const prev = p.jokerPrevDirs || {};
            const lastRow = Math.floor((n - 1) / cols);
            let i = Math.max(0, Math.min(n - 1, p.jokerIndex || 0));
            if (p.left && !prev.left && i % cols > 0) i--;
            if (p.right && !prev.right && i % cols < cols - 1 && i + 1 < n) i++;
            if (p.up && !prev.up && i >= cols) i -= cols;
            if (p.down && !prev.down && Math.floor(i / cols) < lastRow) i = Math.min(n - 1, i + cols);
            p.jokerIndex = i;
            p.jokerPrevDirs = { up: p.up, down: p.down, left: p.left, right: p.right };
            if (p.shoot && !p.prevShoot) {
                const chosen = choiceList[i];
                p.jokerSelecting = false;
                p.slotChoices = null;
                p.powerup = null;
                grantPowerup(p, chosen, now);
                p.lastShot = now;
            }
            p.prevShoot = p.shoot;
            continue;
        }

        if (p.powerup === "teleport" && p.teleportTargeting) {
            // Tank is completely frozen while a teleport is being lined up.
            // WASD/arrows move a free-flying selection cursor instead of the
            // tank; the highlighted tile is whichever grid cell it's over.
            if (p.up) p.teleportCursorY -= TELEPORT_CURSOR_SPEED;
            if (p.down) p.teleportCursorY += TELEPORT_CURSOR_SPEED;
            if (p.left) p.teleportCursorX -= TELEPORT_CURSOR_SPEED;
            if (p.right) p.teleportCursorX += TELEPORT_CURSOR_SPEED;
            p.teleportCursorX = Math.max(MARGIN_X, Math.min(MARGIN_X + COLS * CELL_W, p.teleportCursorX));
            p.teleportCursorY = Math.max(MARGIN_Y, Math.min(MARGIN_Y + ROWS * CELL_H, p.teleportCursorY));

            if (p.shoot && !p.prevShoot) {
                const col = Math.min(COLS - 1, Math.max(0, Math.floor((p.teleportCursorX - MARGIN_X) / CELL_W)));
                const row = Math.min(ROWS - 1, Math.max(0, Math.floor((p.teleportCursorY - MARGIN_Y) / CELL_H)));
                let tc = { col, row };
                if (isBlockCell(col, row)) { // can't land inside a solid block - use the nearest open tile instead
                    let bd = Infinity;
                    for (const cc of CELL_CENTERS) {
                        if (isBlockCell(cc.col, cc.row)) continue;
                        const d = (cc.col - col) ** 2 + (cc.row - row) ** 2;
                        if (d < bd) { bd = d; tc = cc; }
                    }
                }
                p.x = MARGIN_X + (tc.col + 0.5) * CELL_W; // tile center - always clear of walls, which sit on cell edges
                p.y = MARGIN_Y + (tc.row + 0.5) * CELL_H;
                // p.a (facing angle) is intentionally left untouched
                p.teleportTargeting = false;
                p.powerup = null;
                p.lastShot = now; // don't let the still-held confirm key also trigger a normal bullet right after
            }
            p.prevShoot = p.shoot;
            continue;
        }

        if (p.powerup === "airstrike" && p.airstrikeTargeting) {
            // Same frozen-cursor mechanic as teleport, just themed red and
            // used to mark a tile instead of moving the tank there.
            if (p.up) p.airstrikeCursorY -= AIRSTRIKE_CURSOR_SPEED;
            if (p.down) p.airstrikeCursorY += AIRSTRIKE_CURSOR_SPEED;
            if (p.left) p.airstrikeCursorX -= AIRSTRIKE_CURSOR_SPEED;
            if (p.right) p.airstrikeCursorX += AIRSTRIKE_CURSOR_SPEED;
            p.airstrikeCursorX = Math.max(MARGIN_X, Math.min(MARGIN_X + COLS * CELL_W, p.airstrikeCursorX));
            p.airstrikeCursorY = Math.max(MARGIN_Y, Math.min(MARGIN_Y + ROWS * CELL_H, p.airstrikeCursorY));

            if (p.shoot && !p.prevShoot) {
                const col = Math.min(COLS - 1, Math.max(0, Math.floor((p.airstrikeCursorX - MARGIN_X) / CELL_W)));
                const row = Math.min(ROWS - 1, Math.max(0, Math.floor((p.airstrikeCursorY - MARGIN_Y) / CELL_H)));
                airstrikes.push({
                    id: nextAirstrikeId++, col, row,
                    cx: MARGIN_X + (col + 0.5) * CELL_W, cy: MARGIN_Y + (row + 0.5) * CELL_H,
                    activatorId: p.id, confirmTime: now, damageApplied: false
                });
                p.airstrikeTargeting = false;
                p.airstrikePending = true; // tank is free to move again, but still can't fire a normal bullet until it resolves
                p.lastShot = now; // don't let the still-held confirm key also trigger a normal bullet right after
            }
            p.prevShoot = p.shoot;
            continue;
        }

        if (p.powerup === "swap" && p.swapTargeting) {
            // Same frozen-cursor mechanic as hacking, orange-themed. Confirming
            // only succeeds if exactly one OTHER tank is touching the tile;
            // on success the two tanks instantly swap positions.
            if (p.up) p.swapCursorY -= SWAP_CURSOR_SPEED;
            if (p.down) p.swapCursorY += SWAP_CURSOR_SPEED;
            if (p.left) p.swapCursorX -= SWAP_CURSOR_SPEED;
            if (p.right) p.swapCursorX += SWAP_CURSOR_SPEED;
            p.swapCursorX = Math.max(MARGIN_X, Math.min(MARGIN_X + COLS * CELL_W, p.swapCursorX));
            p.swapCursorY = Math.max(MARGIN_Y, Math.min(MARGIN_Y + ROWS * CELL_H, p.swapCursorY));

            if (p.shoot && !p.prevShoot) {
                const col = Math.min(COLS - 1, Math.max(0, Math.floor((p.swapCursorX - MARGIN_X) / CELL_W)));
                const row = Math.min(ROWS - 1, Math.max(0, Math.floor((p.swapCursorY - MARGIN_Y) / CELL_H)));
                const tileRect = { x: MARGIN_X + col * CELL_W, y: MARGIN_Y + row * CELL_H, w: CELL_W, h: CELL_H };
                const touching = playersArray().filter(pl => pl.id !== p.id && pl.alive && circleRectCollide(pl.x, pl.y, TANK_RADIUS, tileRect));
                p.swapTargeting = false;
                p.powerup = null; // consumed regardless of outcome
                if (touching.length === 1) {
                    const victim = touching[0];
                    const tx = p.x, ty = p.y;
                    p.x = victim.x; p.y = victim.y;
                    victim.x = tx; victim.y = ty;
                }
                p.lastShot = now;
            }
            p.prevShoot = p.shoot;
            continue;
        }

        if (p.powerup === "hacking" && p.hackTargeting) {
            // Same frozen-cursor mechanic as teleport, green-themed. Confirming
            // only succeeds if exactly one OTHER tank is touching the tile;
            // any other outcome (0 or 2+) just wastes the powerup.
            if (p.up) p.hackCursorY -= HACK_CURSOR_SPEED;
            if (p.down) p.hackCursorY += HACK_CURSOR_SPEED;
            if (p.left) p.hackCursorX -= HACK_CURSOR_SPEED;
            if (p.right) p.hackCursorX += HACK_CURSOR_SPEED;
            p.hackCursorX = Math.max(MARGIN_X, Math.min(MARGIN_X + COLS * CELL_W, p.hackCursorX));
            p.hackCursorY = Math.max(MARGIN_Y, Math.min(MARGIN_Y + ROWS * CELL_H, p.hackCursorY));

            if (p.shoot && !p.prevShoot) {
                const col = Math.min(COLS - 1, Math.max(0, Math.floor((p.hackCursorX - MARGIN_X) / CELL_W)));
                const row = Math.min(ROWS - 1, Math.max(0, Math.floor((p.hackCursorY - MARGIN_Y) / CELL_H)));
                const tileRect = { x: MARGIN_X + col * CELL_W, y: MARGIN_Y + row * CELL_H, w: CELL_W, h: CELL_H };
                const touching = playersArray().filter(pl => pl.id !== p.id && pl.alive && circleRectCollide(pl.x, pl.y, TANK_RADIUS, tileRect));
                p.hackTargeting = false;
                p.powerup = null; // consumed regardless of outcome
                if (touching.length === 1) {
                    const victim = touching[0];
                    p.hackingTargetId = victim.id;
                    p.hackEndsAt = now + HACK_DURATION;
                    victim.hackedById = p.id;
                }
                p.lastShot = now; // don't let the still-held confirm key also trigger a normal bullet right after
            }
            p.prevShoot = p.shoot;
            continue;
        }

        const nitroActive = now < p.nitroUntil;
        const frozenActive = now < p.frozenUntil;
        const slidingActive = now < p.slideUntil;
        const speedMult = (nitroActive ? NITRO_MULT : 1) * (frozenActive ? FREEZE_SPEED_MULT : 1);
        // water: 30% of base speed; nitro lifts that back to regular (non-nitro) speed
        const speed = isWaterAt(p.x, p.y) ? (nitroActive ? BASE_SPEED * (frozenActive ? FREEZE_SPEED_MULT : 1) : BASE_SPEED * WATER_TANK_SPEED) : BASE_SPEED * speedMult;
        const rot = BASE_ROT * speedMult;

        if (slidingActive) {
            // "spaceship in space": thrust adds velocity (linear AND angular),
            // both keep gliding and slowly decaying even with no key held, so
            // steering overshoots badly. Walls kill the velocity on whichever
            // axis they block.
            if (p.left) p.va -= rot;
            if (p.right) p.va += rot;
            p.va *= SLIDE_ROT_FRICTION;
            const maxRot = rot * SLIDE_MAX_ROT_MULT;
            if (Math.abs(p.va) > maxRot) p.va = Math.sign(p.va) * maxRot;
            p.a += p.va;

            if (p.up && !p.dragged) { p.vx += Math.cos(p.a) * speed; p.vy += Math.sin(p.a) * speed; }
            if (p.down && !p.dragged) { p.vx -= Math.cos(p.a) * speed; p.vy -= Math.sin(p.a) * speed; }
            p.vx *= SLIDE_FRICTION;
            p.vy *= SLIDE_FRICTION;
            const maxSpeed = speed * SLIDE_MAX_SPEED_MULT;
            const curSpeed = Math.hypot(p.vx, p.vy);
            if (curSpeed > maxSpeed) { p.vx *= maxSpeed / curSpeed; p.vy *= maxSpeed / curSpeed; }
            if (p.dragged) { p.vx = 0; p.vy = 0; }
            const nx = p.x + p.vx, ny = p.y + p.vy;
            if (!collidesAny(nx, p.y, TANK_RADIUS)) p.x = nx; else p.vx = 0;
            if (!collidesAny(p.x, ny, TANK_RADIUS)) p.y = ny; else p.vy = 0;
        } else {
            if (p.left) p.a -= rot;
            if (p.right) p.a += rot;
            p.va = 0;
            p.vx = 0;
            p.vy = 0;
            let nx = p.x, ny = p.y;
            if (p.up && !p.dragged) { nx += Math.cos(p.a) * speed; ny += Math.sin(p.a) * speed; }
            if (p.down && !p.dragged) { nx -= Math.cos(p.a) * speed; ny -= Math.sin(p.a) * speed; }
            if (!collidesAny(nx, p.y, TANK_RADIUS)) p.x = nx;
            if (!collidesAny(p.x, ny, TANK_RADIUS)) p.y = ny;
        }

        // fun stats: tiles this tank has touched, and first use of a held powerup
        if (!p.isClone) p.statTiles.add(Math.floor((p.x - MARGIN_X) / CELL_W) + "," + Math.floor((p.y - MARGIN_Y) / CELL_H));
        if (p.powerup && !iAmTimeStopOwner && p.shoot && !p.prevShoot && !p.powerupCounted) { p.powerupCounted = true; statAdd(p, "statPowerups"); }

        // star bullet bookkeeping: once the bullet is gone (hit, bounced out, cleaned, safetile)
        // the powerup is used up
        if (p.starBulletId != null && !bullets.some(bb => bb.id === p.starBulletId)) {
            p.starBulletId = null;
            if (p.powerup === "starbullet") p.powerup = null;
        }

        p.timeShieldActive = false; // recomputed below while the shield is held
        if (iAmTimeStopOwner) {
            // can move freely, but can't fire or activate anything while time is stopped
        } else if (p.powerup === "timeshield") {
            // active only while space is held; drains ammo; regular shooting is replaced by the shield
            if (p.shoot && p.timeShieldAmmo > 0) {
                p.timeShieldActive = true;
                if (!p.timeShieldNextTick) p.timeShieldNextTick = now + TIMESHIELD_TICK;
                if (now >= p.timeShieldNextTick) {
                    p.timeShieldNextTick += TIMESHIELD_TICK;
                    p.timeShieldAmmo -= TIMESHIELD_AMMO_PER_TICK;
                    if (p.timeShieldAmmo <= 0) {
                        p.timeShieldAmmo = 0; p.timeShieldActive = false; p.timeShieldNextTick = 0;
                        p.powerup = null;
                        p.lastShot = now; // don't instantly fire a normal bullet with the still-held key
                    }
                }
            } else {
                p.timeShieldNextTick = 0;
            }
        } else if (p.powerup === "healthorb") {
            if (p.shoot && !p.prevShoot) {
                fireHealthOrb(p, now);
                p.powerup = null; // back to regular bullets
                p.lastShot = now;
            }
        } else if (p.powerup === "starbullet") {
            if (p.shoot && !p.prevShoot) {
                if (p.starBulletId == null) {
                    // not fired yet - space shoots the single star bullet
                    p.starBulletId = fireStarBullet(p, now);
                } else {
                    // star bullet is live - space bursts it into 8 regular bullets
                    const sb = bullets.find(bb => bb.id === p.starBulletId);
                    if (sb) burstStarBullet(sb);
                    p.starBulletId = null;
                    p.powerup = null;
                }
                p.lastShot = now;
            }
        } else if (p.powerup === "laser") {
            if (p.shoot && !p.prevShoot && !p.laserCharging) { p.laserCharging = true; p.laserChargeStart = now; }
            if (p.laserCharging) {
                if (!p.shoot) { p.laserCharging = false; }
                else if (now - p.laserChargeStart >= LASER_CHARGE_TIME) {
                    fireLaser(p, now);
                    p.laserCharging = false;
                    p.powerup = null;
                    p.lastShot = now; // don't let the held key also trigger a normal bullet right after
                }
            }
        } else if (p.powerup === "homing") {
            if (p.shoot && !p.prevShoot) { fireHoming(p, now); p.powerup = null; p.lastShot = now; }
        } else if (p.powerup === "rc") {
            if (p.shoot && !p.prevShoot) { fireRC(p, now); p.powerup = null; p.lastShot = now; }
        } else if (p.powerup === "abomb") {
            if (p.abombId == null) {
                // haven't fired it yet - space launches the bomb and arms detonation
                if (p.shoot && !p.prevShoot) {
                    p.abombId = fireAbomb(p, now);
                    p.lastShot = now;
                }
            } else {
                // bomb is live and hasn't resolved yet - next press detonates it
                // instantly wherever it currently is, instead of firing a normal bullet
                if (p.shoot && !p.prevShoot) {
                    const b = bullets.find(bb => bb.id === p.abombId);
                    if (b) b.forceDetonate = true;
                    p.lastShot = now;
                }
            }
        } else if (p.powerup === "powerbeam") {
            if (p.shoot && !p.prevShoot) {
                firePowerBeam(p, now);
                p.powerBeamShots--;
                if (p.powerBeamShots <= 0) { p.powerup = null; p.powerBeamShots = 0; }
                p.lastShot = now;
            }
        } else if (p.powerup === "shotgun") {
            // same fire rate as the regular bullet: hold space, one volley per cooldown
            const cooldown = frozenActive ? SHOT_COOLDOWN * FREEZE_SHOT_MULT : SHOT_COOLDOWN;
            if (p.shoot && now - p.lastShot >= cooldown) {
                if (!p.powerupCounted) { p.powerupCounted = true; statAdd(p, "statPowerups"); }
                fireShotgun(p, now);
                p.shotgunShots--;
                if (p.shotgunShots <= 0) { p.powerup = null; p.shotgunShots = 0; }
                p.lastShot = now;
            }
        } else if (p.powerup === "mg") {
            if (p.shoot && !p.prevShoot) {
                fireMG(p, now);
                p.mgShots--;
                if (p.mgShots <= 0) { p.powerup = null; p.mgShots = 0; }
                p.lastShot = now;
            }
        } else if (p.powerup === "teleport") {
            // first press just arms targeting mode (handled at the top of
            // this loop from the next tick on) - it doesn't fire/consume anything yet
            if (p.shoot && !p.prevShoot) {
                p.teleportTargeting = true;
                p.teleportCursorX = p.x;
                p.teleportCursorY = p.y;
            }
        } else if (p.powerup === "fastbullet") {
            const fbCooldown = frozenActive ? SHOT_COOLDOWN * FREEZE_SHOT_MULT : SHOT_COOLDOWN;
            if (p.shoot && now - p.lastShot >= fbCooldown) {
                p.lastShot = now;
                fireFastBullet(p, now);
                p.fastBulletShots--;
                if (p.fastBulletShots <= 0) { p.powerup = null; p.fastBulletShots = 0; }
            }
        } else if (p.powerup === "drone") {
            if (p.shoot && !p.prevShoot) {
                // spawns on the center of the tile the tank is standing on
                const col = Math.min(COLS - 1, Math.max(0, Math.floor((p.x - MARGIN_X) / CELL_W)));
                const row = Math.min(ROWS - 1, Math.max(0, Math.floor((p.y - MARGIN_Y) / CELL_H)));
                p.droneActive = true;
                p.droneX = MARGIN_X + (col + 0.5) * CELL_W;
                p.droneY = MARGIN_Y + (row + 0.5) * CELL_H;
                p.droneShots = DRONE_SHOTS;
                p.droneArmed = false;
                p.lastShot = now;
            }
        } else if (p.powerup === "superbullet") {
            if (p.shoot && now - p.lastShot >= SHOT_COOLDOWN) {
                p.lastShot = now;
                fireSuperBullet(p, now);
                p.superBulletShots--;
                if (p.superBulletShots <= 0) { p.powerup = null; p.superBulletShots = 0; }
            }
        } else if (p.powerup === "clean") {
            if (p.shoot && !p.prevShoot) {
                cleanEvents.push({ id: nextCleanEventId++, x: p.x, y: p.y, spawnTime: now });
                pendingCleanses.push({ triggerAt: now + CLEAN_ANIMATION_TIME, activatorId: p.id });
                p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "airstrike") {
            // first press just arms targeting mode (handled at the top of this
            // loop). While a strike is pending resolution, do nothing here -
            // no normal bullet, and no re-targeting until it's resolved.
            if (!p.airstrikePending && p.shoot && !p.prevShoot) {
                p.airstrikeTargeting = true;
                p.airstrikeCursorX = p.x;
                p.airstrikeCursorY = p.y;
            }
        } else if (p.powerup === "ghost") {
            if (p.shoot && !p.prevShoot) {
                p.ghostUntil = now + GHOST_DURATION;
                p.powerup = null; // instantly back to normal firing/picking-up while the invisibility runs
                p.lastShot = now;
            }
        } else if (p.powerup === "bouncelaser") {
            if (p.shoot && !p.prevShoot) {
                fireBouncingLaser(p, now);
                p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "swap") {
            if (p.shoot && !p.prevShoot) {
                p.swapTargeting = true;
                p.swapCursorX = p.x;
                p.swapCursorY = p.y;
            }
        } else if (p.powerup === "hacking") {
            // first press just arms targeting mode (handled at the top of
            // this loop from the next tick on) - it doesn't fire/consume anything yet
            if (p.shoot && !p.prevShoot) {
                p.hackTargeting = true;
                p.hackCursorX = p.x;
                p.hackCursorY = p.y;
            }
        } else if (p.powerup === "freeze") {
            if (p.shoot && !p.prevShoot) {
                for (const pl of playersArray()) {
                    if (pl.id === p.id || !pl.alive) continue;
                    pl.frozenUntil = now + FREEZE_DURATION;
                }
                p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "slide") {
            if (p.shoot && !p.prevShoot) {
                for (const pl of playersArray()) {
                    if (pl.id === p.id || !pl.alive) continue;
                    pl.slideUntil = now + SLIDE_DURATION;
                }
                p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "clone") {
            if (p.shoot && !p.prevShoot) {
                spawnClone(p, now);
                p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "shock") {
            if (p.shoot && !p.prevShoot) {
                shocks.push({ id: nextShockId++, tiles: computeShockTiles(p), startTime: now, damagedUpTo: -1, ownerId: teamIdOf(p) });
                p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "darkness") {
            if (p.shoot && !p.prevShoot) {
                darknessUntil = now + DARKNESS_DURATION;
                darknessOwnerId = teamIdOf(p);
                p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "cannoncap") {
            if (p.shoot && !p.prevShoot) {
                for (const pl of playersArray()) {
                    if (pl.id === p.id || !pl.alive) continue;
                    pl.cannonCapUntil = now + CANNON_CAP_DURATION;
                }
                p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "timestop") {
            if (p.shoot && !p.prevShoot) {
                // must use realNow here, not the (possibly already-frozen) sim
                // clock, since this is the value future ticks compare against
                // to know when the freeze itself should end
                timeStopUntil = realNow + TIME_STOP_DURATION;
                timeStopOwnerId = teamIdOf(p);
                p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "safetile") {
            if (p.shoot && !p.prevShoot) {
                // blocked attempts (wall / another safetile in front) are a no-op: powerup is kept
                if (triggerSafetilePlacement(p, now)) p.powerup = null;
                p.lastShot = now;
            }
        } else if (p.powerup === "joker") {
            if (p.shoot && !p.prevShoot) {
                p.jokerSelecting = true;
                p.jokerIndex = 0;
                p.jokerPrevDirs = { up: p.up, down: p.down, left: p.left, right: p.right };
                p.lastShot = now;
            }
        } else if (p.powerup === "slotmachine") {
            if (p.shoot && !p.prevShoot) {
                p.jokerSelecting = true;
                p.jokerIndex = 0;
                p.slotChoices = rollSlotChoices();
                p.jokerPrevDirs = { up: p.up, down: p.down, left: p.left, right: p.right };
                p.lastShot = now;
            }
        } else if (p.powerup === "magnet" || p.powerup === "antimagnet") {
            // beam + ammo drain are handled in runMagnets(); nothing else may fire while holding it
        } else if (p.powerup === "blackhole") {
            if (p.shoot && !p.prevShoot && now - p.lastShot >= BLACKHOLE_COOLDOWN) {
                triggerBlackHole(p, now);
                p.blackHoleShots--;
                if (p.blackHoleShots <= 0) { p.powerup = null; p.blackHoleShots = 0; }
                p.lastShot = now;
            }
        } else if (p.powerup === "flamethrower") {
            if (p.shoot) {
                if (p.flameStartTime === 0) {
                    // just started holding - begin a fresh growth cycle
                    p.flameStartTime = now;
                    statAdd(p, "statShots");
                    p.flameNextTick = now + FLAME_TICK_INTERVAL;
                }
                const elapsed = now - p.flameStartTime;
                const curLen = FLAME_MAX_LENGTH * Math.min(1, elapsed / FLAME_GROW_TIME);

                // continuous box destruction, every tick (not gated by the fuel/damage cadence)
                powerups = powerups.filter(pu => !inFlameCone(p, pu.x, pu.y, POWERUP_RADIUS, curLen));

                if (now >= p.flameNextTick) {
                    p.flameNextTick += FLAME_TICK_INTERVAL;
                    p.flameFuel -= FLAME_FUEL_PER_TICK;
                    for (const pl of playersArray()) {
                        if (!pl.alive || pl.id === p.id) continue;
                        if (inFlameCone(p, pl.x, pl.y, TANK_RADIUS, curLen)) {
                            if (pl.powerup === "shield") pl.powerup = null;
                            else applyDamage(pl, FLAME_DAMAGE_PER_TICK, p.id);
                        }
                    }
                    if (p.flameFuel <= 0) {
                        p.flameFuel = 0;
                        p.powerup = null;
                        p.flameStartTime = 0;
                    }
                }
            } else {
                p.flameStartTime = 0; // released - fire stops immediately; next press starts fresh
            }
        } else if (p.powerup === "water") {
            if (p.shoot && !p.prevShoot) {
                if (triggerWaterPlacement(p, now)) {
                    p.waterShots--;
                    if (p.waterShots <= 0) { p.powerup = null; p.waterShots = 0; }
                }
                p.lastShot = now;
            }
        } else if (p.powerup === "wall") {
            if (p.shoot && !p.prevShoot) {
                if (triggerWallPlacement(p, now)) {
                    p.wallShots--;
                    if (p.wallShots <= 0) { p.powerup = null; p.wallShots = 0; }
                }
                // blocked attempts are a no-op: no shot consumed, try again once clear
                p.lastShot = now;
            }
        } else {
            const cooldown = frozenActive ? SHOT_COOLDOWN * FREEZE_SHOT_MULT : SHOT_COOLDOWN;
            // cannon cap blocks ONLY the plain default bullet - every other
            // powerup weapon is handled in the branches above and still works
            if (now >= p.cannonCapUntil && p.shoot && now - p.lastShot >= cooldown) { p.lastShot = now; fireBullet(p, now); }
        }
        p.prevShoot = p.shoot;
    }

    // bullets
    const survivors = [];
    for (const b of bullets) {
        if (timeStopped) { survivors.push(b); continue; } // frozen exactly where it was, remembers direction/position
        if (b.magnetDir && b.type !== "rc") {
            // caught in a magnet beam: same speed, new direction
            const mspd = Math.hypot(b.vx, b.vy);
            if (mspd > 0) { b.vx = b.magnetDir.x * mspd; b.vy = b.magnetDir.y * mspd; }
        }
        if (b.type === "rc") {
            const owner = players[b.owner];
            if (!owner) continue; // owner disconnected
            if (now - b.spawnTime >= RC_MAX_LIFETIME) { owner.rcRocketId = null; continue; }
            if (owner.left) b.a -= RC_TURN_RATE;
            if (owner.right) b.a += RC_TURN_RATE;
            if (b.magnetDir) b.a = Math.atan2(b.magnetDir.y, b.magnetDir.x);
            const rcw = isWaterAt(b.x, b.y) ? WATER_BULLET_SPEED : 1;
            b.x += Math.cos(b.a) * RC_SPEED * rcw;
            b.y += Math.sin(b.a) * RC_SPEED * rcw;
            if (b.x < 0 || b.x > ARENA_W || b.y < 0 || b.y > ARENA_H || collidesAny(b.x, b.y, RC_RADIUS)) {
                for (const w of placedWalls) {
                    if (circleRectCollide(b.x, b.y, RC_RADIUS, w.rect)) { damageWall(w, DAMAGE.rc); break; }
                }
                owner.rcRocketId = null;
                continue;
            }
            let hitTank = false;
            for (const pl of playersArray()) {
                if (!pl.alive) continue;
                const dx = pl.x - b.x, dy = pl.y - b.y;
                if (dx * dx + dy * dy < (TANK_RADIUS + RC_RADIUS) * (TANK_RADIUS + RC_RADIUS)) {
                    if (pl.powerup === "shield") pl.powerup = null;
                    else applyDamage(pl, DAMAGE.rc, b.owner);
                    hitTank = true;
                    break;
                }
            }
            if (hitTank) { owner.rcRocketId = null; continue; }
            survivors.push(b);
            continue;
        }

        if (b.type === "homing") {
            if (b.phase === "straight") {
                { const hw = isWaterAt(b.x, b.y) ? WATER_BULLET_SPEED : 1; b.x += b.vx * hw; b.y += b.vy * hw; }
                if (now - b.spawnTime >= HOMING_STRAIGHT_TIME) {
                    let best = null, bestD = Infinity;
                    for (const pl of playersArray()) {
                        if (!pl.alive) continue;
                        const d = Math.hypot(pl.x - b.x, pl.y - b.y);
                        if (d < bestD) { bestD = d; best = pl; }
                    }
                    if (best) { b.target = best.id; b.color = best.color; b.phase = "chase"; b.chaseStart = now; }
                    else { continue; } // no one alive to chase - fizzle out
                }
                survivors.push(b);
            } else {
                if (now - b.chaseStart >= HOMING_CHASE_TIME) continue;
                const t = players[b.target];
                if (!t || !t.alive) continue;
                if (!b.magnetDir) { // steering is suspended while a magnet beam holds it
                    const desired = Math.atan2(t.y - b.y, t.x - b.x);
                    const cur = Math.atan2(b.vy, b.vx);
                    const diff = normalizeAngle(desired - cur);
                    const turn = Math.max(-HOMING_TURN_RATE, Math.min(HOMING_TURN_RATE, diff));
                    const newA = cur + turn;
                    b.vx = Math.cos(newA) * HOMING_SPEED; b.vy = Math.sin(newA) * HOMING_SPEED;
                }
                { const hw = isWaterAt(b.x, b.y) ? WATER_BULLET_SPEED : 1; b.x += b.vx * hw; b.y += b.vy * hw; }
                if (Math.hypot(t.x - b.x, t.y - b.y) < TANK_RADIUS + HOMING_RADIUS) {
                    if (t.powerup === "shield") t.powerup = null;
                    else applyDamage(t, DAMAGE.homing, b.owner);
                    continue; // missile consumed either way
                }
                survivors.push(b);
            }
            continue;
        }

        if (b.type === "abomb") {
            // fixed fuse from spawn, independent of bounce count - it must
            // always go off rather than silently vanish if it bounces a lot.
            // The owner can also force it early via forceDetonate (space, 2nd press).
            if (b.forceDetonate || now - b.spawnTime >= ABOMB_FUSE_TIME) {
                createAbombExplosion(b.x, b.y, now, b.owner);
                const owner = players[b.owner];
                if (owner && owner.abombId === b.id) {
                    owner.abombId = null;
                    if (owner.powerup === "abomb") owner.powerup = null;
                }
                continue;
            }
            const bouncesBefore = b.bounces;
            moveBulletWithBounce(b, ABOMB_RADIUS);
            checkWallBounceDamage(b, ABOMB_RADIUS, bouncesBefore, DAMAGE.abomb);
            let hitTank = false;
            for (const pl of playersArray()) {
                if (!pl.alive) continue;
                const dx = pl.x - b.x, dy = pl.y - b.y;
                if (dx * dx + dy * dy < (TANK_RADIUS + ABOMB_RADIUS) * (TANK_RADIUS + ABOMB_RADIUS)) {
                    if (pl.powerup === "shield") pl.powerup = null;
                    else applyDamage(pl, DAMAGE.abomb, b.owner);
                    hitTank = true;
                    break;
                }
            }
            if (hitTank) {
                const owner = players[b.owner];
                if (owner && owner.abombId === b.id) {
                    owner.abombId = null;
                    if (owner.powerup === "abomb") owner.powerup = null;
                }
            } else {
                survivors.push(b);
            }
            continue;
        }

        // normal / machine-gun / super bullet (same physics; MG is smaller, super bullet hits harder)
        const bRadius = b.type === "mg" ? MG_RADIUS : BULLET_RADIUS;
        const bBouncesBefore = b.bounces;
        moveBulletWithBounce(b, bRadius);
        checkWallBounceDamage(b, bRadius, bBouncesBefore, DAMAGE[b.type] || DAMAGE.bullet);
        let hit = false;
        const bMaxBounces = b.maxBounces || MAX_BOUNCES;
        if (b.bounces <= bMaxBounces) {
            for (const pl of playersArray()) {
                if (!pl.alive) continue;
                const dx = pl.x - b.x, dy = pl.y - b.y;
                if (dx * dx + dy * dy < (TANK_RADIUS + bRadius) * (TANK_RADIUS + bRadius)) {
                    if (pl.powerup === "shield") pl.powerup = null;
                    else applyDamage(pl, DAMAGE[b.type] || DAMAGE.bullet, b.owner);
                    hit = true;
                    break;
                }
            }
        }
        if (!hit && b.bounces <= bMaxBounces) survivors.push(b);
    }
    bullets = survivors;
    if (safeTiles.length) {
        bullets = bullets.filter(b => {
            if (b.type === "homing") return true; // homing missiles fly straight through safetiles (and can hurt tanks inside)
            const r = b.type === "mg" ? MG_RADIUS : b.type === "abomb" ? ABOMB_RADIUS : b.type === "homing" ? HOMING_RADIUS : b.type === "rc" ? RC_RADIUS : BULLET_RADIUS;
            if (!safeTileHit(b.x, b.y, r)) return true;
            const owner = players[b.owner];
            if (owner) {
                if (b.type === "rc" && owner.rcRocketId === b.id) owner.rcRocketId = null;
                if (b.type === "abomb" && owner.abombId === b.id) {
                    owner.abombId = null;
                    if (owner.powerup === "abomb") owner.powerup = null;
                }
            }
            return false;
        });
    }

    // health orbs: ignore every wall, vanish at the arena edge, heal the closest living tank
    if (healthOrbs.length) {
        const keep = [];
        for (const o of healthOrbs) {
            if (!timeStopped) {
                o.x += o.vx; o.y += o.vy;
                if (o.x < 0 || o.x > ARENA_W || o.y < 0 || o.y > ARENA_H) continue;
            }
            let best = null, bestD = Infinity;
            for (const pl of playersArray()) {
                if (!pl.alive) continue;
                const d = Math.hypot(pl.x - o.x, pl.y - o.y);
                if (d < bestD) { bestD = d; best = pl; }
            }
            o.targetId = best ? best.id : null;
            if (best && !timeStopped && now >= o.nextHealAt) {
                o.nextHealAt = now + HEALORB_TICK;
                best.hp = Math.min(MAX_HP, best.hp + HEALORB_HP_PER_TICK);
            }
            keep.push(o);
        }
        healthOrbs = keep;
    }

    // a-bomb shrapnel: brief, deadly debris field flying outward after an
    // a-bomb detonates. Position is recomputed every tick from the fixed
    // origin/angle/target-distance so it's smooth and fully server-authoritative.
    const survivingShrapnel = [];
    for (const s of shrapnel) {
        const age = now - s.spawnTime;
        if (age >= SHRAPNEL_TOTAL_LIFE) continue; // burst has faded
        const travelT = Math.min(1, age / SHRAPNEL_BURST_TIME);
        const eased = 1 - Math.pow(1 - travelT, 2); // ease-out burst
        const d = s.dist * eased;
        s.x = s.cx + Math.cos(s.angle) * d;
        s.y = s.cy + Math.sin(s.angle) * d;
        // a-bomb debris is NOT stopped by safetiles: it flies through and still damages tanks inside
        let consumed = false;
        for (const pl of playersArray()) {
            if (!pl.alive) continue;
            const dx = pl.x - s.x, dy = pl.y - s.y;
            if (dx * dx + dy * dy < (TANK_RADIUS + SHRAPNEL_RADIUS) * (TANK_RADIUS + SHRAPNEL_RADIUS)) {
                if (pl.powerup === "shield") pl.powerup = null;
                else applyDamage(pl, DAMAGE.abomb, s.ownerId);
                consumed = true;
                break;
            }
        }
        if (!consumed) survivingShrapnel.push(s);
    }
    shrapnel = survivingShrapnel;

    // "clean" powerup: the red wave is purely visual and finishes on its own
    // schedule; the actual wipe happens here, once, exactly when it's due.
    for (let i = pendingCleanses.length - 1; i >= 0; i--) {
        const c = pendingCleanses[i];
        if (now < c.triggerAt) continue;
        bullets = [];
        healthOrbs = [];
        shrapnel = [];
        lasers = [];
        bounceLasers = [];
        placedWalls = []; // clean removes wall blocks too, placed or not
        safeTiles = []; // ...and safetiles
        shocks = [];
        if (darknessOwnerId !== c.activatorId) { darknessUntil = 0; darknessOwnerId = null; }
        for (const pl of playersArray()) {
            if (pl.isClone && pl.cloneOwnerId !== c.activatorId) {
                const ow = players[pl.cloneOwnerId];
                if (ow && ow.cloneId === pl.id) ow.cloneId = null;
                delete players[pl.id];
            }
        }
        for (const pl of playersArray()) {
            if (pl.id === c.activatorId || !pl.alive) continue;
            // strip whatever weapon they're holding and any active buff -
            // spawned-but-uncollected powerup boxes and HP are untouched
            pl.powerup = null;
            pl.powerBeamShots = 0;
            pl.mgShots = 0;
            pl.shotgunShots = 0;
            pl.superBulletShots = 0;
            pl.fastBulletShots = 0;
            pl.droneActive = false; // drone disappears
            pl.droneShots = 0;
            pl.blackHoleShots = 0;
            pl.wallShots = 0;
            pl.waterShots = 0;
            pl.abombId = null;
            pl.starBulletId = null;
            pl.timeShieldAmmo = 0; pl.timeShieldNextTick = 0; pl.timeShieldActive = false;
            pl.teleportTargeting = false;
            pl.airstrikeTargeting = false;
            pl.nitroUntil = 0;
            pl.ghostUntil = 0;
            pl.frozenUntil = 0;
            pl.slideUntil = 0;
            pl.vx = 0;
            pl.vy = 0;
            pl.va = 0;
            pl.cannonCapUntil = 0;
            pl.flameStartTime = 0;
            // if they were mid-flight piloting an RC rocket, that rocket just
            // got deleted above (bullets = []) - without this they'd stay
            // frozen forever, since rcRocketId is the only thing gating the
            // per-tick freeze check and nothing else ever clears it
            pl.rcRocketId = null;
            // "hacking" powerup: break the link from whichever side it's on,
            // and release the other side too - otherwise one half of the
            // pairing keeps waiting for a release that will never come.
            pl.hackTargeting = false;
            pl.swapTargeting = false;
            pl.jokerSelecting = false;
            pl.slotChoices = null;
            if (pl.hackingTargetId != null) {
                const victim = players[pl.hackingTargetId];
                if (victim) victim.hackedById = null;
                pl.hackingTargetId = null;
            }
            if (pl.hackedById != null) {
                const hacker = players[pl.hackedById];
                if (hacker) hacker.hackingTargetId = null;
                pl.hackedById = null;
            }
        }
        pendingCleanses.splice(i, 1);
    }
    cleanEvents = cleanEvents.filter(e => now - e.spawnTime < CLEAN_ANIMATION_TIME + 300);
    blackHoles = blackHoles.filter(bh => now - bh.triggerTime < 600); // purely visual, well past the 0.3s fade

    // "airstrike" powerup: damage resolves the instant the 1s fade ends;
    // the strike (and its owner's frozen weapon slot) fully clears once the
    // 0.5s explosion visual afterward has also finished.
    for (let i = airstrikes.length - 1; i >= 0; i--) {
        const s = airstrikes[i];
        const sinceConfirm = now - s.confirmTime;
        if (!s.damageApplied && sinceConfirm >= AIRSTRIKE_FADE_TIME) {
            const tileRect = { x: MARGIN_X + s.col * CELL_W, y: MARGIN_Y + s.row * CELL_H, w: CELL_W, h: CELL_H };
            for (const pl of playersArray()) {
                if (!pl.alive) continue;
                if (circleRectCollide(pl.x, pl.y, TANK_RADIUS, tileRect)) {
                    if (pl.powerup === "shield") pl.powerup = null;
                    else applyDamage(pl, AIRSTRIKE_DAMAGE, s.activatorId, true);
                }
            }
            s.damageApplied = true;
            safeTiles = safeTiles.filter(st => !(st.col === s.col && st.row === s.row));
        }
        if (sinceConfirm >= AIRSTRIKE_FADE_TIME + AIRSTRIKE_EXPLOSION_TIME) {
            const owner = players[s.activatorId];
            if (owner) {
                owner.airstrikePending = false;
                if (owner.powerup === "airstrike") owner.powerup = null;
            }
            airstrikes.splice(i, 1);
        }
    }

    // bouncing laser: fast, bounces off walls like a normal bullet, but the
    // whole path it has traced stays drawn AND dangerous until it finishes
    // its 10 bounces, at which point it's removed outright (no fade-out).
    for (const bl of bounceLasers) {
        if (bl.done) continue;
        if (timeStopped) continue; // frozen exactly where it was
        const blBouncesBefore = bl.bounces;
        moveBulletWithBounce(bl, BOUNCE_LASER_RADIUS, true); // lasers ignore water
        checkWallBounceDamage(bl, BOUNCE_LASER_RADIUS, blBouncesBefore, DAMAGE.bouncelaser);
        bl.points.push({ x: bl.x, y: bl.y });
        if (safeTileHit(bl.x, bl.y, BOUNCE_LASER_RADIUS)) { bl.done = true; continue; } // stopped by a safetile
        if (bl.bounces >= BOUNCE_LASER_MAX_BOUNCES) bl.done = true;

        for (const pl of playersArray()) {
            if (!pl.alive || pl.id === bl.ownerId || bl.hitIds.has(pl.id)) continue;
            for (let i = 0; i < bl.points.length - 1; i++) {
                const a = bl.points[i], b2 = bl.points[i + 1];
                if (pointSegmentDistSq(pl.x, pl.y, a.x, a.y, b2.x, b2.y) < (TANK_RADIUS + BOUNCE_LASER_RADIUS) * (TANK_RADIUS + BOUNCE_LASER_RADIUS)) {
                    if (pl.powerup === "shield") pl.powerup = null;
                    else applyDamage(pl, BOUNCE_LASER_DAMAGE, bl.ownerId);
                    bl.hitIds.add(pl.id);
                    break;
                }
            }
        }
    }
    bounceLasers = bounceLasers.filter(bl => !bl.done);

    // shock: the bolt lights one tile every SHOCK_STEP_TIME, damaging anything
    // standing there as that tile lights up; the whole line clears at the end.
    for (let i = shocks.length - 1; i >= 0; i--) {
        const sh = shocks[i];
        const reached = Math.floor((now - sh.startTime) / SHOCK_STEP_TIME);
        const upTo = Math.min(reached, sh.tiles.length - 1);
        while (sh.damagedUpTo < upTo) {
            sh.damagedUpTo++;
            const t = sh.tiles[sh.damagedUpTo];
            const rect = tileRectOf(t.col, t.row);
            for (const pl of playersArray()) {
                if (!pl.alive || teamIdOf(pl) === sh.ownerId) continue;
                if (circleRectCollide(pl.x, pl.y, TANK_RADIUS, rect)) {
                    if (pl.powerup === "shield") pl.powerup = null;
                    else applyDamage(pl, SHOCK_DAMAGE, sh.ownerId, true);
                }
            }
        }
        if (reached >= sh.tiles.length) shocks.splice(i, 1);
    }

    lasers = lasers.filter(l => l.expires > now);

    // powerups: spawn on schedule, expire if left unpicked too long
    if (now >= powerupNextSpawnAt) spawnPowerup(now);
    powerups = powerups.filter(pu => pu.expiresAt > now);

    // powerup pickups - always replaces whatever the player is currently carrying
    for (const p of playersArray()) {
        if (!p.alive) continue;
        for (let i = powerups.length - 1; i >= 0; i--) {
            const pu = powerups[i];
            const dist = Math.hypot(p.x - pu.x, p.y - pu.y);
            if (dist < TANK_RADIUS + POWERUP_RADIUS) {
                grantPowerup(p, pu.type, now);
                powerups.splice(i, 1);
            }
        }
    }

    if (DEBUG) { debugUpdate(now); return; } // debug never ends a round

    // round-end condition
    const aliveTeams = [...new Set(playersArray().filter(p => p.alive).map(teamIdOf))];
    if (aliveTeams.length === 0) {
        endRound(null, now);
    } else if (aliveTeams.length === 1) {
        if (lonelyStart === null) lonelyStart = now;
        else if (now - lonelyStart >= ROUND_LONELY_TIME) endRound(aliveTeams[0], now);
    } else {
        lonelyStart = null;
    }
}

function tryStartGame(now) {
    const list = realPlayers();
    if (list.length > 0 && list.every(p => p.ready)) {
        list.forEach(p => { p.score = 0; });
        startRound(now);
    }
}

function tickInner() {
    const realNow = Date.now();
    // "time stop" freezes a sim clock that everything (bullets, timers,
    // powerup expiry, etc.) reads instead of the real clock, so pausing and
    // resuming preserves exact time-left for everything in flight. Real time
    // is what timeStopUntil itself is compared against, so the freeze can end.
    if (lastTickRealNow == null) lastTickRealNow = realNow;
    const dt = realNow - lastTickRealNow;
    lastTickRealNow = realNow;
    if (paused) {
        // paused: stop the sim clock entirely, so every timer (powerup spawn/expiry, ghost, nitro,
        // fuses, cooldowns...) resumes exactly where it was. A running time-stop is pushed back too.
        simTimeOffset += dt;
        if (timeStopUntil > realNow) timeStopUntil += dt;
    } else if (realNow < timeStopUntil) simTimeOffset += dt;
    const now = realNow - simTimeOffset;

    if (paused) { broadcastState(now); return; }
    if (gamePhase === "lobby") tryStartGame(now);
    else if (gamePhase === "round") updateRound(now, realNow);
    else if (gamePhase === "roundend") { if (now - roundEndTime >= ROUND_END_PAUSE) startRound(now); }
    // gameover: idle, waiting for a reset message

    broadcastState(now);
}

function broadcastState(now) {
    const hostId = currentHostId();
    const outPlayers = {};
    for (const id in players) {
        const p = players[id];
        let glow = null;
        if (p.powerup === "laser") glow = "#4cc9f0";
        else if (p.powerup === "homing") glow = "#ff4d4d";
        else if (p.powerup === "shield") glow = "#22c55e";
        else if (p.powerup === "rc") glow = "#a78bfa";
        else if (p.powerup === "abomb") glow = "#8d5524";
        else if (p.powerup === "powerbeam") glow = "#f72585";
        else if (p.powerup === "mg") glow = "#14b8a6";
        else if (p.powerup === "shotgun") glow = "#a3e635"; // lime
        else if (p.powerup === "teleport") glow = "#87CEFA";
        else if (p.powerup === "superbullet") glow = "#6366f1";
        else if (p.powerup === "timeshield") glow = "#0284c7"; // deep sky blue
        else if (p.powerup === "healthorb") glow = "#166534"; // dark green
        else if (p.powerup === "starbullet") glow = "#1d4ed8"; // royal blue
        else if (p.powerup === "clean") glow = "#8b0000";
        else if (p.powerup === "airstrike") glow = "#000000";
        else if (p.powerup === "ghost") glow = "#94a3b8"; // shown while holding it, unactivated
        else if (p.powerup === "bouncelaser") glow = "#f59e0b";
        else if (p.powerup === "hacking") glow = "#39ff14";
        else if (p.powerup === "swap") glow = "#65a30d";
        else if (p.powerup === "freeze") glow = "#38bdf8";
        else if (p.powerup === "slide") glow = "#44403c";
        else if (p.powerup === "cannoncap") glow = "#dc2626";
        else if (p.powerup === "clone") glow = "#06b6d4";
        else if (p.powerup === "shock") glow = "#facc15";
        else if (p.powerup === "darkness") glow = "#5b3a1a";
        else if (p.powerup === "timestop") glow = "#a16207";
        else if (p.powerup === "fastbullet") glow = "#ffb6c1";
        else if (p.powerup === "drone") glow = "#ff8a8a";
        else if (p.powerup === "safetile") glow = "#4ade80";
        else if (p.powerup === "joker") glow = "#fbbf24";
        else if (p.powerup === "slotmachine") glow = "#ff2d95"; // hot magenta-pink
        else if (p.powerup === "magnet") glow = "#6366f1";
        else if (p.powerup === "antimagnet") glow = "#f97316";
        else if (p.powerup === "blackhole") glow = "#1e293b";
        else if (p.powerup === "flamethrower") glow = "#ff1744";
        else if (p.powerup === "wall") glow = "#78716c";
        else if (p.powerup === "water") glow = "#4f9cf0";
        else if (now < p.ghostUntil) glow = "#94a3b8"; // shown while the invisibility itself is running
        else if (now < p.nitroUntil) glow = "#ffd60a";
        const needsFrontTile = p.alive && (p.powerup === "blackhole" || p.powerup === "wall" || p.powerup === "safetile" || p.powerup === "water");
        const frontTile = needsFrontTile ? computeFrontTile(p) : null;
        const wallBlocked = (p.powerup === "wall" && frontTile)
            ? playersArray().some(pl => pl.alive && circleRectCollide(pl.x, pl.y, TANK_RADIUS, tileRectOf(frontTile.col, frontTile.row)))
                || placedWalls.some(w => w.col === frontTile.col && w.row === frontTile.row)
                || isBlockCell(frontTile.col, frontTile.row)
            : false;
        const safeBlocked = (p.powerup === "safetile" && frontTile) ? safetileBlocked(frontTile) : false;
        outPlayers[id] = {
            safeBlocked,
            waterLeft: p.waterSince != null ? Math.max(0, (WATER_GRACE_MS - (now - p.waterSince)) / 1000) : null,
            id: p.id, x: p.x, y: p.y, a: p.a, color: p.color, name: p.name || "",
            alive: p.alive, score: p.score || 0, ready: p.ready,
            glow, charging: p.laserCharging, powerup: p.powerup,
            powerBeamShots: p.powerBeamShots || 0,
            mgShots: p.mgShots || 0,
            shotgunShots: p.shotgunShots || 0,
            superBulletShots: p.superBulletShots || 0,
            timeShieldAmmo: p.timeShieldAmmo || 0, timeShieldActive: !!p.timeShieldActive,
            fastBulletShots: p.fastBulletShots || 0,
            droneActive: !!p.droneActive, droneX: p.droneX, droneY: p.droneY, droneShots: p.droneShots || 0,
            blackHoleShots: p.blackHoleShots || 0,
            wallShots: p.wallShots || 0,
            waterShots: p.waterShots || 0,
            frontTile,
            wallBlocked: wallBlocked || (p.powerup === "safetile" && frontTile ? safetileBlocked(frontTile) : false),
            flameFuel: p.flameFuel || 0,
            flameActive: p.powerup === "flamethrower" && p.flameStartTime > 0,
            flameLen: p.powerup === "flamethrower" && p.flameStartTime > 0
                ? FLAME_MAX_LENGTH * Math.min(1, (now - p.flameStartTime) / FLAME_GROW_TIME)
                : 0,
            hp: p.hp,
            magnetAmmo: p.magnetAmmo || 0,
            magnetActive: !!p.magnetActive,
            jokerSelecting: !!p.jokerSelecting,
            jokerIndex: p.jokerIndex || 0,
            slotChoices: (p.powerup === "slotmachine" && p.jokerSelecting) ? p.slotChoices : null,
            ghosted: now < p.ghostUntil,
            frozen: now < p.frozenUntil,
            sliding: now < p.slideUntil,
            cannonCapped: now < p.cannonCapUntil,
            isClone: !!p.isClone,
            cloneFadeFrac: p.isClone ? Math.max(0, Math.min(1, (p.cloneSpawnedAt - now) / CLONE_SPAWN_TIME)) : 0,
            shockLine: p.powerup === "shock" ? computeShockTiles(p) : null,
            teleportTargeting: p.teleportTargeting,
            teleportCursorX: p.teleportCursorX,
            teleportCursorY: p.teleportCursorY,
            airstrikeTargeting: p.airstrikeTargeting,
            airstrikeCursorX: p.airstrikeCursorX,
            airstrikeCursorY: p.airstrikeCursorY,
            hackTargeting: p.hackTargeting,
            hackCursorX: p.hackCursorX,
            hackCursorY: p.hackCursorY,
            swapTargeting: p.swapTargeting,
            swapCursorX: p.swapCursorX,
            swapCursorY: p.swapCursorY,
            hacking: p.hackingTargetId != null,
            hackSecondsLeft: p.hackingTargetId != null ? Math.max(0, Math.ceil((p.hackEndsAt - now) / 1000)) : 0,
            hacked: p.hackedById != null,
            moving: p.alive && !p.rcRocketId && !p.droneActive && (p.hackedById != null
                ? (() => { const h = players[p.hackedById]; return !!h && (h.up || h.down || h.left || h.right); })()
                : (p.up || p.down || p.left || p.right)),
            piloting: !!p.rcRocketId
        };
    }

    let lonelyInfo = null;
    if (gamePhase === "round" && lonelyStart !== null) {
        const aliveTeamIds = [...new Set(playersArray().filter(p => p.alive).map(teamIdOf))];
        if (aliveTeamIds.length === 1) {
            lonelyInfo = { id: aliveTeamIds[0], secondsLeft: Math.max(0, (ROUND_LONELY_TIME - (now - lonelyStart)) / 1000) };
        }
    }

    const message = JSON.stringify({
        type: "state",
        state: {
            gamePhase, roundNumber, paused, hostId,
            players: outPlayers,
            bullets: bullets.map(b => {
                if (b.type === "homing") return { x: b.x, y: b.y, a: Math.atan2(b.vy, b.vx), type: "homing", color: b.color, spawnTime: b.spawnTime, maxLife: HOMING_STRAIGHT_TIME + HOMING_CHASE_TIME };
                if (b.type === "rc") return { x: b.x, y: b.y, a: b.a, type: "rc", spawnTime: b.spawnTime, maxLife: RC_MAX_LIFETIME };
                if (b.type === "abomb") return { x: b.x, y: b.y, type: "abomb", spawnTime: b.spawnTime, fuseTime: ABOMB_FUSE_TIME };
                return { id: b.id, x: b.x, y: b.y, a: Math.atan2(b.vy, b.vx), type: b.type, bounces: b.bounces, maxBounces: b.maxBounces || MAX_BOUNCES };
            }),
            healthOrbs: healthOrbs.map(o => ({ id: o.id, x: o.x, y: o.y, r: HEALORB_RADIUS, targetId: o.targetId })),
            shrapnel: shrapnel.map(s => ({ x: s.x, y: s.y, angle: s.angle, cx: s.cx, cy: s.cy, explosionId: s.explosionId })),
            cleanEvents: cleanEvents.map(e => ({ id: e.id, x: e.x, y: e.y, spawnTime: e.spawnTime, kind: e.kind || "clean" })),
            airstrikes: airstrikes.map(s => ({ id: s.id, col: s.col, row: s.row, cx: s.cx, cy: s.cy, confirmTime: s.confirmTime })),
            bounceLasers: bounceLasers.map(bl => ({ id: bl.id, ownerId: bl.ownerId, points: bl.points })),
            blackHoles: blackHoles.map(bh => ({ id: bh.id, col: bh.col, row: bh.row, triggerTime: bh.triggerTime })),
            shocks: shocks.map(sh => ({ id: sh.id, tiles: sh.tiles, litUpTo: Math.min(Math.floor((now - sh.startTime) / SHOCK_STEP_TIME), sh.tiles.length - 1) })),
            darkness: now < darknessUntil ? { ownerId: darknessOwnerId } : null,
            simOffset: simTimeOffset,
            tickMs: Math.round(tickMsAvg * 10) / 10,
            timeStop: Date.now() < timeStopUntil ? { ownerId: timeStopOwnerId, secondsLeft: Math.max(0, (timeStopUntil - Date.now()) / 1000) } : null,
            safeTiles: safeTiles.map(st => ({ id: st.id, col: st.col, row: st.row })),
            jokerChoices: JOKER_CHOICES,
            jokerCols: JOKER_COLS,
            placedWalls: placedWalls.map(w => ({ id: w.id, col: w.col, row: w.row, hp: w.hp, maxHp: WALL_HP })),
            powerups,
            lasers: lasers.map(l => ({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, color: l.color, kind: l.kind || "laser" })),
            maze: mazeWalls,
            solidBlocks: solidBlocks.map(b => ({ col: b.col, row: b.row })),
            water: waterGrid,
            mapType,
            lonely: lonelyInfo,
            roundEndInfo: gamePhase === "roundend" ? roundEndInfo : null,
            gameWinner: gamePhase === "gameover" ? gameWinner : null,
            winScore: WIN_SCORE,
            colors: COLORS
        }
    });

    if (IS_NODE) {
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) client.send(message);
        });
    } else {
        for (const c of debugSockets) c.send(message);
    }
}

// ---------- tiny performance logger ----------
// Measures how long each server tick takes (simulation + broadcast). The
// smoothed value is sent to clients (shown top-right), and every 10s the
// average + worst tick is printed to the console.
let tickMsAvg = 0, tickMsMax = 0, tickLogAt = Date.now() + 10000;
function perfNow() { return IS_NODE ? Number(process.hrtime.bigint()) / 1e6 : performance.now(); }
function tick() {
    const t0 = perfNow();
    tickInner();
    const ms = perfNow() - t0;
    tickMsAvg = tickMsAvg === 0 ? ms : tickMsAvg * 0.9 + ms * 0.1;
    if (ms > tickMsMax) tickMsMax = ms;
    if (Date.now() >= tickLogAt) {
        console.log("[perf] tick avg " + tickMsAvg.toFixed(2) + " ms, max " + tickMsMax.toFixed(2) + " ms (last 10s)");
        tickMsMax = 0;
        tickLogAt = Date.now() + 10000;
    }
}

if (IS_NODE) {
setInterval(tick, 1000 / 30);

server.listen(PORT, "0.0.0.0", () => {
    console.log("");
    console.log("=================================");
    console.log(" Tank Trouble server is running!");
    console.log("=================================");
    console.log("");
    console.log("Open this on this computer:");
    console.log("http://localhost:" + PORT);
    console.log("");
    console.log("Your friends can connect using:");
    console.log("http://YOUR-IP:" + PORT);
    console.log("");
});
} else {
    // Browser: in-page "server" for offline debug mode. The page talks to it
    // through fake socket objects with the same send()/message shape as ws.
    window.TankDebugServer = {
        start(onClientMessage) {
            DEBUG = true;
            const handlers = {};
            const serverSideWs = {
                readyState: 1,
                send(msg) { setTimeout(() => onClientMessage({ data: msg }), 0); },
                close() {},
                on(ev, fn) { handlers[ev] = fn; }
            };
            debugSockets.add(serverSideWs);
            const id = handleConnection(serverSideWs);
            players[id].name = "DEBUG";
            if (DEBUG_DUMMY) {
                const did = nextPlayerId++;
                players[did] = Object.assign({}, players[id], { id: did, ws: null, name: "DUMMY", color: "#6b7280", isDummy: true, statTiles: new Set() });
            }
            startRound(Date.now());
            setInterval(tick, 1000 / 30);
            return {
                readyState: 1,
                send(str) { setTimeout(() => { if (handlers.message) handlers.message(str); }, 0); },
                close() {}
            };
        }
    };
}
})();
