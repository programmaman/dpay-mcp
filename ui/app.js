/**
 * Demo UI Client
 *
 * Connects to the WebSocket server and renders demo events into
 * the three-column dashboard in real time.
 */

(function () {
  'use strict';

  // ─── DOM refs ────────────────────────────────────────────────────────────

  const chatFeed = document.getElementById('chat-feed');
  const escrowCard = document.getElementById('escrow-card');
  const timelineFeed = document.getElementById('timeline-feed');
  const activityFeed = document.getElementById('activity-feed');
  const statusBadge = document.getElementById('status-badge');

  // ─── State ───────────────────────────────────────────────────────────────

  let escrowState = null;       // latest payment data
  let thinkingTimers = {};      // agent -> setTimeout ID

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function timestamp() {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  }

  function shortenAddr(addr) {
    if (!addr || typeof addr !== 'string') return addr;
    if (addr.length <= 14) return addr;
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  function esc(summary) {
    const div = document.createElement('div');
    div.textContent = summary;
    return div.innerHTML;
  }

  // ─── Renderers ───────────────────────────────────────────────────────────

  function addChatMessage(agent, content, time) {
    const card = document.createElement('div');
    card.className = `msg-card ${agent}`;
    card.innerHTML = `
      <div class="msg-agent">${agent === 'pm' ? '🟦 PM' : '🟧 Developer'}</div>
      <div class="msg-text">${esc(content)}</div>
      <div class="msg-time">${time}</div>
    `;
    chatFeed.appendChild(card);
    chatFeed.scrollTop = chatFeed.scrollHeight;
  }

  function addToolCard(agent, tool, args, result, isError, time) {
    const card = document.createElement('div');
    card.className = 'tool-card';
    card.innerHTML = `
      <div class="tool-name">⚡ ${tool}</div>
      <div class="tool-args">by ${agent} · ${JSON.stringify(args)}</div>
      ${result ? `<div class="tool-result ${isError ? 'error' : ''}">${esc(typeof result === 'string' ? result : JSON.stringify(result, null, 2))}</div>` : ''}
      <div class="msg-time" style="margin-top:0.15rem">${time}</div>
    `;
    chatFeed.appendChild(card);
    chatFeed.scrollTop = chatFeed.scrollHeight;
  }

  function setThinking(agent, active) {
    const id = `thinking-${agent}`;
    const existing = document.getElementById(id);

    if (!active) {
      if (existing) existing.remove();
      return;
    }

    if (existing) return; // already shown

    const el = document.createElement('div');
    el.id = id;
    el.className = 'thinking-indicator';
    el.textContent = `${agent === 'BUYER' ? '🟦 PM' : '🟧 Developer'} is thinking...`;
    chatFeed.appendChild(el);
    chatFeed.scrollTop = chatFeed.scrollHeight;
  }

  function updateEscrow(state) {
    escrowState = state;

    if (!state || state.status === 'pending') {
      escrowCard.innerHTML = '<div class="escrow-empty">Waiting for payment creation...</div>';
      return;
    }

    const statusClass = state.status === 'settled' ? 'settled'
      : state.status === 'disputed' ? 'disputed'
      : 'active';

    escrowCard.innerHTML = `
      <div class="escrow-detail">
        <div class="field">
          <span class="field-label">Status</span>
          <span class="status-badge-detail ${statusClass}">${state.status ?? 'active'}</span>
        </div>
        <div class="field">
          <span class="field-label">Contract</span>
          <span class="field-value">${shortenAddr(state.contract)}</span>
        </div>
        <div class="field">
          <span class="field-label">Amount</span>
          <span class="field-value">${state.amount ?? '—'}</span>
        </div>
        <div class="field">
          <span class="field-label">Payor</span>
          <span class="field-value">${shortenAddr(state.payor)}</span>
        </div>
        <div class="field">
          <span class="field-label">Payee</span>
          <span class="field-value">${shortenAddr(state.payee)}</span>
        </div>
        <div class="field">
          <span class="field-label">Settlement</span>
          <span class="field-value">${state.settlement ?? '—'}</span>
        </div>
        <div class="field">
          <span class="field-label">Tx Hash</span>
          <span class="field-value">${shortenAddr(state.txHash)}</span>
        </div>
      </div>
    `;
  }

  function addTimelineEvent(icon, text, time) {
    const item = document.createElement('div');
    item.className = 'timeline-item';
    item.innerHTML = `
      <span class="tl-icon">${icon}</span>
      <span class="tl-text">${text}</span>
      <span class="tl-time">${time}</span>
    `;
    timelineFeed.prepend(item); // newest at top
  }

  function addActivity(text, time) {
    const item = document.createElement('div');
    item.className = 'activity-item';
    item.innerHTML = `<span class="act-time">${time}</span>${esc(text)}`;
    activityFeed.prepend(item);
  }

  // ─── Event dispatcher ────────────────────────────────────────────────────

  function handleEvent(data) {
    const t = formatTime(data.timestamp);

    switch (data.type) {

      case 'agent_thinking':
        setThinking(data.agent, true);
        addActivity(`${data.agent} thinking…`, t);
        break;

      case 'agent_message': {
        setThinking(data.agent, false);
        addChatMessage(data.agent, data.content, t);
        addActivity(`${data.agent === 'pm' ? 'PM' : 'Developer'} sent message`, t);
        break;
      }

      case 'tool_called': {
        addToolCard(data.agent, data.tool, data.args, null, false, t);
        addActivity(`Tool: ${data.tool}`, t);
        break;
      }

      case 'tool_result': {
        // Update the last tool card in chat with the result
        const toolCards = chatFeed.querySelectorAll('.tool-card');
        const lastCard = toolCards[toolCards.length - 1];
        if (lastCard) {
          const resultDiv = lastCard.querySelector('.tool-result');
          if (!resultDiv) {
            const div = document.createElement('div');
            div.className = `tool-result ${data.success ? '' : 'error'}`;
            div.textContent = typeof data.result === 'string'
              ? data.result
              : JSON.stringify(data.result, null, 2);
            lastCard.appendChild(div);
          }
        }
        const emoji = data.success ? '✅' : '❌';
        addActivity(`${emoji} ${data.tool} ${data.success ? 'succeeded' : 'failed'}`, t);
        break;
      }

      case 'blockchain_event': {
        const ev = data.event;
        const p = data.payload ?? {};

        switch (ev) {
          case 'payment_created': {
            const payor = p.payor ?? p.yourWallet ?? '—';
            const payee = p.payee ?? '—';
            const amount = p.grossAmountWei ?? p.amount ?? '—';
            const contract = p.paymentAddress ?? '—';
            const txHash = p.txHash ?? '—';

            updateEscrow({
              status: 'active',
              contract,
              amount,
              payor,
              payee,
              settlement: '1 day',
              txHash,
            });

            addTimelineEvent('💰', 'Payment Created', t);
            addTimelineEvent('📄', 'Contract Funded', t);
            addActivity('💰 Payment created on-chain', t);
            break;
          }

          case 'payment_verified': {
            addTimelineEvent('🔍', 'Developer Verified Payment', t);
            addActivity('🔍 Payment verified by payee', t);
            break;
          }

          case 'payment_settled': {
            updateEscrow({ ...escrowState, status: 'settled' });
            addTimelineEvent('✅', 'Settled — Funds Released', t);
            addActivity('✅ Payment settled', t);
            break;
          }

          case 'dispute_raised': {
            updateEscrow({ ...escrowState, status: 'disputed' });
            addTimelineEvent('⚠️', '⚠️ Dispute Raised', t);
            addActivity('⚠️ Dispute raised', t);
            break;
          }
        }
        break;
      }
    }
  }

  // ─── WebSocket connection ────────────────────────────────────────────────

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;

    statusBadge.textContent = '⏳ Connecting...';
    statusBadge.className = 'status-badge';

    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      statusBadge.textContent = '✅ Connected';
      statusBadge.className = 'status-badge connected';
      addActivity('📡 Connected to demo server', timestamp());
    };

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        handleEvent(data);
      } catch (err) {
        console.warn('Failed to parse event:', err);
      }
    };

    ws.onerror = () => {
      statusBadge.textContent = '❌ Connection error';
      statusBadge.className = 'status-badge error';
    };

    ws.onclose = () => {
      statusBadge.textContent = '🔌 Disconnected — retrying...';
      statusBadge.className = 'status-badge error';
      addActivity('🔌 Disconnected, retrying in 3s…', timestamp());
      setTimeout(connect, 3000);
    };
  }

  // ─── Start ───────────────────────────────────────────────────────────────

  connect();

})();
