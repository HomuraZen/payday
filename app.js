(function () {
  'use strict';
  var KEY = 'payday.plan.v1';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var COLORS = { save: 'var(--c-save)', bills: 'var(--c-bills)', daily: 'var(--c-daily)', funds: 'var(--c-funds)', idle: 'var(--c-idle)' };
  var state = null, view = 'now', tab = 'home', adding = null, confirming = false, chosen = null, mode = 'spend', kind = null;
  var KINDS = [
    { id: 'extra', name: 'Extra income', to: 'fund', hint: 'Money outside your salary plan goes to the emergency fund by default. Move it to your savings account after you save this.' },
    { id: 'claim', name: 'Claim', to: null, hint: 'If it pays back spending you logged here, put it back in that budget item. If you paid for work items with your own money and never logged them, choose No budget change.' },
    { id: 'friend', name: 'Friend transfer', to: null, hint: 'If a friend is paying you back, put it back where the money came from. If it\'s a gift, the emergency fund is the safe choice.' }
  ];
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
  function spentOn(id) { var s = 0; state.expenses.forEach(function (e) { if (e.item === id) s += e.amt; }); return r2(s); }
  function totalSpent() { var s = 0; state.expenses.forEach(function (e) { s += e.amt; }); return r2(s); }
  function incomeTo(id) { var s = 0; state.income.forEach(function (e) { if (e.to === id) s += e.amt; }); return r2(s); }
  function incomeTotal() { var s = 0; state.income.forEach(function (e) { s += e.amt; }); return r2(s); }
  function itemTopUps() { var s = 0; state.income.forEach(function (e) { if (e.to !== 'fund' && e.to !== 'none') s += e.amt; }); return r2(s); }
  function effBudget(it) { return r2((it.now || 0) + incomeTo(it.id)); }
  function destName(to) {
    if (to === 'fund') return 'Emergency fund';
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
  function project() {
    var bal = r2(state.fundBase + Math.max(0, calc('now').savings) + incomeTo('fund')), k = state.cycle.key, out = [{ key: k, val: bal, now: true }];
    for (var i = 0; i < 11; i++) {
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
      if (e.date === today && items.some(function (i) { return i.id === e.item; })) todaySp += e.amt;
      if (countsDaily(e)) { sp += e.amt; if (e.date === today) todaySp += e.amt; }
    });
    var rest = r2(bud - sp), startOfDay = rest + todaySp, safe = r2(startOfDay / left - todaySp);
    $('toPay').textContent = left + (left === 1 ? ' day' : ' days') + ' to salary';
    $('daySafe').textContent = rm(Math.max(0, safe));
    $('dayBody').textContent = (safe < 0 ? rm(-safe) + ' over today\'s share. ' : '') + rm(rest) + ' left for ' + items.map(function (i) { return i.name.toLowerCase(); }).join(' and ') + ' until ' + cy.nextPay + '.';
    var all = calc('now');
    $('sLeft').textContent = rm(all.spend + itemTopUps() - totalSpent());
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
    var f = fundAcct(), hub = hubAcct(), list = [{ id: 'fund', label: f.saveLabel || f.name, detail: 'Emergency fund', amt: Math.max(0, c.savings), a: f }];
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
    $('spendS').textContent = rm(spent) + ' of ' + rm(total + itemTopUps()) + (inn > 0 ? ' · ' + rm(inn) + ' in' : '');
    var html = '';
    budgetAccts().forEach(function (a) {
      state.items.filter(function (it) { return it.acct === a.id && !it.paid; }).forEach(function (it) {
        var b = effBudget(it), s = spentOn(it.id), left = r2(b - s), pct = b > 0 ? Math.min(100, s / b * 100) : (s > 0 ? 100 : 0), top = incomeTo(it.id);
        html += '<div class="cat"><div class="r"><span>' + esc(it.name) + (top > 0 ? ' <span class="tag">+' + rm(top) + ' added</span>' : '') + '</span><b class="' + (left < 0 ? 'o' : '') + '">' + (left < 0 ? rm(-left) + ' over' : rm(left) + ' left') + '</b></div>'
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
        var sub = 'To ' + destName(e.to) + (e.note ? ' · ' + e.note : '');
        out += '<div class="entry"><span class="t"><span>' + esc(kindName(e.kind)) + '</span><span class="small muted">' + esc(sub) + '</span></span><span class="amt in">+' + rm(e.amt) + '</span><button type="button" class="x" data-in="' + esc(e.id) + '" aria-label="Delete ' + esc(rm(e.amt)) + ' money in">×</button></div>';
        return;
      }
      var it = state.items.filter(function (i) { return i.id === e.item; })[0];
      if (e.src === 'applepay') {
        var ca = cardAcct(e.card), sub2 = [e.merchant || 'Apple Pay', e.card].filter(Boolean).join(' · ') + (e.auto ? ' · Sorted automatically' : '') + (e.note ? ' · ' + e.note : '');
        var warn = it && ca && it.acct !== ca && acct(ca) && acct(it.acct) ? '<span class="warn">! Paid from ' + esc(acct(ca).name) + ', budgeted in ' + esc(acct(it.acct).name) + '</span>' : '';
        out += '<div class="entry"><button type="button" class="linkish" data-sort="' + esc(e.id) + '"><span>' + esc(it ? it.name : 'Not sorted yet') + '</span><span class="small muted">' + esc(sub2) + '</span>' + warn + '</button><span class="amt">' + rm(e.amt) + '</span><button type="button" class="x" data-ex="' + esc(e.id) + '" aria-label="Delete ' + esc(rm(e.amt)) + ' entry">×</button></div>';
        return;
      }
      out += '<div class="entry"><span class="t"><span>' + esc(it ? it.name : 'Removed item') + '</span>' + (e.note ? '<span class="small muted">' + esc(e.note) + '</span>' : '') + '</span><span class="amt">' + rm(e.amt) + '</span><button type="button" class="x" data-ex="' + esc(e.id) + '" aria-label="Delete ' + esc(rm(e.amt)) + ' entry">×</button></div>';
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
    var pts = project(), box = $('chart'), W = Math.max(280, box.clientWidth || 360), H = 230;
    var p = { l: 34, r: 6, t: 20, b: 24 }, iw = W - p.l - p.r, ih = H - p.t - p.b;
    var full = fullGoal(), maxV = Math.max(pts[pts.length - 1].val, full, 3000), step = maxV > 20000 ? 10000 : 5000;
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
    [{ v: 3000, l: 'Starter RM3,000' }, { v: full, l: '3 months ' + rm(full) }].forEach(function (g) {
      if (g.v > top) return;
      s += '<line x1="' + p.l + '" x2="' + (W - p.r) + '" y1="' + y(g.v) + '" y2="' + y(g.v) + '" stroke="var(--fg-2)" stroke-dasharray="4 4"/>';
      s += '<text class="v" x="' + (p.l + 4) + '" y="' + (y(g.v) - 5) + '">' + g.l + '</text>';
    });
    var last = pts[pts.length - 1];
    s += '<text class="v" x="' + (W - p.r) + '" y="' + (y(last.val) - 6) + '" text-anchor="end">' + rm(last.val) + '</text>';
    var old = box.querySelector('svg'); if (old) old.remove();
    box.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 ' + W + ' ' + H + '" height="' + H + '" role="group" aria-label="Projected emergency fund by salary month">' + s + '</svg>');
    box._pts = pts; box._geo = { band: band, l: p.l, y: y };

    var f3 = pts.filter(function (q) { return q.val >= 3000; })[0], ff = pts.filter(function (q) { return q.val >= full; })[0];
    var ending = state.items.filter(function (it) { return it.endsAfter; })[0], ms = [];
    ms.push(['Starter goal, RM3,000', f3 ? kFull(f3.key) + ' salary' : 'After ' + kFull(last.key)]);
    ms.push(['3 months of spending, ' + rm(full), ff ? kFull(ff.key) + ' salary' : 'After ' + kFull(last.key)]);
    if (ending) ms.push([ending.name + ' paid off, savings rise by ' + rm(ending.month), kFull(nextKey(ending.endsAfter)) + ' salary']);
    $('miles').innerHTML = ms.map(function (m) { return '<li><span>' + esc(m[0]) + '</span><b>' + esc(m[1]) + '</b></li>'; }).join('');
    $('fundS').textContent = 'Projected on a ' + rm(state.salary) + ' salary. Darker bar is this month.';
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
  function chip(id, label, dot) {
    return '<button type="button" class="chip" role="radio" aria-checked="' + (chosen === id) + '" data-chip="' + esc(id) + '">' + (dot ? '<span class="dot" style="background:' + dot + '"></span>' : '') + esc(label) + '</button>';
  }
  function sortExp() { return state.expenses.filter(function (x) { return x.id === sortId; })[0]; }
  function renderSheet() {
    var isIn = mode === 'in', isSort = mode === 'sort', se = isSort ? sortExp() : null;
    $('mSeg').hidden = isSort;
    $('exAmt').readOnly = isSort;
    $('sortDel').hidden = !isSort;
    var key = se ? norm(se.merchant) : '';
    $('rememberWrap').hidden = !key;
    $('rememberT').textContent = se ? 'Always put ' + se.merchant + ' here' : '';
    $('sheetT').textContent = isSort ? 'Sort payment' : isIn ? 'Add money in' : 'Add spending';
    $('mSpend').setAttribute('aria-pressed', !isIn); $('mIn').setAttribute('aria-pressed', isIn);
    $('kinds').hidden = !isIn;
    $('kinds').innerHTML = KINDS.map(function (k) {
      return '<button type="button" class="chip" role="radio" aria-checked="' + (kind === k.id) + '" data-kind="' + k.id + '">' + esc(k.name) + '</button>';
    }).join('');
    var k = KINDS.filter(function (x) { return x.id === kind; })[0];
    $('inHint').hidden = isSort ? !se : (!isIn || !k);
    $('inHint').textContent = se ? [se.merchant || 'Apple Pay payment', se.card, dayName(se.date)].filter(Boolean).join(' · ') : k ? k.hint : '';
    $('chipsL').textContent = isIn ? 'Where does it go?' : 'Category';
    var html = isIn ? chip('fund', 'Emergency fund', 'var(--c-save)') + chip('none', 'No budget change', '') : '';
    budgetAccts().forEach(function (a) {
      state.items.filter(function (it) { return it.acct === a.id && !it.paid && (isIn || isSort || effBudget(it) > 0); }).forEach(function (it) {
        html += chip(it.id, (isIn ? 'Back to ' : '') + it.name, color(a));
      });
    });
    $('chips').innerHTML = html;
    $('exSave').textContent = isSort ? 'Sort' : isIn ? 'Add money in' : 'Save';
  }
  function openSheet() {
    chosen = null; kind = null; mode = 'spend';
    $('exAmt').value = ''; $('exNote').value = ''; $('exErr').hidden = true;
    renderSheet();
    $('sheet').showModal();
    $('exAmt').focus();
  }
  function openSort(id) {
    sortId = id; var e = sortExp(); if (!e) return;
    mode = 'sort'; chosen = e.item || null; kind = null;
    $('exAmt').value = e.amt; $('exNote').value = e.note || ''; $('exErr').hidden = true; $('remember').checked = true;
    renderSheet(); $('sheet').showModal();
  }
  function pick(id) {
    chosen = id; $('exErr').hidden = true;
    $('chips').querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-checked', c.dataset.chip === id); });
    if (mode !== 'spend') return;
    var it = state.items.filter(function (i) { return i.id === id; })[0];
    if (it && it.fixed && !$('exAmt').value) { var left = r2(effBudget(it) - spentOn(id)); if (left > 0) $('exAmt').value = left; }
  }
  function pickKind(id) {
    kind = id; $('exErr').hidden = true;
    var k = KINDS.filter(function (x) { return x.id === id; })[0];
    if (k && k.to && !chosen) chosen = k.to;
    renderSheet();
  }

  function rollover() {
    var c = calc('now'), got = num($('nextSal').value) || state.salary, cy = state.cycle, nk = nextKey(cy.key), nnk = nextKey(nk), un = unspentDaily(), extra = $('addLeft').checked ? un : 0;
    var saved = (state.moves.fund ? Math.max(0, c.savings) : 0) + extra + incomeTo('fund');
    state.fundBase = r2(state.fundBase + saved);
    state.history.push({ key: cy.key, saved: r2(saved), spent: totalSpent(), moneyIn: incomeTotal() });
    state.income = [];
    state.items = state.items.filter(function (it) { return active(it, nk); });
    state.items.forEach(function (it) { it.now = it.month || 0; delete it.paid; });
    var pd = state.payday || 7, s = nk + '-' + pad(pd), e = nnk + '-' + pad(pd);
    state.cycle = { key: nk, label: pd + ' ' + kMonth(nk) + ' – ' + pd + ' ' + kMonth(nnk), nextPay: pd + ' ' + kMonth(nnk), nextPayISO: e, days: Math.round((utc(e) - utc(s)) / 864e5), received: got, paid: 0 };
    state.moves = {}; state.expenses = []; confirming = false; $('addLeft').checked = false;
    save(); renderAll(); window.scrollTo(0, 0);
  }

  /* Events */
  function byId(id) { return state.items.filter(function (it) { return it.id === id; })[0]; }
  document.addEventListener('input', function (e) {
    var t = e.target; if (!state) return;
    if (t.dataset.amt) { var it = byId(t.dataset.amt); if (it) { it[view] = num(t.value); save(); renderPlanSummary(); renderHome(); renderSpend(); renderFund(); } }
    else if (t.id === 'salary') { state.salary = num(t.value); save(); renderPlanSummary(); renderFund(); }
    else if (t.id === 'fundEdit') { state.fundBase = r2(num(t.value) - (state.moves.fund ? Math.max(0, calc('now').savings) : 0) - incomeTo('fund')); save(); renderFund(); renderHome(); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.card != null) { state.cards[t.dataset.card] = t.value; save(); renderAll(); }
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
    else if (t.dataset.mode) { if (mode !== t.dataset.mode) { mode = t.dataset.mode; chosen = null; kind = null; $('exErr').hidden = true; renderSheet(); } }
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
      var amt = num($('exAmt').value), now = Date.now(), note = $('exNote').value.trim();
      if (mode === 'sort') {
        var se = sortExp();
        if (!chosen) { $('exErr').textContent = 'Choose a category first.'; $('exErr').hidden = false; return; }
        if (se) {
          se.item = chosen; se.auto = false; se.note = note;
          var k2 = norm(se.merchant);
          if (k2 && $('remember').checked) {
            state.rules[k2] = chosen;
            state.expenses.forEach(function (x) { if (!x.item && x.src === 'applepay' && norm(x.merchant) === k2) { x.item = chosen; x.auto = true; } });
          }
        }
        save(); $('sheet').close(); renderAll(); return;
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
