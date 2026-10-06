/* billing-core.js — the ONE place where bill totals and payment status are calculated.
 *
 * Used by index.html (admin), staff.html and staffud.html. Previously each file had its own copy
 * of this logic and the copies drifted apart. Each app now builds a small "context" that says how
 * to look up its own data, and gets the same calculations back:
 *
 *   const bc = BillingCore.create({
 *     findCustomer:   (custId) => customer | null | undefined,
 *     getRequisitions:(custId, 'YYYY-MM') => array | firebase-object | undefined,   // that month's requisition entries
 *     getCatalog:     () => [ {id, price, ...} ],
 *     getRcptEdits:   (custId, 'YYYY-MM') => saved receipt line items | null,
 *     getPayment:     (custId, 'YYYY-MM') => { amount, ... } | undefined,
 *   });
 *   bc.calcTotalBill(id, ym)     base fee + requisitions in the billing window (0 before service start)
 *   bc.calcReceiptTotal(id, ym)  actual receipt total (admin edits/discounts) or calcTotalBill if never edited
 *   bc.getPayStatus(id, ym)      'paid' | 'partial' | 'unpaid' — compares the payment with calcReceiptTotal
 *
 * Plain script (no modules, no dependencies) so it also runs under Node for tests (billing-core.test.js).
 * If you change this file, bump the ?v= number on the <script src> tags in the three HTML files.
 */
(function (root) {
  'use strict';

  var TH_MONTHS = { 'ม.ค.': 1, 'ก.พ.': 2, 'มี.ค.': 3, 'เม.ย.': 4, 'พ.ค.': 5, 'มิ.ย.': 6,
                    'ก.ค.': 7, 'ส.ค.': 8, 'ก.ย.': 9, 'ต.ค.': 10, 'พ.ย.': 11, 'ธ.ค.': 12 };

  function pad(n) { return String(n).padStart(2, '0'); }

  // key used by requisitions / rcpt_edits in Firebase ("/" is not allowed in keys)
  function reqKey(custId, month) { return custId.replace(/\//g, '_') + '_' + month; }

  // "7-พ.ค.-2566" -> 7
  function parseDueDay(dueDate) {
    if (!dueDate) return 1;
    var d = parseInt(String(dueDate).split('-')[0], 10);
    return isNaN(d) ? 1 : d;
  }

  // "10-ส.ค.-2569" -> "2026-08" (Buddhist year -> Gregorian); null if it can't be read
  function parseStartYM(dueDate) {
    if (!dueDate) return null;
    var parts = String(dueDate).split('-');
    if (parts.length < 3) return null;
    var mo = TH_MONTHS[parts[1]];
    var yr = parseInt(parts[2], 10) - 543;
    if (!mo || isNaN(yr) || yr < 2000) return null;
    return yr + '-' + pad(mo);
  }

  // true if the customer has not reached their service start for month ym ("YYYY-MM")
  function isBeforeStart(c, ym) {
    var startYM = parseStartYM(c.due_date);
    return startYM ? ym < startYM : false;
  }

  function toArray(raw) {
    return Array.isArray(raw) ? raw : (raw ? Object.values(raw) : []);
  }

  function lineAmount(item) {
    return parseFloat(item.amount) || (parseFloat(item.qty) || 0) * (parseFloat(item.price) || 0);
  }

  // total of a receipt's line items: everything except "other" placeholder rows and discounts, minus discounts
  function receiptItemsTotal(items) {
    var totalDiscount = 0, subTotal = 0;
    items.forEach(function (it) {
      if (it.isDiscount) totalDiscount += Math.abs(lineAmount(it));
      else if (!it.isOther) subTotal += lineAmount(it);
    });
    return subTotal - totalDiscount;
  }

  function create(ctx) {
    function calcTotalBill(custId, month) {
      var c = ctx.findCustomer(custId);
      if (!c) return 0;
      if (isBeforeStart(c, month)) return 0; // not started yet -> nothing to bill

      var dueDay = parseDueDay(c.due_date);
      var ty = parseInt(month.slice(0, 4), 10), tm = parseInt(month.slice(5, 7), 10);
      var prevDate = new Date(ty, tm - 2, 1);
      var prevYM = prevDate.getFullYear() + '-' + pad(prevDate.getMonth() + 1);

      // billing window: prev month's due day .. day before this month's due day (may span two months)
      var rangeStart = prevDate.getFullYear() + '-' + pad(prevDate.getMonth() + 1) + '-' + pad(dueDay);
      var endDate = new Date(ty, tm - 1, dueDay - 1);
      var rangeEnd = endDate.getFullYear() + '-' + pad(endDate.getMonth() + 1) + '-' + pad(endDate.getDate());

      var entries = toArray(ctx.getRequisitions(custId, prevYM)).concat(toArray(ctx.getRequisitions(custId, month)));
      var catalog = ctx.getCatalog() || [];
      var reqTotal = 0;
      entries.forEach(function (e) {
        if (e.savedAt) {
          var d = e.savedAt.slice(0, 10);
          if (d < rangeStart || d > rangeEnd) return;
        }
        var item = catalog.find(function (x) { return x.id === e.itemId; });
        if (!item) return;
        var unitPrice = (e.price != null) ? e.price : (item.price || 0);
        reqTotal += unitPrice * (parseInt(e.qty, 10) || 0);
      });
      return (c.fee || 0) + reqTotal;
    }

    function calcReceiptTotal(custId, month) {
      var saved = ctx.getRcptEdits(custId, month);
      if (saved && saved.length) return receiptItemsTotal(toArray(saved));
      return calcTotalBill(custId, month);
    }

    function getPayStatus(custId, month) {
      var p = ctx.getPayment(custId, month);
      if (!p) return 'unpaid';
      if (!ctx.findCustomer(custId)) return 'unpaid';
      var total = calcReceiptTotal(custId, month);
      if (p.amount >= total) return 'paid';
      if (p.amount > 0) return 'partial';
      return 'unpaid';
    }

    return { calcTotalBill: calcTotalBill, calcReceiptTotal: calcReceiptTotal, getPayStatus: getPayStatus };
  }

  var api = {
    create: create,
    reqKey: reqKey,
    parseDueDay: parseDueDay,
    parseStartYM: parseStartYM,
    isBeforeStart: isBeforeStart,
    receiptItemsTotal: receiptItemsTotal,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BillingCore = api;
})(typeof window !== 'undefined' ? window : this);
