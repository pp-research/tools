/* ============================================================================
 * irr-breakdown-engine.js — Performance Property
 *
 * IRR by the BREAKDOWN method: build a month-by-month cashflow over the hold
 * period, then XIRR it. Ported line-for-line from the "Breakdown (LT)" /
 * "Breakdown (ST)" tabs of "Updated IRR Calculation (15 Sep 2026)".
 *
 * Pure calculation — no DOM. Everything is UTC-based so it can't drift on a
 * daylight-saving boundary.
 *
 * The month grid runs from the 1st of the PURCHASE month to the 1st of the
 * SALE month (sheet: A8 = DATE(YEAR(C5),MONTH(C5),1), then EDATE(+1) while
 * <= EOMONTH(soldDate)). Deposit lands in the first row, sale proceeds in the
 * last — so XIRR sees the sale dated to the 1st of the sale month, not the
 * actual settlement day. That is the sheet's behaviour and is reproduced here.
 * ==========================================================================*/
(function (root) {
  'use strict';

  /* ═══ DATE HELPERS (all UTC) ═══ */

  var MS_DAY = 86400000;

  function utc(y, m, d) { return new Date(Date.UTC(y, m - 1, d)); }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  /** Excel EDATE — same day-of-month n months on, clamped to month end. */
  function edate(dt, n) {
    var y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1 + n, d = dt.getUTCDate();
    y += Math.floor((m - 1) / 12);
    m = ((m - 1) % 12 + 12) % 12 + 1;
    return utc(y, m, Math.min(d, daysInMonth(y, m)));
  }

  /** Excel EOMONTH(dt, 0) — last day of dt's month. */
  function eomonth(dt) {
    var y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
    return utc(y, m, daysInMonth(y, m));
  }

  /**
   * Excel YEARFRAC basis 0 (US 30/360 NASD).
   * Excel returns a POSITIVE fraction whichever way round the dates are —
   * that matters here, because the first breakdown row (1st of the purchase
   * month) sits BEFORE the purchase date, and the sheet still grows the
   * property value over that gap. Reproduced deliberately.
   */
  function yearFrac30360US(a, b) {
    var s = a, e = b, t;
    if (s.getTime() > e.getTime()) { t = s; s = e; e = t; }
    var d1 = s.getUTCDate(), m1 = s.getUTCMonth() + 1, y1 = s.getUTCFullYear();
    var d2 = e.getUTCDate(), m2 = e.getUTCMonth() + 1, y2 = e.getUTCFullYear();

    var sLastFeb = (m1 === 2 && d1 === daysInMonth(y1, 2));
    var eLastFeb = (m2 === 2 && d2 === daysInMonth(y2, 2));

    if (sLastFeb && eLastFeb) d2 = 30;   // NASD rule order matters
    if (sLastFeb) d1 = 30;
    if (d2 === 31 && d1 >= 30) d2 = 30;
    if (d1 === 31) d1 = 30;

    return ((y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1)) / 360;
  }

  /* ═══ XIRR (Excel-compatible: actual/365) ═══ */

  function xnpv(rate, amounts, dates) {
    var t0 = dates[0].getTime(), sum = 0;
    for (var i = 0; i < amounts.length; i++) {
      var yrs = (dates[i].getTime() - t0) / MS_DAY / 365;
      sum += amounts[i] / Math.pow(1 + rate, yrs);
    }
    return sum;
  }

  /**
   * Solve XNPV(r) = 0. Brackets by scan then bisects — slower than Newton but
   * it does not wander off on the near-vertical cashflow profile a 90% LVR
   * deal produces. Returns null when there is no sign change to bracket.
   */
  function xirr(amounts, dates) {
    if (!amounts || amounts.length < 2) return null;
    var hasPos = false, hasNeg = false;
    for (var i = 0; i < amounts.length; i++) {
      if (amounts[i] > 0) hasPos = true;
      if (amounts[i] < 0) hasNeg = true;
    }
    if (!hasPos || !hasNeg) return null;

    var lo = -0.9999, f0 = xnpv(lo, amounts, dates), hi = null, f1;
    var probe = [-0.99, -0.95, -0.9, -0.8, -0.6, -0.4, -0.2, -0.1, -0.05, 0.0001,
                 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5, 10, 50, 100, 1000];
    for (var p = 0; p < probe.length; p++) {
      f1 = xnpv(probe[p], amounts, dates);
      if (isFinite(f1) && f0 * f1 < 0) { hi = probe[p]; break; }
      if (isFinite(f1)) { lo = probe[p]; f0 = f1; }
    }
    if (hi === null) return null;

    for (var k = 0; k < 200; k++) {
      var mid = (lo + hi) / 2, fm = xnpv(mid, amounts, dates);
      if (fm === 0 || (hi - lo) < 1e-12) return mid;
      if (f0 * fm < 0) { hi = mid; } else { lo = mid; f0 = fm; }
    }
    return (lo + hi) / 2;
  }

  /* ═══ DEFAULT ASSUMPTIONS (Assumptions tab) ═══ */

  var DEFAULTS = {
    depositAndFee:    0.185,   // B2  deposit + performance fee
    runningCostPa:    0.02,    // B3  running cost per year (% of property value)
    lvr:              0.90,    // B4
    normalisedRate:   0.049,   // B5  18-yr avg cash rate + bank margin + APRA buffer
    rentalYield:      0.03,    // B6  % of property value in breakdown
    marginalTaxRate:  0.47,    // B7
    sellingCommission:0.018,   // B8
    sellingMarketSpend: 20000, // B9
    bankMargin:       0.0175,  // B10 added to ACTUAL cash rates only
    apraBuffer:       0.005,   // B11 added to ACTUAL cash rates only
    // toggles
    cashRateBasis:    'Normalised', // B14  Normalised | Actual
    negativeGearing:  'Off',        // B15  Off | On
    rentBasis:        'Growing',    // B16  Growing | Flat
    financeCostBasis: 'Purchase Price' // B17  Purchase Price | Midpoint
  };

  /* ═══ RBA CASH RATE TARGET (monthly, Jan 2008 – Aug 2026) ═══
     Public RBA policy data, lifted from the workbook's "RBA Cash Rate" tab.
     Used only when cashRateBasis = 'Actual'. Keys are "YYYY-M". */
  var RBA = {"2008-1":0.0675,"2008-2":0.07,"2008-3":0.0725,"2008-4":0.0725,"2008-5":0.0725,"2008-6":0.0725,"2008-7":0.0725,"2008-8":0.0725,"2008-9":0.07,"2008-10":0.06,"2008-11":0.0525,"2008-12":0.0425,"2009-1":0.0425,"2009-2":0.0325,"2009-3":0.0325,"2009-4":0.03,"2009-5":0.03,"2009-6":0.03,"2009-7":0.03,"2009-8":0.03,"2009-9":0.03,"2009-10":0.0325,"2009-11":0.035,"2009-12":0.0375,"2010-1":0.0375,"2010-2":0.0375,"2010-3":0.04,"2010-4":0.0425,"2010-5":0.045,"2010-6":0.045,"2010-7":0.045,"2010-8":0.045,"2010-9":0.045,"2010-10":0.045,"2010-11":0.0475,"2010-12":0.0475,"2011-1":0.0475,"2011-2":0.0475,"2011-3":0.0475,"2011-4":0.0475,"2011-5":0.0475,"2011-6":0.0475,"2011-7":0.0475,"2011-8":0.0475,"2011-9":0.0475,"2011-10":0.0475,"2011-11":0.045,"2011-12":0.0425,"2012-1":0.0425,"2012-2":0.0425,"2012-3":0.0425,"2012-4":0.0425,"2012-5":0.0375,"2012-6":0.035,"2012-7":0.035,"2012-8":0.035,"2012-9":0.035,"2012-10":0.0325,"2012-11":0.0325,"2012-12":0.03,"2013-1":0.03,"2013-2":0.03,"2013-3":0.03,"2013-4":0.03,"2013-5":0.0275,"2013-6":0.0275,"2013-7":0.0275,"2013-8":0.025,"2013-9":0.025,"2013-10":0.025,"2013-11":0.025,"2013-12":0.025,"2014-1":0.025,"2014-2":0.025,"2014-3":0.025,"2014-4":0.025,"2014-5":0.025,"2014-6":0.025,"2014-7":0.025,"2014-8":0.025,"2014-9":0.025,"2014-10":0.025,"2014-11":0.025,"2014-12":0.025,"2015-1":0.025,"2015-2":0.0225,"2015-3":0.0225,"2015-4":0.0225,"2015-5":0.02,"2015-6":0.02,"2015-7":0.02,"2015-8":0.02,"2015-9":0.02,"2015-10":0.02,"2015-11":0.02,"2015-12":0.02,"2016-1":0.02,"2016-2":0.02,"2016-3":0.02,"2016-4":0.02,"2016-5":0.0175,"2016-6":0.0175,"2016-7":0.0175,"2016-8":0.015,"2016-9":0.015,"2016-10":0.015,"2016-11":0.015,"2016-12":0.015,"2017-1":0.015,"2017-2":0.015,"2017-3":0.015,"2017-4":0.015,"2017-5":0.015,"2017-6":0.015,"2017-7":0.015,"2017-8":0.015,"2017-9":0.015,"2017-10":0.015,"2017-11":0.015,"2017-12":0.015,"2018-1":0.015,"2018-2":0.015,"2018-3":0.015,"2018-4":0.015,"2018-5":0.015,"2018-6":0.015,"2018-7":0.015,"2018-8":0.015,"2018-9":0.015,"2018-10":0.015,"2018-11":0.015,"2018-12":0.015,"2019-1":0.015,"2019-2":0.015,"2019-3":0.015,"2019-4":0.015,"2019-5":0.015,"2019-6":0.0125,"2019-7":0.01,"2019-8":0.01,"2019-9":0.01,"2019-10":0.0075,"2019-11":0.0075,"2019-12":0.0075,"2020-1":0.0075,"2020-2":0.0075,"2020-3":0.005,"2020-4":0.0025,"2020-5":0.0025,"2020-6":0.0025,"2020-7":0.0025,"2020-8":0.0025,"2020-9":0.0025,"2020-10":0.0025,"2020-11":0.001,"2020-12":0.001,"2021-1":0.001,"2021-2":0.001,"2021-3":0.001,"2021-4":0.001,"2021-5":0.001,"2021-6":0.001,"2021-7":0.001,"2021-8":0.001,"2021-9":0.001,"2021-10":0.001,"2021-11":0.001,"2021-12":0.001,"2022-1":0.001,"2022-2":0.001,"2022-3":0.001,"2022-4":0.001,"2022-5":0.0035,"2022-6":0.0085,"2022-7":0.0135,"2022-8":0.0185,"2022-9":0.0235,"2022-10":0.026,"2022-11":0.0285,"2022-12":0.031,"2023-1":0.031,"2023-2":0.0335,"2023-3":0.036,"2023-4":0.036,"2023-5":0.0385,"2023-6":0.041,"2023-7":0.041,"2023-8":0.041,"2023-9":0.041,"2023-10":0.041,"2023-11":0.0435,"2023-12":0.0435,"2024-1":0.0435,"2024-2":0.0435,"2024-3":0.0435,"2024-4":0.0435,"2024-5":0.0435,"2024-6":0.0435,"2024-7":0.0435,"2024-8":0.0435,"2024-9":0.0435,"2024-10":0.0435,"2024-11":0.0435,"2024-12":0.0435,"2025-1":0.0435,"2025-2":0.041,"2025-3":0.041,"2025-4":0.041,"2025-5":0.0385,"2025-6":0.0385,"2025-7":0.0385,"2025-8":0.036,"2025-9":0.036,"2025-10":0.036,"2025-11":0.036,"2025-12":0.036,"2026-1":0.0385,"2026-2":0.0385,"2026-3":0.0385,"2026-4":0.040999999999999995,"2026-5":0.0435,"2026-6":0.0435,"2026-7":0.0435,"2026-8":0.0435};

  /* ═══ THE BREAKDOWN ═══ */

  /**
   * @param {Object} deal  {purchasePrice, purchaseDate, soldPrice, soldDate}
   *                       dates are JS Date (UTC) or "YYYY-MM-DD"
   * @param {Object} [opts] assumption overrides — see DEFAULTS
   * @returns {Object} {rows, summary, warnings}
   */
  function computeBreakdown(deal, opts) {
    var a = {};
    for (var k in DEFAULTS) a[k] = DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined && opts[k2] !== null && opts[k2] !== '') a[k2] = opts[k2];

    var P = Number(deal.purchasePrice);
    var S = Number(deal.soldPrice);
    var pDate = toDate(deal.purchaseDate);
    var sDate = toDate(deal.soldDate);

    var warnings = [];
    if (!(P > 0)) throw new Error('Purchase price must be greater than zero');
    if (!(S > 0)) throw new Error('Sold price must be greater than zero');
    if (!pDate || !sDate) throw new Error('Both purchase and sold dates are required');
    if (sDate.getTime() < pDate.getTime()) throw new Error('Sold date cannot be before the purchase date');

    var normalised = (a.cashRateBasis === 'Normalised');
    var midpointLoan = (a.financeCostBasis === 'Midpoint');
    var flatRent = (a.rentBasis === 'Flat');
    var ngOn = (a.negativeGearing === 'On');

    /* ── summary block (sheet rows 4–5) ── */
    var holdYears    = yearFrac30360US(pDate, sDate);          // F5
    var loan         = P * a.lvr;                              // G5
    var deposit      = -P * a.depositAndFee;                   // H5
    var grossProfit  = S - P;                                  // I5
    var sellingCosts = -(S * a.sellingCommission + a.sellingMarketSpend); // P5
    var rowLoan      = midpointLoan ? ((P + S) / 2) * a.lvr : loan;       // E column

    /* ── month grid: 1st of purchase month → 1st of sale month ── */
    var dates = [];
    var cur = utc(pDate.getUTCFullYear(), pDate.getUTCMonth() + 1, 1);
    var stop = eomonth(sDate);
    while (cur.getTime() <= stop.getTime()) { dates.push(cur); cur = edate(cur, 1); }

    var rows = [], prevAccum = 0, cumFin = 0, cumCash = 0, missingRates = 0;

    for (var i = 0; i < dates.length; i++) {
      var d = dates[i];
      var isLast = (i === dates.length - 1);
      var y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1;

      // D — cash rate
      var cashRate;
      if (normalised) {
        cashRate = a.normalisedRate;
      } else {
        var hit = RBA[y + '-' + mo];
        if (hit === undefined) { cashRate = 0; missingRates++; } else { cashRate = hit; }
      }

      // F — interest. Margin + buffer are added to ACTUAL rates only; the
      //     normalised rate already includes them.
      var interest = rowLoan * (cashRate + (normalised ? 0 : a.bankMargin + a.apraBuffer)) / 12;

      // O — property value: compounds purchase→sold across the hold period,
      //     snapped to the sold price on the final row.
      var propValue = isLast
        ? S
        : P * Math.pow(S / P, yearFrac30360US(pDate, d) / holdYears);

      // G / H — running costs and rent
      var running = propValue * a.runningCostPa / 12;
      var rent = (flatRent ? (P + S) / 2 : propValue) * a.rentalYield / 12;

      // N — accumulated loss for the financial year. Resets when the PREVIOUS
      //     row was June, i.e. the July row starts the new FY.
      var monthLoss = interest + running - rent;
      var accumLoss;
      if (i === 0) accumLoss = monthLoss;
      else accumLoss = (dates[i - 1].getUTCMonth() + 1 === 6) ? monthLoss : prevAccum + monthLoss;
      prevAccum = accumLoss;

      // I — negative gearing refund: booked each June and at sale
      var ngRefund = 0;
      if (ngOn && (mo === 6 || isLast)) ngRefund = accumLoss * a.marginalTaxRate;

      // J — holding-only cashflow
      var monthlyCF = -(interest + running - rent) + ngRefund;

      // K — net cashflow: deposit on the first row, sale proceeds on the last.
      //     NOTE the sheet discharges the PURCHASE-basis loan here ($G$5) even
      //     when interest was charged on the midpoint loan — reproduced as-is.
      var netCF = monthlyCF
        + (i === 0 ? deposit : 0)
        + (isLast ? (S - loan + sellingCosts) : 0);

      cumFin += interest;
      cumCash += netCF;

      rows.push({
        date: d, year: y, month: mo, cashRate: cashRate, loan: rowLoan,
        interest: interest, running: running, rent: rent, ngRefund: ngRefund,
        monthlyCF: monthlyCF, netCF: netCF, cumFinance: cumFin,
        cumCashflow: cumCash, accumLoss: accumLoss, propValue: propValue
      });
    }

    if (missingRates > 0) {
      warnings.push(missingRates + ' month' + (missingRates === 1 ? '' : 's') +
        ' fall outside the RBA series (Jan 2008 – Aug 2026) and were treated as a 0% cash rate, ' +
        'exactly as the workbook’s SUMIFS does. Switch to the normalised basis for holds outside that window.');
    }

    /* ── totals ── */
    var financeCosts = 0, runningCosts = 0, rentalIncome = 0, ngTotal = 0;
    for (var r = 0; r < rows.length; r++) {
      financeCosts += rows[r].interest;
      runningCosts += rows[r].running;
      rentalIncome += rows[r].rent;
      ngTotal      += rows[r].ngRefund;
    }
    var netHoldingPreTax = financeCosts + runningCosts - rentalIncome;
    var afterTaxHolding = netHoldingPreTax - ngTotal;
    var netProfit = grossProfit - afterTaxHolding + sellingCosts;

    var amounts = rows.map(function (r) { return r.netCF; });
    var cfDates = rows.map(function (r) { return r.date; });
    var irr = xirr(amounts, cfDates);
    if (irr === null && rows.length) {
      warnings.push('IRR is undefined for this deal — the monthly cashflows never change sign, so there is no rate that zeroes the NPV.');
    }

    return {
      rows: rows,
      warnings: warnings,
      assumptions: a,
      summary: {
        purchasePrice: P, purchaseDate: pDate, soldPrice: S, soldDate: sDate,
        holdYears: holdYears, loan: loan, deposit: deposit,
        grossProfit: grossProfit, financeCosts: financeCosts,
        runningCosts: runningCosts, rentalIncome: rentalIncome,
        netHoldingPreTax: netHoldingPreTax, ngRefund: ngTotal,
        afterTaxHolding: afterTaxHolding, sellingCosts: sellingCosts,
        netProfit: netProfit, irr: irr, months: rows.length
      }
    };
  }

  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
    var m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return utc(+m[1], +m[2], +m[3]);
    var d = new Date(v);
    return isNaN(d) ? null : new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  }

  /* ═══ PASTE PARSER — rows copied straight out of the sheet ═══
     The 'ADL - Sold' tab is laid out
       # | Property | Purchase Price | Purchase Date | Sold Price | Sold Date | …
     so after dropping the row number the first four substantive values always
     run price, date, price, date. That ordering is what the parser leans on,
     which means extra trailing columns (hold period, ROI, CAGR, IRR) are
     harmless and a partial copy of just the four terms works too. */

  var MONTH_NAMES = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};

  /** Excel serial → Date. Serial 1 is 1 Jan 1900, with Excel's 1900 leap bug. */
  function serialToDate(n) {
    var ms = Date.UTC(1899, 11, 30) + Math.round(n) * MS_DAY;
    var d = new Date(ms);
    return utc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  function parseMoney(s) {
    var t = String(s).replace(/[\s$,]/g, '');
    if (t === '' || !/^-?\d*\.?\d+$/.test(t)) return null;
    var n = parseFloat(t);
    return isFinite(n) ? n : null;
  }

  /**
   * @param {string} s
   * @param {boolean} dayFirst  how to read an ambiguous d/m vs m/d token
   */
  function parseFlexDate(s, dayFirst) {
    var t = String(s).trim();
    if (t === '') return null;

    var iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) return utc(+iso[1], +iso[2], +iso[3]);

    // 22 Oct 2016 · 22-Oct-16 · Oct 22 2016
    var named = t.match(/^(\d{1,2})[\s\-\/]+([A-Za-z]{3,})[\s\-\/]+(\d{2,4})$/);
    if (named && MONTH_NAMES[named[2].slice(0, 3).toLowerCase()]) {
      return utc(fullYear(+named[3]), MONTH_NAMES[named[2].slice(0, 3).toLowerCase()], +named[1]);
    }
    var named2 = t.match(/^([A-Za-z]{3,})[\s\-\/]+(\d{1,2}),?[\s\-\/]+(\d{2,4})$/);
    if (named2 && MONTH_NAMES[named2[1].slice(0, 3).toLowerCase()]) {
      return utc(fullYear(+named2[3]), MONTH_NAMES[named2[1].slice(0, 3).toLowerCase()], +named2[2]);
    }

    var slash = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (slash) {
      var a = +slash[1], b = +slash[2], y = fullYear(+slash[3]);
      var day = dayFirst ? a : b, mon = dayFirst ? b : a;
      if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
      return utc(y, mon, day);
    }

    // bare Excel serial
    if (/^\d{5}(\.\d+)?$/.test(t)) {
      var n = parseFloat(t);
      if (n >= 20000 && n <= 80000) return serialToDate(n);
    }
    return null;
  }

  function fullYear(y) { return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y; }

  /** Split one line into fields: tabs win, then commas (quote-aware), then 2+ spaces. */
  function splitFields(line) {
    if (line.indexOf('\t') >= 0) return line.split('\t');
    if (line.indexOf(',') >= 0) {
      var out = [], cur = '', q = false;
      for (var i = 0; i < line.length; i++) {
        var c = line[i];
        if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
        else if (c === ',' && !q) { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      // A lone thousands-separated number must not be mistaken for columns.
      if (out.length > 1 && out.every(function (f) { return /^\s*\d{1,3}\s*$/.test(f); })) return [line];
      return out;
    }
    return line.split(/\s{2,}/);
  }

  /**
   * Parse pasted sheet rows into deals.
   * @param {string} text
   * @returns {{deals:Array, skipped:Array, dayFirst:boolean}}
   */
  function parseDeals(text) {
    var lines = String(text || '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });

    /* Decide d/m vs m/d once for the whole paste: any token with a component
       above 12 settles it; otherwise assume day-first (Australian sheet). */
    var dayFirst = true, votesDay = 0, votesMonth = 0;
    String(text || '').replace(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/g, function (_, a, b) {
      if (+a > 12 && +b <= 12) votesDay++;
      else if (+b > 12 && +a <= 12) votesMonth++;
      return _;
    });
    if (votesMonth > votesDay) dayFirst = false;

    var deals = [], skipped = [];

    lines.forEach(function (line, li) {
      if (/purchase\s*price/i.test(line) && /sold/i.test(line)) return;   // header row

      var fields = splitFields(line).map(function (f) { return String(f).trim().replace(/^"|"$/g, ''); });

      var values = [], texts = [];
      fields.forEach(function (f) {
        if (f === '') return;
        var d = parseFlexDate(f, dayFirst);
        if (d) { values.push({ kind: 'date', date: d, raw: f }); return; }
        var m = parseMoney(f);
        // Below 10,000 it is a row number, a hold period, an ROI — never a
        // price and never a date serial, so it can be dropped safely.
        if (m !== null) { if (Math.abs(m) >= 10000) values.push({ kind: 'num', num: m, raw: f }); return; }
        if (/[A-Za-z]/.test(f)) texts.push(f);
      });

      if (values.length < 4) {
        skipped.push({ line: li + 1, text: line.slice(0, 80), why: 'needs a purchase price, purchase date, sold price and sold date — found ' + values.length + ' usable value' + (values.length === 1 ? '' : 's') });
        return;
      }

      var v = values.slice(0, 4);
      var pPrice = v[0].kind === 'num' ? v[0].num : null;
      var pDate  = v[1].kind === 'date' ? v[1].date : (v[1].kind === 'num' ? parseFlexDate(String(v[1].num), dayFirst) : null);
      var sPrice = v[2].kind === 'num' ? v[2].num : null;
      var sDate  = v[3].kind === 'date' ? v[3].date : (v[3].kind === 'num' ? parseFlexDate(String(v[3].num), dayFirst) : null);

      if (pPrice === null || sPrice === null || !pDate || !sDate) {
        skipped.push({ line: li + 1, text: line.slice(0, 80), why: 'could not tell prices from dates — expected price, date, price, date' });
        return;
      }

      deals.push({
        name: texts.length ? texts[0] : 'Row ' + (li + 1),
        purchasePrice: pPrice, purchaseDate: pDate,
        soldPrice: sPrice, soldDate: sDate
      });
    });

    return { deals: deals, skipped: skipped, dayFirst: dayFirst };
  }

  /* ═══ SELF-TEST — the two worked samples on the workbook's breakdown tabs ═══
     Addresses deliberately omitted; only the numeric deal terms are needed. */
  function selfTest() {
    var cases = [
      { name: 'Long-hold sample (Oct 2016 → Apr 2026)',
        deal: { purchasePrice: 560000, purchaseDate: '2016-10-22', soldPrice: 1450000, soldDate: '2026-04-25' },
        expect: { irr: 0.1826136538377273, holdYears: 9.508333333333333, financeCosts: 236670,
                  runningCosts: 178314.1038, rentalIncome: 267471.1557, netProfit: 696387.0519 } },
      { name: 'Short-hold sample (Dec 2022 → Mar 2026)',
        deal: { purchasePrice: 965000, purchaseDate: '2022-12-19', soldPrice: 1387500, soldDate: '2026-03-31' },
        expect: { irr: 0.2083312748813537, holdYears: 3.283333333333333, financeCosts: 141855,
                  runningCosts: 77048.06229, rentalIncome: 115572.0934, netProfit: 274194.0311 } }
    ];
    var out = [];
    cases.forEach(function (c) {
      var res = computeBreakdown(c.deal);
      var checks = [];
      Object.keys(c.expect).forEach(function (key) {
        var got = res.summary[key], want = c.expect[key];
        var tol = (key === 'irr') ? 1e-9 : 1e-3;
        checks.push({ field: key, got: got, want: want, pass: Math.abs(got - want) <= tol });
      });
      out.push({ name: c.name, months: res.rows.length, checks: checks,
                 pass: checks.every(function (x) { return x.pass; }) });
    });
    return out;
  }

  root.IRRBreakdown = {
    computeBreakdown: computeBreakdown,
    parseDeals: parseDeals, parseFlexDate: parseFlexDate, serialToDate: serialToDate,
    xirr: xirr, xnpv: xnpv,
    yearFrac30360US: yearFrac30360US, edate: edate, eomonth: eomonth,
    DEFAULTS: DEFAULTS, RBA: RBA, selfTest: selfTest
  };
})(typeof window !== 'undefined' ? window : this);
