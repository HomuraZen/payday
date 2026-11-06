(function () {
  'use strict';
  var KEY = 'payday.plan.v1';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var COLORS = { save: 'var(--c-save)', bills: 'var(--c-bills)', daily: 'var(--c-daily)', funds: 'var(--c-funds)', idle: 'var(--c-idle)' };
  var state = null, view = 'now', tab = 'home', adding = null, confirming = false, chosen = null;

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
  function fundNow() { return r2(state.fundBase + (state.moves.fund ? Math.max(0, calc('now').savings) : 0)); }
  function unspentDaily() {
    var s = 0;
    state.items.forEach(function (it) { if (it.acct === 'daily') s += Math.max(0, (it.now || 0) - spentOn(it.id)); });
    return r2(s);
  }
  function project() {
    var bal = r2(state.fundBase + Math.max(0, calc('now').savings)), k = state.cycle.key, out = [{ key: k, val: bal, now: true }];
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
  function adopt(d) {
    d.expenses = d.expenses || []; d.moves = d.moves || {}; d.history = d.history || [];
    d.fundBase = d.fundBase || 0;
    state = d; save(); show();
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
    items.forEach(function (it) { bud += it.now || 0; sp += spentOn(it.id); });
    state.expenses.forEach(function (e) {
      if (e.date === today && items.some(function (i) { return i.id === e.item; })) todaySp += e.amt;
    });
    var rest = r2(bud - sp), startOfDay = rest + todaySp, safe = r2(startOfDay / left - todaySp);
    $('toPay').textContent = left + (left === 1 ? ' day' : ' days') + ' to salary';
    $('daySafe').textContent = rm(Math.max(0, safe));
    $('dayBody').textContent = (safe < 0 ? rm(-safe) + ' over today\'s share. ' : '') + rm(rest) + ' left for ' + items.map(function (i) { return i.name.toLowerCase(); }).join(' and ') + ' until ' + cy.nextPay + '.';
    var all = calc('now');
    $('sLeft').textContent = rm(all.spend - totalSpent());
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
    $('spendS').textContent = rm(spent) + ' of ' + rm(total);
    var html = '';
    budgetAccts().forEach(function (a) {
      state.items.filter(function (it) { return it.acct === a.id && !it.paid; }).forEach(function (it) {
        var b = it.now || 0, s = spentOn(it.id), left = r2(b - s), pct = b > 0 ? Math.min(100, s / b * 100) : (s > 0 ? 100 : 0);
        html += '<div class="cat"><div class="r"><span>' + esc(it.name) + '</span><b class="' + (left < 0 ? 'o' : '') + '">' + (left < 0 ? rm(-left) + ' over' : rm(left) + ' left') + '</b></div>'
          + '<div class="track"><i style="width:' + pct + '%;background:' + (left < 0 ? 'var(--bad)' : color(a)) + '"></i></div></div>';
      });
    });
    $('cats').innerHTML = html;
    var ex = state.expenses.slice().sort(function (x, y) { return y.ts - x.ts; }), last = null, out = '';
    ex.forEach(function (e) {
      if (e.date !== last) { out += '<div class="day">' + esc(dayName(e.date)) + '</div>'; last = e.date; }
      var it = state.items.filter(function (i) { return i.id === e.item; })[0];
      out += '<div class="entry"><span class="t"><span>' + esc(it ? it.name : 'Removed item') + '</span>' + (e.note ? '<span class="small muted">' + esc(e.note) + '</span>' : '') + '</span><span class="amt">' + rm(e.amt) + '</span><button type="button" class="x" data-ex="' + esc(e.id) + '" aria-label="Delete ' + esc(rm(e.amt)) + ' entry">×</button></div>';
    });
    $('log').innerHTML = out || '<p class="none">Nothing logged yet. Press + after you spend.</p>';
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

  function renderTab() {
    ['home', 'spend', 'plan', 'fund', 'banks'].forEach(function (t) { $('t-' + t).hidden = t !== tab; });
    document.querySelectorAll('.tabs button').forEach(function (b) {
      if (b.dataset.go === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }
  function renderAll() {
    renderTab(); renderHome(); renderSpend(); renderBudget(); renderPlanSummary(); renderFund(); renderBanks();
  }
  function show() {
    $('setup').hidden = !!state; $('app').hidden = !state;
    if (state) renderAll();
  }

  /* Add spending */
  function openSheet() {
    chosen = null; $('exAmt').value = ''; $('exNote').value = ''; $('exErr').hidden = true;
    var html = '';
    budgetAccts().forEach(function (a) {
      state.items.filter(function (it) { return it.acct === a.id && !it.paid && (it.now || 0) > 0; }).forEach(function (it) {
        html += '<button type="button" class="chip" role="radio" aria-checked="false" data-chip="' + esc(it.id) + '"><span class="dot" style="background:' + color(a) + '"></span>' + esc(it.name) + '</button>';
      });
    });
    $('chips').innerHTML = html;
    $('sheet').showModal();
    $('exAmt').focus();
  }
  function pick(id) {
    chosen = id; $('exErr').hidden = true;
    document.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-checked', c.dataset.chip === id); });
    var it = state.items.filter(function (i) { return i.id === id; })[0];
    if (it && it.fixed && !$('exAmt').value) { var left = r2((it.now || 0) - spentOn(id)); if (left > 0) $('exAmt').value = left; }
  }

  function rollover() {
    var c = calc('now'), got = num($('nextSal').value) || state.salary, cy = state.cycle, nk = nextKey(cy.key), nnk = nextKey(nk), un = unspentDaily(), extra = $('addLeft').checked ? un : 0;
    var saved = (state.moves.fund ? Math.max(0, c.savings) : 0) + extra;
    state.fundBase = r2(state.fundBase + saved);
    state.history.push({ key: cy.key, saved: r2(saved), spent: totalSpent() });
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
    else if (t.id === 'fundEdit') { state.fundBase = r2(num(t.value) - (state.moves.fund ? Math.max(0, calc('now').savings) : 0)); save(); renderFund(); renderHome(); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.move) { state.moves[t.dataset.move] = t.checked; save(); renderHome(); renderFund(); }
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
    else if (t.dataset.chip) { pick(t.dataset.chip); }
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
      var amt = num($('exAmt').value);
      if (!chosen) { $('exErr').hidden = false; return; }
      if (!amt) return;
      var now = Date.now();
      state.expenses.push({ id: 'e' + now.toString(36), item: chosen, amt: r2(amt), date: todayISO(), ts: now, note: $('exNote').value.trim() });
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
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state) renderHome(); });
  window.addEventListener('resize', function () { if (state && tab === 'fund') renderFund(); });

  var saved = load();
  if (saved && valid(saved)) { saved.expenses = saved.expenses || []; saved.moves = saved.moves || {}; saved.history = saved.history || []; state = saved; }
  show();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
})();
