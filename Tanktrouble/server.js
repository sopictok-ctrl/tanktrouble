const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = 8000;

const MIME_TYPES = { ".html": "text/html", ".js": "application/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml" };

// ---------- static file server ----------
const server = http.createServer((req, res) => {
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

const wss = new WebSocket.Server({ server });

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
        CELL_CENTERS.push({ x: MARGIN_X + c * CELL_W + CELL_W / 2, y: MARGIN_Y + r * CELL_H + CELL_H / 2 });

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
function generateMazeType() {
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
            if (hWalls[r][c] && Math.random() < 0.15) hWalls[r][c] = false;
    for (let r = 0; r < ROWS; r++)
        for (let c = 1; c < COLS; c++)
            if (vWalls[r][c] && Math.random() < 0.15) vWalls[r][c] = false;

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

function generateMaze() {
    const roll = Math.random();
    const type = roll < 1 / 3 ? "empty" : roll < 2 / 3 ? "horizontal" : "maze";
    const { hWalls, vWalls } = type === "empty" ? generateEmptyLandsType()
        : type === "horizontal" ? generateHorizontalLinesType()
        : generateMazeType();
    return wallsToGeometry(hWalls, vWalls);
}

let mazeWalls = [], mazeSegments = [];
{ const m = generateMaze(); mazeWalls = m.rects; mazeSegments = m.segments; }

function pickDistinctSpawns(n) {
    const arr = [...CELL_CENTERS];
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

function collidesAny(x, y, radius) {
    for (const w of mazeWalls) if (circleRectCollide(x, y, radius, w)) return true;
    for (const w of placedWalls) if (circleRectCollide(x, y, radius, w.rect)) return true;
    return false;
}

// Applies the same rotation + forward/back movement math as a normal tank's
// own input, but onto `target` using someone else's (ctrl's) up/down/left/right
// - used while "hacking" powerup control is redirected to an enemy tank.
function driveTankMovement(target, ctrl, nitroActive) {
    const speed = BASE_SPEED * (nitroActive ? NITRO_MULT : 1);
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
    for (const w of placedWalls) {
        const t = rayRectIntersect(x, y, dx, dy, w.rect);
        if (t !== null && t < closest) { closest = t; hitWall = w; }
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
function moveBulletWithBounce(b, radius) {
    const effRadius = radius + WALL_T / 2; // walls are collided against their centerline
    const SUBSTEPS = 4;
    const stepX = b.vx / SUBSTEPS, stepY = b.vy / SUBSTEPS;
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
const MG_SPREAD_DEG = 2; // each shot's angle is randomized by +/- this many degrees

const TELEPORT_CURSOR_SPEED = 10; // px/tick the selection cursor moves while targeting (fast, ~3x tank speed)

const SUPERBULLET_SHOTS = 10; // bullets granted per pickup - change this one number to rebalance

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
const HACK_DURATION = 5000; // 5s of controlling the enemy tank - change this one number to adjust

const FREEZE_DURATION = 13000; // 13s - change this one number to adjust
const FREEZE_SPEED_MULT = 0.41; // movement & rotation speed while frozen (41% of normal)
const FREEZE_SHOT_MULT = 2; // regular-bullet cooldown multiplier while frozen (2x = half fire rate)

const SLIDE_DURATION = 17000; // 17s - change this one number to adjust
const SLIDE_FRICTION = 0.982; // per-tick velocity retention while sliding (higher = glides longer)
const SLIDE_MAX_SPEED_MULT = 0.9; // cap on glide speed, slightly slower than normal driving
const SLIDE_ROT_FRICTION = 0.9; // per-tick spin retention - steering overshoots and keeps turning
const SLIDE_MAX_ROT_MULT = 0.9; // cap on spin rate, slightly slower than normal turning

const CLONE_SPAWN_TIME = 200; // ms blue fade-in before the clone becomes controllable
const CLONE_HP = 20;

const SHOCK_STEP_TIME = 200; // ms per tile as the bolt travels
const SHOCK_DAMAGE = 50;

const DARKNESS_DURATION = 15000; // 15s
const CANNON_CAP_DURATION = 15000; // 15s of no regular bullets - change this one number to adjust
const TIME_STOP_DURATION = 15000; // 15s - change this one number to adjust

const BLACKHOLE_SHOTS = 4; // change this one number to rebalance
const BLACKHOLE_DAMAGE = 60;
const BLACKHOLE_COOLDOWN = 300; // ms - matches the 0.3s fade animation; can't fire again until it's done

const FLAMETHROWER_FUEL = 30; // change this one number to rebalance
const FLAME_GROW_TIME = 800; // ms to reach full length
const FLAME_TICK_INTERVAL = 100; // ms - shared cadence for both fuel drain and damage
const FLAME_FUEL_PER_TICK = 1;
const FLAME_DAMAGE_PER_TICK = 3;

const WALL_SHOTS = 3; // change this one number to rebalance
const WALL_HP = 600;

const MAX_HP = 100;const HEALTH_PACK_AMOUNT = 60;
const GHOST_DURATION = 30000; // 30s invisibility - change this one number to adjust
const DAMAGE = {
    bullet: 20,
    normal: 20, // alias - bullets fired without a special powerup carry type "normal"
    mg: 25,
    laser: 80,
    powerbeam: 40,
    homing: 50,
    rc: 80,
    abomb: 100,
    superbullet: 50,
    airstrike: 90,
    bouncelaser: 60
};
function applyDamage(pl, amount) {
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

const ROUND_LONELY_TIME = 3000, ROUND_END_PAUSE = 1500;
const WIN_SCORE = 10;

// ---------- game state ----------
let players = {};
let bullets = [];
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
let nextPlayerId = 1, nextBulletId = 1, nextPowerupId = 1, nextExplosionId = 1, nextCleanEventId = 1, nextAirstrikeId = 1, nextBounceLaserId = 1, nextBlackHoleId = 1, nextWallId = 1;

let gamePhase = "lobby"; // lobby | round | roundend | gameover
let roundNumber = 0;
let roundEndTime = 0;
let roundEndInfo = null;
let lonelyStart = null;
let powerupNextSpawnAt = 0;
let gameWinner = null;
let paused = false;

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

wss.on("connection", (ws) => {
    if (realPlayers().length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: "full" }));
        ws.close();
        return;
    }

    const id = nextPlayerId++;
    const spawn = CELL_CENTERS[Math.floor(Math.random() * CELL_CENTERS.length)];

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
        powerup: null, // null | 'laser' | 'homing' | 'shield' | 'rc' | 'abomb' | 'powerbeam' | 'mg' | 'teleport' | 'superbullet' | 'clean' | 'airstrike' | 'ghost' | 'bouncelaser' | 'hacking' | 'freeze' | 'blackhole' | 'flamethrower' | 'wall' | 'slide' | 'cannoncap' | 'clone' | 'shock' | 'darkness' | 'timestop'
        laserCharging: false, laserChargeStart: 0,
        powerBeamShots: 0,
        mgShots: 0,
        superBulletShots: 0,
        blackHoleShots: 0,
        wallShots: 0,
        flameFuel: 0,
        flameStartTime: 0, // 0 = not currently holding fire; else when the current hold began
        flameNextTick: 0,
        abombId: null, // bullet id of this player's own live a-bomb, if any - lets them detonate it early
        teleportTargeting: false, teleportCursorX: 0, teleportCursorY: 0,
        airstrikeTargeting: false, airstrikeCursorX: 0, airstrikeCursorY: 0, airstrikePending: false,
        hackTargeting: false, hackCursorX: 0, hackCursorY: 0,
        hackingTargetId: null, // set on the hacker while actively driving someone else's tank
        hackedById: null, // set on the victim while someone else is driving their tank
        hackEndsAt: 0, // when the current hack session ends (meaningful on the hacker)
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
            } else if (data.type === "pause") {
                if (id === currentHostId()) paused = !paused;
            } else if (data.type === "reset") {
                if (gamePhase === "gameover") {
                    for (const pl of playersArray()) { pl.score = 0; pl.ready = false; pl.alive = false; }
                    bullets = []; powerups = []; lasers = []; shrapnel = []; cleanEvents = []; pendingCleanses = []; airstrikes = []; bounceLasers = []; blackHoles = []; placedWalls = []; shocks = []; darknessUntil = 0; darknessOwnerId = null; removeAllClones(); timeStopUntil = 0; timeStopOwnerId = null; simTimeOffset = 0;
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
            bullets = []; powerups = []; lasers = []; shrapnel = []; cleanEvents = []; pendingCleanses = []; airstrikes = []; bounceLasers = []; blackHoles = []; placedWalls = []; shocks = []; darknessUntil = 0; darknessOwnerId = null; removeAllClones(); timeStopUntil = 0; timeStopOwnerId = null; simTimeOffset = 0;
            paused = false;
        }
    });
});

// ---------- round management ----------
function startRound(now) {
    { const m = generateMaze(); mazeWalls = m.rects; mazeSegments = m.segments; }
    const list = playersArray();
    if (list.length === 0) { gamePhase = "lobby"; return; }
    const spawns = pickDistinctSpawns(list.length);
    list.forEach((p, i) => {
        p.alive = true;
        p.x = spawns[i].x; p.y = spawns[i].y;
        p.a = Math.random() * Math.PI * 2;
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
        p.superBulletShots = 0;
        p.blackHoleShots = 0;
        p.wallShots = 0;
        p.flameFuel = 0;
        p.flameStartTime = 0;
        p.flameNextTick = 0;
        p.abombId = null;
        p.teleportTargeting = false;
        p.airstrikeTargeting = false;
        p.airstrikePending = false;
        p.hackTargeting = false;
        p.hackingTargetId = null;
        p.hackedById = null;
        p.hackEndsAt = 0;
        p.hp = MAX_HP;
        p.laserCharging = false;
        p.prevShoot = false;
        p.lastShot = 0;
        p.ready = false;
        p.rcRocketId = null;
    });
    bullets = []; powerups = []; lasers = []; shrapnel = []; cleanEvents = []; pendingCleanses = []; airstrikes = []; bounceLasers = []; blackHoles = []; placedWalls = []; shocks = []; darknessUntil = 0; darknessOwnerId = null; removeAllClones(); timeStopUntil = 0; timeStopOwnerId = null; simTimeOffset = 0;
    roundNumber++;
    gamePhase = "round";
    lonelyStart = null;
    powerupNextSpawnAt = now + POWERUP_FIRST_DELAY;
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
            gameWinner = { id: winnerId, color: p.color, colorName: COLOR_NAMES[p.color] || "Mystery", score: p.score };
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
        // don't stack a new powerup on top of one that's still sitting on the map
        if (powerups.some(pu => Math.hypot(pu.x - cell.x, pu.y - cell.y) < POWERUP_MIN_GAP)) continue;
        let minD = Infinity;
        for (const pl of alive) { const d = Math.hypot(cell.x - pl.x, cell.y - pl.y); if (d < minD) minD = d; }
        if (minD >= POWERUP_MIN_PLAYER_DIST) candidates.push(cell);
    }
    if (candidates.length === 0) return; // no free spot 3+ tiles from everyone this cycle, try again next interval
    const best = candidates[Math.floor(Math.random() * candidates.length)];
    const types = ["nitro", "laser", "homing", "shield", "rc", "abomb", "powerbeam", "mg", "health", "teleport", "superbullet", "clean", "airstrike", "ghost", "bouncelaser", "hacking", "freeze", "blackhole", "flamethrower", "wall", "slide", "cannoncap", "clone", "shock", "darkness", "timestop"];
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
function fireMG(p, now) {
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
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, BULLET_RADIUS + WALL_T / 2);
    bullets.push({
        id: nextBulletId++, type: "superbullet",
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        vx: Math.cos(p.a) * BULLET_SPEED, vy: Math.sin(p.a) * BULLET_SPEED,
        owner: p.id, bounces: 0
    });
}

// Fast thin beam that bounces off walls like a normal bullet (reuses
// moveBulletWithBounce) but leaves its whole traveled path drawn and
// dangerous behind it - lives in its own list (bounceLasers), not `bullets`,
// since it needs a growing polyline, not a single point.
function fireBouncingLaser(p, now) {
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
        powerBeamShots: 0, mgShots: 0, superBulletShots: 0, blackHoleShots: 0, wallShots: 0,
        flameFuel: 0, flameStartTime: 0, flameNextTick: 0,
        abombId: null, rcRocketId: null,
        teleportTargeting: false, teleportCursorX: 0, teleportCursorY: 0,
        airstrikeTargeting: false, airstrikeCursorX: 0, airstrikeCursorY: 0, airstrikePending: false,
        hackTargeting: false, hackCursorX: 0, hackCursorY: 0,
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
        || placedWalls.some(w => w.col === tile.col && w.row === tile.row);
    if (blocked) return false;
    clearTileProjectilesAndPowerups(rect);
    placedWalls.push({ id: nextWallId++, col: tile.col, row: tile.row, hp: WALL_HP, rect, segments: wallSegmentsForTile(tile.col, tile.row) });
    return true;
}

function triggerBlackHole(p, now) {
    const tile = computeFrontTile(p);
    if (!tile) return;
    const rect = tileRectOf(tile.col, tile.row);

    clearTileProjectilesAndPowerups(rect);
    placedWalls = placedWalls.filter(w => !(w.col === tile.col && w.row === tile.row)); // black hole can also remove a wall block

    for (const pl of playersArray()) {
        if (!pl.alive) continue;
        if (circleRectCollide(pl.x, pl.y, TANK_RADIUS, rect)) {
            if (pl.powerup === "shield") pl.powerup = null;
            else applyDamage(pl, BLACKHOLE_DAMAGE);
        }
    }

    destroyNeighboringWalls(tile.col, tile.row);
    blackHoles.push({ id: nextBlackHoleId++, col: tile.col, row: tile.row, triggerTime: now });
}

function fireHoming(p, now) {
    const d = safeMuzzleDistance(p, TANK_RADIUS + 6, HOMING_RADIUS + WALL_T / 2);
    bullets.push({
        id: nextBulletId++, type: "homing",
        x: p.x + Math.cos(p.a) * d, y: p.y + Math.sin(p.a) * d,
        vx: Math.cos(p.a) * HOMING_SPEED, vy: Math.sin(p.a) * HOMING_SPEED,
        owner: p.id, spawnTime: now, phase: "straight", target: null, color: "#111"
    });
}

function fireRC(p, now) {
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
function createAbombExplosion(x, y, now) {
    const explosionId = nextExplosionId++;
    for (let i = 0; i < SHRAPNEL_COUNT; i++) {
        const angle = (Math.PI * 2 * i) / SHRAPNEL_COUNT + (Math.random() - 0.5) * 0.35;
        const dist = SHRAPNEL_MIN_DIST + Math.random() * (SHRAPNEL_MAX_DIST - SHRAPNEL_MIN_DIST);
        shrapnel.push({ id: nextBulletId++, explosionId, cx: x, cy: y, angle, dist, x, y, spawnTime: now });
    }
}

function fireLaser(p, now) {
    const cosA = Math.cos(p.a), sinA = Math.sin(p.a);
    for (const q of playersArray()) {
        if (q.id === p.id || !q.alive) continue;
        const t = (q.x - p.x) * cosA + (q.y - p.y) * sinA;
        if (t < 0) continue;
        const cx = p.x + cosA * t, cy = p.y + sinA * t;
        const dist = Math.hypot(q.x - cx, q.y - cy);
        if (dist < TANK_RADIUS + LASER_HALF_WIDTH) {
            if (q.powerup === "shield") q.powerup = null;
            else applyDamage(q, DAMAGE.laser);
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
            else applyDamage(q, DAMAGE.powerbeam);
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

    // movement + shooting
    for (const p of playersArray()) {
        if (!p.alive) continue;
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
                p.x = MARGIN_X + (col + 0.5) * CELL_W; // tile center - always clear of walls, which sit on cell edges
                p.y = MARGIN_Y + (row + 0.5) * CELL_H;
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
        const speed = BASE_SPEED * speedMult;
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

            if (p.up) { p.vx += Math.cos(p.a) * speed; p.vy += Math.sin(p.a) * speed; }
            if (p.down) { p.vx -= Math.cos(p.a) * speed; p.vy -= Math.sin(p.a) * speed; }
            p.vx *= SLIDE_FRICTION;
            p.vy *= SLIDE_FRICTION;
            const maxSpeed = speed * SLIDE_MAX_SPEED_MULT;
            const curSpeed = Math.hypot(p.vx, p.vy);
            if (curSpeed > maxSpeed) { p.vx *= maxSpeed / curSpeed; p.vy *= maxSpeed / curSpeed; }
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
            if (p.up) { nx += Math.cos(p.a) * speed; ny += Math.sin(p.a) * speed; }
            if (p.down) { nx -= Math.cos(p.a) * speed; ny -= Math.sin(p.a) * speed; }
            if (!collidesAny(nx, p.y, TANK_RADIUS)) p.x = nx;
            if (!collidesAny(p.x, ny, TANK_RADIUS)) p.y = ny;
        }

        if (iAmTimeStopOwner) {
            // can move freely, but can't fire or activate anything while time is stopped
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
                            else applyDamage(pl, FLAME_DAMAGE_PER_TICK);
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
        if (b.type === "rc") {
            const owner = players[b.owner];
            if (!owner) continue; // owner disconnected
            if (now - b.spawnTime >= RC_MAX_LIFETIME) { owner.rcRocketId = null; continue; }
            if (owner.left) b.a -= RC_TURN_RATE;
            if (owner.right) b.a += RC_TURN_RATE;
            b.x += Math.cos(b.a) * RC_SPEED;
            b.y += Math.sin(b.a) * RC_SPEED;
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
                    else applyDamage(pl, DAMAGE.rc);
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
                b.x += b.vx; b.y += b.vy;
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
                const desired = Math.atan2(t.y - b.y, t.x - b.x);
                const cur = Math.atan2(b.vy, b.vx);
                const diff = normalizeAngle(desired - cur);
                const turn = Math.max(-HOMING_TURN_RATE, Math.min(HOMING_TURN_RATE, diff));
                const newA = cur + turn;
                b.vx = Math.cos(newA) * HOMING_SPEED; b.vy = Math.sin(newA) * HOMING_SPEED;
                b.x += b.vx; b.y += b.vy;
                if (Math.hypot(t.x - b.x, t.y - b.y) < TANK_RADIUS + HOMING_RADIUS) {
                    if (t.powerup === "shield") t.powerup = null;
                    else applyDamage(t, DAMAGE.homing);
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
                createAbombExplosion(b.x, b.y, now);
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
                    else applyDamage(pl, DAMAGE.abomb);
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
        if (b.bounces <= MAX_BOUNCES) {
            for (const pl of playersArray()) {
                if (!pl.alive) continue;
                const dx = pl.x - b.x, dy = pl.y - b.y;
                if (dx * dx + dy * dy < (TANK_RADIUS + bRadius) * (TANK_RADIUS + bRadius)) {
                    if (pl.powerup === "shield") pl.powerup = null;
                    else applyDamage(pl, DAMAGE[b.type] || DAMAGE.bullet);
                    hit = true;
                    break;
                }
            }
        }
        if (!hit && b.bounces <= MAX_BOUNCES) survivors.push(b);
    }
    bullets = survivors;

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
        let consumed = false;
        for (const pl of playersArray()) {
            if (!pl.alive) continue;
            const dx = pl.x - s.x, dy = pl.y - s.y;
            if (dx * dx + dy * dy < (TANK_RADIUS + SHRAPNEL_RADIUS) * (TANK_RADIUS + SHRAPNEL_RADIUS)) {
                if (pl.powerup === "shield") pl.powerup = null;
                else applyDamage(pl, DAMAGE.abomb);
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
        shrapnel = [];
        lasers = [];
        bounceLasers = [];
        placedWalls = []; // clean removes wall blocks too, placed or not
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
            pl.superBulletShots = 0;
            pl.blackHoleShots = 0;
            pl.wallShots = 0;
            pl.abombId = null;
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
                    else applyDamage(pl, AIRSTRIKE_DAMAGE);
                }
            }
            s.damageApplied = true;
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
        moveBulletWithBounce(bl, BOUNCE_LASER_RADIUS);
        checkWallBounceDamage(bl, BOUNCE_LASER_RADIUS, blBouncesBefore, DAMAGE.bouncelaser);
        bl.points.push({ x: bl.x, y: bl.y });
        if (bl.bounces >= BOUNCE_LASER_MAX_BOUNCES) bl.done = true;

        for (const pl of playersArray()) {
            if (!pl.alive || pl.id === bl.ownerId || bl.hitIds.has(pl.id)) continue;
            for (let i = 0; i < bl.points.length - 1; i++) {
                const a = bl.points[i], b2 = bl.points[i + 1];
                if (pointSegmentDistSq(pl.x, pl.y, a.x, a.y, b2.x, b2.y) < (TANK_RADIUS + BOUNCE_LASER_RADIUS) * (TANK_RADIUS + BOUNCE_LASER_RADIUS)) {
                    if (pl.powerup === "shield") pl.powerup = null;
                    else applyDamage(pl, BOUNCE_LASER_DAMAGE);
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
                    else applyDamage(pl, SHOCK_DAMAGE);
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
                if (pu.type === "nitro") {
                    p.nitroUntil = now + NITRO_DURATION;
                } else if (pu.type === "health") {
                    p.hp = Math.min(MAX_HP, p.hp + HEALTH_PACK_AMOUNT);
                } else {
                    p.powerup = pu.type; // laser / homing / shield / rc / abomb / powerbeam / mg / teleport / superbullet / clean / airstrike / ghost / bouncelaser / hacking / freeze / blackhole / flamethrower / wall - replaces prior one, if any
                    p.laserCharging = false;
                    p.powerBeamShots = pu.type === "powerbeam" ? POWER_BEAM_SHOTS : 0;
                    p.mgShots = pu.type === "mg" ? MG_SHOTS : 0;
                    p.superBulletShots = pu.type === "superbullet" ? SUPERBULLET_SHOTS : 0;
                    p.blackHoleShots = pu.type === "blackhole" ? BLACKHOLE_SHOTS : 0;
                    p.wallShots = pu.type === "wall" ? WALL_SHOTS : 0;
                    p.flameFuel = pu.type === "flamethrower" ? FLAMETHROWER_FUEL : 0;
                    p.flameStartTime = 0;
                    p.flameNextTick = 0;
                    p.abombId = null;
                    p.teleportTargeting = false;
                    p.airstrikeTargeting = false;
                    p.airstrikePending = false;
                    p.hackTargeting = false;
                }
                powerups.splice(i, 1);
            }
        }
    }

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

function tick() {
    const realNow = Date.now();
    // "time stop" freezes a sim clock that everything (bullets, timers,
    // powerup expiry, etc.) reads instead of the real clock, so pausing and
    // resuming preserves exact time-left for everything in flight. Real time
    // is what timeStopUntil itself is compared against, so the freeze can end.
    if (lastTickRealNow == null) lastTickRealNow = realNow;
    const dt = realNow - lastTickRealNow;
    lastTickRealNow = realNow;
    if (realNow < timeStopUntil) simTimeOffset += dt;
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
        else if (p.powerup === "teleport") glow = "#87CEFA";
        else if (p.powerup === "superbullet") glow = "#6366f1";
        else if (p.powerup === "clean") glow = "#8b0000";
        else if (p.powerup === "airstrike") glow = "#000000";
        else if (p.powerup === "ghost") glow = "#94a3b8"; // shown while holding it, unactivated
        else if (p.powerup === "bouncelaser") glow = "#f59e0b";
        else if (p.powerup === "hacking") glow = "#39ff14";
        else if (p.powerup === "freeze") glow = "#38bdf8";
        else if (p.powerup === "slide") glow = "#44403c";
        else if (p.powerup === "cannoncap") glow = "#dc2626";
        else if (p.powerup === "clone") glow = "#06b6d4";
        else if (p.powerup === "shock") glow = "#facc15";
        else if (p.powerup === "darkness") glow = "#5b3a1a";
        else if (p.powerup === "timestop") glow = "#a16207";
        else if (p.powerup === "blackhole") glow = "#1e293b";
        else if (p.powerup === "flamethrower") glow = "#ff1744";
        else if (p.powerup === "wall") glow = "#78716c";
        else if (now < p.ghostUntil) glow = "#94a3b8"; // shown while the invisibility itself is running
        else if (now < p.nitroUntil) glow = "#ffd60a";
        const needsFrontTile = p.powerup === "blackhole" || p.powerup === "wall";
        const frontTile = needsFrontTile ? computeFrontTile(p) : null;
        const wallBlocked = (p.powerup === "wall" && frontTile)
            ? playersArray().some(pl => pl.alive && circleRectCollide(pl.x, pl.y, TANK_RADIUS, tileRectOf(frontTile.col, frontTile.row)))
                || placedWalls.some(w => w.col === frontTile.col && w.row === frontTile.row)
            : false;
        outPlayers[id] = {
            id: p.id, x: p.x, y: p.y, a: p.a, color: p.color, name: p.name || "",
            alive: p.alive, score: p.score || 0, ready: p.ready,
            glow, charging: p.laserCharging, powerup: p.powerup,
            powerBeamShots: p.powerBeamShots || 0,
            mgShots: p.mgShots || 0,
            superBulletShots: p.superBulletShots || 0,
            blackHoleShots: p.blackHoleShots || 0,
            wallShots: p.wallShots || 0,
            frontTile,
            wallBlocked,
            flameFuel: p.flameFuel || 0,
            flameActive: p.powerup === "flamethrower" && p.flameStartTime > 0,
            flameLen: p.powerup === "flamethrower" && p.flameStartTime > 0
                ? FLAME_MAX_LENGTH * Math.min(1, (now - p.flameStartTime) / FLAME_GROW_TIME)
                : 0,
            hp: p.hp,
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
            hacking: p.hackingTargetId != null,
            hackSecondsLeft: p.hackingTargetId != null ? Math.max(0, Math.ceil((p.hackEndsAt - now) / 1000)) : 0,
            hacked: p.hackedById != null,
            moving: p.alive && !p.rcRocketId && (p.hackedById != null
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
                return { id: b.id, x: b.x, y: b.y, a: Math.atan2(b.vy, b.vx), type: b.type, bounces: b.bounces, maxBounces: MAX_BOUNCES };
            }),
            shrapnel: shrapnel.map(s => ({ x: s.x, y: s.y, angle: s.angle, cx: s.cx, cy: s.cy, explosionId: s.explosionId })),
            cleanEvents: cleanEvents.map(e => ({ id: e.id, x: e.x, y: e.y, spawnTime: e.spawnTime })),
            airstrikes: airstrikes.map(s => ({ id: s.id, col: s.col, row: s.row, cx: s.cx, cy: s.cy, confirmTime: s.confirmTime })),
            bounceLasers: bounceLasers.map(bl => ({ id: bl.id, ownerId: bl.ownerId, points: bl.points })),
            blackHoles: blackHoles.map(bh => ({ id: bh.id, col: bh.col, row: bh.row, triggerTime: bh.triggerTime })),
            shocks: shocks.map(sh => ({ id: sh.id, tiles: sh.tiles, litUpTo: Math.min(Math.floor((now - sh.startTime) / SHOCK_STEP_TIME), sh.tiles.length - 1) })),
            darkness: now < darknessUntil ? { ownerId: darknessOwnerId } : null,
            simOffset: simTimeOffset,
            timeStop: Date.now() < timeStopUntil ? { ownerId: timeStopOwnerId, secondsLeft: Math.max(0, (timeStopUntil - Date.now()) / 1000) } : null,
            placedWalls: placedWalls.map(w => ({ id: w.id, col: w.col, row: w.row, hp: w.hp, maxHp: WALL_HP })),
            powerups,
            lasers: lasers.map(l => ({ x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, color: l.color, kind: l.kind || "laser" })),
            maze: mazeWalls,
            lonely: lonelyInfo,
            roundEndInfo: gamePhase === "roundend" ? roundEndInfo : null,
            gameWinner: gamePhase === "gameover" ? gameWinner : null,
            winScore: WIN_SCORE,
            colors: COLORS
        }
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

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
