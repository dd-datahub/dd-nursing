// Run:  node bedmap-3d.test.js     (no dependencies; exits non-zero on failure)
// Tests the pure model/geometry helpers of bedmap-3d.js (the three.js rendering is checked in the browser).
const assert = require('assert');
const T = require('./bedmap-3d.js')._test;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

function area(poly) { // shoelace
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

console.log('helpers');
test('snap rounds to the 0.25 m grid', () => { assert.strictEqual(T.snap(1.12), 1.0); assert.strictEqual(T.snap(1.13), 1.25); assert.strictEqual(T.snap(-0.1), -0); });
test('bedKey makes Firebase-safe keys', () => { assert.strictEqual(T.bedKey('B1'), 'B1'); assert.strictEqual(T.bedKey('A/1.2#[x]$'), 'A_1_2__x__'); });
test('floor 2 is raised', () => { assert.strictEqual(T.elevation('1'), 0); assert.ok(T.elevation('2') > 2); assert.strictEqual(T.elevation(2), T.elevation('2')); });

console.log('roomPolygon');
test('rectangle area = w*d', () => assert.strictEqual(area(T.roomPolygon({ w: 4, d: 3 })), 12));
test('L shape area = w*d - notch for every corner', () => {
  ['ne', 'nw', 'se', 'sw'].forEach((corner) => {
    const p = T.roomPolygon({ shape: 'L', w: 6, d: 4, nw: 2, nd: 1.5, corner });
    assert.strictEqual(p.length, 6, corner);
    assert.strictEqual(area(p), 6 * 4 - 2 * 1.5, corner);
    p.forEach(([x, z]) => { assert.ok(x >= 0 && x <= 6 && z >= 0 && z <= 4, corner + ' inside bounding box'); });
  });
});
test('L notch is clamped so the room never disappears', () => {
  const p = T.roomPolygon({ shape: 'L', w: 3, d: 3, nw: 99, nd: 99, corner: 'ne' });
  assert.ok(area(p) > 0);
});

console.log('makeRoom / normalizeModel');
test('makeRoom enforces minimum size, wall height range and colour format', () => {
  const r = T.makeRoom({ name: 'x', w: 0.2, d: -5, h: 99, color: 'red', floor: 2 });
  assert.ok(r.w >= 1.5 && r.d >= 1.5); assert.strictEqual(r.h, 6); assert.ok(/^#[0-9a-f]{6}$/i.test(r.color)); assert.strictEqual(r.floor, '2');
});
test('normalizeModel copes with empty / odd Firebase data', () => {
  assert.deepStrictEqual(T.normalizeModel(null), { rooms: {}, beds: {} });
  assert.deepStrictEqual(T.normalizeModel({}), { rooms: {}, beds: {} });
  const m = T.normalizeModel({ rooms: { a: { name: 'A', x: '2', z: 'abc', w: '5', d: 4 } }, beds: { B1: { x: 1.234, z: 2, rot: 95 }, B2: null } });
  assert.strictEqual(m.rooms.a.id, 'a'); assert.strictEqual(m.rooms.a.x, 2); assert.strictEqual(m.rooms.a.z, 0); assert.strictEqual(m.rooms.a.w, 5);
  assert.strictEqual(m.beds.B1.no, 'B1'); assert.strictEqual(m.beds.B1.x, 1.23); assert.strictEqual(m.beds.B1.rot, 90); assert.ok(!('B2' in m.beds));
});
test('defaultModel: rooms on both floors, none overlap, no beds', () => {
  const m = T.defaultModel(); const rooms = Object.values(m.rooms);
  assert.ok(rooms.some((r) => r.floor === '1') && rooms.some((r) => r.floor === '2')); assert.deepStrictEqual(m.beds, {});
  rooms.forEach((a) => rooms.forEach((b) => {
    if (a === b || a.floor !== b.floor) return;
    const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.z < b.z + b.d - 1e-9 && b.z < a.z + a.d - 1e-9;
    assert.ok(!overlap, a.name + ' overlaps ' + b.name);
  }));
});

console.log('beds');
test('splitBeds separates placed and unplaced beds', () => {
  const model = { rooms: {}, beds: { B1: { no: 'B1', x: 1, z: 1, rot: 0 } } };
  const r = T.splitBeds([{ bedNo: 'B1' }, { bedNo: 'B2' }, { bedNo: 'B3' }], model);
  assert.deepStrictEqual(r.placed.map((x) => x.bed.bedNo), ['B1']); assert.deepStrictEqual(r.unplaced.map((x) => x.idx), [1, 2]);
});
test('defaultPlacement puts a bed inside the preferred room and does not stack beds', () => {
  const model = T.defaultModel(); const room = Object.values(model.rooms).find((r) => r.floor === '1' && r.name === 'ห้องพัก 1');
  const p1 = T.defaultPlacement(model, '1', room.id);
  assert.ok(T.insideRoomBox(room, p1.x, p1.z));
  model.beds.B1 = { no: 'B1', x: p1.x, z: p1.z, rot: 0 };
  const p2 = T.defaultPlacement(model, '1', room.id);
  assert.ok(Math.abs(p2.x - p1.x) >= 0.6 || Math.abs(p2.z - p1.z) >= 0.6);
});
test('defaultPlacement falls back to a room on the bed floor', () => {
  const model = T.defaultModel(); const room = Object.values(model.rooms).find((r) => r.floor === '1');
  const p = T.defaultPlacement(model, '2', room.id);       // preferred room is on floor 1 but the bed is on floor 2
  const on2 = Object.values(model.rooms).filter((r) => r.floor === '2');
  assert.ok(on2.some((r) => T.insideRoomBox(r, p.x, p.z)));
});

console.log(`\n${passed} passed${process.exitCode ? ', with FAILURES' : ''}`);
