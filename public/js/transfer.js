// ================= TRANSFER PAGE =================
let pendingTransfer = null;
let transferAdInterval = null;
let isWindowOpen = false;

document.addEventListener('DOMContentLoaded', async () => {
    const user = Auth.requireAuth();
    if (!user) return;

    // Fill username
    const usernameEl = document.getElementById('username');
    if (usernameEl) usernameEl.textContent = user.username;

    // Load balance
    try {
        const res = await fetch(`/api/user/${user.id}`);
        const data = await res.json();
        if (res.ok) {
            const balEl = document.getElementById('balance');
            if (balEl) balEl.textContent = `₦${(data.balance || 0).toLocaleString()}`;
            Auth.setUser(data);
        }
    } catch {}

    // Check window
    await loadWindowStatus();

    // Load history
    loadTransferHistory();

    // Wire form
    const form = document.getElementById('transferForm');
    if (form) form.addEventListener('submit', handleTransferSubmit);

    // Wire modal buttons
    const confirmBtn = document.getElementById('confirmTransferBtn');
    const cancelBtn = document.getElementById('cancelTransferBtn');
    if (confirmBtn) confirmBtn.onclick = () => submitTransfer();
    if (cancelBtn) cancelBtn.onclick = () => {
        if (transferAdInterval) {
            clearInterval(transferAdInterval);
            transferAdInterval = null;
        }
        closeTransferModal();
        pendingTransfer = null;
    };
});

async function loadWindowStatus() {
    const banner = document.getElementById('windowBanner');
    const statusText = document.getElementById('windowStatusText');
    const subText = document.getElementById('windowSubText');
    const transferBtn = document.getElementById('transferBtn');

    try {
        const res = await fetch('/api/withdraw/window');
        const data = await res.json();
        isWindowOpen = data.open;

        if (data.open) {
            banner.classList.add('window-open');
            banner.classList.remove('window-closed');
            statusText.textContent = 'Transfer window is OPEN';
            subText.textContent = 'You can transfer from your balance until the 5th of this month.';
            if (transferBtn) transferBtn.disabled = false;
        } else {
            banner.classList.add('window-closed');
            banner.classList.remove('window-open');
            statusText.textContent = 'Transfer window is CLOSED';
            subText.textContent = `Next window opens on ${data.nextWindowLabel}.`;
            if (transferBtn) {
                transferBtn.disabled = true;
                transferBtn.textContent = 'Transfers closed until ' + data.nextWindowLabel;
            }
        }
    } catch {
        statusText.textContent = 'Could not verify transfer window';
        subText.textContent = 'Please try again later.';
    }
}

function handleTransferSubmit(event) {
    event.preventDefault();

    if (!isWindowOpen) {
        showMessage('transferMessage', 'Transfers are only available from the 1st to the 5th of each month.', 'error');
        return;
    }

    const user = Auth.getUser();
    if (!user) return;

    const amount = parseInt(document.getElementById('transferAmount').value);
    const bankName = document.getElementById('bankName').value;
    const accountNumber = document.getElementById('accountNumber').value.trim();
    const accountName = document.getElementById('accountName').value.trim();

    if (!amount || amount < 100) {
        return showMessage('transferMessage', 'Minimum transfer is ₦100', 'error');
    }
    if (amount > (user.balance || 0)) {
        return showMessage('transferMessage', 'Amount exceeds your balance', 'error');
    }
    if (!bankName) {
        return showMessage('transferMessage', 'Please select a bank', 'error');
    }
    if (!/^\d{10}$/.test(accountNumber)) {
        return showMessage('transferMessage', 'Account number must be 10 digits', 'error');
    }
    if (accountName.length < 3) {
        return showMessage('transferMessage', 'Please enter your account name', 'error');
    }

    pendingTransfer = { userId: user.id, amount, bankName, accountNumber, accountName };
    openTransferModal();
}

