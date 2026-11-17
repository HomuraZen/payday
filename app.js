(function () {
  'use strict';
  var KEY = 'payday.plan.v1';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var COLORS = { save: 'var(--c-save)', bills: 'var(--c-bills)', daily: 'var(--c-daily)', funds: 'var(--c-funds)', idle: 'var(--c-idle)' };
  var state = null, view = 'now', tab = 'home', adding = null, confirming = false, chosen = null, mode = 'spend', kind = null;
  var KINDS = [
    { id: 'side', name: 'Side income', to: 'fund', hint: 'Side income isn\'t part of your budget. It\'s split by your usual percentages, and you can change them for this payment.' },
    { id: 'extra', name: 'Extra income', to: 'fund', hint: 'Money outside your salary plan goes to your {fund} by default. Move it to your savings account after you save this.' },
    { id: 'claim', name: 'Claim', to: null, hint: 'If it pays back spending you logged here, put it back in that budget item. If you paid for work items with your own money and never logged them, choose No budget change.' },
    { id: 'friend', name: 'Friend transfer', to: null, hint: 'If a friend is paying you back, put it back where the money came from. If it\'s a gift, your {fund} is the safe choice.' }
  ];
  function fundName() { return (state && state.fundName) || 'Emergency fund'; }
  function hintOf(k) { return k.hint.replace(/\{fund\}/g, fundName().toLowerCase()); }
  function kindName(id) { var k = KINDS.filter(function (x) { return x.id === id; })[0]; return k ? k.name : 'Money in'; }
  var pulling = false, lastPull = 0, sortId = null, apErr = '', apNote = '';

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function r2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function rm(n) {
    var neg = n < 0; n = Math.abs(r2(n));
    return (neg ? '-' : '') + 'RM' + n.toLocaleString('en-MY', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) && n >= 0 ? n : 0; }
  function color(a) { return COLORS[a.color] || COLORS.idle; }

  /* Dates */
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function utc(iso) { var p = iso.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function daysLeft() { return Math.max(1, Math.round((utc(state.cycle.nextPayISO) - utc(todayISO())) / 864e5)); }
  function nextKey(k) { var y = +k.slice(0, 4), m = +k.slice(5, 7) + 1; if (m > 12) { m = 1; y++; } return y + '-' + pad(m); }
  function kMonth(k) { return MONTHS[+k.slice(5, 7) - 1]; }
  function kLong(k) { return LONG[+k.slice(5, 7) - 1]; }
  function kFull(k) { return kMonth(k) + ' ' + k.slice(0, 4); }
  function dayName(iso) {
    if (iso === todayISO()) return 'Today';
    var p = iso.split('-');
    return (+p[2]) + ' ' + MONTHS[+p[1] - 1];
  }
  function active(it, k) { return !it.endsAfter || k <= it.endsAfter; }

  /* Accounts */
  function budgetAccts() { return state.accounts.filter(function (a) { return !a.noBudget; }); }
  function fundAcct() { return state.accounts.filter(function (a) { return a.saveLabel; })[0] || budgetAccts()[0]; }
  function hubAcct() { return state.accounts.filter(function (a) { return a.hub; })[0] || budgetAccts()[0]; }
  function acct(id) { return state.accounts.filter(function (a) { return a.id === id; })[0]; }

  /* Sums */
  function calc(v) {
    var c = state.cycle, pot = v === 'now' ? c.received - c.paid : state.salary, by = {}, spend = 0;
    budgetAccts().forEach(function (a) { by[a.id] = 0; });
    state.items.forEach(function (it) { by[it.acct] = (by[it.acct] || 0) + (it[v] || 0); spend += it[v] || 0; });
    return { pot: r2(pot), by: by, spend: r2(spend), savings: r2(pot - spend) };
  }
  function partsOf(e) { return e.parts && e.parts.length ? e.parts : (e.item ? [{ item: e.item, amt: e.amt }] : []); }
  function spentOn(id) { var s = 0; state.expenses.forEach(function (e) { partsOf(e).forEach(function (p) { if (p.item === id) s += p.amt; }); }); return r2(s); }
  function totalSpent() { var s = 0; state.expenses.forEach(function (e) { s += e.amt; }); return r2(s); }
  function inParts(e) { return e.parts && e.parts.length ? e.parts : [{ to: e.to, amt: e.amt }]; }
  function incomeTo(id) { var s = 0; state.income.forEach(function (e) { inParts(e).forEach(function (p) { if (p.to === id) s += p.amt; }); }); return r2(s); }
  function incomeTotal() { var s = 0; state.income.forEach(function (e) { s += e.amt; }); return r2(s); }
  function itemTopUps() { var s = 0; state.income.forEach(function (e) { inParts(e).forEach(function (p) { if (p.to !== 'fund' && p.to !== 'none') s += p.amt; }); }); return r2(s); }
  function effBudget(it) { return r2((it.now || 0) + incomeTo(it.id) + (it.pot ? (it.carry || 0) : 0)); }
  function potCarry() { var s = 0; state.items.forEach(function (it) { if (it.pot) s += it.carry || 0; }); return r2(s); }
  function pots() { return state.items.filter(function (it) { return it.pot; }); }
  function destName(to) {
    if (to === 'fund') return fundName();
    if (to === 'none') return 'No budget change';
    var it = state.items.filter(function (i) { return i.id === to; })[0];
    return it ? it.name : 'Removed item';
  }
  /* Apple Pay helpers */
  function norm(m) {
    var t = String(m || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(function (w) { return w && !/\d/.test(w); });
    if (!t.length) return '';
    return t[0].length < 4 && t[1] ? t[0] + ' ' + t[1] : t[0];
  }
  function parseAmt(raw) {
    var s = String(raw == null ? '' : raw);
    if (/^[^\d]*-/.test(s)) return 0;
    s = s.replace(/[^\d.,]/g, '');
    if (s.indexOf('.') >= 0 && s.indexOf(',') >= 0) s = s.replace(/,/g, '');
    else if (/,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
    var n = parseFloat(s);
    return isFinite(n) && n > 0 ? r2(n) : 0;
  }
  function cardAcct(name) { return (state.cards && state.cards[name]) || ''; }
  function countsDaily(e) { if (e.item) return false; var a = cardAcct(e.card); return !a || a === 'daily'; }
  function unsorted() { return state.expenses.filter(function (e) { return !e.item; }); }
  function fundNow() { return r2(state.fundBase + (state.moves.fund ? Math.max(0, calc('now').savings) : 0) + incomeTo('fund')); }
  function unspentDaily() {
    var s = 0;
    state.items.forEach(function (it) { if (it.acct === 'daily') s += Math.max(0, effBudget(it) - spentOn(it.id)); });
    return r2(s);
  }
  function project(n) {
    var bal = r2(state.fundBase + Math.max(0, calc('now').savings) + incomeTo('fund')), k = state.cycle.key, out = [{ key: k, val: bal, now: true }];
    for (var i = 0; i < (n || 12) - 1; i++) {
      k = nextKey(k);
      var sp = 0;
      state.items.forEach(function (it) { if (active(it, k)) sp += it.month || 0; });
      bal = r2(bal + Math.max(0, state.salary - sp));
      out.push({ key: k, val: bal });
    }
    return out;
  }
  function fullGoal() {
    var s = 0;
    state.items.forEach(function (it) { if (!it.endsAfter) s += it.month || 0; });
    return r2(s * 3);
  }

  /* Storage */
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); $('saveErr').hidden = true; }
    catch (e) { $('saveErr').hidden = false; }
  }
  function load() {
    try { var s = localStorage.getItem(KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function valid(d) {
    return d && d.cycle && d.cycle.nextPayISO && d.cycle.key && Array.isArray(d.items) && Array.isArray(d.accounts) && typeof d.salary === 'number';
  }
  function normalize(d) {
    d.expenses = d.expenses || []; d.income = d.income || []; d.moves = d.moves || {}; d.history = d.history || [];
    d.fundBase = d.fundBase || 0; d.cards = d.cards || {}; d.rules = d.rules || {};
    if (!d.potsReady) { d.items.forEach(function (it) { if (it.acct === 'funds') { it.pot = true; it.carry = it.carry || 0; } }); d.potsReady = true; }
    return d;
  }
  function adopt(d) {
    state = normalize(d); save(); show(); pull(true);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  }
  function parseText(t) {
    var d; try { d = JSON.parse(t); } catch (e) { return null; }
    return valid(d) ? d : null;
  }

  /* Home */
  function perDayItems() { return state.items.filter(function (it) { return it.perDay; }); }
  function renderHome() {
    var cy = state.cycle, left = daysLeft(), items = perDayItems(), bud = 0, sp = 0, todaySp = 0, today = todayISO();
    items.forEach(function (it) { bud += effBudget(it); sp += spentOn(it.id); });
    state.expenses.forEach(function (e) {
      if (e.date === today) partsOf(e).forEach(function (p) { if (items.some(function (i) { return i.id === p.item; })) todaySp += p.amt; });
      if (countsDaily(e)) { sp += e.amt; if (e.date === today) todaySp += e.amt; }
    });
    var rest = r2(bud - sp), startOfDay = rest + todaySp, safe = r2(startOfDay / left - todaySp);
    $('toPay').textContent = left + (left === 1 ? ' day' : ' days') + ' to salary';
    $('daySafe').textContent = rm(Math.max(0, safe));
    $('dayBody').textContent = (safe < 0 ? rm(-safe) + ' over today\'s share. ' : '') + rm(rest) + ' left for ' + items.map(function (i) { return i.name.toLowerCase(); }).join(' and ') + ' until ' + cy.nextPay + '.';
    var all = calc('now');
    $('sLeft').textContent = rm(all.spend + itemTopUps() + potCarry() - totalSpent());
    $('sFundL').textContent = fundName();
    $('sFund').textContent = rm(fundNow());

    var ml = moveList('now', all), done = ml.filter(function (m) { return state.moves[m.id]; }).length;
    $('movesP').textContent = done + ' of ' + ml.length + ' done';
    $('moves').innerHTML = moveHTML(ml, true, all, 'now');

    var nk = nextKey(cy.key), due = today >= cy.nextPayISO, un = unspentDaily();
    $('dueNote').hidden = !due;
    $('dueT').textContent = 'It\'s salary time for ' + kLong(nk);
    $('nextT').textContent = 'Start ' + kLong(nk);
    $('nextBtn').textContent = confirming ? 'Start ' + kLong(nk) + '?' : 'Start ' + kLong(nk);
    $('nextBtn').disabled = confirming;
    $('nextYes').hidden = !confirming; $('nextNo').hidden = !confirming;
    $('leftWrap').hidden = un <= 0;
    $('addLeftT').textContent = 'Also count ' + rm(un) + ' of unspent ' + (acct('daily') ? acct('daily').name : 'daily') + ' money as saved';
    if (document.activeElement !== $('nextSal')) $('nextSal').value = state.salary;
  }
  function names(id, v) {
    return state.items.filter(function (it) { return it.acct === id && (it[v] || 0) > 0; }).map(function (it) { return it.name; }).join(', ');
  }
  function moveList(v, c) {
    var f = fundAcct(), hub = hubAcct(), list = [{ id: 'fund', label: f.saveLabel || f.name, detail: fundName(), amt: Math.max(0, c.savings), a: f }];
    budgetAccts().forEach(function (a) {
      if (a.id === hub.id) return;
      list.push({ id: a.id, label: a.mainLabel || a.moveLabel || a.name, detail: names(a.id, v), amt: c.by[a.id] || 0, a: a });
    });
    return list.filter(function (m) { return m.amt > 0; });
  }
  function moveHTML(ml, ticks, c, v) {
    var hub = hubAcct();
    var html = ml.map(function (m) {
      var body = '<span class="t"><b>' + esc(m.label) + '</b><span class="small muted">' + esc(m.detail) + '</span></span><span class="amt">' + rm(m.amt) + '</span>';
      if (!ticks) return '<div class="move"><span class="bul" style="background:' + color(m.a) + '"></span>' + body + '</div>';
      var on = !!state.moves[m.id];
      return '<div class="move' + (on ? ' done' : '') + '"><label><input type="checkbox" data-move="' + esc(m.id) + '"' + (on ? ' checked' : '') + '>' + body + '</label></div>';
    }).join('');
    if ((c.by[hub.id] || 0) > 0) html += '<div class="keep small">Keep ' + rm(c.by[hub.id]) + ' in ' + esc(hub.name) + ' for ' + esc(names(hub.id, v)) + '.</div>';
    return html;
  }

  /* Spending */
  function renderSpend() {
    var total = calc('now').spend, spent = totalSpent();
    var inn = incomeTotal();
    $('spendS').textContent = rm(spent) + ' of ' + rm(total + itemTopUps() + potCarry()) + (inn > 0 ? ' · ' + rm(inn) + ' in' : '');
    var html = '';
    budgetAccts().forEach(function (a) {
      state.items.filter(function (it) { return it.acct === a.id && !it.paid; }).forEach(function (it) {
        var b = effBudget(it), s = spentOn(it.id), left = r2(b - s), pct = b > 0 ? Math.min(100, s / b * 100) : (s > 0 ? 100 : 0), top = incomeTo(it.id);
        html += '<div class="cat"><div class="r"><span>' + esc(it.name) + (it.pot ? ' <span class="tag">Pot</span>' : '') + (top > 0 ? ' <span class="tag">+' + rm(top) + ' added</span>' : '') + '</span><b class="' + (left < 0 ? 'o' : '') + '">' + (left < 0 ? rm(-left) + ' over' : rm(left) + (it.pot ? ' in pot' : ' left')) + '</b></div>'
          + '<div class="track"><i style="width:' + pct + '%;background:' + (left < 0 ? 'var(--bad)' : color(a)) + '"></i></div></div>';
      });
    });
    var uns = 0; unsorted().forEach(function (e) { uns += e.amt; });
    if (uns > 0) html = '<div class="cat"><div class="r"><span>Not sorted yet</span><b class="o">' + rm(uns) + '</b></div></div>' + html;
    $('cats').innerHTML = html;
    var rows = state.expenses.map(function (e) { return { e: e, inn: false }; }).concat(state.income.map(function (e) { return { e: e, inn: true }; }));
    rows.sort(function (x, y) { return y.e.ts - x.e.ts; });
    var last = null, out = '';
    rows.forEach(function (r) {
      var e = r.e;
      if (e.date !== last) { out += '<div class="day">' + esc(dayName(e.date)) + '</div>'; last = e.date; }
      if (r.inn) {
        var ip = inParts(e), sub = (ip.length > 1 ? 'Split · ' + ip.map(function (q) { return destName(q.to) + ' ' + rm(q.amt); }).join(' · ') : 'To ' + destName(e.to)) + (e.note ? ' · ' + e.note : '');
        out += '<div class="entry"><span class="t"><span>' + esc(kindName(e.kind)) + '</span><span class="small muted">' + esc(sub) + '</span></span><span class="amt in">+' + rm(e.amt) + '</span><button type="button" class="x" data-in="' + esc(e.id) + '" aria-label="Delete ' + esc(rm(e.amt)) + ' money in">×</button></div>';
        return;
      }
      var ps = partsOf(e), ca = e.src === 'applepay' ? cardAcct(e.card) : '', one = ps.length === 1 ? byId(ps[0].item) : null;
      var title = ps.length > 1 ? 'Split' : ps.length ? (one ? one.name : 'Removed item') : 'Not sorted yet', subs = [], warns = '';
      if (ps.length > 1) subs.push(ps.map(function (p) { var it = byId(p.item); return (it ? it.name : 'Removed item') + ' ' + rm(p.amt); }).join(' · '));
      if (e.src === 'applepay') subs.push([e.merchant || 'Apple Pay', e.card].filter(Boolean).join(' · ') + (e.auto ? ' · Sorted automatically' : ''));
      if (e.note) subs.push(e.note);
      if (ca && acct(ca)) ps.forEach(function (p) {
        var it = byId(p.item);
        if (it && it.acct !== ca && acct(it.acct)) warns += '<span class="warn">! ' + (ps.length > 1 ? esc(it.name) + ': ' : '') + 'Paid from ' + esc(acct(ca).name) + ', budgeted in ' + esc(acct(it.acct).name) + '</span>';
      });
      out += '<div class="entry"><button type="button" class="linkish" data-sort="' + esc(e.id) + '"><span>' + esc(title) + '</span>' + subs.map(function (x) { return '<span class="small muted">' + esc(x) + '</span>'; }).join('') + warns + '</button><span class="amt">' + rm(e.amt) + '</span><button type="button" class="x" data-ex="' + esc(e.id) + '" aria-label="Delete ' + esc(rm(e.amt)) + ' entry">×</button></div>';
    });
    $('log').innerHTML = out || '<p class="none">Nothing logged yet. Press + after you spend or receive money.</p>';
  }

  /* Plan */
  function renderPlanSummary() {
    var c = calc(view), cy = state.cycle, isNow = view === 'now';
    $('vNow').setAttribute('aria-pressed', isNow); $('vMonth').setAttribute('aria-pressed', !isNow);
    $('potL').textContent = isNow ? 'To split' : 'Salary';
    $('pot').textContent = rm(c.pot);
    $('potS').textContent = isNow
      ? (cy.paid > 0 ? rm(cy.received) + ' received, ' + rm(cy.paid) + ' paid' : 'Until ' + cy.nextPay)
      : 'From your ' + cy.nextPay + ' salary';
    $('sav').textContent = rm(Math.max(0, c.savings));
    $('over').hidden = c.savings >= 0;
    if (c.savings < 0) $('over').textContent = '! Over budget by ' + rm(-c.savings);
    var f = fundAcct();
    var parts = budgetAccts().map(function (a) { return { a: a, v: (c.by[a.id] || 0) + (a.id === f.id ? Math.max(0, c.savings) : 0) }; });
    $('stack').innerHTML = parts.filter(function (p) { return p.v > 0; }).map(function (p) { return '<i style="flex:' + p.v + ' 1 0;background:' + color(p.a) + '"></i>'; }).join('');
    $('legend').innerHTML = parts.map(function (p) { return '<div><span class="dot" style="background:' + color(p.a) + '"></span><span class="n">' + esc(p.a.name) + '</span><b>' + rm(p.v) + '</b></div>'; }).join('');
    $('payMoves').hidden = isNow;
    if (!isNow) $('moves2').innerHTML = moveHTML(moveList('month', c), false, c, 'month');
    budgetAccts().forEach(function (a) { var e = $('gt-' + a.id); if (e) e.textContent = rm(c.by[a.id] || 0); });
    $('budgetS').textContent = rm(c.spend) + ' planned';
    $('saveTotal').textContent = rm(c.savings);
    $('saveL').textContent = 'Left for your ' + fundName().toLowerCase();
    $('saveTotal').style.color = c.savings < 0 ? 'var(--bad)' : 'var(--good)';
    $('salWrap').hidden = isNow;
    if (document.activeElement !== $('salary')) $('salary').value = state.salary;
  }
  function renderBudget() {
    var isNow = view === 'now';
    $('groups').innerHTML = budgetAccts().map(function (a) {
      var rows = state.items.filter(function (it) { return it.acct === a.id && !(isNow && it.paid); });
      var body = rows.map(function (it) {
        var sub = [];
        if (it.note) sub.push(it.note);
        if (it.est) sub.push('Estimate');
        if (it.pot) sub.push('Pot, carries over');
        return '<div class="row"><span class="nm"><span>' + esc(it.name) + '</span>' + (sub.length ? '<span class="tag">' + esc(sub.join(' · ')) + '</span>' : '') + '</span>'
          + (it.custom ? '<button type="button" class="x" data-del="' + esc(it.id) + '" aria-label="Remove ' + esc(it.name) + '">×</button>' : '<span></span>')
          + '<label class="money"><span>RM</span><input type="number" inputmode="decimal" min="0" step="0.01" data-amt="' + esc(it.id) + '" value="' + (it[view] || 0) + '" aria-label="' + esc(it.name) + ' amount"></label></div>';
      }).join('');
      var paid = isNow ? state.items.filter(function (it) { return it.acct === a.id && it.paid; }).map(function (it) { return it.name; }) : [];
      var add = adding === a.id
        ? '<form class="addform" data-add="' + esc(a.id) + '"><input type="text" id="addName" placeholder="Item name" required aria-label="Item name"><span class="money"><span>RM</span><input type="number" id="addAmt" inputmode="decimal" min="0" step="0.01" required aria-label="Amount"></span><button class="btn" type="submit">Add</button><button class="text-btn" type="button" data-cancel="1">Cancel</button></form>'
        : '<button type="button" class="text-btn" data-open="' + esc(a.id) + '">Add item</button>';
      return '<div class="group"><div class="ghead"><span class="dot" style="background:' + color(a) + '"></span><h3>' + esc(a.name) + ': ' + esc(a.role.toLowerCase()) + '</h3><span class="gt" id="gt-' + esc(a.id) + '"></span>'
        + (paid.length ? '<p class="small muted">Already paid: ' + esc(paid.join(', ')) + '</p>' : '') + '</div>' + body + add + '</div>';
    }).join('');
  }

  /* Fund */
  function renderFund() {
    var saved = fundNow();
    $('fund').textContent = rm(saved);
    $('fundL').textContent = 'In your ' + (fundAcct().saveLabel || fundAcct().name);
    if (document.activeElement !== $('fundEdit')) $('fundEdit').value = saved;
    $('fundH').textContent = fundName();
    var pts = project(12), box = $('chart'), W = Math.max(280, box.clientWidth || 360), H = 230;
    var p = { l: 34, r: 6, t: 20, b: 24 }, iw = W - p.l - p.r, ih = H - p.t - p.b;
    var full = fullGoal(), goals = state.goals || [{ v: 3000, l: 'Starter RM3,000', name: 'Starter goal, RM3,000' }, { v: full, l: '3 months ' + rm(full), name: '3 months of spending, ' + rm(full) }];
    var maxV = Math.max.apply(null, [pts[pts.length - 1].val].concat(goals.map(function (g) { return g.v; }))), step = maxV > 60000 ? 20000 : maxV > 20000 ? 10000 : 5000;
    var top = Math.ceil(maxV / step) * step, y = function (v) { return p.t + ih - (v / top) * ih; };
    var band = iw / pts.length, bw = Math.max(8, Math.min(34, band - 6)), s = '';
    for (var t = 0; t <= top; t += step) {
      s += '<line x1="' + p.l + '" x2="' + (W - p.r) + '" y1="' + y(t) + '" y2="' + y(t) + '" stroke="var(--line)"/>';
      s += '<text x="' + (p.l - 6) + '" y="' + (y(t) + 4) + '" text-anchor="end">' + (t ? (t / 1000) + 'k' : '0') + '</text>';
    }
    var every = band < 34 ? 2 : 1;
    pts.forEach(function (q, i) {
      var x = p.l + band * i + (band - bw) / 2, h = Math.max(2, y(0) - y(q.val)), yy = y(0) - h, r = Math.min(4, bw / 2, h);
      s += '<path d="M' + x + ' ' + y(0) + 'V' + (yy + r) + 'Q' + x + ' ' + yy + ' ' + (x + r) + ' ' + yy + 'H' + (x + bw - r) + 'Q' + (x + bw) + ' ' + yy + ' ' + (x + bw) + ' ' + (yy + r) + 'V' + y(0) + 'Z" fill="var(--c-save)" fill-opacity="' + (q.now ? 1 : .55) + '"/>';
      if (i % every === 0) s += '<text x="' + (x + bw / 2) + '" y="' + (H - 7) + '" text-anchor="middle">' + kMonth(q.key) + '</text>';
      s += '<rect data-i="' + i + '" tabindex="0" role="img" aria-label="' + kFull(q.key) + ': ' + rm(q.val) + '" x="' + (p.l + band * i) + '" y="' + p.t + '" width="' + band + '" height="' + ih + '" fill="transparent" style="outline:none"/>';
    });
    goals.forEach(function (g) {
      if (g.v > top) return;
      s += '<line x1="' + p.l + '" x2="' + (W - p.r) + '" y1="' + y(g.v) + '" y2="' + y(g.v) + '" stroke="var(--fg-2)" stroke-dasharray="4 4"/>';
      s += '<text class="v" x="' + (p.l + 4) + '" y="' + (y(g.v) - 5) + '">' + g.l + '</text>';
    });
    var last = pts[pts.length - 1];
    s += '<text class="v" x="' + (W - p.r) + '" y="' + (y(last.val) - 6) + '" text-anchor="end">' + rm(last.val) + '</text>';
    var old = box.querySelector('svg'); if (old) old.remove();
    box.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 ' + W + ' ' + H + '" height="' + H + '" role="group" aria-label="Projected ' + esc(fundName().toLowerCase()) + ' by salary month">' + s + '</svg>');
    box._pts = pts; box._geo = { band: band, l: p.l, y: y };

    var long = project(120), ms = [];
    goals.forEach(function (g) {
      var hit = long.filter(function (q) { return q.val >= g.v; })[0];
      ms.push([g.name || g.l, hit ? kFull(hit.key) + ' salary' : 'More than 10 years away']);
    });
    state.items.filter(function (it) { return it.endsAfter; }).sort(function (a, b) { return a.endsAfter < b.endsAfter ? -1 : 1; }).forEach(function (it) {
      ms.push([it.name + ' paid off, savings rise by ' + rm(it.month), kFull(nextKey(it.endsAfter)) + ' salary']);
    });
    $('miles').innerHTML = ms.map(function (m) { return '<li><span>' + esc(m[0]) + '</span><b>' + esc(m[1]) + '</b></li>'; }).join('');
    $('fundS').textContent = 'Projected on a ' + rm(state.salary) + ' salary. The brightest bar is this month.';
    var pl = pots();
    $('potSec').hidden = !pl.length;
    $('potList').innerHTML = pl.map(function (it) {
      var bal = r2(effBudget(it) - spentOn(it.id));
      return '<li><span>' + esc(it.name) + '<span class="small muted">' + (it.month ? ' · +' + rm(it.month) + ' a month' : ' · Filled by money in') + '</span></span><b' + (bal < 0 ? ' class="o"' : '') + '>' + rm(bal) + '</b></li>';
    }).join('');
    var yr = todayISO().slice(0, 4), side = 0;
    (state.history || []).forEach(function (h) { if (h.key && h.key.slice(0, 4) === yr) side += h.sideIn || 0; });
    state.income.forEach(function (e) { if (e.kind === 'side' && e.date.slice(0, 4) === yr) side += e.amt; });
    var tax = pl.filter(function (it) { return it.id === 'tax'; })[0];
    $('sideSum').hidden = !side;
    $('sideSum').textContent = 'Side income in ' + yr + ': ' + rm(r2(side)) + (tax ? '. Tax set-aside: ' + rm(r2(effBudget(tax) - spentOn(tax.id))) + '.' : '.');
    $('ptable').innerHTML = '<table><thead><tr><th>Salary month</th><th>Fund after saving</th></tr></thead><tbody>' + pts.map(function (q) { return '<tr><td>' + kFull(q.key) + '</td><td>' + rm(q.val) + '</td></tr>'; }).join('') + '</tbody></table>';
  }

  /* Banks */
  function renderBanks() {
    $('banks').innerHTML = state.accounts.map(function (a) {
      return '<div class="bank"><span class="dot" style="background:' + color(a) + '"></span><div><h3>' + esc(a.name) + ': ' + esc(a.role.toLowerCase()) + '</h3>'
        + (a.rate ? '<span class="rate">' + esc(a.rate) + '</span>' : '') + '<p class="sub">' + esc(a.text) + '</p>' + (a.fine ? '<p class="small muted">' + esc(a.fine) + '</p>' : '') + '</div></div>';
    }).join('');
    $('bankNote').textContent = state.bankNote || '';
    $('lastBackup').textContent = state.lastBackup ? 'Last saved ' + dayName(state.lastBackup) + '.' : 'No backup saved yet.';
  }

  /* Apple Pay */
  function ago(ts) {
    var m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    return h < 24 ? h + (h === 1 ? ' hour ago' : ' hours ago') : Math.round(h / 24) + ' days ago';
  }
  function acctChips(attr, name) {
    return budgetAccts().map(function (a) {
      return '<button type="button" class="chip" ' + attr + '="' + esc(name) + '" data-acct="' + esc(a.id) + '"><span class="dot" style="background:' + color(a) + '"></span>' + esc(a.name) + '</button>';
    }).join('');
  }
  function renderAP() {
    var s = state.sync, on = !!(s && s.url && s.key);
    $('apSec').hidden = !on;
    $('apOff').hidden = !on;
    $('apSave').textContent = on ? 'Save and check' : 'Connect';
    if (on && document.activeElement !== $('apUrl')) $('apUrl').value = s.url;
    if (on && document.activeElement !== $('apKey')) $('apKey').value = s.key;
    $('apStatus').textContent = apErr || ((s && s.lastCheck ? 'Checked ' + ago(s.lastCheck) : 'Not checked yet') + (apNote ? '. ' + apNote + '.' : '.'));
    $('apStatus').className = 'small ' + (apErr ? 'warn' : 'muted');
    var cards = Object.keys(state.cards);
    $('apCards').innerHTML = cards.filter(function (n) { return !state.cards[n]; }).map(function (n) {
      return '<div class="ask"><p class="small">Which account does <b>' + esc(n) + '</b> pay from?</p><div class="chips">' + acctChips('data-map-card', n) + '</div></div>';
    }).join('');
    var list = unsorted().filter(function (e) { return e.src === 'applepay'; }).sort(function (x, y) { return y.ts - x.ts; });
    $('apList').innerHTML = list.length ? list.map(function (e) {
      return '<div class="entry ap"><span class="t"><span>' + esc(e.merchant || 'Apple Pay payment') + '</span><span class="small muted">' + esc([e.card, dayName(e.date)].filter(Boolean).join(' · ')) + '</span></span><span class="amt">' + rm(e.amt) + '</span><button type="button" class="text-btn" data-sort="' + esc(e.id) + '">Sort</button></div>';
    }).join('') : '<p class="none small">All Apple Pay payments are sorted.</p>';
    $('cardMap').innerHTML = cards.length ? '<p class="label">Cards</p>' + cards.map(function (n) {
      return '<label class="cardrow"><span>' + esc(n) + '</span><select data-card="' + esc(n) + '" aria-label="Account for ' + esc(n) + '"><option value="">Not set</option>'
        + budgetAccts().map(function (a) { return '<option value="' + esc(a.id) + '"' + (state.cards[n] === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join('') + '</select></label>';
    }).join('') : '';
  }
  function cycleStart() { return new Date(utc(state.cycle.nextPayISO) - (state.cycle.days || 30) * 864e5).toISOString().slice(0, 10); }
  function importRows(rows) {
    var s = state.sync, start = cycleStart(), n = 0;
    rows.forEach(function (r) {
      var row = +r.row;
      if (!(row > (s.lastRow || 1))) return;
      s.lastRow = row;
      var id = 'a' + row;
      if (state.expenses.some(function (x) { return x.id === id; })) return;
      var amt = parseAmt(r.amount);
      if (!amt) return;
      var dt = new Date(r.ts); if (isNaN(dt)) dt = new Date();
      var date = dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate());
      if (date < start) return;
      var card = String(r.card || '').trim() || 'Apple Pay card', merchant = String(r.merchant || '').trim();
      if (!(card in state.cards)) state.cards[card] = '';
      var item = state.rules[norm(merchant)] || null;
      if (item && !byId(item)) item = null;
      state.expenses.push({ id: id, item: item, auto: !!item, amt: amt, date: date, ts: dt.getTime(), note: '', src: 'applepay', merchant: merchant, card: card });
      n++;
    });
    return n;
  }
  function pull(manual) {
    var s = state && state.sync;
    if (!s || !s.url || !s.key || pulling) return Promise.resolve();
    if (!manual && Date.now() - lastPull < 20000) return Promise.resolve();
    pulling = true; lastPull = Date.now();
    var u = s.url + (s.url.indexOf('?') < 0 ? '?' : '&') + 'action=pull&key=' + encodeURIComponent(s.key) + '&after=' + (s.lastRow || 1);
    return fetch(u, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) throw new Error(d && d.error === 'key' ? 'key' : 'bad');
        var n = importRows(d.rows || []);
        s.lastCheck = Date.now(); apErr = '';
        apNote = n ? n + (n === 1 ? ' new payment' : ' new payments') : 'No new payments';
        save(); renderAll();
      })
      .catch(function (err) {
        apErr = err && err.message === 'key' ? 'The key doesn\'t match your Google Sheet. Copy it again from your setup.'
          : navigator.onLine === false ? 'You\'re offline. New payments will come in when you\'re back online.'
          : 'Couldn\'t reach your Google Sheet. Check the web app link in the Banks tab.';
        renderAP();
      })
      .then(function () { pulling = false; });
  }

  function renderTab() {
    $('tabFund').textContent = state.fundTab || 'Fund';
    ['home', 'spend', 'plan', 'fund', 'banks'].forEach(function (t) { $('t-' + t).hidden = t !== tab; });
    document.querySelectorAll('.tabs button').forEach(function (b) {
      if (b.dataset.go === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  function renderAll() {
    renderTab(); renderHome(); renderSpend(); renderBudget(); renderPlanSummary(); renderFund(); renderBanks(); renderAP();
  }
  function show() {
    $('setup').hidden = !!state; $('app').hidden = !state;
    if (state) renderAll();
  }

  /* Add spending */
  var split = false, lines = [];
  function editAlloc(id) {
    var e = mode === 'sort' ? sortExp() : null, t = 0;
    if (e) partsOf(e).forEach(function (p) { if (p.item === id) t += p.amt; });
    return r2(t);
  }
  function leftNow(it) { return r2(effBudget(it) - spentOn(it.id) + editAlloc(it.id)); }
  function tone(it, after) { if (after < 0) return ' neg'; var b = effBudget(it); return b > 0 && after < b * 0.1 ? ' low' : ''; }
  function balText(it, use) {
    var before = leftNow(it);
    if (!use) return { t: rm(before) + (it.pot ? ' in pot' : ' left'), c: tone(it, before) };
    var after = r2(before - use);
    return { t: rm(before) + ' → ' + rm(after), c: tone(it, after) };
  }
  function chip(id, label, dot, bal) {
    return '<button type="button" class="chip" role="radio" aria-checked="' + (chosen === id) + '" data-chip="' + esc(id) + '">' + (dot ? '<span class="dot" style="background:' + dot + '"></span>' : '') + '<span>' + esc(label) + '</span>' + (bal ? '<span class="cb' + bal.c + '">' + esc(bal.t) + '</span>' : '') + '</button>';
  }
  function sortExp() { return state.expenses.filter(function (x) { return x.id === sortId; })[0]; }
  function sheetItems() {
    var isIn = mode === 'in', isSort = mode === 'sort', out = [];
    budgetAccts().forEach(function (a) {
      state.items.filter(function (it) { return it.acct === a.id && !it.paid && (isIn || isSort || split || effBudget(it) > 0); }).forEach(function (it) { out.push({ it: it, a: a }); });
    });
    return out;
  }
  function renderChips() {
    var isIn = mode === 'in', amt = num($('exAmt').value);
    var html = isIn ? chip('fund', fundName(), 'var(--c-save)') + chip('none', 'No budget change', '') : '';
    sheetItems().forEach(function (x) {
      html += chip(x.it.id, (isIn ? 'Back to ' : '') + x.it.name, color(x.a), isIn ? null : balText(x.it, chosen === x.it.id ? amt : 0));
    });
    $('chips').innerHTML = html;
  }
  function renderSplit() {
    var opts = function (sel) {
      var o = '<option value="">Choose ' + (mode === 'in' ? 'where it goes' : 'a category') + '</option>';
      if (mode === 'in') {
        o += '<option value="fund"' + (sel === 'fund' ? ' selected' : '') + '>' + esc(fundName() + ' · ' + rm(fundNow())) + '</option>';
        o += '<option value="none"' + (sel === 'none' ? ' selected' : '') + '>No budget change</option>';
      }
      return o + sheetItems().map(function (x) {
        return '<option value="' + esc(x.it.id) + '"' + (sel === x.it.id ? ' selected' : '') + '>' + esc(x.it.name + ' · ' + rm(leftNow(x.it)) + (x.it.pot ? ' in pot' : ' left')) + '</option>';
      }).join('');
    };
    $('splitBox').innerHTML = lines.map(function (l, i) {
      var n = i + 1;
      return '<div class="sline"><select id="sl-item-' + i + '" data-sl-item="' + i + '" aria-label="Category for line ' + n + '">' + opts(l.item) + '</select>'
        + '<div class="srow"><label class="money"><span>' + (l.unit === 'pct' ? '%' : 'RM') + '</span><input id="sl-val-' + i + '" data-sl-val="' + i + '" type="number" inputmode="decimal" min="0" step="0.01" placeholder="the rest" value="' + esc(l.val) + '" aria-label="Amount for line ' + n + '"></label>'
        + '<div class="seg unit"><button type="button" data-sl-unit="' + i + '" data-u="rm" aria-pressed="' + (l.unit !== 'pct') + '">RM</button><button type="button" data-sl-unit="' + i + '" data-u="pct" aria-pressed="' + (l.unit === 'pct') + '">%</button></div>'
        + '<span class="samt" id="sl-amt-' + i + '"></span>'
        + (lines.length > 2 ? '<button type="button" class="x" data-sl-del="' + i + '" aria-label="Remove line ' + n + '">×</button>' : '') + '</div>'
        + '<span class="sbal" id="sl-bal-' + i + '"></span></div>';
    }).join('') + '<div class="sfoot"><button type="button" class="text-btn" id="slAdd">Add a line</button><span class="sstat" id="slStat" role="status"></span></div>';
    updateSplit();
  }
  function splitCalc() {
    var total = r2(num($('exAmt').value)), amts = lines.map(function () { return 0; }), blank = [], sum = 0, lastPct = -1, err = '', used = {};
    lines.forEach(function (l, i) {
      if (String(l.val).trim() === '') { blank.push(i); return; }
      var v = num(l.val), a = l.unit === 'pct' ? r2(total * v / 100) : r2(v);
      if (l.unit === 'pct') lastPct = i;
      amts[i] = a; sum += a;
    });
    var diff = r2(total - r2(sum));
    if (blank.length === 1 && diff >= 0) { amts[blank[0]] = diff; diff = 0; }
    else if (!blank.length && diff !== 0 && lastPct >= 0 && Math.abs(diff) <= 0.05) { amts[lastPct] = r2(amts[lastPct] + diff); diff = 0; }
    if (!total) err = 'Enter the total first';
    else if (blank.length > 1) err = 'Leave only one line blank for the rest';
    else if (lines.some(function (l) { return !l.item; })) err = 'Choose a category for every line';
    else if (lines.some(function (l) { if (used[l.item]) return true; used[l.item] = 1; return false; })) err = 'Each category can only be used once';
    else if (diff > 0) err = rm(diff) + ' left to assign';
    else if (diff < 0) err = rm(-diff) + ' too much';
    return { total: total, amts: amts, err: err };
  }
  function updateSplit() {
    var c = splitCalc();
    lines.forEach(function (l, i) {
      var a = $('sl-amt-' + i), b = $('sl-bal-' + i);
      if (!a) return;
      a.textContent = rm(c.amts[i]);
      var it = byId(l.item), sign = mode === 'in' ? -1 : 1;
      if (it) { var bt = balText(it, sign * c.amts[i]); b.textContent = it.name + ': ' + bt.t; b.className = 'sbal' + bt.c; }
      else if (l.item === 'fund') { var f0 = fundNow(); b.textContent = fundName() + ': ' + rm(f0) + ' → ' + rm(r2(f0 + c.amts[i])); b.className = 'sbal'; }
      else { b.textContent = ''; b.className = 'sbal'; }
    });
    var st = $('slStat');
    if (st) { st.textContent = c.err || rm(c.total) + ' ✓'; st.className = 'sstat ' + (c.err ? 'bad' : 'ok'); }
    $('exSave').disabled = !!c.err;
  }
  function renderSheet() {
    var isIn = mode === 'in', isSort = mode === 'sort', se = isSort ? sortExp() : null, ap = !!(se && se.src === 'applepay');
    $('mSeg').hidden = isSort;
    $('exAmt').readOnly = ap;
    $('sortDel').hidden = !isSort;
    $('sortDel').textContent = ap ? 'Not a real payment? Delete it' : 'Delete this payment';
    var key = ap ? norm(se.merchant) : '';
    $('rememberWrap').hidden = !key || split;
    $('rememberT').textContent = key ? 'Always put ' + se.merchant + ' here' : '';
    $('sheetT').textContent = isSort ? (ap && !se.item ? 'Sort payment' : 'Edit payment') : isIn ? 'Add money in' : 'Add spending';
    $('mSpend').setAttribute('aria-pressed', !isIn); $('mIn').setAttribute('aria-pressed', isIn);
    $('kinds').hidden = !isIn;
    $('kinds').innerHTML = KINDS.map(function (k) {
      return '<button type="button" class="chip" role="radio" aria-checked="' + (kind === k.id) + '" data-kind="' + k.id + '">' + esc(k.name) + '</button>';
    }).join('');
    var k = KINDS.filter(function (x) { return x.id === kind; })[0];
    $('inHint').hidden = isSort ? !se : (!isIn || !k);
    $('inHint').textContent = se ? [ap ? (se.merchant || 'Apple Pay payment') : 'Added by you', se.card, dayName(se.date)].filter(Boolean).join(' · ') : k ? hintOf(k) : '';
    $('chipsL').textContent = isIn ? 'Where does it go?' : split ? 'Split' : 'Category';
    $('splitBtn').textContent = split ? 'Don\'t split, use one category' : 'Split across categories';
    $('chips').hidden = split;
    $('splitBox').hidden = !split;
    $('exSave').disabled = false;
    if (split) renderSplit(); else renderChips();
    $('exSave').textContent = isSort ? (ap && !se.item ? 'Sort' : 'Save changes') : isIn ? 'Add money in' : 'Save';
  }
  function openSheet() {
    chosen = null; kind = null; mode = 'spend'; split = false; lines = [];
    $('exAmt').value = ''; $('exNote').value = ''; $('exErr').hidden = true;
    renderSheet();
    $('sheet').showModal();
    $('exAmt').focus();
  }
  function openSort(id) {
    sortId = id; var e = sortExp(); if (!e) return;
    mode = 'sort'; chosen = e.item || null; kind = null;
    split = !!(e.parts && e.parts.length > 1);
    lines = split ? e.parts.map(function (p) { return { item: p.item, val: String(p.amt), unit: 'rm' }; }) : [];
    $('exAmt').value = e.amt; $('exNote').value = e.note || ''; $('exErr').hidden = true; $('remember').checked = true;
    renderSheet(); $('sheet').showModal();
  }
  function toggleSplit() {
    if (!split) { split = true; lines = [{ item: chosen || '', val: '', unit: 'rm' }, { item: '', val: '', unit: 'rm' }]; }
    else { split = false; chosen = (lines[0] && lines[0].item) || chosen; }
    $('exErr').hidden = true;
    renderSheet();
  }
  function pick(id) {
    chosen = id; $('exErr').hidden = true;
    if (mode === 'spend') {
      var it = byId(id);
      if (it && it.fixed && !$('exAmt').value) { var left = r2(effBudget(it) - spentOn(id)); if (left > 0) $('exAmt').value = left; }
    }
    if (mode === 'in') $('chips').querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-checked', c.dataset.chip === id); });
    else renderChips();
  }
  function pickKind(id) {
    kind = id; $('exErr').hidden = true;
    var k = KINDS.filter(function (x) { return x.id === id; })[0];
    if (id === 'side' && state.sideSplit && state.sideSplit.length) {
      split = true; chosen = null;
      lines = state.sideSplit.filter(function (q) { return q.to === 'fund' || q.to === 'none' || byId(q.to); }).map(function (q) { return { item: q.to, val: String(q.pct), unit: 'pct' }; });
    } else if (k && k.to && !chosen && !split) chosen = k.to;
    renderSheet();
  }

  function rollover() {
    var c = calc('now'), got = num($('nextSal').value) || state.salary, cy = state.cycle, nk = nextKey(cy.key), nnk = nextKey(nk), un = unspentDaily(), extra = $('addLeft').checked ? un : 0;
    var carries = {}, sideIn = 0;
    state.items.forEach(function (it) { if (it.pot) carries[it.id] = r2(effBudget(it) - spentOn(it.id)); });
    state.income.forEach(function (x) { if (x.kind === 'side') sideIn += x.amt; });
    var saved = (state.moves.fund ? Math.max(0, c.savings) : 0) + extra + incomeTo('fund');
    state.fundBase = r2(state.fundBase + saved);
    state.history.push({ key: cy.key, saved: r2(saved), spent: totalSpent(), moneyIn: incomeTotal(), sideIn: r2(sideIn) });
    state.income = [];
    state.items = state.items.filter(function (it) { return active(it, nk); });
    state.items.forEach(function (it) { it.now = it.month || 0; delete it.paid; if (it.pot) it.carry = carries[it.id] || 0; });
    var pd = state.payday || 7, s = nk + '-' + pad(pd), e = nnk + '-' + pad(pd);
    state.cycle = { key: nk, label: pd + ' ' + kMonth(nk) + ' – ' + pd + ' ' + kMonth(nnk), nextPay: pd + ' ' + kMonth(nnk), nextPayISO: e, days: Math.round((utc(e) - utc(s)) / 864e5), received: got, paid: 0 };
    state.moves = {}; state.expenses = []; confirming = false; $('addLeft').checked = false;
    save(); renderAll(); window.scrollTo(0, 0);
  }

  /* Events */
  function byId(id) { return state.items.filter(function (it) { return it.id === id; })[0]; }
  document.addEventListener('input', function (e) {
    var t = e.target; if (!state) return;
    if (t.id === 'exAmt') { if (split) updateSplit(); else if (mode !== 'in') renderChips(); return; }
    if (t.dataset.slVal != null) { lines[+t.dataset.slVal].val = t.value; updateSplit(); return; }
    if (t.dataset.amt) { var it = byId(t.dataset.amt); if (it) { it[view] = num(t.value); save(); renderPlanSummary(); renderHome(); renderSpend(); renderFund(); } }
    else if (t.id === 'salary') { state.salary = num(t.value); save(); renderPlanSummary(); renderFund(); }
    else if (t.id === 'fundEdit') { state.fundBase = r2(num(t.value) - (state.moves.fund ? Math.max(0, calc('now').savings) : 0) - incomeTo('fund')); save(); renderFund(); renderHome(); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.slItem != null) { lines[+t.dataset.slItem].item = t.value; $('exErr').hidden = true; updateSplit(); }
    else if (t.dataset && t.dataset.card != null) { state.cards[t.dataset.card] = t.value; save(); renderAll(); }
    else if (t.dataset && t.dataset.move) { state.moves[t.dataset.move] = t.checked; save(); renderHome(); renderFund(); }
    else if (t.id === 'setupFile' || t.id === 'bkFile') {
      var f = t.files[0]; if (!f) return;
      f.text().then(function (txt) {
        var d = parseText(txt);
        if (d) { adopt(d); $('bkMsg').textContent = 'Plan restored.'; }
        else if (t.id === 'setupFile') showSetupErr(); else $('bkMsg').textContent = 'That file isn\'t a Payday backup, so nothing changed.';
        t.value = '';
      });
    }
  });
  function showSetupErr() { $('setupErr').textContent = 'That isn\'t a Payday plan. Check you chose the right file.'; $('setupErr').hidden = false; }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('button'); if (!t) return;
    if (t.dataset.go) { tab = t.dataset.go; renderAll(); window.scrollTo(0, 0); }
    else if (t.dataset.v) { view = t.dataset.v; adding = null; renderBudget(); renderPlanSummary(); }
    else if (t.dataset.open) { adding = t.dataset.open; renderBudget(); renderPlanSummary(); var n = $('addName'); if (n) n.focus(); }
    else if (t.dataset.cancel) { adding = null; renderBudget(); renderPlanSummary(); }
    else if (t.dataset.del) { state.items = state.items.filter(function (it) { return it.id !== t.dataset.del; }); save(); renderAll(); }
    else if (t.dataset.ex) { state.expenses = state.expenses.filter(function (x) { return x.id !== t.dataset.ex; }); save(); renderAll(); }
    else if (t.dataset.in) { state.income = state.income.filter(function (x) { return x.id !== t.dataset.in; }); save(); renderAll(); }
    else if (t.dataset.sort) { openSort(t.dataset.sort); }
    else if (t.id === 'splitBtn') { toggleSplit(); }
    else if (t.dataset.slUnit != null) { lines[+t.dataset.slUnit].unit = t.dataset.u; renderSplit(); }
    else if (t.dataset.slDel != null) { lines.splice(+t.dataset.slDel, 1); renderSplit(); }
    else if (t.id === 'slAdd') { lines.push({ item: '', val: '', unit: 'rm' }); renderSplit(); }
    else if (t.dataset.mapCard) { state.cards[t.dataset.mapCard] = t.dataset.acct; save(); renderAll(); }
    else if (t.id === 'sortDel') { state.expenses = state.expenses.filter(function (x) { return x.id !== sortId; }); save(); $('sheet').close(); renderAll(); }
    else if (t.id === 'apCheck') { pull(true); }
    else if (t.id === 'apOff') { delete state.sync; apErr = ''; apNote = ''; $('apUrl').value = ''; $('apKey').value = ''; $('apMsg').textContent = 'Disconnected.'; save(); renderAll(); }
    else if (t.id === 'apSave') {
      var url = $('apUrl').value.trim(), key = $('apKey').value.trim();
      if (!/^(https:\/\/script\.google\.com\/|http:\/\/localhost[:\/])/.test(url)) { $('apMsg').textContent = 'The web app link should start with https://script.google.com/'; return; }
      if (!key) { $('apMsg').textContent = 'Paste the key as well.'; return; }
      var sy = state.sync || {};
      if (sy.url !== url) sy.lastRow = 1;
      sy.url = url; sy.key = key; state.sync = sy; save();
      $('apMsg').textContent = 'Checking your Google Sheet';
      pull(true).then(function () { $('apMsg').textContent = apErr || 'Connected. ' + apNote + '.'; });
    }
    else if (t.dataset.chip) { pick(t.dataset.chip); }
    else if (t.dataset.kind) { pickKind(t.dataset.kind); }
    else if (t.dataset.mode) { if (mode !== t.dataset.mode) { mode = t.dataset.mode; chosen = null; kind = null; split = false; lines = []; $('exErr').hidden = true; renderSheet(); } }
    else if (t.id === 'fab') { openSheet(); }
    else if (t.id === 'sheetX') { $('sheet').close(); }
    else if (t.id === 'nextBtn') { confirming = true; renderHome(); }
    else if (t.id === 'nextNo') { confirming = false; renderHome(); }
    else if (t.id === 'nextYes') { rollover(); }
    else if (t.id === 'setupPaste') { var d = parseText($('setupText').value); if (d) adopt(d); else showSetupErr(); }
    else if (t.id === 'bkSave') { backupFile(); }
    else if (t.id === 'bkCopy') { backupCopy(); }
  });
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.id === 'addForm') {
      e.preventDefault();
      var amt = num($('exAmt').value), now = Date.now(), note = $('exNote').value.trim(), parts = null;
      if (mode === 'in' && !kind) { $('exErr').textContent = 'Choose what kind of money it is.'; $('exErr').hidden = false; return; }
      if (split) {
        var c = splitCalc();
        if (c.err) { $('exErr').textContent = c.err + '.'; $('exErr').hidden = false; return; }
        parts = [];
        lines.forEach(function (l, i) { if (c.amts[i] > 0) parts.push({ item: l.item, amt: c.amts[i] }); });
        amt = c.total;
      }
      if (mode === 'sort') {
        var se = sortExp();
        if (!parts && !chosen) { $('exErr').textContent = 'Choose a category first.'; $('exErr').hidden = false; return; }
        if (se) {
          if (se.src !== 'applepay') { if (!amt) return; se.amt = r2(amt); }
          if (parts && parts.length > 1) { se.parts = parts; se.item = parts[0].item; }
          else { delete se.parts; se.item = parts ? parts[0].item : chosen; }
          se.auto = false; se.note = note;
          var k2 = se.src === 'applepay' && !parts ? norm(se.merchant) : '';
          if (k2 && $('remember').checked) {
            state.rules[k2] = se.item;
            state.expenses.forEach(function (x) { if (!x.item && x.src === 'applepay' && norm(x.merchant) === k2) { x.item = se.item; x.auto = true; } });
          }
        }
        save(); $('sheet').close(); renderAll(); return;
      }
      if (parts && mode === 'in') {
        var inc = { id: 'i' + now.toString(36), kind: kind, to: parts[0].item, amt: amt, date: todayISO(), ts: now, note: note };
        if (parts.length > 1) inc.parts = parts.map(function (q) { return { to: q.item, amt: q.amt }; });
        state.income.push(inc); save(); $('sheet').close(); renderAll(); return;
      }
      if (parts) {
        var ex = { id: 'e' + now.toString(36), item: parts[0].item, amt: amt, date: todayISO(), ts: now, note: note };
        if (parts.length > 1) ex.parts = parts;
        state.expenses.push(ex); save(); $('sheet').close(); renderAll(); return;
      }
      if (mode === 'in' && !kind) { $('exErr').textContent = 'Choose what kind of money it is.'; $('exErr').hidden = false; return; }
      if (!chosen) { $('exErr').textContent = mode === 'in' ? 'Choose where the money goes.' : 'Choose a category first.'; $('exErr').hidden = false; return; }
      if (!amt) return;
      if (mode === 'in') state.income.push({ id: 'i' + now.toString(36), kind: kind, to: chosen, amt: r2(amt), date: todayISO(), ts: now, note: note });
      else state.expenses.push({ id: 'e' + now.toString(36), item: chosen, amt: r2(amt), date: todayISO(), ts: now, note: note });
      save(); $('sheet').close(); renderAll();
    } else if (f.dataset && f.dataset.add) {
      e.preventDefault();
      var name = $('addName').value.trim(), v = num($('addAmt').value);
      if (!name) return;
      state.items.push({ id: 'c' + Date.now().toString(36), name: name, acct: f.dataset.add, now: v, month: v, custom: true });
      adding = null; save(); renderAll();
    }
  });
  function stamp() { state.lastBackup = todayISO(); save(); renderBanks(); }
  function backupFile() {
    var name = 'payday-backup-' + todayISO() + '.json', text = JSON.stringify(state);
    var file = new File([text], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).then(function () { stamp(); $('bkMsg').textContent = 'Backup saved.'; }).catch(function () {});
      return;
    }
    var a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    stamp(); $('bkMsg').textContent = 'Backup downloaded.';
  }
  function backupCopy() {
    if (!navigator.clipboard) { $('bkMsg').textContent = 'This phone blocked copying. Use Save backup instead.'; return; }
    navigator.clipboard.writeText(JSON.stringify(state)).then(function () { stamp(); $('bkMsg').textContent = 'Backup copied. Paste it somewhere private.'; })
      .catch(function () { $('bkMsg').textContent = 'This phone blocked copying. Use Save backup instead.'; });
  }

  function tipAt(i) {
    var box = $('chart'), q = box._pts && box._pts[i], g = box._geo, tip = $('tip');
    if (!q) return;
    tip.textContent = kFull(q.key) + ': ' + rm(q.val); tip.hidden = false;
    tip.style.left = Math.min(box.clientWidth - 70, Math.max(70, g.l + g.band * i + g.band / 2)) + 'px';
    tip.style.top = (g.y(q.val) - 6) + 'px';
  }
  ['pointermove', 'click', 'focusin'].forEach(function (ev) {
    $('chart').addEventListener(ev, function (e) { if (e.target.dataset && e.target.dataset.i) tipAt(+e.target.dataset.i); });
  });
  ['pointerleave', 'focusout'].forEach(function (ev) { $('chart').addEventListener(ev, function () { $('tip').hidden = true; }); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state) { renderHome(); renderAP(); pull(false); } });
  window.addEventListener('online', function () { if (state) pull(true); });
  window.addEventListener('resize', function () { if (state && tab === 'fund') renderFund(); });

  var saved = load();
  if (saved && valid(saved)) state = normalize(saved);
  show();
  if (state) pull(true);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
