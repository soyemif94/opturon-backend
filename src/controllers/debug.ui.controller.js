const crypto = require('crypto');
const env = require('../config/env');

function isDebugKeyMatch(provided, expected) {
  const providedBuffer = Buffer.from(String(provided || ''), 'utf-8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf-8');
  return (
    providedBuffer.length === expectedBuffer.length &&
    providedBuffer.length > 0 &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

function renderInboxHtml() {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ClinicAI Debug Inbox</title>
  <style>
    :root { --bg:#f5f7fb; --card:#fff; --border:#d9e1ee; --text:#0f172a; --muted:#475569; }
    body { margin:0; font-family: Arial, sans-serif; background:var(--bg); color:var(--text); }
    .topbar { padding:10px 12px; border-bottom:1px solid var(--border); background:#fff; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .topbar input, .topbar select, .topbar button { padding:7px 8px; border:1px solid var(--border); border-radius:6px; }
    .layout { display:flex; min-height:calc(100vh - 56px); }
    .left { width:42%; min-width:360px; border-right:1px solid var(--border); overflow:auto; }
    .right { flex:1; overflow:auto; }
    .panel { padding:10px; }
    .item { border:1px solid var(--border); background:var(--card); border-radius:8px; padding:10px; margin-bottom:8px; cursor:pointer; }
    .item.active { outline:2px solid #0ea5e9; }
    .row { display:flex; justify-content:space-between; gap:8px; }
    .small { font-size:12px; color:var(--muted); }
    .badge { font-size:11px; border-radius:999px; padding:2px 8px; border:1px solid var(--border); }
    .badge.high { background:#fee2e2; color:#7f1d1d; border-color:#fecaca; }
    .badge.normal { background:#fef3c7; color:#78350f; border-color:#fde68a; }
    .badge.low { background:#dcfce7; color:#14532d; border-color:#bbf7d0; }
    .box { border:1px solid var(--border); background:var(--card); border-radius:8px; padding:10px; margin-bottom:10px; }
    .actions input, .actions textarea, .actions button { width:100%; margin:5px 0; padding:8px; border:1px solid var(--border); border-radius:6px; box-sizing:border-box; }
    .actions textarea { min-height:66px; resize:vertical; }
    pre { background:#0b1220; color:#cbd5e1; padding:8px; border-radius:8px; overflow:auto; }
    .messages { max-height:300px; overflow:auto; border:1px solid var(--border); border-radius:6px; }
    .msg { padding:6px 8px; border-bottom:1px solid var(--border); }
    .msg:last-child { border-bottom:none; }
  </style>
</head>
<body>
  <div class="topbar">
    <strong>ClinicAI Inbox</strong>
    <input id="debugKey" placeholder="x-debug-key" />
    <select id="priority">
      <option value="">priority: all</option>
      <option value="high">high</option>
      <option value="normal">normal</option>
      <option value="low">low</option>
    </select>
    <select id="hasTime">
      <option value="">hasTime: all</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
    <select id="timeWindow">
      <option value="">timeWindow: all</option>
      <option value="morning">morning</option>
      <option value="afternoon">afternoon</option>
      <option value="evening">evening</option>
    </select>
    <input id="searchQ" placeholder="buscar (name, waId, texto)" />
    <button id="refreshBtn">Refresh</button>
    <span id="status" class="small"></span>
  </div>

  <div class="layout">
    <div class="left">
      <div class="panel">
        <div id="list"></div>
      </div>
    </div>
    <div class="right">
      <div class="panel">
        <div class="box">
          <strong>Detalle</strong>
          <div id="detailMeta" class="small" style="margin-top:8px"></div>
          <div style="margin-top:8px; display:flex; gap:8px;">
            <button id="copyWaBtn" style="padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:#fff;">Copy waId</button>
            <button id="copyConversationBtn" style="padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:#fff;">Copy conversationId</button>
          </div>
        </div>
        <div class="box">
          <strong>Mensajes</strong>
          <div id="messages" class="messages"></div>
        </div>
        <div class="box">
          <div class="row" style="align-items:center;">
            <strong>IA (ultimo outbound)</strong>
            <button id="viewAiAuditBtn" style="padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:#fff;">Ver auditoria IA</button>
          </div>
          <div id="aiMeta" class="small" style="margin-top:8px">Sin datos de IA todavia.</div>
          <div id="aiAuditList" style="margin-top:10px"></div>
          <div style="margin-top:8px;">
            <button id="copyAiAuditBtn" style="padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:#fff;">Copy JSON</button>
          </div>
        </div>
        <div class="box actions">
          <strong>Acciones</strong>
          <input id="confirmedText" placeholder="confirmedText (ej: lunes 10:30)" />
          <textarea id="confirmMessage" placeholder="mensaje custom confirmar (opcional)"></textarea>
          <button id="confirmBtn">Confirmar</button>
          <textarea id="rejectMessage" placeholder="mensaje rechazo (opcional)"></textarea>
          <button id="rejectBtn">Rechazar</button>
          <input id="rescheduleProposed" placeholder="propuesta reprogramación (ej: martes 11:00)" />
          <textarea id="rescheduleMessage" placeholder="mensaje reprogramación (opcional)"></textarea>
          <button id="rescheduleBtn">Reprogramar</button>
        </div>
        <div class="box">
          <strong>Respuesta servidor</strong>
          <pre id="serverResp">{}</pre>
        </div>
        <div class="box">
          <strong>Sugerencias</strong>
          <div class="small" style="margin-top:6px">Elegí una opción para proponerle al paciente.</div>
          <div id="suggestions" class="small">Sin sugerencias.</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    (function () {
      var qs = new URLSearchParams(window.location.search);
      var keyFromQuery = qs.get('k');
      var keyInput = document.getElementById('debugKey');
      var statusEl = document.getElementById('status');
      var listEl = document.getElementById('list');
      var detailMetaEl = document.getElementById('detailMeta');
      var messagesEl = document.getElementById('messages');
      var aiMetaEl = document.getElementById('aiMeta');
      var aiAuditListEl = document.getElementById('aiAuditList');
      var serverRespEl = document.getElementById('serverResp');
      var suggestionsEl = document.getElementById('suggestions');
      var copyWaBtn = document.getElementById('copyWaBtn');
      var copyConversationBtn = document.getElementById('copyConversationBtn');
      var viewAiAuditBtn = document.getElementById('viewAiAuditBtn');
      var copyAiAuditBtn = document.getElementById('copyAiAuditBtn');
      var selectedConversationId = null;
      var lastItems = [];
      var lastAiAuditPayload = null;
      var selectedMeta = { waId: null, name: null, candidateDisplay: null, conversationId: null };

      if (keyFromQuery) {
        localStorage.setItem('debugKey', keyFromQuery);
        if (window.history && window.history.replaceState) {
          window.history.replaceState({}, '', '/debug/ui/inbox');
        }
      }
      keyInput.value = localStorage.getItem('debugKey') || '';
      keyInput.addEventListener('change', function () {
        localStorage.setItem('debugKey', keyInput.value.trim());
      });

      function getDebugKey() {
        var key = (localStorage.getItem('debugKey') || '').trim();
        if (!key) throw new Error('Ingresá x-debug-key');
        return key;
      }

      async function apiFetch(path, options) {
        var opts = options || {};
        var headers = Object.assign({}, opts.headers || {}, { 'x-debug-key': getDebugKey() });
        if (!headers['Content-Type'] && opts.body) headers['Content-Type'] = 'application/json';
        var res = await fetch(path, Object.assign({}, opts, { headers: headers }));
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) {
          throw new Error((data && data.error) ? data.error : ('HTTP ' + res.status));
        }
        return data;
      }

      function showCopied(button, originalText) {
        var prev = button.textContent;
        button.textContent = 'Copied!';
        setTimeout(function () { button.textContent = originalText || prev; }, 1200);
      }

      async function copyTextSafe(text) {
        var value = String(text || '').trim();
        if (!value) throw new Error('No hay valor para copiar');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          return;
        }
        var ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try {
          document.execCommand('copy');
        } finally {
          document.body.removeChild(ta);
        }
      }

      function badge(priority) {
        var p = String(priority || 'low').toLowerCase();
        return '<span class="badge ' + p + '">' + p + '</span>';
      }

      function renderList(items) {
        lastItems = items || [];
        if (!lastItems.length) {
          listEl.innerHTML = '<div class="small">Sin items.</div>';
          return;
        }

        listEl.innerHTML = lastItems.map(function (item) {
          var active = selectedConversationId === item.conversationId ? 'active' : '';
          return '<div class="item ' + active + '" data-id="' + item.conversationId + '">' +
            '<div class="row"><div><strong>' + (item.name || '(sin nombre)') + '</strong></div><div>' + badge(item.priority) + '</div></div>' +
            '<div class="small">' + (item.waId || '-') + '</div>' +
            '<div style="margin-top:4px">' + (item.candidateDisplay || '-') + '</div>' +
            '<div class="small">age: ' + String(item.ageMinutes || 0) + 'm · status: ' + (item.status || '-') + '</div>' +
            '</div>';
        }).join('');

        Array.prototype.forEach.call(listEl.querySelectorAll('.item'), function (el) {
          el.addEventListener('click', function () {
            selectedConversationId = el.getAttribute('data-id');
            loadDetail(selectedConversationId).catch(showErr);
            renderList(lastItems);
          });
        });
      }

      function renderMessages(messages) {
        var list = messages || [];
        if (!list.length) {
          messagesEl.innerHTML = '<div class="msg small">Sin mensajes</div>';
          return;
        }
        messagesEl.innerHTML = list.map(function (m) {
          return '<div class="msg"><div class="small">' + (m.direction || '-') + ' · ' + (m.createdAt || '-') + '</div><div>' + (m.text || '-') + '</div></div>';
        }).join('');
      }

      function formatUsage(usage) {
        if (!usage || typeof usage !== 'object') return '-';
        var prompt = usage.prompt_tokens != null ? usage.prompt_tokens : '-';
        var completion = usage.completion_tokens != null ? usage.completion_tokens : '-';
        var total = usage.total_tokens != null ? usage.total_tokens : '-';
        return 'p:' + prompt + ' c:' + completion + ' t:' + total;
      }

      function renderAiMeta(item) {
        if (!item || !item.ai) {
          aiMetaEl.innerHTML = 'Sin datos de IA todavia.';
          return;
        }
        var ai = item.ai || {};
        aiMetaEl.innerHTML =
          '<div><strong>enabled:</strong> ' + String(!!ai.enabled) + '</div>' +
          '<div><strong>attempted:</strong> ' + String(!!ai.attempted) + '</div>' +
          '<div><strong>used:</strong> ' + String(!!ai.used) + '</div>' +
          '<div><strong>fallbackUsed:</strong> ' + String(!!ai.fallbackUsed) + '</div>' +
          '<div><strong>skipReason:</strong> ' + (ai.skipReason || '-') + '</div>' +
          '<div><strong>model:</strong> ' + (ai.model || '-') + '</div>' +
          '<div><strong>usage:</strong> ' + formatUsage(ai.usage) + '</div>' +
          '<div><strong>createdAt:</strong> ' + (item.createdAt || '-') + '</div>';
      }

      function renderAiAuditList(items) {
        var list = Array.isArray(items) ? items : [];
        if (!list.length) {
          aiAuditListEl.innerHTML = '<div class="small">Sin registros de auditoria IA.</div>';
          return;
        }
        aiAuditListEl.innerHTML = list.map(function (it) {
          var ai = it.ai || {};
          return '<div class="msg">' +
            '<div class="small">' + (it.createdAt || '-') + '</div>' +
            '<div><strong>used:</strong> ' + String(!!ai.used) +
            ' · <strong>fallback:</strong> ' + String(!!ai.fallbackUsed) +
            ' · <strong>skip:</strong> ' + (ai.skipReason || '-') +
            ' · <strong>model:</strong> ' + (ai.model || '-') + '</div>' +
            '</div>';
        }).join('');
      }

      async function loadAiMetaLatest(conversationId) {
        try {
          var resp = await apiFetch('/debug/ai/audit?conversationId=' + encodeURIComponent(conversationId) + '&limit=1');
          var items = (resp && resp.items) ? resp.items : [];
          renderAiMeta(items.length ? items[0] : null);
        } catch (err) {
          renderAiMeta(null);
          setServerResp({ success: false, stage: 'ai_meta_latest', error: err.message || String(err) });
        }
      }

      async function loadAiAudit(conversationId, limit) {
        var safeLimit = Number(limit || 20);
        var resp = await apiFetch('/debug/ai/audit?conversationId=' + encodeURIComponent(conversationId) + '&limit=' + safeLimit);
        lastAiAuditPayload = resp;
        renderAiAuditList(resp.items || []);
        return resp;
      }

      async function loadList() {
        var params = new URLSearchParams();
        params.set('sort', 'priority');
        params.set('needsHumanAction', 'true');
        params.set('includeTotal', 'false');
        params.set('limit', '50');
        var q = document.getElementById('searchQ').value.trim();
        var priority = document.getElementById('priority').value;
        var hasTime = document.getElementById('hasTime').value;
        var timeWindow = document.getElementById('timeWindow').value;
        if (q) params.set('q', q);
        if (priority) params.set('priority', priority);
        if (hasTime) params.set('hasTime', hasTime);
        if (timeWindow) params.set('timeWindow', timeWindow);

        var resp = await apiFetch('/debug/inbox/appointments?' + params.toString());
        if (resp.warnings && resp.warnings.length) {
          statusEl.textContent = resp.warnings.join(' | ');
        } else {
          statusEl.textContent = 'OK';
        }
        renderList(resp.items || []);
      }

      async function loadDetail(conversationId) {
        aiMetaEl.innerHTML = 'Cargando metadata IA...';
        aiAuditListEl.innerHTML = '<div class="small">Sin registros de auditoria IA.</div>';
        lastAiAuditPayload = null;
        renderSuggestions([]);

        var resp = await apiFetch('/debug/appointments/' + conversationId);
        var c = resp.conversation || {};
        var contact = resp.contact || {};
        var candidate = (c.context && c.context.appointmentCandidate) ? c.context.appointmentCandidate : null;
        var candidateDisplay = (candidate && candidate.rawText) ? candidate.rawText : '-';
        selectedMeta = {
          waId: contact.waId || null,
          name: contact.name || null,
          candidateDisplay: candidateDisplay,
          conversationId: c.id || conversationId
        };
        detailMetaEl.innerHTML =
          '<div><strong>conversationId:</strong> ' + (c.id || '-') + '</div>' +
          '<div><strong>status:</strong> ' + ((c.context && c.context.appointmentStatus) || '-') + '</div>' +
          '<div><strong>candidate:</strong> ' + candidateDisplay + '</div>' +
          '<div><strong>contact:</strong> ' + (contact.waId || '-') + '</div>' +
          '<div><strong>channel:</strong> ' + ((resp.channel && resp.channel.phoneNumberId) || '-') + '</div>';
        renderMessages(resp.messages || []);

        loadAiMetaLatest(conversationId).catch(function (err) {
          setServerResp({ success: false, stage: 'ai_meta_latest', error: err.message || String(err) });
        });
      }

      function setServerResp(payload) {
        serverRespEl.textContent = JSON.stringify(payload, null, 2);
      }

      function renderSuggestions(suggestions) {
        var list = Array.isArray(suggestions) ? suggestions : [];
        if (!list.length) {
          suggestionsEl.innerHTML = '<div class="small">Sin sugerencias.</div>';
          return;
        }

        suggestionsEl.innerHTML = list.map(function (slot, idx) {
          var label = slot.displayText || slot.startAt || ('slot-' + (idx + 1));
          return '' +
            '<div class="msg" style="border:1px solid var(--border); border-radius:6px; margin-bottom:6px; padding:8px;">' +
            '<div class="small">startAt: ' + (slot.startAt || '-') + '</div>' +
            '<div><strong>' + label + '</strong></div>' +
            '<button data-proposed="' + label.replace(/"/g, '&quot;') + '" style="margin-top:6px; padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:#fff;">Proponer ' + label + '</button>' +
            '</div>';
        }).join('');

        Array.prototype.forEach.call(suggestionsEl.querySelectorAll('button[data-proposed]'), function (btn) {
          btn.addEventListener('click', function () {
            var proposed = btn.getAttribute('data-proposed');
            act('reschedule', { proposed: proposed }).catch(showErr);
          });
        });
      }

      async function act(endpoint, body) {
        if (!selectedConversationId) throw new Error('Seleccioná una conversación');

        var name = selectedMeta.name || 'Paciente';
        var wa = selectedMeta.waId || '-';
        var candidateDisplay = selectedMeta.candidateDisplay || '-';
        var confirmText = '';
        if (endpoint === 'confirm') {
          confirmText = '¿Confirmar turno para ' + name + ' (waId: ' + wa + ') - ' + candidateDisplay + '?';
        } else if (endpoint === 'reject') {
          confirmText = '¿Rechazar pedido de turno de ' + name + ' (waId: ' + wa + ')?';
        } else {
          var proposed = body && body.proposed ? body.proposed : '(sin propuesta)';
          confirmText = '¿Proponer reprogramación a ' + name + ' (waId: ' + wa + ') -> ' + proposed + '?';
        }

        if (!window.confirm(confirmText)) {
          setServerResp({ success: false, skipped: true, reason: 'user_cancelled' });
          return;
        }

        var actionId = 'ui-' + Date.now();
        var resp = await apiFetch('/debug/appointments/' + selectedConversationId + '/' + endpoint, {
          method: 'POST',
          headers: { 'x-action-id': actionId },
          body: JSON.stringify(body || {})
        });
        setServerResp(resp);
        await loadList();
        await loadDetail(selectedConversationId);
        renderSuggestions(resp.suggestions || []);
      }

      function showErr(err) {
        setServerResp({ success: false, error: err.message || String(err) });
      }

      document.getElementById('refreshBtn').addEventListener('click', function () {
        loadList().catch(showErr);
      });

      document.getElementById('confirmBtn').addEventListener('click', function () {
        act('confirm', {
          confirmedText: document.getElementById('confirmedText').value.trim() || undefined,
          message: document.getElementById('confirmMessage').value.trim() || undefined
        }).catch(showErr);
      });

      document.getElementById('rejectBtn').addEventListener('click', function () {
        act('reject', {
          message: document.getElementById('rejectMessage').value.trim() || undefined
        }).catch(showErr);
      });

      document.getElementById('rescheduleBtn').addEventListener('click', function () {
        act('reschedule', {
          proposed: document.getElementById('rescheduleProposed').value.trim(),
          message: document.getElementById('rescheduleMessage').value.trim() || undefined
        }).catch(showErr);
      });

      copyWaBtn.addEventListener('click', function () {
        copyTextSafe(selectedMeta.waId || '').then(function () {
          showCopied(copyWaBtn, 'Copy waId');
        }).catch(showErr);
      });

      copyConversationBtn.addEventListener('click', function () {
        copyTextSafe(selectedMeta.conversationId || '').then(function () {
          showCopied(copyConversationBtn, 'Copy conversationId');
        }).catch(showErr);
      });

      viewAiAuditBtn.addEventListener('click', function () {
        if (!selectedConversationId) {
          setServerResp({ success: false, error: 'Seleccioná una conversación' });
          return;
        }
        loadAiAudit(selectedConversationId, 20).then(function (resp) {
          setServerResp(resp);
        }).catch(function (err) {
          setServerResp({ success: false, stage: 'ai_audit', error: err.message || String(err) });
        });
      });

      copyAiAuditBtn.addEventListener('click', function () {
        if (!lastAiAuditPayload) {
          showErr(new Error('Todavia no hay auditoria para copiar'));
          return;
        }
        copyTextSafe(JSON.stringify(lastAiAuditPayload, null, 2)).then(function () {
          showCopied(copyAiAuditBtn, 'Copy JSON');
        }).catch(showErr);
      });

      loadList().catch(showErr);
    })();
  </script>
</body>
</html>`;
}

function getInboxUi(req, res) {
  if (!env.whatsappDebug || !env.debugApiEnabled || !env.debugUiEnabled) {
    return res.status(404).json({ success: false, error: 'Endpoint not found' });
  }

  const provided = String(req.query.k || '').trim();
  if (!isDebugKeyMatch(provided, env.whatsappDebugKey)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  return res.status(200).type('html').send(renderInboxHtml());
}

module.exports = {
  getInboxUi
};