function openTransferModal() {
    const modal = document.getElementById('transferAdModal');
    if (!modal) return submitTransfer();

    const timerEl = document.getElementById('transferTimer');
    const confirmBtn = document.getElementById('confirmTransferBtn');

    modal.classList.add('open');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirm Transfer';
    timerEl.classList.remove('timer-ready');

    // Tell server the user started watching the ad
    fetch('/api/withdraw/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: Auth.getUser().id })
    }).catch(() => {});

    let remaining = 600;

    const format = (s) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${String(sec).padStart(2, '0')}`;
    };

    timerEl.textContent = format(remaining);

    if (transferAdInterval) clearInterval(transferAdInterval);
    transferAdInterval = setInterval(() => {
        remaining--;
        timerEl.textContent = format(remaining);

        if (remaining <= 0) {
            clearInterval(transferAdInterval);
            transferAdInterval = null;
            timerEl.textContent = '✅ Unlocked';
            timerEl.classList.add('timer-ready');
            confirmBtn.disabled = false;
        }
    }, 1000);
}

function closeTransferModal() {
    const modal = document.getElementById('transferAdModal');
    if (modal) modal.classList.remove('open');
    const timerEl = document.getElementById('transferTimer');
    if (timerEl) timerEl.classList.remove('timer-ready');
    if (transferAdInterval) {
        clearInterval(transferAdInterval);
        transferAdInterval = null;
    }
}

async function submitTransfer() {
    if (!pendingTransfer) return;

    const confirmBtn = document.getElementById('confirmTransferBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Submitting…';
    }

    try {
        // Server expects /api/withdraw with { userId, amount, bankName, accountNumber }
        // We'll pass accountName as an extra field the server can store.
        const payload = { ...pendingTransfer };
        delete payload.accountName; // server doesn't know this field yet — optional

        const res = await fetch('/api/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        closeTransferModal();

        if (res.ok) {
            showMessage(
                'transferMessage',
                `✅ Transfer of ₦${data.amount.toLocaleString()} to ${data.bankName} (${data.accountNumber}) submitted. You'll receive it within 48 hours.`,
                'success'
            );
            document.getElementById('transferForm').reset();
            // Refresh balance
            const user = Auth.getUser();
            const balRes = await fetch(`/api/user/${user.id}`);
            const balData = await balRes.json();
            if (balRes.ok) {
                document.getElementById('balance').textContent = `₦${(balData.balance || 0).toLocaleString()}`;
                Auth.setUser(balData);
            }
            loadTransferHistory();
        } else {
            showMessage('transferMessage', data.error || 'Transfer failed', 'error');
        }
    } catch {
        closeTransferModal();
        showMessage('transferMessage', 'Network error. Please try again.', 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.textContent = 'Confirm Transfer';
            confirmBtn.disabled = true;
        }
        pendingTransfer = null;
    }
}

async function loadTransferHistory() {
    const container = document.getElementById('transferHistory');
    if (!container) return;

    const user = Auth.getUser();
    if (!user) return;

    try {
        const res = await fetch(`/api/withdrawals/${user.id}`);
        const list = await res.json();

        if (!res.ok || !list.length) {
            container.innerHTML = '<p class="empty-state">No transfers yet.</p>';
            return;
        }

        container.innerHTML = list.map(w => `
            <div class="withdrawal-item">
                <div>
                    <strong>₦${w.amount.toLocaleString()}</strong>
                    <span class="withdrawal-bank">${escapeHtml(w.bankName)} · ${escapeHtml(w.accountNumber)}</span>
                </div>
                <span class="withdrawal-status status-${w.status}">${escapeHtml(w.status)}</span>
            </div>
        `).join('');
    } catch {
        container.innerHTML = '<p class="empty-state">Could not load history.</p>';
    }
}

function showMessage(elementId, message, type) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = `message message-${type}`;
    el.style.display = 'block';
    setTimeout(() => (el.style.display = 'none'), 6000);
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}