// Auth Functions
async function register(event) {
    event.preventDefault();
    
    const username = document.getElementById('username').value;
    const email = document.getElementById('email').value;
    const phone = document.getElementById('phone').value;
    const password = document.getElementById('password').value;
    
    // Validate Nigerian phone number
    const phoneRegex = /^(\+234|0)[789][01]\d{8}$/;
    if (!phoneRegex.test(phone)) {
        showMessage('registerMessage', 'Please enter a valid Nigerian phone number (e.g., 08012345678)', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, phone, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showMessage('registerMessage', 'Registration successful! Redirecting...', 'success');
            setTimeout(() => {
                window.location.href = '/dashboard';
            }, 1500);
        } else {
            showMessage('registerMessage', data.error || 'Registration failed', 'error');
        }
    } catch (error) {
        showMessage('registerMessage', 'Network error. Please try again.', 'error');
    }
}

async function login(event) {
    event.preventDefault();
    
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showMessage('loginMessage', 'Login successful! Redirecting...', 'success');
            setTimeout(() => {
                window.location.href = '/dashboard';
            }, 1500);
        } else {
            showMessage('loginMessage', data.error || 'Login failed', 'error');
        }
    } catch (error) {
        showMessage('loginMessage', 'Network error. Please try again.', 'error');
    }
}

async function logout() {
    try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/';
    } catch (error) {
        console.error('Logout error:', error);
    }
}

// Dashboard Functions
async function loadDashboard() {
    try {
        // Load user profile
        const profileResponse = await fetch('/api/user/profile');
        const user = await profileResponse.json();
        
        if (user.id) {
            document.getElementById('username').textContent = user.username;
            document.getElementById('balance').textContent = `₦${user.balance || 0}`;
            document.getElementById('tasksCompleted').textContent = user.tasksCompleted || 0;
            document.getElementById('referralCode').textContent = user.referralCode || '-';
            
            // Load tasks
            loadTasks();
        } else {
            window.location.href = '/login';
        }
    } catch (error) {
        console.error('Error loading dashboard:', error);
        window.location.href = '/login';
    }
}

async function loadTasks() {
    try {
        const response = await fetch('/api/tasks');
        const tasks = await response.json();
        
        const container = document.getElementById('tasksContainer');
        container.innerHTML = '';
        
        if (tasks.length === 0) {
            container.innerHTML = '<p class="no-tasks">No tasks available at the moment. Check back soon!</p>';
            return;
        }
        
        tasks.forEach(task => {
            const taskCard = document.createElement('div');
            taskCard.className = `task-card ${task.completed ? 'completed' : ''}`;
            
            taskCard.innerHTML = `
                <div class="task-header">
                    <span class="task-title">${task.title}</span>
                    <span class="task-reward">₦${task.reward}</span>
                </div>
                <span class="task-category">${task.category}</span>
                <p class="task-description">${task.description}</p>
                <div class="task-actions">
                    ${task.link ? `<a href="${task.link}" target="_blank" class="task-link">View Task</a>` : ''}
                    ${!task.completed ? 
                        `<button onclick="completeTask(${task.id})" class="btn btn-success">Complete Task</button>` :
                        `<span class="task-completed">✅ Completed</span>`
                    }
                </div>
                <small>${task.instructions}</small>
            `;
            
            container.appendChild(taskCard);
        });
    } catch (error) {
        console.error('Error loading tasks:', error);
        document.getElementById('tasksContainer').innerHTML = '<p class="error">Failed to load tasks. Please refresh.</p>';
    }
}

async function completeTask(taskId) {
    if (!confirm('Confirm you have completed this task?')) return;
    
    try {
        const response = await fetch(`/api/tasks/${taskId}/complete`, {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (response.ok) {
            alert(`✅ Task completed! You earned ₦${data.reward}`);
            loadTasks(); // Refresh tasks
            loadDashboard(); // Refresh balance
        } else {
            alert(data.error || 'Failed to complete task');
        }
    } catch (error) {
        alert('Network error. Please try again.');
    }
}

async function withdraw(event) {
    event.preventDefault();
    
    const amount = parseInt(document.getElementById('withdrawAmount').value);
    const bankName = document.getElementById('bankName').value;
    const accountNumber = document.getElementById('accountNumber').value;
    
    if (!amount || amount < 100) {
        showMessage('withdrawMessage', 'Minimum withdrawal is ₦100', 'error');
        return;
    }
    
    if (!bankName) {
        showMessage('withdrawMessage', 'Please select a bank', 'error');
        return;
    }
    
    if (accountNumber.length !== 10 || !/^\d{10}$/.test(accountNumber)) {
        showMessage('withdrawMessage', 'Please enter a valid 10-digit account number', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, bankName, accountNumber })
        });
        
        const data = await response.json();
        
        if (response.ok) {
            showMessage('withdrawMessage', 
                `✅ Withdrawal of ₦${amount} to ${bankName} (${accountNumber}) submitted successfully!`, 
                'success'
            );
            document.getElementById('withdrawForm').reset();
            loadDashboard(); // Refresh balance
        } else {
            showMessage('withdrawMessage', data.error || 'Withdrawal failed', 'error');
        }
    } catch (error) {
        showMessage('withdrawMessage', 'Network error. Please try again.', 'error');
    }
}

// Utility Functions
function showMessage(elementId, message, type) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    element.textContent = message;
    element.className = `message-${type}`;
    element.style.display = 'block';
    
    setTimeout(() => {
        element.style.display = 'none';
    }, 5000);
}

// Event Listeners
document.addEventListener('DOMContentLoaded', function() {
    // Auth forms
    const registerForm = document.getElementById('registerForm');
    if (registerForm) {
        registerForm.addEventListener('submit', register);
    }
    
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', login);
    }
    
    // Withdraw form
    const withdrawForm = document.getElementById('withdrawForm');
    if (withdrawForm) {
        withdrawForm.addEventListener('submit', withdraw);
    }
    
    // Load dashboard if on dashboard page
    if (window.location.pathname.includes('dashboard')) {
        loadDashboard();
    }
});