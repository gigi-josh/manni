// ================= TRANSFER PAGE =================
let pendingTransfer = null;
let transferAdInterval = null;
let isWindowOpen = false;
let bankList = [];

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

    // Load banks + window in parallel
    await Promise.all([loadBanks(), loadWindowStatus()]);

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

// ================= LOAD BANKS =================
async function loadBanks() {
    const sel = document.getElementById('bankName');
    if (!sel) return;

    try {
        const res = await fetch('/api/banks');
        const banks = await res.json();

        if (!Array.isArray(banks) || !banks.length) throw new Error('No banks');

        bankList = banks;

        // Sort alphabetically by name, put popular banks first
        const priority = ['GTBank', 'Access Bank', 'First Bank', 'Zenith Bank', 'UBA', 'Opay', 'PalmPay', 'Kuda', 'Moniepoint'];
        banks.sort((a, b) => {
            const ai = priority.findIndex(p => a.name.includes(p));
            const bi = priority.findIndex(p => b.name.includes(p));
            if (ai !== -1 && bi === -1) return -1;
            if (bi !== -1 && ai === -1) return 1;
            if (ai !== -1 && bi !== -1) return ai - bi;
            return a.name.localeCompare(b.name);
        });

        sel.innerHTML = '<option value="">Select your bank</option>' +
            banks.map(b => `<option value="${escapeHtml(b.code)}" data-name="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`).join('');
    } catch (err) {
        console.error('Banks load error:', err);
        sel.innerHTML = '<option value="">Could not load banks — refresh page</option>';
    }
}

// ================= WINDOW STATUS =================
async function loadWindowStatus() {
    const banner = document.getElementById('windowBanner');
    const statusText = document.getElementById('windowStatusText');
    const subText = document.getElementById('windowSubText');
    const transferBtn = document.getElementById('transferBtn');

    if (!banner) return;

    try {
        const res = await fetch('/api/withdraw/window');
        const data = await res.json();
        isWindowOpen = data.open;

        if (data.open) {
            banner.classList.add('window-open');
            banner.classList.remove('window-closed');
            statusText.textContent = 'Transfer window is OPEN';
            subText.textContent = `You can transfer until the ${data.windowEndDay}th of this month. Minimum ₦${data.minTransfer.toLocaleString()}.`;
            if (transferBtn) transferBtn.disabled = false;
        } else {
            banner.classList.add('window-closed');
            banner.classList.remove('window-open');
            statusText.textContent = 'Transfer window is CLOSED';
            subText.textContent = `Next window opens on ${data.nextWindowLabel}.`;
            if (transferBtn) {
                transferBtn.disabled = true;
                transferBtn.innerHTML = '<i class="fas fa-lock"></i> Transfers closed';
            }
        }
    } catch {
        statusText.textContent = 'Could not verify transfer window';
        subText.textContent = 'Please refresh the page.';
    }
}

// ================= SUBMIT FORM =================
function handleTransferSubmit(event) {
    event.preventDefault();

    if (!isWindowOpen) {
        showTransferMessage('Transfers are only available from the 1st to the 5th of each month.', 'error');
        return;
    }

    const user = Auth.getUser();
    if (!user) return;

    const amount = parseInt(document.getElementById('transferAmount').value);
    const bankSelect = document.getElementById('bankName');
    const bankCode = bankSelect.value;
    const bankName = bankSelect.options[bankSelect.selectedIndex]?.dataset.name || '';
    const accountNumber = document.getElementById('accountNumber').value.trim();
    const accountName = document.getElementById('accountName').value.trim();

    // Validation
    if (!amount || amount < 2500) {
        return showTransferMessage('Minimum transfer is ₦2,500', 'error');
    }
    if (amount > (user.balance || 0)) {
        return showTransferMessage('Amount exceeds your balance', 'error');
    }
    if (!bankCode || !bankName) {
        return showTransferMessage('Please select your bank', 'error');
    }
    if (!/^\d{10}$/.test(accountNumber)) {
        return showTransferMessage('Account number must be 10 digits', 'error');
    }
    if (accountName.length < 3) {
        return showTransferMessage('Please enter your account name', 'error');
    }

    // Save payload
    pendingTransfer = {
        userId: user.id,
        amount,
        bankCode,
        bankName,
        accountNumber,
        accountName
    };

    // Open ad modal
    openTransferModal();
}

// ================= AD MODAL =================
function openTransferModal() {
    const modal = document.getElementById('transferAdModal');
    if (!modal) return submitTransfer();

    const timerEl = document.getElementById('transferTimer');
    const confirmBtn = document.getElementById('confirmTransferBtn');

    modal.classList.add('open');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirm Transfer';
    timerEl.classList.remove('timer-ready');

    // Tell server the user started watching
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

// ================= SUBMIT TO SERVER =================
async function submitTransfer() {
    if (!pendingTransfer) return;

    const confirmBtn = document.getElementById('confirmTransferBtn');
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Submitting to bank…';
    }

    try {
        const res = await fetch('/api/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: pendingTransfer.userId,
                amount: pendingTransfer.amount,
                bankName: pendingTransfer.bankName,
                bankCode: pendingTransfer.bankCode,
                accountNumber: pendingTransfer.accountNumber
                // accountName sent for display only — Flutterwave doesn't take it
            })
        });
        const data = await res.json();

        closeTransferModal();

        if (res.ok) {
            showTransferMessage(
                `✅ ₦${data.amount.toLocaleString()} transfer to ${data.bankName} (${data.accountNumber}) submitted! Funds will arrive within 24 hours.`,
                'success'
            );
            const form = document.getElementById('transferForm');
            if (form) form.reset();
            document.getElementById('bankName').value = '';

            // Refresh balance + history
            const user = Auth.getUser();
            const balRes = await fetch(`/api/user/${user.id}`);
            const balData = await balRes.json();
            if (balRes.ok) {
                document.getElementById('balance').textContent = `₦${(balData.balance || 0).toLocaleString()}`;
                Auth.setUser(balData);
            }
            loadTransferHistory();
        } else {
            showTransferMessage(data.error || 'Transfer failed', 'error');
            // Refresh balance — server may have refunded
            const user = Auth.getUser();
            const balRes = await fetch(`/api/user/${user.id}`);
            const balData = await balRes.json();
            if (balRes.ok) {
                document.getElementById('balance').textContent = `₦${(balData.balance || 0).toLocaleString()}`;
                Auth.setUser(balData);
            }
        }
    } catch {
        closeTransferModal();
        showTransferMessage('Network error. Please try again.', 'error');
    } finally {
        if (confirmBtn) {
            confirmBtn.textContent = 'Confirm Transfer';
            confirmBtn.disabled = true;
        }
        pendingTransfer = null;
    }
}

// ================= HISTORY =================
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

// ================= UTILITIES =================
function showTransferMessage(message, type) {
    const el = document.getElementById('transferMessage');
    if (!el) return;
    el.textContent = message;
    el.className = `message message-${type}`;
    el.style.display = 'block';
    setTimeout(() => (el.style.display = 'none'), 8000);
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