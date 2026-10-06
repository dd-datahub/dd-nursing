// Run:  node billing-core.test.js     (no dependencies; exits non-zero on failure)
const assert = require('assert');
const BC = require('./billing-core.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

const catalog = [{ id: 'p1', price: 100 }, { id: 'p2', price: 50 }];
function make(over = {}) {
  const customers = over.customers || [{ id: 'DD1/01', fee: 16000, due_date: '10-ม.ค.-2569' }];
  const reqs = over.reqs || {};
  const edits = over.edits || {};
  const pays = over.pays || {};
  return BC.create({
    findCustomer: (id) => customers.find((c) => c.id === id),
    getRequisitions: (id, ym) => reqs[BC.reqKey(id, ym)],
    getCatalog: () => catalog,
    getRcptEdits: (id, ym) => edits[BC.reqKey(id, ym)] || null,
    getPayment: (id, ym) => pays[BC.reqKey(id, ym)],
  });
}

console.log('helpers');
test('parseDueDay', () => { assert.strictEqual(BC.parseDueDay('7-พ.ค.-2566'), 7); assert.strictEqual(BC.parseDueDay(''), 1); assert.strictEqual(BC.parseDueDay('x'), 1); });
test('parseStartYM converts Buddhist year', () => { assert.strictEqual(BC.parseStartYM('10-ส.ค.-2569'), '2026-08'); assert.strictEqual(BC.parseStartYM('bad'), null); });
test('isBeforeStart', () => {
  const c = { due_date: '10-ส.ค.-2569' };
  assert.strictEqual(BC.isBeforeStart(c, '2026-07'), true);
  assert.strictEqual(BC.isBeforeStart(c, '2026-08'), false);
  assert.strictEqual(BC.isBeforeStart({ due_date: '' }, '2020-01'), false);
});
test('reqKey sanitises slash', () => assert.strictEqual(BC.reqKey('DD1/01', '2026-05'), 'DD1_01_2026-05'));

console.log('calcTotalBill');
test('base fee only', () => assert.strictEqual(make().calcTotalBill('DD1/01', '2026-05'), 16000));
test('unknown customer -> 0', () => assert.strictEqual(make().calcTotalBill('NOPE', '2026-05'), 0));
test('before service start -> 0', () => assert.strictEqual(make().calcTotalBill('DD1/01', '2025-12'), 0));
test('adds requisitions inside the billing window (due day 10: 10 Apr .. 9 May)', () => {
  const bc = make({ reqs: { 'DD1_01_2026-04': [{ itemId: 'p1', qty: 2, savedAt: '2026-04-20T08:00:00Z' }],
                            'DD1_01_2026-05': [{ itemId: 'p2', qty: 1, savedAt: '2026-05-09T08:00:00Z' }] } });
  assert.strictEqual(bc.calcTotalBill('DD1/01', '2026-05'), 16000 + 200 + 50);
});
test('excludes requisitions outside the window (before 10 Apr and from 10 May)', () => {
  const bc = make({ reqs: { 'DD1_01_2026-04': [{ itemId: 'p1', qty: 1, savedAt: '2026-04-09T23:00:00Z' }],
                            'DD1_01_2026-05': [{ itemId: 'p1', qty: 1, savedAt: '2026-05-10T00:00:00Z' }] } });
  assert.strictEqual(bc.calcTotalBill('DD1/01', '2026-05'), 16000);
});
test('entry without savedAt is always counted', () => {
  assert.strictEqual(make({ reqs: { 'DD1_01_2026-05': [{ itemId: 'p1', qty: 3 }] } }).calcTotalBill('DD1/01', '2026-05'), 16300);
});
test('per-entry price override beats catalog price', () => {
  assert.strictEqual(make({ reqs: { 'DD1_01_2026-05': [{ itemId: 'p1', qty: 2, price: 30 }] } }).calcTotalBill('DD1/01', '2026-05'), 16060);
});
test('unknown catalog item ignored', () => {
  assert.strictEqual(make({ reqs: { 'DD1_01_2026-05': [{ itemId: 'zzz', qty: 5 }] } }).calcTotalBill('DD1/01', '2026-05'), 16000);
});
test('firebase object-shaped requisition list is accepted', () => {
  assert.strictEqual(make({ reqs: { 'DD1_01_2026-05': { a1: { itemId: 'p1', qty: 1 }, a2: { itemId: 'p2', qty: 2 } } } }).calcTotalBill('DD1/01', '2026-05'), 16200);
});
test('missing fee counts as 0 (no NaN)', () => {
  assert.strictEqual(make({ customers: [{ id: 'DD1/01', due_date: '10-ม.ค.-2569' }] }).calcTotalBill('DD1/01', '2026-05'), 0);
});
test('window across year boundary (due day 10, January bill covers 10 Dec .. 9 Jan)', () => {
  const bc = make({ reqs: { 'DD1_01_2025-12': [{ itemId: 'p1', qty: 1, savedAt: '2025-12-31T10:00:00Z' }] } });
  assert.strictEqual(bc.calcTotalBill('DD1/01', '2026-01'), 16100);
});

console.log('calcReceiptTotal');
test('falls back to calcTotalBill when receipt never edited', () => assert.strictEqual(make().calcReceiptTotal('DD1/01', '2026-05'), 16000));
test('before start with no edits -> 0 (regression guard)', () => assert.strictEqual(make().calcReceiptTotal('DD1/01', '2025-12'), 0));
test('uses saved receipt items, subtracts discounts, skips isOther rows', () => {
  const edits = { 'DD1_01_2026-05': [
    { id: 'row_1', amount: 16000 }, { id: 'row_2', amount: 999, isOther: true },
    { id: 'req_p1', amount: 4000, isSub: true }, { id: 'disc_1', amount: 2000, isDiscount: true } ] };
  assert.strictEqual(make({ edits }).calcReceiptTotal('DD1/01', '2026-05'), 18000);
});
test('line amount falls back to qty*price when amount is 0/missing', () => {
  const edits = { 'DD1_01_2026-05': [{ id: 'r', qty: '3', price: '250' }] };
  assert.strictEqual(make({ edits }).calcReceiptTotal('DD1/01', '2026-05'), 750);
});
test('fully discounted receipt totals 0', () => {
  const edits = { 'DD1_01_2026-05': [{ id: 'r', amount: 3100 }, { id: 'd', amount: 3100, isDiscount: true }] };
  assert.strictEqual(make({ edits }).calcReceiptTotal('DD1/01', '2026-05'), 0);
});
test('saved edits win even before service start', () => {
  const edits = { 'DD1_01_2025-12': [{ id: 'r', amount: 500 }] };
  assert.strictEqual(make({ edits }).calcReceiptTotal('DD1/01', '2025-12'), 500);
});

console.log('getPayStatus');
test('no payment -> unpaid', () => assert.strictEqual(make().getPayStatus('DD1/01', '2026-05'), 'unpaid'));
test('unknown customer -> unpaid', () => assert.strictEqual(make({ pays: { 'NOPE_2026-05': { amount: 1 } } }).getPayStatus('NOPE', '2026-05'), 'unpaid'));
test('exact amount -> paid', () => assert.strictEqual(make({ pays: { 'DD1_01_2026-05': { amount: 16000 } } }).getPayStatus('DD1/01', '2026-05'), 'paid'));
test('overpaid -> paid', () => assert.strictEqual(make({ pays: { 'DD1_01_2026-05': { amount: 20000 } } }).getPayStatus('DD1/01', '2026-05'), 'paid'));
test('less than total -> partial', () => assert.strictEqual(make({ pays: { 'DD1_01_2026-05': { amount: 5000 } } }).getPayStatus('DD1/01', '2026-05'), 'partial'));
test('zero amount -> unpaid', () => assert.strictEqual(make({ pays: { 'DD1_01_2026-05': { amount: 0 } } }).getPayStatus('DD1/01', '2026-05'), 'unpaid'));
test('status follows the edited receipt total, not the base fee', () => {
  const edits = { 'DD1_01_2026-05': [{ id: 'r', amount: 16000 }, { id: 'd', amount: 2000, isDiscount: true }] };
  const pays = { 'DD1_01_2026-05': { amount: 14000 } };
  assert.strictEqual(make({ edits, pays }).getPayStatus('DD1/01', '2026-05'), 'paid');
});

console.log(`\n${passed} passed${process.exitCode ? ', with FAILURES' : ''}`);
