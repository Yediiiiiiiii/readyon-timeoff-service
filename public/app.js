/* eslint-disable */
// ReadyOn Time-Off — dashboard. Vanilla JS, no build step.
(() => {
  const state = {
    employees: [],
    balancesByEmp: {},
    requests: [],
    outbox: { stats: { pending: 0, done: 0, dead: 0 }, recent: [] },
    ledgerEmpId: null,
    ledger: [],
    locations: new Map(),
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- HTTP helper with logging ----------
  async function api(method, path, body) {
    const start = performance.now();
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (method === 'POST' && path === '/time-off-requests') {
      opts.headers['idempotency-key'] = 'ui-' + crypto.randomUUID();
    }
    let res, json;
    try {
      res = await fetch(path, opts);
    } catch (err) {
      logEntry(method, path, 'ERR', performance.now() - start, err.message);
      throw err;
    }
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    logEntry(method, path, res.status, performance.now() - start, json);
    if (!res.ok) {
      const detail = json?.detail || json?.message || res.statusText;
      const err = new Error(detail);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  // ---------- Logger ----------
  function logEntry(method, path, status, ms, body) {
    const log = $('#log');
    const div = document.createElement('div');
    div.className = 'log-entry';
    const statusBucket =
      typeof status === 'number'
        ? status >= 500
          ? '5xx'
          : status >= 400
            ? '4xx'
            : '2xx'
        : 'err';
    div.innerHTML = `
      <span class="log-time">${new Date().toLocaleTimeString([], { hour12: false })}</span>
      <span class="log-method log-method-${method}">${method}</span>
      <span><span class="log-status-${statusBucket}">${status}</span> · ${path} <span class="muted">(${Math.round(ms)}ms)</span></span>
    `;
    log.prepend(div);
    while (log.children.length > 100) log.removeChild(log.lastChild);
  }

  // ---------- Toasts ----------
  function toast(title, body, kind = 'good') {
    const c = $('#toast-container');
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    el.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div>${
      body
        ? `<div class="toast-body">${escapeHtml(typeof body === 'string' ? body : JSON.stringify(body))}</div>`
        : ''
    }`;
    c.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    }, 3500);
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c],
    );
  }

  // ---------- Data load ----------
  async function refresh() {
    try {
      const [emps, reqs, outbox] = await Promise.all([
        api('GET', '/employees'),
        api('GET', '/time-off-requests'),
        api('GET', '/admin/outbox'),
      ]);
      state.employees = emps.items || [];
      state.requests = reqs.items || [];
      state.outbox = outbox;
      const balances = await Promise.all(
        state.employees.map((e) =>
          api('GET', `/employees/${e.id}/balances`).then((r) => [e.id, r.items]),
        ),
      );
      state.balancesByEmp = Object.fromEntries(balances);
      // collect locations from balances
      state.locations = new Map();
      for (const list of Object.values(state.balancesByEmp)) {
        for (const b of list) state.locations.set(b.locationId, b.locationId);
      }
      if (!state.ledgerEmpId && state.employees.length) {
        state.ledgerEmpId = state.employees[0].id;
      }
      if (state.ledgerEmpId) {
        const led = await api(
          'GET',
          `/employees/${state.ledgerEmpId}/ledger?limit=40`,
        );
        state.ledger = led.items || [];
      } else {
        state.ledger = [];
      }
      setStatus('live', 'good');
    } catch (e) {
      setStatus('error', 'danger');
    }
    render();
  }

  function setStatus(text, kind) {
    const pill = $('#status-pill');
    pill.textContent = `● ${text}`;
    pill.className = `pill pill--${kind === 'danger' ? 'danger' : kind === 'warn' ? 'warn' : 'good'}`;
  }

  // ---------- Render ----------
  function render() {
    renderEmployees();
    renderFormDropdowns();
    renderRequests();
    renderOutbox();
    renderLedger();
  }

  function renderEmployees() {
    const c = $('#employees-list');
    $('#balances-meta').textContent = `${state.employees.length} employees`;
    if (!state.employees.length) {
      c.innerHTML = `<div class="empty">No employees yet — click <strong>Seed demo data</strong> to get started.</div>`;
      return;
    }
    c.innerHTML = state.employees
      .map((e) => {
        const bals = state.balancesByEmp[e.id] || [];
        const balsHtml = bals.length
          ? `<div class="balances-grid">${bals.map(renderBalance).join('')}</div>`
          : `<div class="empty">No balances synced yet.</div>`;
        return `
          <div class="employee">
            <div class="employee-head">
              <div>
                <div class="employee-name">${escapeHtml(e.name)}</div>
                <div class="employee-id">${escapeHtml(e.id)} · hcm:${escapeHtml(e.hcm_employee_id)}</div>
              </div>
              <button class="btn btn--ghost" data-emp-sync="${e.id}">Reconcile ↻</button>
            </div>
            ${balsHtml}
          </div>
        `;
      })
      .join('');
  }

  function renderBalance(b) {
    const total = Math.max(b.hcmBalanceMinutes, 1);
    const reservedPct = Math.round(
      (Math.min(b.reservedMinutes, total) / total) * 100,
    );
    const availPct = Math.max(0, 100 - reservedPct);
    return `
      <div class="balance">
        <div class="balance-head">
          <span class="balance-type">${escapeHtml(b.leaveType)}</span>
          <span class="balance-loc">${escapeHtml(b.locationId)}</span>
        </div>
        <div class="balance-bar">
          <div class="bar-available" style="width:${availPct}%"></div>
          <div class="bar-reserved" style="width:${reservedPct}%"></div>
        </div>
        <div class="balance-stats">
          <span><span class="balance-stat-num">${fmtMin(b.availableMinutes)}</span> avail</span>
          <span><span class="balance-stat-num">${fmtMin(b.reservedMinutes)}</span> held</span>
          <span>HCM <span class="balance-stat-num">${fmtMin(b.hcmBalanceMinutes)}</span></span>
        </div>
      </div>
    `;
  }

  function fmtMin(m) {
    if (m == null) return '—';
    if (m === 0) return '0m';
    const days = Math.floor(m / 480);
    const rem = m - days * 480;
    if (days && !rem) return `${days}d`;
    if (days) return `${days}d ${Math.round(rem / 60)}h`;
    if (m % 60 === 0) return `${m / 60}h`;
    return `${m}m`;
  }

  function renderFormDropdowns() {
    const empSel = $('select[name=employeeId]');
    const locSel = $('select[name=locationId]');
    const bonusEmp = $('#bonus-employee');
    const ledgerEmp = $('#ledger-employee');
    const empOpts = state.employees
      .map((e) => `<option value="${e.id}">${escapeHtml(e.name)}</option>`)
      .join('');
    const locOpts = Array.from(state.locations.keys())
      .map((l) => `<option value="${l}">${escapeHtml(l)}</option>`)
      .join('');
    [empSel, bonusEmp, ledgerEmp].forEach((sel) => {
      const cur = sel.value;
      sel.innerHTML = empOpts;
      if (cur) sel.value = cur;
    });
    const cur = locSel.value;
    locSel.innerHTML = locOpts;
    if (cur) locSel.value = cur;
    if (state.ledgerEmpId) ledgerEmp.value = state.ledgerEmpId;
  }

  function renderRequests() {
    const tbody = $('#requests-table tbody');
    if (!state.requests.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">No requests yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = state.requests
      .map((r) => {
        const canApprove = r.status === 'PENDING';
        const canCancel =
          r.status === 'PENDING' ||
          r.status === 'APPROVED' ||
          r.status === 'FILED';
        return `
          <tr>
            <td>${r.id.slice(0, 8)}…</td>
            <td>${escapeHtml(r.employeeId)}</td>
            <td>${escapeHtml(r.leaveType)}</td>
            <td>${r.startDate} → ${r.endDate}</td>
            <td>${r.durationMinutes}</td>
            <td><span class="status-badge status-${r.status}">${r.status}</span></td>
            <td>${r.hcmRequestId ? r.hcmRequestId.slice(0, 12) + '…' : '—'}</td>
            <td>
              ${canApprove ? `<button class="btn btn--ghost" data-approve="${r.id}">Approve</button>` : ''}
              ${canCancel ? `<button class="btn btn--ghost" data-cancel="${r.id}">Cancel</button>` : ''}
            </td>
          </tr>
        `;
      })
      .join('');
  }

  function renderOutbox() {
    $('#ob-pending').textContent = state.outbox.stats.pending ?? 0;
    $('#ob-done').textContent = state.outbox.stats.done ?? 0;
    $('#ob-dead').textContent = state.outbox.stats.dead ?? 0;
    const tbody = $('#outbox-table tbody');
    if (!state.outbox.recent.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty">Outbox is empty.</td></tr>`;
      return;
    }
    tbody.innerHTML = state.outbox.recent
      .map(
        (r) => `
        <tr>
          <td>${r.id}</td>
          <td>${r.type.replace('HCM_', '')}</td>
          <td>${r.request_id ? r.request_id.slice(0, 8) + '…' : '—'}</td>
          <td>${r.attempts}</td>
          <td><span class="status-badge status-${r.status}">${r.status}</span></td>
          <td title="${escapeHtml(r.last_error || '')}">${r.last_error ? escapeHtml(r.last_error.slice(0, 60)) : '—'}</td>
        </tr>
      `,
      )
      .join('');
  }

  function renderLedger() {
    const list = $('#ledger-list');
    if (!state.ledger.length) {
      list.innerHTML = `<li class="empty">No ledger entries yet.</li>`;
      return;
    }
    list.innerHTML = state.ledger
      .map((l) => {
        const sign = l.delta_minutes > 0 ? 'pos' : 'neg';
        const symbol = l.delta_minutes > 0 ? '+' : '';
        const t = new Date(l.created_at).toLocaleTimeString([], {
          hour12: false,
        });
        return `
          <li>
            <span class="ledger-dot ledger-cause-${l.cause}"></span>
            <div>
              <span class="ledger-cause">${l.cause}</span>
              <span class="ledger-delta ledger-delta-${sign}">${symbol}${l.delta_minutes}m</span>
              <div class="ledger-meta">
                ${escapeHtml(l.location_id)} · ${escapeHtml(l.leave_type)} ·
                hcm=${l.hcm_balance_after} reserved=${l.reserved_after}
                ${l.note ? '· ' + escapeHtml(l.note) : ''}
              </div>
            </div>
            <span class="muted">${t}</span>
          </li>
        `;
      })
      .join('');
  }

  // ---------- Actions ----------
  $('#seed-btn').addEventListener('click', async () => {
    try {
      const seed = {
        employees: [
          {
            employeeId: 'emp-alice',
            hcmEmployeeId: 'wd-alice',
            name: 'Alice Chen',
            balances: [
              {
                locationId: 'loc-NYC',
                hcmLocationId: 'wd-loc-NYC',
                leaveType: 'VACATION',
                balanceMinutes: 4800,
              },
              {
                locationId: 'loc-NYC',
                hcmLocationId: 'wd-loc-NYC',
                leaveType: 'SICK',
                balanceMinutes: 2400,
              },
            ],
          },
          {
            employeeId: 'emp-bob',
            hcmEmployeeId: 'wd-bob',
            name: 'Bob Martinez',
            balances: [
              {
                locationId: 'loc-SF',
                hcmLocationId: 'wd-loc-SF',
                leaveType: 'VACATION',
                balanceMinutes: 3840,
              },
              {
                locationId: 'loc-SF',
                hcmLocationId: 'wd-loc-SF',
                leaveType: 'PERSONAL',
                balanceMinutes: 960,
              },
            ],
          },
        ],
      };
      await api('POST', '/admin/seed', seed);
      toast('Seeded', 'Alice + Bob loaded with VAC / SICK / PERSONAL', 'good');
      // Default the form to today + 7 / today + 8
      const t = new Date();
      t.setDate(t.getDate() + 14);
      const t2 = new Date(t);
      t2.setDate(t2.getDate() + 1);
      $('input[name=startDate]').value = t.toISOString().slice(0, 10);
      $('input[name=endDate]').value = t2.toISOString().slice(0, 10);
      await refresh();
    } catch (e) {
      toast('Seed failed', e.message, 'bad');
    }
  });

  $('#create-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const body = {
      employeeId: fd.get('employeeId'),
      locationId: fd.get('locationId'),
      leaveType: fd.get('leaveType'),
      startDate: fd.get('startDate'),
      endDate: fd.get('endDate'),
      durationMinutes: Number(fd.get('durationMinutes')),
      reason: fd.get('reason') || undefined,
    };
    try {
      const r = await api('POST', '/time-off-requests', body);
      toast('Request created', `${r.id.slice(0, 8)}… · ${r.status}`, 'good');
      await refresh();
    } catch (e) {
      toast('Create failed', e.message, 'bad');
    }
  });

  document.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!(t instanceof HTMLElement)) return;
    const approveId = t.getAttribute('data-approve');
    const cancelId = t.getAttribute('data-cancel');
    const empSync = t.getAttribute('data-emp-sync');
    if (approveId) {
      try {
        await api('POST', `/time-off-requests/${approveId}/approve`, {
          managerId: 'mgr-ui',
        });
        toast('Approved', 'Outbox row enqueued; click "Flush outbox"', 'good');
        await refresh();
      } catch (e) {
        toast('Approve failed', e.message, 'bad');
      }
    }
    if (cancelId) {
      try {
        await api('POST', `/time-off-requests/${cancelId}/cancel`, {
          actorId: 'ui-user',
        });
        toast('Cancelled', '', 'warn');
        await refresh();
      } catch (e) {
        toast('Cancel failed', e.message, 'bad');
      }
    }
    if (empSync) {
      try {
        const r = await api('POST', `/admin/sync/employee/${empSync}`);
        toast(
          'Reconciled',
          `scanned=${r.scanned} updated=${r.updated}`,
          'good',
        );
        await refresh();
      } catch (e) {
        toast('Sync failed', e.message, 'bad');
      }
    }
  });

  $('#flush-btn').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/admin/outbox/flush');
      toast(
        'Outbox flushed',
        `succeeded=${r.succeeded} retried=${r.retried} dead=${r.dead}`,
        r.dead ? 'bad' : 'good',
      );
      await refresh();
    } catch (e) {
      toast('Flush failed', e.message, 'bad');
    }
  });

  $('#full-sync-btn').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/admin/sync/full');
      toast(
        'Full sync complete',
        `scanned=${r.scanned} updated=${r.updated} unchanged=${r.unchanged}`,
        'good',
      );
      await refresh();
    } catch (e) {
      toast('Sync failed', e.message, 'bad');
    }
  });

  $('#fail-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/mock-hcm/admin/failures', {
        fileTimeOffTransientUntil: 3,
      });
      toast(
        'HCM outage injected',
        'Next 3 file-time-off attempts return 503',
        'warn',
      );
    } catch (e) {
      toast('Inject failed', e.message, 'bad');
    }
  });

  $('#recover-btn').addEventListener('click', async () => {
    try {
      await api('POST', '/mock-hcm/admin/failures', {
        fileTimeOffTransientUntil: 0,
        fileTimeOffPermanent: false,
      });
      toast('HCM healed', 'Failure modes cleared', 'good');
    } catch (e) {
      toast('Heal failed', e.message, 'bad');
    }
  });

  $('#bonus-btn').addEventListener('click', async () => {
    try {
      const empId = $('#bonus-employee').value;
      const emp = state.employees.find((e) => e.id === empId);
      if (!emp) throw new Error('Pick an employee');
      const balances = state.balancesByEmp[empId] || [];
      const leaveType = $('#bonus-leave-type').value;
      const target = balances.find((b) => b.leaveType === leaveType);
      if (!target) throw new Error(`No ${leaveType} balance for ${emp.name}`);
      const minutes = Number($('#bonus-minutes').value);
      const hcmLoc = `wd-${target.locationId}`;
      const bumped = await api('POST', '/mock-hcm/admin/bump-balance', {
        hcmEmployeeId: emp.hcm_employee_id,
        hcmLocationId: hcmLoc,
        leaveType,
        deltaMinutes: minutes,
      });
      await api('POST', '/webhooks/hcm/balance-updated', {
        hcmEmployeeId: emp.hcm_employee_id,
        hcmLocationId: hcmLoc,
        leaveType,
        balanceMinutes: bumped.balanceMinutes,
        version: bumped.version,
        occurredAt: new Date().toISOString(),
      });
      toast(
        'Anniversary bonus applied',
        `${emp.name} +${minutes}m ${leaveType}`,
        'good',
      );
      await refresh();
    } catch (e) {
      toast('Bonus failed', e.message, 'bad');
    }
  });

  $('#ledger-employee').addEventListener('change', async (e) => {
    state.ledgerEmpId = e.target.value;
    await refresh();
  });

  $('#clear-log').addEventListener('click', () => {
    $('#log').innerHTML = '';
  });

  // ---------- Boot ----------
  // Sensible default dates
  const t = new Date();
  t.setDate(t.getDate() + 14);
  const t2 = new Date(t);
  t2.setDate(t2.getDate() + 1);
  $('input[name=startDate]').value = t.toISOString().slice(0, 10);
  $('input[name=endDate]').value = t2.toISOString().slice(0, 10);

  refresh();
  setInterval(refresh, 4000);
})();
