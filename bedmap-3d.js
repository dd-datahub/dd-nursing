/* bedmap-3d.js — 3D house view + editor for the "แผนผังเตียง" page of index.html.
 *
 * The admin designs the house here: rooms (position, size, wall height, colour, rectangle or L-shape) on
 * floor 1 / floor 2, and places the beds from the bed list into the rooms. Bed colours follow the bed status
 * (vacant / occupied / reserved) and clicking a bed opens the normal bed dialog.
 *
 *   BedMap3D.mount(container, host)   host = {
 *       getBranch(), getBeds() -> [{bedNo, floor, status, custName, ...}],
 *       getModel(branch) -> saved model | null,  save(branch, model),
 *       openBed(index), openNewBed(floor) }
 *   BedMap3D.refresh()   re-read branch / beds / model (call after anything changed outside)
 *   BedMap3D.unmount()
 *
 * Model (stored in Firebase at bed_map_3d/<branch>), units = metres:
 *   { rooms: { <id>: {id, name, floor:'1'|'2', x, z, w, d, h, color, shape:'rect'|'L', nw, nd, corner} },
 *     beds:  { <bedKey>: {no, x, z, rot} } }      bed x/z = centre of the bed, rot = 0|90|180|270 degrees
 *
 * three.js is loaded on demand (not on every page load). The geometry/model helpers at the top are plain
 * functions with no dependency on three.js so they can be tested under Node (bedmap-3d.test.js).
 * If you change this file, bump the ?v= number where index.html loads it.
 */
(function (root) {
  'use strict';

  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var ORBIT_URL = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js';
  var FLOOR_H = 3.2;     // floor-to-floor height (m); floor 2 sits this high
  var WALL_T = 0.12;     // wall thickness (m)
  var SNAP = 0.25;       // drag / resize grid (m)
  var MIN_SIZE = 1.5;    // smallest room side (m)
  var BED_W = 1.0, BED_L = 2.0;

  // ───────────────────────── pure helpers (no three.js) ─────────────────────────
  function snap(v, step) { step = step || SNAP; return Math.round(v / step) * step; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function num(v, fallback) { v = parseFloat(v); return isFinite(v) ? v : fallback; }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function bedKey(no) { return String(no).replace(/[.#$\/\[\]]/g, '_'); }   // Firebase-safe key
  function elevation(floor) { return String(floor) === '2' ? FLOOR_H : 0; }
  function newId(prefix) { return (prefix || 'r') + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  var ROOM_COLORS = { bed: '#fff3c4', common: '#e0f2fe', bath: '#cffafe', stairs: '#e7e5e4', kitchen: '#dcfce7' };

  // Outline of a room in room-local coordinates (x right, z down, origin = top-left of its bounding box).
  // 'rect' = rectangle; 'L' = rectangle with a corner notch (nw × nd) cut out at 'ne' | 'nw' | 'se' | 'sw'.
  function roomPolygon(r) {
    var w = r.w, d = r.d;
    if (r.shape === 'L') {
      var nw = clamp(num(r.nw, w / 2), 0.5, w - 0.5), nd = clamp(num(r.nd, d / 2), 0.5, d - 0.5);
      switch (r.corner) {
        case 'nw': return [[nw, 0], [w, 0], [w, d], [0, d], [0, nd], [nw, nd]];
        case 'se': return [[0, 0], [w, 0], [w, d - nd], [w - nw, d - nd], [w - nw, d], [0, d]];
        case 'sw': return [[0, 0], [w, 0], [w, d], [nw, d], [nw, d - nd], [0, d - nd]];
        default:   return [[0, 0], [w - nw, 0], [w - nw, nd], [w, nd], [w, d], [0, d]];   // 'ne'
      }
    }
    return [[0, 0], [w, 0], [w, d], [0, d]];
  }

  function makeRoom(o) {
    var r = {
      id: o.id || newId('r'), name: o.name || 'ห้องใหม่', floor: String(o.floor || '1'),
      x: round2(num(o.x, 0)), z: round2(num(o.z, 0)),
      w: round2(Math.max(MIN_SIZE, num(o.w, 4))), d: round2(Math.max(MIN_SIZE, num(o.d, 4))),
      h: round2(clamp(num(o.h, 2.6), 1, 6)),
      color: /^#[0-9a-fA-F]{6}$/.test(o.color || '') ? o.color : ROOM_COLORS.bed,
      shape: o.shape === 'L' ? 'L' : 'rect', corner: ['ne', 'nw', 'se', 'sw'].indexOf(o.corner) >= 0 ? o.corner : 'ne'
    };
    r.nw = round2(clamp(num(o.nw, r.w / 2), 0.5, Math.max(0.5, r.w - 0.5)));
    r.nd = round2(clamp(num(o.nd, r.d / 2), 0.5, Math.max(0.5, r.d - 0.5)));
    return r;
  }

  // Starting house so the page is never empty: floor 1 = living room, 3 bedrooms, bathroom, kitchen;
  // floor 2 = 3 bedrooms + bathroom. No beds placed — the admin places them.
  function defaultModel() {
    var R = [
      { name: 'ห้องรับแขก', floor: '1', x: 0, z: 0, w: 6, d: 4, color: ROOM_COLORS.common },
      { name: 'ห้องพัก 1', floor: '1', x: 6, z: 0, w: 4, d: 4 },
      { name: 'ห้องพัก 2', floor: '1', x: 10, z: 0, w: 4, d: 4 },
      { name: 'ห้องน้ำ 1', floor: '1', x: 0, z: 4, w: 2.5, d: 3.5, color: ROOM_COLORS.bath },
      { name: 'ห้องพัก 3', floor: '1', x: 2.5, z: 4, w: 4.5, d: 4, shape: 'rect' },
      { name: 'ห้องครัว', floor: '1', x: 7, z: 4, w: 4, d: 4, color: ROOM_COLORS.kitchen },
      { name: 'บันได', floor: '1', x: 11, z: 4, w: 3, d: 4, color: ROOM_COLORS.stairs },
      { name: 'ห้องพัก 4', floor: '2', x: 0, z: 0, w: 5, d: 4 },
      { name: 'ห้องพัก 5', floor: '2', x: 5, z: 0, w: 5, d: 4 },
      { name: 'ห้องพัก 6', floor: '2', x: 10, z: 0, w: 4, d: 4 },
      { name: 'ห้องน้ำ 2', floor: '2', x: 0, z: 4, w: 3, d: 3, color: ROOM_COLORS.bath },
      { name: 'บันได', floor: '2', x: 11, z: 4, w: 3, d: 4, color: ROOM_COLORS.stairs }
    ];
    var rooms = {};
    R.forEach(function (o, i) { var r = makeRoom(Object.assign({ id: 'r' + (i + 1) }, o)); rooms[r.id] = r; });
    return { rooms: rooms, beds: {} };
  }

  // Firebase drops empty objects and may hand back odd shapes — make the model safe to use.
  function normalizeModel(m) {
    var out = { rooms: {}, beds: {} };
    if (!m || typeof m !== 'object') return out;
    var rooms = m.rooms || {};
    Object.keys(rooms).forEach(function (k) {
      if (!rooms[k]) return;
      var r = makeRoom(Object.assign({}, rooms[k], { id: rooms[k].id || k }));
      out.rooms[r.id] = r;
    });
    var beds = m.beds || {};
    Object.keys(beds).forEach(function (k) {
      var b = beds[k]; if (!b) return;
      out.beds[k] = { no: String(b.no != null ? b.no : k), x: round2(num(b.x, 0)), z: round2(num(b.z, 0)), rot: ((Math.round(num(b.rot, 0) / 90) * 90) % 360 + 360) % 360 };
    });
    return out;
  }

  function boundsOf(rooms) {
    if (!rooms.length) return { x0: 0, z0: 0, x1: 14, z1: 8 };
    var b = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
    rooms.forEach(function (r) {
      b.x0 = Math.min(b.x0, r.x); b.z0 = Math.min(b.z0, r.z);
      b.x1 = Math.max(b.x1, r.x + r.w); b.z1 = Math.max(b.z1, r.z + r.d);
    });
    return b;
  }
  function insideRoomBox(r, x, z) { return x >= r.x && x <= r.x + r.w && z >= r.z && z <= r.z + r.d; }

  // Beds (from the bed list) that have a placement in the model, and the ones that do not yet.
  function splitBeds(beds, model) {
    var placed = [], unplaced = [];
    beds.forEach(function (b, idx) {
      var p = model.beds[bedKey(b.bedNo)];
      (p ? placed : unplaced).push({ bed: b, idx: idx, key: bedKey(b.bedNo), place: p });
    });
    return { placed: placed, unplaced: unplaced };
  }

  // Where to put a bed that has just been "วาง": centre of the preferred room if it is on the bed's floor,
  // else the first room on that floor, else the origin. Nudged so it does not sit exactly on another bed.
  function defaultPlacement(model, bedFloor, preferRoomId) {
    var rooms = Object.keys(model.rooms).map(function (k) { return model.rooms[k]; })
      .filter(function (r) { return r.floor === String(bedFloor); });
    var room = (preferRoomId && model.rooms[preferRoomId] && model.rooms[preferRoomId].floor === String(bedFloor))
      ? model.rooms[preferRoomId] : rooms[0];
    var x = room ? room.x + room.w / 2 : 0, z = room ? room.z + room.d / 2 : 0;
    var used = Object.keys(model.beds).map(function (k) { return model.beds[k]; });
    for (var i = 0; i < 30; i++) {
      var clash = used.some(function (p) { return Math.abs(p.x - x) < 0.6 && Math.abs(p.z - z) < 0.6; });
      if (!clash) break;
      x += 1.1; if (room && x > room.x + room.w - 0.6) { x = room.x + 0.6; z += 2.2; }
    }
    return { x: snap(x), z: snap(z), rot: 0 };
  }

  var STATUS_COLORS = { vacant: '#86efac', occupied: '#fdba74', reserved: '#7dd3fc', none: '#cbd5e1' };
  var STATUS_LABEL = { vacant: 'ว่าง', occupied: 'มีผู้พัก', reserved: 'จอง', none: 'ยังไม่กำหนด' };

  // ───────────────────────── three.js part ─────────────────────────
  var S = null;           // the one live viewer (null when not mounted)
  var libsPromise = null;
  var mountSeq = 0;       // guards against overlapping async mounts
  var cssDone = false;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('โหลดไลบรารี 3D ไม่สำเร็จ: ' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadLibs() {
    if (root.THREE && root.THREE.OrbitControls) return Promise.resolve();
    if (!libsPromise) {
      libsPromise = (root.THREE ? Promise.resolve() : loadScript(THREE_URL))
        .then(function () { return root.THREE.OrbitControls ? null : loadScript(ORBIT_URL); })
        .catch(function (e) { libsPromise = null; throw e; });
    }
    return libsPromise;
  }

  function injectCss() {
    if (cssDone) return; cssDone = true;
    var st = document.createElement('style');
    st.textContent = [
      '.bm3d{display:flex;flex-wrap:wrap;gap:12px;align-items:stretch}',
      '.bm3d-main{flex:1 1 560px;min-width:0;display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--surface)}',
      '.bm3d-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--border);background:var(--surface2)}',
      '.bm3d-seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}',
      '.bm3d-seg button{border:0;background:var(--surface);padding:5px 11px;font-size:12px;cursor:pointer;color:var(--text2)}',
      '.bm3d-seg button+button{border-left:1px solid var(--border)}',
      '.bm3d-seg button.on{background:var(--accent,#c2588a);color:#fff;font-weight:600}',
      '.bm3d-stage{position:relative;height:560px;background:linear-gradient(#e6eef8,#f7f9fc)}',
      '.bm3d-stage canvas{display:block;width:100%;height:100%;touch-action:none}',
      '.bm3d-hint{position:absolute;left:10px;bottom:8px;font-size:11px;color:#475569;background:#ffffffd0;padding:3px 9px;border-radius:8px;pointer-events:none}',
      '.bm3d-err{padding:30px;text-align:center;color:var(--danger,#b91c1c);font-size:13px}',
      '.bm3d-panel{flex:0 0 270px;max-width:100%;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);padding:12px;font-size:12px;display:flex;flex-direction:column;gap:10px}',
      '.bm3d-panel h4{margin:0 0 4px;font-size:12px;color:var(--text2);font-weight:700}',
      '.bm3d-panel label{display:block;font-size:11px;color:var(--text3);margin-bottom:2px}',
      '.bm3d-panel input,.bm3d-panel select{width:100%;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--surface);color:var(--text);box-sizing:border-box}',
      '.bm3d-panel input[type=color]{padding:0;height:26px}',
      '.bm3d-row{display:flex;gap:6px}.bm3d-row>div{flex:1;min-width:0}',
      '.bm3d-btn{border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;color:var(--text)}',
      '.bm3d-btn.pri{background:var(--accent,#c2588a);border-color:var(--accent,#c2588a);color:#fff}',
      '.bm3d-btn.dng{color:#b91c1c;border-color:#fca5a5;background:#fef2f2}',
      '.bm3d-leg{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--text2)}',
      '.bm3d-leg i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:4px;vertical-align:-1px;border:1px solid #0002}'
    ].join('\n');
    document.head.appendChild(st);
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function makeLabel(lines, opt) {
    opt = opt || {};
    var T = root.THREE, size = opt.size || 28, pad = 10;
    var c = document.createElement('canvas'), g = c.getContext('2d');
    var font = function (px, weight) { return (weight || 600) + ' ' + px + 'px Sarabun, Kanit, "Segoe UI", sans-serif'; };
    g.font = font(size, 700);
    var w = 0; lines.forEach(function (l, i) { g.font = font(i ? size * 0.78 : size, i ? 500 : 700); w = Math.max(w, g.measureText(l).width); });
    c.width = Math.ceil(w + pad * 2); c.height = Math.ceil(lines.length * size * 1.25 + pad * 1.4);
    g = c.getContext('2d');
    g.fillStyle = opt.bg || 'rgba(255,255,255,0.88)'; g.strokeStyle = opt.border || 'rgba(15,23,42,0.35)'; g.lineWidth = 2;
    var r = 10; g.beginPath(); g.moveTo(r, 0); g.arcTo(c.width, 0, c.width, c.height, r); g.arcTo(c.width, c.height, 0, c.height, r);
    g.arcTo(0, c.height, 0, 0, r); g.arcTo(0, 0, c.width, 0, r); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = opt.color || '#0f172a'; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach(function (l, i) { g.font = font(i ? size * 0.78 : size, i ? 500 : 700); g.fillText(l, c.width / 2, pad * 0.7 + (i + 0.5) * size * 1.25); });
    var tex = new T.CanvasTexture(c); tex.minFilter = T.LinearFilter;
    var sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    var hMeters = opt.height || 0.6;
    sp.scale.set(hMeters * c.width / c.height, hMeters, 1);
    sp.renderOrder = 10;
    return sp;
  }

  function disposeGroup(g) {
    g.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
    });
  }

  // ── building the scene objects ──
  function buildRoom(r) {
    var T = root.THREE, g = new T.Group(), el = elevation(r.floor);
    var poly = roomPolygon(r);
    // floor slab (extruded downward 0.2 m so the top face sits at the floor level)
    var shape = new T.Shape(poly.map(function (p) { return new T.Vector2(p[0], -p[1]); }));
    var slabGeo = new T.ExtrudeGeometry(shape, { depth: 0.2, bevelEnabled: false });
    slabGeo.rotateX(-Math.PI / 2);
    var slab = new T.Mesh(slabGeo, new T.MeshLambertMaterial({ color: r.color }));
    slab.position.y = el - 0.2;
    slab.userData.pick = { type: 'room', id: r.id };
    g.add(slab);
    // walls: one box per outline edge
    var low = S && S.view.low, wh = low ? 0.35 : r.h;
    var wallMat = new T.MeshLambertMaterial({ color: low ? '#ffffff' : '#f1f5f9', transparent: !low, opacity: low ? 1 : 0.5, side: T.DoubleSide, depthWrite: low });
    for (var i = 0; i < poly.length; i++) {
      var a = poly[i], b = poly[(i + 1) % poly.length];
      var dx = b[0] - a[0], dz = b[1] - a[1], len = Math.sqrt(dx * dx + dz * dz);
      var wall = new T.Mesh(new T.BoxGeometry(len + WALL_T, wh, WALL_T), wallMat);
      wall.position.set((a[0] + b[0]) / 2, el + wh / 2, (a[1] + b[1]) / 2);
      wall.rotation.y = -Math.atan2(dz, dx);
      g.add(wall);
    }
    // name label
    var lb = makeLabel([r.name], { size: 26, height: 0.5, bg: 'rgba(255,255,255,0.82)' });
    var cx = r.shape === 'L' ? (poly.reduce(function (s, p) { return s + p[0]; }, 0) / poly.length) : r.w / 2;
    var cz = r.shape === 'L' ? (poly.reduce(function (s, p) { return s + p[1]; }, 0) / poly.length) : r.d / 2;
    lb.position.set(cx, el + (low ? 0.6 : Math.min(r.h, 1.6)), cz - 0.9 > 0.3 ? cz - 0.9 : cz);
    g.add(lb);
    g.position.set(r.x, 0, r.z);
    g.userData.id = r.id;
    return g;
  }

  function buildBed(item, place) {
    var T = root.THREE, g = new T.Group();
    var b = item.bed, st = b.status || 'vacant', el = elevation(b.floor);
    var color = STATUS_COLORS[st] || STATUS_COLORS.none;
    var pick = { type: 'bed', id: item.key };
    function box(w, h, d, col, x, y, z) {
      var m = new T.Mesh(new T.BoxGeometry(w, h, d), new T.MeshLambertMaterial({ color: col }));
      m.position.set(x, y, z); m.userData.pick = pick; g.add(m); return m;
    }
    box(BED_W, 0.28, BED_L, '#8d6e63', 0, 0.14, 0);              // frame
    box(BED_W - 0.1, 0.16, BED_L - 0.12, color, 0, 0.36, 0);     // mattress (status colour)
    box(0.7, 0.1, 0.35, '#ffffff', 0, 0.49, -BED_L / 2 + 0.4);   // pillow
    box(BED_W, 0.75, 0.08, '#6d4c41', 0, 0.5, -BED_L / 2 + 0.04); // headboard
    var lines = [String(b.bedNo)]; if (b.custName) lines.push(b.custName.length > 14 ? b.custName.slice(0, 13) + '…' : b.custName);
    var lb = makeLabel(lines, { size: 24, height: lines.length > 1 ? 0.62 : 0.42, bg: color, border: '#0f172a66' });
    lb.position.set(0, 1.35, 0); g.add(lb);
    g.position.set(place.x, el, place.z);
    g.rotation.y = -place.rot * Math.PI / 180;
    g.userData.key = item.key;
    return g;
  }

  function floorVisible(f) { return S.view.floor === 'all' || S.view.floor === String(f); }

  function clearGroup(g) { while (g.children.length) { var c = g.children[0]; g.remove(c); disposeGroup(c); } }

  function rebuildAll() {
    if (!S) return;
    clearGroup(S.roomsG); clearGroup(S.bedsG); clearGroup(S.selG);
    S.pickables = []; S.roomGroups = {}; S.bedGroups = {};
    Object.keys(S.model.rooms).forEach(function (id) {
      var r = S.model.rooms[id]; if (!floorVisible(r.floor)) return;
      var g = buildRoom(r); S.roomGroups[id] = g; S.roomsG.add(g);
    });
    var beds = S.host.getBeds() || [], sp = splitBeds(beds, S.model);
    sp.placed.forEach(function (it) {
      if (!floorVisible(it.bed.floor || '1')) return;
      var g = buildBed(it, it.place); S.bedGroups[it.key] = g; S.bedsG.add(g);
    });
    S.roomsG.traverse(function (o) { if (o.userData.pick) S.pickables.push(o); });
    S.bedsG.traverse(function (o) { if (o.userData.pick) S.pickables.push(o); });
    drawSelection();
    updatePanel();
  }

  function drawSelection() {
    var T = root.THREE; clearGroup(S.selG);
    if (S.handle) S.pickables = S.pickables.filter(function (o) { return o !== S.handle; });
    S.handle = null;
    if (!S.view.edit || !S.sel) return;
    if (S.sel.type === 'room') {
      var r = S.model.rooms[S.sel.id]; if (!r || !floorVisible(r.floor)) return;
      var poly = roomPolygon(r), el = elevation(r.floor) + 0.04;
      var pts = poly.map(function (p) { return new T.Vector3(r.x + p[0], el, r.z + p[1]); });
      var line = new T.LineLoop(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: '#2563eb' }));
      line.renderOrder = 5; S.selG.add(line);
      var h = new T.Mesh(new T.SphereGeometry(0.28, 16, 12), new T.MeshBasicMaterial({ color: '#2563eb', depthTest: false }));
      h.position.set(r.x + r.w, el + 0.15, r.z + r.d); h.renderOrder = 6; h.userData.pick = { type: 'handle', id: r.id };
      S.selG.add(h); S.handle = h; S.pickables.push(h);
    } else if (S.sel.type === 'bed') {
      var bg = S.bedGroups[S.sel.id]; if (!bg) return;
      var bh = new T.BoxHelper(bg, 0x2563eb); S.selG.add(bh);
    }
  }

  // ── camera ──
  function fitCamera(mode) {
    var T = root.THREE;
    var rooms = Object.keys(S.model.rooms).map(function (k) { return S.model.rooms[k]; }).filter(function (r) { return floorVisible(r.floor); });
    var b = boundsOf(rooms), cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    var size = Math.max(b.x1 - b.x0, b.z1 - b.z0, 6);
    var cy = S.view.floor === '2' ? FLOOR_H : (S.view.floor === 'all' ? FLOOR_H / 2 : 0);
    S.controls.target.set(cx, cy, cz);
    if (mode === 'top') S.camera.position.set(cx, cy + size * 1.45, cz + 0.001);
    else S.camera.position.set(cx - size * 0.5, cy + size * 0.94, cz + size * 1.04);
    S.camera.lookAt(S.controls.target); S.controls.update();
  }

  // ── pointer interaction ──
  function setRay(e) {
    var r = S.canvas.getBoundingClientRect();
    S.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    S.ray.setFromCamera(S.ndc, S.camera);
  }
  function pickAt(e) {
    setRay(e);
    var hits = S.ray.intersectObjects(S.pickables, false);
    for (var i = 0; i < hits.length; i++) {
      var p = hits[i].object.userData.pick;
      if (!p) continue;
      if (!S.view.edit && p.type !== 'bed') continue;   // in view mode only beds are clickable
      return p;
    }
    return null;
  }
  function planePoint(el) {
    var T = root.THREE, plane = new T.Plane(new T.Vector3(0, 1, 0), -el), out = new T.Vector3();
    return S.ray.ray.intersectPlane(plane, out) ? out : null;
  }

  function startDrag(hit, e) {
    var model = S.model;
    if (hit.type === 'room' || hit.type === 'handle') {
      var r = model.rooms[hit.id]; if (!r) return;
      setRay(e); var pt = planePoint(elevation(r.floor)); if (!pt) return;
      if (hit.type === 'handle') { S.drag = { type: 'handle', id: r.id }; return; }
      var carried = Object.keys(model.beds).map(function (k) { return { key: k, p: model.beds[k] }; }).filter(function (c) {
        var bed = (S.host.getBeds() || []).filter(function (b) { return bedKey(b.bedNo) === c.key; })[0];
        return bed && String(bed.floor || '1') === r.floor && insideRoomBox(r, c.p.x, c.p.z);
      }).map(function (c) { return { key: c.key, x0: c.p.x, z0: c.p.z }; });
      S.drag = { type: 'room', id: r.id, offX: pt.x - r.x, offZ: pt.z - r.z, startX: r.x, startZ: r.z, carried: carried };
    } else if (hit.type === 'bed') {
      var p = model.beds[hit.id]; if (!p) return;
      var bed = (S.host.getBeds() || []).filter(function (b) { return bedKey(b.bedNo) === hit.id; })[0];
      setRay(e); var pt2 = planePoint(elevation(bed ? bed.floor : '1')); if (!pt2) return;
      S.drag = { type: 'bed', id: hit.id, offX: pt2.x - p.x, offZ: pt2.z - p.z, el: elevation(bed ? bed.floor : '1') };
    }
  }

  function onDown(e) {
    if (e.button !== 0 || !S) return;
    var hit = pickAt(e);
    S.down = { x: e.clientX, y: e.clientY, hit: hit, moved: false };
    if (S.view.edit && hit) {
      S.sel = { type: hit.type === 'handle' ? 'room' : hit.type, id: hit.id };
      S.controls.enabled = false; S.canvas.setPointerCapture(e.pointerId);
      startDrag(hit, e); drawSelection(); updatePanel();
    }
  }
  function onMove(e) {
    if (!S) return;
    if (S.down && !S.down.moved && Math.abs(e.clientX - S.down.x) + Math.abs(e.clientY - S.down.y) > 4) S.down.moved = true;
    if (!S.drag) {
      if (!S.hoverT || performance.now() - S.hoverT > 60) {
        S.hoverT = performance.now();
        var h = pickAt(e); S.canvas.style.cursor = h ? (S.view.edit ? 'move' : 'pointer') : '';
      }
      return;
    }
    var d = S.drag, model = S.model;
    setRay(e);
    if (d.type === 'room') {
      var r = model.rooms[d.id], pt = planePoint(elevation(r.floor)); if (!pt) return;
      r.x = round2(snap(pt.x - d.offX)); r.z = round2(snap(pt.z - d.offZ));
      var g = S.roomGroups[r.id]; if (g) g.position.set(r.x, 0, r.z);
      d.carried.forEach(function (c) {       // beds inside the room keep their offset from the room's corner
        var p = model.beds[c.key]; if (!p) return;
        p.x = round2(c.x0 + (r.x - d.startX)); p.z = round2(c.z0 + (r.z - d.startZ));
        var bg = S.bedGroups[c.key]; if (bg) bg.position.set(p.x, bg.position.y, p.z);
      });
      drawSelection();
    } else if (d.type === 'handle') {
      var rr = model.rooms[d.id], p3 = planePoint(elevation(rr.floor)); if (!p3) return;
      rr.w = round2(Math.max(MIN_SIZE, snap(p3.x - rr.x))); rr.d = round2(Math.max(MIN_SIZE, snap(p3.z - rr.z)));
      rr.nw = round2(clamp(rr.nw, 0.5, Math.max(0.5, rr.w - 0.5))); rr.nd = round2(clamp(rr.nd, 0.5, Math.max(0.5, rr.d - 0.5)));
      rebuildRoomOnly(rr.id);
    } else if (d.type === 'bed') {
      var p2 = model.beds[d.id], pt3 = planePoint(d.el); if (!pt3) return;
      p2.x = round2(snap(pt3.x - d.offX)); p2.z = round2(snap(pt3.z - d.offZ));
      var bg2 = S.bedGroups[d.id]; if (bg2) bg2.position.set(p2.x, d.el, p2.z);
      drawSelection();
    }
  }
  function onUp(e) {
    if (!S) return;
    S.controls.enabled = true;
    try { S.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* not captured */ }
    var d = S.drag, down = S.down; S.drag = null; S.down = null;
    if (d) {
      if (down && down.moved) { save(); }
      if (d.type === 'room' || d.type === 'handle') rebuildAll(); else { drawSelection(); updatePanel(); }
      return;
    }
    if (!down || down.moved) return;      // it was an orbit/pan gesture, not a click
    if (!S.view.edit) {
      if (down.hit && down.hit.type === 'bed') {
        var beds = S.host.getBeds() || [], idx = -1;
        beds.forEach(function (b, i) { if (bedKey(b.bedNo) === down.hit.id) idx = i; });
        if (idx >= 0) S.host.openBed(idx);
      }
    } else if (!down.hit) { S.sel = null; drawSelection(); updatePanel(); }
  }
  function rebuildRoomOnly(id) {
    var r = S.model.rooms[id], old = S.roomGroups[id];
    if (old) { S.roomsG.remove(old); disposeGroup(old); }
    S.pickables = S.pickables.filter(function (o) { return !(o.userData.pick && o.userData.pick.id === id && o.userData.pick.type === 'room'); });
    var g = buildRoom(r); S.roomGroups[id] = g; S.roomsG.add(g);
    g.traverse(function (o) { if (o.userData.pick) S.pickables.push(o); });
    drawSelection();
  }

  // ── persistence ──
  var saveTimer = null;
  function save() {
    if (!S) return;
    clearTimeout(saveTimer);
    var branch = S.branch, model = S.model;
    saveTimer = setTimeout(function () { S.host.save(branch, JSON.parse(JSON.stringify(model))); S.isDefault = false; }, 250);
  }

  // ── side panel ──
  function selRoom() { return S.sel && S.sel.type === 'room' ? S.model.rooms[S.sel.id] : null; }
  function selBedInfo() {
    if (!S.sel || S.sel.type !== 'bed') return null;
    var beds = S.host.getBeds() || [];
    for (var i = 0; i < beds.length; i++) if (bedKey(beds[i].bedNo) === S.sel.id) return { bed: beds[i], idx: i, place: S.model.beds[S.sel.id] };
    return null;
  }

  function numField(label, id, val, step, min) {
    return '<div><label>' + label + '</label><input type="number" data-f="' + id + '" value="' + val + '" step="' + (step || 0.25) + '"' + (min != null ? ' min="' + min + '"' : '') + '></div>';
  }

  function updatePanel() {
    if (!S) return;
    var p = S.panel, beds = S.host.getBeds() || [], sp = splitBeds(beds, S.model);
    var counts = { vacant: 0, occupied: 0, reserved: 0 };
    sp.placed.forEach(function (it) { var s = it.bed.status || 'vacant'; if (counts[s] != null) counts[s]++; });
    var legend = '<div class="bm3d-leg"><span><i style="background:' + STATUS_COLORS.vacant + '"></i>ว่าง ' + counts.vacant + '</span>' +
      '<span><i style="background:' + STATUS_COLORS.occupied + '"></i>มีผู้พัก ' + counts.occupied + '</span>' +
      '<span><i style="background:' + STATUS_COLORS.reserved + '"></i>จอง ' + counts.reserved + '</span></div>';
    var html = '<div><h4>สถานะเตียงในผัง</h4>' + legend +
      '<div style="margin-top:6px;color:var(--text3)">วางในผังแล้ว ' + sp.placed.length + ' / ' + beds.length + ' เตียง</div></div>';

    if (!S.view.edit) {
      html += '<div style="color:var(--text2);line-height:1.5">คลิกที่เตียงเพื่อดู/แก้ไขผู้พักและสถานะ<br>ลาก = หมุนมุมมอง · ล้อเมาส์ = ซูม · คลิกขวาลาก = เลื่อน</div>';
      if (sp.unplaced.length) html += '<div style="color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:6px 8px">มี ' + sp.unplaced.length + ' เตียงที่ยังไม่ได้วางในผัง 3D — กด "✏️ แก้ไข" เพื่อวาง</div>';
      p.innerHTML = html; return;
    }

    // edit mode: add things
    html += '<div><h4>เพิ่ม</h4><div class="bm3d-row"><button class="bm3d-btn pri" data-act="addRoom">＋ ห้อง</button>' +
      '<button class="bm3d-btn" data-act="newBed">＋ สร้างเตียงใหม่</button></div>';
    html += '<div style="margin-top:8px"><label>วางเตียงที่ยังไม่อยู่ในผัง (' + sp.unplaced.length + ')</label><div class="bm3d-row"><select data-f="unplaced"' + (sp.unplaced.length ? '' : ' disabled') + '>' +
      (sp.unplaced.length ? sp.unplaced.map(function (it) { return '<option value="' + esc(it.key) + '">' + esc(it.bed.bedNo) + ' (ชั้น ' + esc(it.bed.floor || '1') + ')' + '</option>'; }).join('') : '<option>— วางครบแล้ว —</option>') +
      '</select><button class="bm3d-btn" data-act="placeBed"' + (sp.unplaced.length ? '' : ' disabled') + '>วาง</button></div></div></div>';

    var r = selRoom(), bi = selBedInfo();
    if (r) {
      html += '<div><h4>ห้องที่เลือก</h4>' +
        '<div><label>ชื่อห้อง</label><input type="text" data-f="name" value="' + esc(r.name) + '"></div>' +
        '<div class="bm3d-row" style="margin-top:6px"><div><label>ชั้น</label><select data-f="floor"><option value="1"' + (r.floor === '1' ? ' selected' : '') + '>ชั้น 1</option><option value="2"' + (r.floor === '2' ? ' selected' : '') + '>ชั้น 2</option></select></div>' +
        '<div><label>สี</label><input type="color" data-f="color" value="' + r.color + '"></div></div>' +
        '<div class="bm3d-row" style="margin-top:6px">' + numField('กว้าง (ม.)', 'w', r.w, 0.25, MIN_SIZE) + numField('ยาว (ม.)', 'd', r.d, 0.25, MIN_SIZE) + numField('สูง (ม.)', 'h', r.h, 0.1, 1) + '</div>' +
        '<div class="bm3d-row" style="margin-top:6px">' + numField('ตำแหน่ง X', 'x', r.x) + numField('ตำแหน่ง Z', 'z', r.z) + '</div>' +
        '<div style="margin-top:6px"><label>รูปทรง</label><select data-f="shape"><option value="rect"' + (r.shape === 'rect' ? ' selected' : '') + '>สี่เหลี่ยม</option><option value="L"' + (r.shape === 'L' ? ' selected' : '') + '>ตัว L (ตัดมุม)</option></select></div>' +
        (r.shape === 'L' ? '<div class="bm3d-row" style="margin-top:6px">' + numField('ตัดกว้าง', 'nw', r.nw) + numField('ตัดยาว', 'nd', r.nd) +
          '<div><label>มุมที่ตัด</label><select data-f="corner">' + [['ne', 'บนขวา'], ['nw', 'บนซ้าย'], ['se', 'ล่างขวา'], ['sw', 'ล่างซ้าย']].map(function (c) { return '<option value="' + c[0] + '"' + (r.corner === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select></div></div>' : '') +
        '<div class="bm3d-row" style="margin-top:8px"><button class="bm3d-btn" data-act="dupRoom">⧉ ทำซ้ำ</button><button class="bm3d-btn dng" data-act="delRoom">🗑 ลบห้อง</button></div>' +
        '<div style="margin-top:6px;color:var(--text3)">ลากพื้นห้องเพื่อย้าย (เตียงในห้องย้ายตาม) · ลากจุดน้ำเงินเพื่อปรับขนาด</div></div>';
    } else if (bi) {
      html += '<div><h4>เตียงที่เลือก: ' + esc(bi.bed.bedNo) + '</h4>' +
        '<div style="color:var(--text2)">' + esc(STATUS_LABEL[bi.bed.status || 'vacant'] || '') + (bi.bed.custName ? ' · ' + esc(bi.bed.custName) : '') + ' · ชั้น ' + esc(bi.bed.floor || '1') + '</div>' +
        '<div class="bm3d-row" style="margin-top:8px"><button class="bm3d-btn" data-act="rotL">⟲ หมุน</button><button class="bm3d-btn" data-act="rotR">⟳ หมุน</button></div>' +
        '<div class="bm3d-row" style="margin-top:6px"><button class="bm3d-btn" data-act="editBed">แก้ไขข้อมูลเตียง</button><button class="bm3d-btn dng" data-act="unplace">ถอดออกจากผัง</button></div>' +
        '<div style="margin-top:6px;color:var(--text3)">ลากเตียงเพื่อย้าย (ย้ายได้ทุกที่บนพื้นชั้นนั้น)</div></div>';
    } else {
      html += '<div style="color:var(--text3);line-height:1.5">คลิกห้องหรือเตียงเพื่อแก้ไข · ลากเพื่อย้าย<br>ลากบนพื้นที่ว่างเพื่อหมุนมุมมอง</div>';
    }
    html += '<div style="margin-top:auto"><button class="bm3d-btn dng" data-act="reset">↺ รีเซ็ตเป็นแบบเริ่มต้น</button></div>';
    p.innerHTML = html;
  }

  function onPanelChange(e) {
    var f = e.target.getAttribute && e.target.getAttribute('data-f');
    if (!f || f === 'unplaced') return;
    var r = selRoom(); if (!r) return;
    var v = e.target.value;
    if (f === 'name') r.name = (v || '').trim() || r.name;
    else if (f === 'floor') r.floor = v === '2' ? '2' : '1';
    else if (f === 'color') r.color = v;
    else if (f === 'shape') r.shape = v === 'L' ? 'L' : 'rect';
    else if (f === 'corner') r.corner = v;
    else if (f === 'w') r.w = round2(Math.max(MIN_SIZE, num(v, r.w)));
    else if (f === 'd') r.d = round2(Math.max(MIN_SIZE, num(v, r.d)));
    else if (f === 'h') r.h = round2(clamp(num(v, r.h), 1, 6));
    else if (f === 'x') r.x = round2(num(v, r.x));
    else if (f === 'z') r.z = round2(num(v, r.z));
    else if (f === 'nw') r.nw = round2(clamp(num(v, r.nw), 0.5, Math.max(0.5, r.w - 0.5)));
    else if (f === 'nd') r.nd = round2(clamp(num(v, r.nd), 0.5, Math.max(0.5, r.d - 0.5)));
    S.model.rooms[r.id] = makeRoom(r);
    save(); rebuildAll();
  }

  function onPanelClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn || btn.disabled) return;
    var act = btn.getAttribute('data-act'), model = S.model;
    if (act === 'addRoom') {
      var fl = S.view.floor === '2' ? '2' : '1';
      var rooms = Object.keys(model.rooms).map(function (k) { return model.rooms[k]; }).filter(function (r) { return r.floor === fl; });
      var b = boundsOf(rooms);
      var r = makeRoom({ name: 'ห้องใหม่ ' + (Object.keys(model.rooms).length + 1), floor: fl, x: rooms.length ? snap(b.x1 + 0.5) : 0, z: rooms.length ? snap(b.z0) : 0, w: 4, d: 4 });
      model.rooms[r.id] = r; S.sel = { type: 'room', id: r.id }; save(); rebuildAll(); fitCamera('iso');
    } else if (act === 'dupRoom') {
      var src = selRoom(); if (!src) return;
      var cp = makeRoom(Object.assign({}, src, { id: newId('r'), name: src.name + ' (สำเนา)', x: src.x + 1, z: src.z + 1 }));
      model.rooms[cp.id] = cp; S.sel = { type: 'room', id: cp.id }; save(); rebuildAll();
    } else if (act === 'delRoom') {
      var rr = selRoom(); if (!rr) return;
      if (!confirm('ลบห้อง "' + rr.name + '" ?\n(เตียงที่วางอยู่ในห้องนี้จะยังอยู่ในผัง)')) return;
      delete model.rooms[rr.id]; S.sel = null; save(); rebuildAll();
    } else if (act === 'newBed') {
      S.host.openNewBed(S.view.floor === '2' ? '2' : '1');
    } else if (act === 'placeBed') {
      var sel = S.panel.querySelector('[data-f="unplaced"]'); if (!sel || !sel.value) return;
      var it = splitBeds(S.host.getBeds() || [], model).unplaced.filter(function (u) { return u.key === sel.value; })[0]; if (!it) return;
      var pr = selRoom();
      var pl = defaultPlacement(model, it.bed.floor || '1', pr ? pr.id : null);
      model.beds[it.key] = { no: String(it.bed.bedNo), x: pl.x, z: pl.z, rot: pl.rot };
      S.sel = { type: 'bed', id: it.key };
      if (S.view.floor !== 'all' && S.view.floor !== String(it.bed.floor || '1')) setFloor(String(it.bed.floor || '1'), true);
      save(); rebuildAll();
    } else if (act === 'rotL' || act === 'rotR') {
      var bi = selBedInfo(); if (!bi || !bi.place) return;
      bi.place.rot = (bi.place.rot + (act === 'rotR' ? 90 : 270)) % 360; save(); rebuildAll();
    } else if (act === 'editBed') {
      var b2 = selBedInfo(); if (b2) S.host.openBed(b2.idx);
    } else if (act === 'unplace') {
      if (S.sel && S.sel.type === 'bed') { delete model.beds[S.sel.id]; S.sel = null; save(); rebuildAll(); }
    } else if (act === 'reset') {
      if (!confirm('รีเซ็ตผัง 3D ของสาขานี้เป็นแบบเริ่มต้น?\nห้องและตำแหน่งเตียงที่ออกแบบไว้จะหายทั้งหมด (ข้อมูลเตียง/ผู้พักไม่หาย)')) return;
      S.model = defaultModel(); S.sel = null; save(); rebuildAll(); fitCamera('iso');
    }
  }

  // ── top bar ──
  function setFloor(f, silent) {
    S.view.floor = f; if (!silent) { S.sel = null; }
    S.bar.querySelectorAll('[data-floor]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-floor') === f); });
    rebuildAll(); if (!silent) fitCamera('iso');
  }
  function setEdit(on) {
    S.view.edit = on; S.sel = null;
    var b = S.bar.querySelector('[data-act="edit"]'); b.classList.toggle('pri', on); b.textContent = on ? '✅ เสร็จแล้ว' : '✏️ แก้ไข';
    S.hint.textContent = on ? 'โหมดแก้ไข: ลากห้อง/เตียงเพื่อย้าย · ลากพื้นที่ว่างเพื่อหมุนมุมมอง' : 'ลาก = หมุน · ล้อเมาส์ = ซูม · คลิกเตียง = ดู/แก้ไขผู้พัก';
    rebuildAll();
  }
  function onBarClick(e) {
    var fl = e.target.closest && e.target.closest('[data-floor]');
    if (fl) { setFloor(fl.getAttribute('data-floor')); return; }
    var btn = e.target.closest && e.target.closest('[data-act]'); if (!btn) return;
    var a = btn.getAttribute('data-act');
    if (a === 'edit') setEdit(!S.view.edit);
    else if (a === 'low') { S.view.low = !S.view.low; btn.classList.toggle('on', S.view.low); rebuildAll(); }
    else if (a === 'top') fitCamera('top');
    else if (a === 'iso') fitCamera('iso');
  }

  // ── lifecycle ──
  function resize() {
    if (!S) return;
    var w = S.stage.clientWidth, h = S.stage.clientHeight; if (!w || !h) return;
    S.renderer.setSize(w, h, false); S.camera.aspect = w / h; S.camera.updateProjectionMatrix();
  }
  function loop() {
    if (!S) return;
    S.raf = requestAnimationFrame(loop);
    if (!S.stage.offsetParent) return;           // page hidden → skip rendering
    S.controls.update(); S.renderer.render(S.scene, S.camera);
  }

  function loadModelForBranch() {
    S.branch = S.host.getBranch();
    var saved = S.host.getModel(S.branch);
    S.isDefault = !saved;
    S.model = saved ? normalizeModel(saved) : defaultModel();
    S.sel = null;
  }

  function init(container, host) {
    var T = root.THREE;
    injectCss();
    container.innerHTML =
      '<div class="bm3d"><div class="bm3d-main">' +
      '<div class="bm3d-bar"><div class="bm3d-seg">' +
      '<button data-floor="1" class="on">ชั้น 1</button><button data-floor="2">ชั้น 2</button><button data-floor="all">ทั้งสองชั้น</button></div>' +
      '<div class="bm3d-seg"><button data-act="iso">มุมเฉียง</button><button data-act="top">มุมบน</button></div>' +
      '<button class="bm3d-btn" data-act="low" title="ลดความสูงผนังเพื่อมองเห็นเตียงด้านใน">ผนังเตี้ย</button>' +
      '<span style="flex:1"></span><button class="bm3d-btn" data-act="edit">✏️ แก้ไข</button></div>' +
      '<div class="bm3d-stage"><canvas></canvas><div class="bm3d-hint"></div></div></div>' +
      '<div class="bm3d-panel"></div></div>';
    var stage = container.querySelector('.bm3d-stage'), canvas = stage.querySelector('canvas');
    S = {
      host: host, container: container, stage: stage, canvas: canvas, hint: stage.querySelector('.bm3d-hint'),
      bar: container.querySelector('.bm3d-bar'), panel: container.querySelector('.bm3d-panel'),
      view: { floor: '1', edit: false, low: false }, sel: null, drag: null, down: null,
      ray: new T.Raycaster(), ndc: new T.Vector2(), pickables: [], roomGroups: {}, bedGroups: {}
    };
    loadModelForBranch();
    S.renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true });
    S.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    S.renderer.setClearColor(0xeaf0f8, 1);
    S.scene = new T.Scene();
    S.camera = new T.PerspectiveCamera(45, 1, 0.1, 400);
    S.controls = new T.OrbitControls(S.camera, canvas);
    S.controls.enableDamping = true; S.controls.dampingFactor = 0.12; S.controls.maxPolarAngle = Math.PI / 2.02;
    S.scene.add(new T.AmbientLight(0xffffff, 0.78));
    var sun = new T.DirectionalLight(0xffffff, 0.55); sun.position.set(12, 24, 10); S.scene.add(sun);
    var grid = new T.GridHelper(60, 60, 0x94a3b8, 0xcbd5e1); grid.position.set(7, -0.21, 4); S.scene.add(grid);
    S.roomsG = new T.Group(); S.bedsG = new T.Group(); S.selG = new T.Group();
    S.scene.add(S.roomsG); S.scene.add(S.bedsG); S.scene.add(S.selG);
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp); canvas.addEventListener('pointercancel', onUp);
    S.bar.addEventListener('click', onBarClick);
    S.panel.addEventListener('click', onPanelClick); S.panel.addEventListener('change', onPanelChange);
    if (window.ResizeObserver) { S.ro = new ResizeObserver(resize); S.ro.observe(stage); } else window.addEventListener('resize', resize);
    resize(); setEdit(false); fitCamera('iso'); loop();
  }

  function mount(container, host) {
    unmount();
    var my = ++mountSeq;
    return loadLibs().then(function () {
      if (my !== mountSeq || !container.isConnected) return;     // superseded or removed while loading
      init(container, host);
    }).catch(function (e) {
      if (my !== mountSeq) return;
      container.innerHTML = '<div class="bm3d-err">เปิดมุมมอง 3D ไม่ได้: ' + esc(e.message || e) + '<br><small>ต้องต่ออินเทอร์เน็ต/อนุญาต WebGL ในเบราว์เซอร์</small></div>';
    });
  }
  function refresh() {
    if (!S) return;
    var branchChanged = S.host.getBranch() !== S.branch;
    if (branchChanged) { loadModelForBranch(); S.view.floor = '1'; S.bar.querySelectorAll('[data-floor]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-floor') === '1'); }); }
    rebuildAll(); if (branchChanged) fitCamera('iso');
  }
  function unmount() {
    mountSeq++;
    if (!S) return;
    cancelAnimationFrame(S.raf); clearTimeout(saveTimer);
    if (S.ro) S.ro.disconnect(); else window.removeEventListener('resize', resize);
    clearGroup(S.roomsG); clearGroup(S.bedsG); clearGroup(S.selG);
    S.controls.dispose(); S.renderer.dispose();
    S = null;
  }
  function isMounted() { return !!S; }

  var api = {
    mount: mount, refresh: refresh, unmount: unmount, isMounted: isMounted,
    _state: function () { return S; },     // for debugging / browser tests only
    _test: { snap: snap, bedKey: bedKey, elevation: elevation, roomPolygon: roomPolygon, makeRoom: makeRoom, defaultModel: defaultModel,
             normalizeModel: normalizeModel, splitBeds: splitBeds, defaultPlacement: defaultPlacement, boundsOf: boundsOf, insideRoomBox: insideRoomBox }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BedMap3D = api;
})(typeof window !== 'undefined' ? window : this);
