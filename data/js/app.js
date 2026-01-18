// TerraNurture - WebSocket Client Implementation
class TerraNurtureApp {
    constructor() {
        // WebSocket configuration
        this.wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        this.wsUrl = `${this.wsProtocol}//${window.location.hostname}:81`;
        
        // State management
        this.state = {
            sensor: {
                moisture: 0,
                raw_adc: 0,
                timestamp: 0,
                valid: false
            },
            pump: {
                active: false,
                status: 'IDLE',
                retry_count: 0,
                last_change: 0
            },
            network: {
                connected: false,
                ip: '',
                mac: '',
                gateway: '',
                subnet: '',
                dns: '',
                ssid: '',
                rssi: 0
            },
            system: {
                uptime: 0,
                free_heap: 0,
                fs_available: false,
                build_date: ''
            },
            calibration: {
                adc_dry: 4095,
                adc_wet: 1500,
                threshold: 45.0,
                target: 60.0
            },
            logs: [],
            config: {
                dry_threshold: 45.0,
                expected_value: 60.0,
                max_retries: 3,
                sampling_interval: 3000
            }
        };
        
        // WebSocket instance
        this.ws = null;
        this.reconnectInterval = 3000;
        this.maxReconnectAttempts = 5;
        this.reconnectAttempts = 0;
        
        // Chart instances
        this.moistureChart = null;
        this.memoryChart = null;
        this.calibrationChart = null;
        
        // Logs pagination
        this.currentLogPage = 1;
        this.logsPerPage = 20;
        this.filteredLogs = [];
        
        // Initialize
        this.init();
    }
    
    async init() {
        console.log('Initializing TerraNurture App...');
        this.bindEvents();
        this.initializeCharts();
        this.connectWebSocket();
        this.loadInitialData();
    }
    
    bindEvents() {
        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                this.switchPanel(item.dataset.target);
            });
        });
        
        // Dashboard Controls
        document.getElementById('manualPumpBtn').addEventListener('click', () => this.manualPump());
        document.getElementById('emergencyStopBtn').addEventListener('click', () => this.emergencyStop());
        document.getElementById('refreshBtn').addEventListener('click', () => this.fetchAllData());
        
        // Calibration
        document.getElementById('calibrateDryBtn').addEventListener('click', () => this.calibrate('dry'));
        document.getElementById('calibrateWetBtn').addEventListener('click', () => this.calibrate('wet'));
        
        // Configuration Form
        document.getElementById('configForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveConfiguration();
        });
        
        document.getElementById('resetConfigBtn').addEventListener('click', () => this.resetConfiguration());
        
        // Advanced Controls
        document.getElementById('testPump1s').addEventListener('click', () => this.testPump(1000));
        document.getElementById('testPump3s').addEventListener('click', () => this.testPump(3000));
        document.getElementById('testPump5s').addEventListener('click', () => this.testPump(5000));
        document.getElementById('clearLogsBtn').addEventListener('click', () => this.clearLogs());
        document.getElementById('restartSystemBtn').addEventListener('click', () => this.restartSystem());
        
        // Logs Panel
        document.getElementById('refreshLogsBtn').addEventListener('click', () => this.fetchLogs());
        document.getElementById('downloadLogsBtn').addEventListener('click', () => this.downloadLogs());
        document.getElementById('downloadLogsBtn2').addEventListener('click', () => this.downloadLogs());
        document.getElementById('clearLogsBtn2').addEventListener('click', () => this.clearLogs());
        document.getElementById('logFilter').addEventListener('change', () => this.filterLogs());
        document.getElementById('logSearch').addEventListener('input', () => this.filterLogs());
        document.getElementById('prevPageBtn').addEventListener('click', () => this.prevLogPage());
        document.getElementById('nextPageBtn').addEventListener('click', () => this.nextLogPage());
        
        // Quick Actions (from dashboard)
        document.querySelectorAll('#calibrateDryBtn, #calibrateWetBtn, #downloadLogsBtn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = e.target.closest('button').id;
                if (action === 'calibrateDryBtn') this.calibrate('dry');
                if (action === 'calibrateWetBtn') this.calibrate('wet');
                if (action === 'downloadLogsBtn') this.downloadLogs();
            });
        });
        
        console.log('All events bound successfully');
    }
    
    connectWebSocket() {
        try {
            console.log(`Connecting to WebSocket at ${this.wsUrl}`);
            this.ws = new WebSocket(this.wsUrl);
            
            this.ws.onopen = () => {
                console.log('WebSocket connected');
                this.reconnectAttempts = 0;
                this.updateConnectionStatus(true);
                this.showToast('Connected to system', 'success');
            };
            
            this.ws.onmessage = (event) => {
                this.handleWebSocketMessage(event.data);
            };
            
            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.updateConnectionStatus(false);
            };
            
            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                this.updateConnectionStatus(false);
                this.attemptReconnect();
            };
            
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.updateConnectionStatus(false);
        }
    }
    
    handleWebSocketMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('WebSocket message received:', message.type);
            
            switch (message.type) {
                case 'state':
                    this.updateState(message.data);
                    break;
                case 'log':
                    this.addLogEntry(message.data);
                    break;
                case 'system':
                    this.updateSystemInfo(message.data);
                    break;
                case 'calibration':
                    this.updateCalibration(message.data);
                    break;
                case 'config':
                    this.updateConfiguration(message.data);
                    break;
                case 'error':
                    this.showToast(message.message, 'error');
                    break;
                default:
                    console.warn('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Error parsing WebSocket message:', error);
        }
    }
    
    async loadInitialData() {
        try {
            // Fetch initial state via HTTP (fallback)
            const response = await fetch('/api/state');
            if (response.ok) {
                const data = await response.json();
                this.updateState(data);
            }
            
            // Fetch logs
            await this.fetchLogs();
            
            // Fetch system info
            await this.fetchSystemInfo();
            
        } catch (error) {
            console.error('Failed to load initial data:', error);
            this.showToast('Failed to load initial data', 'error');
        }
    }
    
    async fetchAllData() {
        try {
            const [stateResponse, logsResponse, systemResponse] = await Promise.all([
                fetch('/api/state'),
                fetch('/api/logs'),
                fetch('/api/system')
            ]);
            
            if (stateResponse.ok) {
                const state = await stateResponse.json();
                this.updateState(state);
            }
            
            if (logsResponse.ok) {
                const logs = await logsResponse.json();
                this.updateLogs(logs);
            }
            
            if (systemResponse.ok) {
                const system = await systemResponse.json();
                this.updateSystemInfo(system);
            }
            
            this.showToast('Data refreshed', 'success');
            
        } catch (error) {
            console.error('Failed to fetch all data:', error);
            this.showToast('Failed to refresh data', 'error');
        }
    }
    
    async fetchLogs() {
        try {
            const response = await fetch('/api/logs');
            if (response.ok) {
                const logs = await response.json();
                this.updateLogs(logs);
            }
        } catch (error) {
            console.error('Failed to fetch logs:', error);
        }
    }
    
    async fetchSystemInfo() {
        try {
            const response = await fetch('/api/system');
            if (response.ok) {
                const system = await response.json();
                this.updateSystemInfo(system);
            }
        } catch (error) {
            console.error('Failed to fetch system info:', error);
        }
    }
    
    updateState(data) {
        // Update sensor data
        if (data.sensor) {
            this.state.sensor = { ...this.state.sensor, ...data.sensor };
            this.updateSensorUI();
        }
        
        // Update pump data
        if (data.pump) {
            this.state.pump = { ...this.state.pump, ...data.pump };
            this.updatePumpUI();
        }
        
        // Update network data
        if (data.network) {
            this.state.network = { ...this.state.network, ...data.network };
            this.updateNetworkUI();
        }
        
        // Update calibration data
        if (data.calibration) {
            this.state.calibration = { ...this.state.calibration, ...data.calibration };
            this.updateCalibrationUI();
        }
        
        // Update last update time
        document.getElementById('lastUpdate').textContent = 
            `Last update: ${new Date().toLocaleTimeString()}`;
    }
    
    updateSensorUI() {
        const sensor = this.state.sensor;
        
        if (!sensor.valid) {
            document.getElementById('moistureValue').textContent = '--';
            document.getElementById('moistureBar').style.width = '0%';
            document.getElementById('moistureStatus').textContent = 'ERROR';
            document.getElementById('moistureStatus').className = 'card-badge error';
            document.getElementById('rawAdc').textContent = '--';
            document.getElementById('sensorAge').textContent = 'Invalid';
            return;
        }
        
        // Update moisture display
        const moisture = sensor.moisture.toFixed(1);
        document.getElementById('moistureValue').textContent = moisture;
        document.getElementById('moistureBar').style.width = `${moisture}%`;
        document.getElementById('rawAdc').textContent = sensor.raw_adc;
        
        // Update moisture status
        const threshold = this.state.calibration.threshold;
        document.getElementById('thresholdLabel').textContent = `Threshold: ${threshold}%`;
        document.getElementById('thresholdMarker').style.left = `${threshold}%`;
        
        if (moisture < threshold) {
            document.getElementById('moistureStatus').textContent = 'DRY';
            document.getElementById('moistureStatus').className = 'card-badge warning';
        } else {
            document.getElementById('moistureStatus').textContent = 'OK';
            document.getElementById('moistureStatus').className = 'card-badge success';
        }
        
        // Update sensor age (in seconds)
        const ageMs = Date.now() - sensor.timestamp;
        const ageSeconds = Math.floor(ageMs / 1000);
        document.getElementById('sensorAge').textContent = `${ageSeconds}s ago`;
        
        // Update current ADC in calibration panel
        document.getElementById('currentAdc').textContent = sensor.raw_adc;
    }
    
    updatePumpUI() {
        const pump = this.state.pump;
        
        document.getElementById('pumpStatusText').textContent = pump.status;
        document.getElementById('retryCount').textContent = pump.retry_count;
        
        // Format last change time
        const lastChange = new Date(pump.last_change);
        const now = new Date();
        const diffMs = now - lastChange;
        
        let lastChangeText;
        if (diffMs < 60000) {
            lastChangeText = `${Math.floor(diffMs / 1000)}s ago`;
        } else if (diffMs < 3600000) {
            lastChangeText = `${Math.floor(diffMs / 60000)}m ago`;
        } else {
            lastChangeText = lastChange.toLocaleTimeString();
        }
        
        document.getElementById('lastChange').textContent = lastChangeText;
        
        // Update pump status badge
        const pumpBadge = document.getElementById('pumpStatusBadge');
        pumpBadge.textContent = pump.status;
        
        if (pump.active) {
            pumpBadge.className = 'status-badge danger';
            document.getElementById('pumpIcon').classList.add('active');
            document.getElementById('emergencyStopBtn').disabled = false;
        } else {
            pumpBadge.className = 'status-badge success';
            document.getElementById('pumpIcon').classList.remove('active');
            document.getElementById('emergencyStopBtn').disabled = true;
        }
    }
    
    updateNetworkUI() {
        const network = this.state.network;
        
        // Update network indicators
        const wifiStatus = document.getElementById('wifiStatus');
        const connectionText = document.getElementById('connectionText');
        
        if (network.connected) {
            wifiStatus.className = 'status-indicator connected';
            connectionText.textContent = 'Connected';
            document.getElementById('wifiRssi').textContent = `${network.rssi} dBm`;
        } else {
            wifiStatus.className = 'status-indicator disconnected';
            connectionText.textContent = 'Disconnected';
            document.getElementById('wifiRssi').textContent = '-- dBm';
        }
        
        // Update system info panel
        document.getElementById('ipAddress').textContent = network.ip || '--';
        document.getElementById('macAddress').textContent = network.mac || '--';
        document.getElementById('gateway').textContent = network.gateway || '--';
        document.getElementById('subnetMask').textContent = network.subnet || '--';
        document.getElementById('dnsServer').textContent = network.dns || '--';
    }
    
    updateSystemInfo(data) {
        if (data.system) {
            this.state.system = { ...this.state.system, ...data.system };
            
            // Update system status card
            document.getElementById('storageStatus').textContent = 
                this.state.system.fs_available ? 'LittleFS' : 'None';
            document.getElementById('freeHeap').textContent = 
                `${Math.floor(this.state.system.free_heap / 1024)} KB`;
            
            // Update system info panel
            document.getElementById('freeHeapDetailed').textContent = 
                `${Math.floor(this.state.system.free_heap / 1024)} KB`;
            document.getElementById('buildDate').textContent = 
                this.state.system.build_date || '--';
        }
    }
    
    updateCalibration(data) {
        if (data) {
            this.state.calibration = { ...this.state.calibration, ...data };
            this.updateCalibrationUI();
        }
    }
    
    updateCalibrationUI() {
        const cal = this.state.calibration;
        
        document.getElementById('adcDryValue').textContent = cal.adc_dry;
        document.getElementById('adcWetValue').textContent = cal.adc_wet;
        
        // Update dry/wet calibration results
        document.getElementById('dryResult').textContent = 
            cal.adc_dry > 0 ? `Calibrated: ${cal.adc_dry}` : 'Not calibrated';
        document.getElementById('wetResult').textContent = 
            cal.adc_wet > 0 ? `Calibrated: ${cal.adc_wet}` : 'Not calibrated';
        
        // Update configuration form
        document.getElementById('dryThreshold').value = cal.threshold;
        document.getElementById('expectedValue').value = cal.target;
        
        // Update calibration chart
        this.updateCalibrationChart();
    }
    
    updateConfiguration(data) {
        if (data) {
            this.state.config = { ...this.state.config, ...data };
            
            // Update form values
            document.getElementById('dryThreshold').value = this.state.config.dry_threshold;
            document.getElementById('expectedValue').value = this.state.config.expected_value;
            document.getElementById('maxRetries').value = this.state.config.max_retries;
            document.getElementById('samplingInterval').value = this.state.config.sampling_interval;
            
            // Update calibration thresholds
            this.state.calibration.threshold = this.state.config.dry_threshold;
            this.state.calibration.target = this.state.config.expected_value;
        }
    }
    
    updateLogs(logs) {
        this.state.logs = logs;
        this.filterLogs();
    }
    
    addLogEntry(entry) {
        this.state.logs.unshift(entry);
        if (this.state.logs.length > 1000) {
            this.state.logs.pop(); // Keep only last 1000 entries
        }
        this.filterLogs();
        
        // Auto-switch to logs panel if new important event
        if (entry.event.includes('ERROR') || entry.event.includes('WATERING')) {
            this.switchPanel('logs');
        }
    }
    
    filterLogs() {
        const filter = document.getElementById('logFilter').value;
        const search = document.getElementById('logSearch').value.toLowerCase();
        
        this.filteredLogs = this.state.logs.filter(log => {
            // Apply type filter
            if (filter !== 'all') {
                if (filter === 'sensor' && !log.event.includes('SENSOR')) return false;
                if (filter === 'pump' && !log.event.includes('PUMP')) return false;
                if (filter === 'system' && !log.event.includes('SYSTEM') && !log.event.includes('WIFI')) return false;
            }
            
            // Apply search filter
            if (search) {
                const searchable = `${log.event} ${log.details || ''}`.toLowerCase();
                if (!searchable.includes(search)) return false;
            }
            
            return true;
        });
        
        this.renderLogs();
    }
    
    renderLogs() {
        const tbody = document.getElementById('logsTableBody');
        if (!tbody) return;
        
        if (this.filteredLogs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="no-logs">No logs found</td></tr>';
            return;
        }
        
        // Calculate pagination
        const totalPages = Math.ceil(this.filteredLogs.length / this.logsPerPage);
        const startIndex = (this.currentLogPage - 1) * this.logsPerPage;
        const endIndex = Math.min(startIndex + this.logsPerPage, this.filteredLogs.length);
        const pageLogs = this.filteredLogs.slice(startIndex, endIndex);
        
        // Update pagination controls
        document.getElementById('currentPage').textContent = this.currentLogPage;
        document.getElementById('totalPages').textContent = totalPages;
        document.getElementById('prevPageBtn').disabled = this.currentLogPage <= 1;
        document.getElementById('nextPageBtn').disabled = this.currentLogPage >= totalPages;
        
        // Render logs
        tbody.innerHTML = pageLogs.map(log => `
            <tr>
                <td>${this.formatTimestamp(log.timestamp)}</td>
                <td><span class="log-event ${this.getLogEventClass(log.event)}">${log.event}</span></td>
                <td>${log.raw_adc || '--'}</td>
                <td>${log.percentage ? log.percentage.toFixed(1) + '%' : '--'}</td>
                <td>${log.details || '--'}</td>
            </tr>
        `).join('');
    }
    
    getLogEventClass(event) {
        if (event.includes('ERROR')) return 'log-error';
        if (event.includes('WARNING')) return 'log-warning';
        if (event.includes('PUMP')) return 'log-pump';
        if (event.includes('SENSOR')) return 'log-sensor';
        return 'log-info';
    }
    
    formatTimestamp(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit',
            second: '2-digit'
        });
    }
    
    // Control Functions
    async manualPump() {
        try {
            const response = await fetch('/api/pump/manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (response.ok) {
                this.showToast('Manual pump activated', 'success');
            } else {
                this.showToast('Failed to activate pump', 'error');
            }
        } catch (error) {
            console.error('Manual pump error:', error);
            this.showToast('Network error', 'error');
        }
    }
    
    async emergencyStop() {
        try {
            const response = await fetch('/api/pump/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            
            if (response.ok) {
                this.showToast('Emergency stop activated', 'warning');
            } else {
                this.showToast('Failed to stop pump', 'error');
            }
        } catch (error) {
            console.error('Emergency stop error:', error);
            this.showToast('Network error', 'error');
        }
    }
    
    async testPump(duration) {
        try {
            const response = await fetch('/api/pump/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ duration })
            });
            
            if (response.ok) {
                this.showToast(`Test pump activated for ${duration}ms`, 'info');
            } else {
                this.showToast('Failed to test pump', 'error');
            }
        } catch (error) {
            console.error('Test pump error:', error);
            this.showToast('Network error', 'error');
        }
    }
    
    async calibrate(type) {
        if (!confirm(`Place sensor in ${type === 'dry' ? 'DRY air' : 'WATER'} and click OK to calibrate`)) {
            return;
        }
        
        try {
            const response = await fetch('/api/calibrate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type })
            });
            
            if (response.ok) {
                this.showToast(`${type === 'dry' ? 'Dry' : 'Wet'} calibration saved`, 'success');
                // Refresh calibration data
                this.fetchAllData();
            } else {
                this.showToast('Calibration failed', 'error');
            }
        } catch (error) {
            console.error('Calibration error:', error);
            this.showToast('Network error', 'error');
        }
    }
    
    async saveConfiguration() {
        const formData = {
            dry_threshold: parseFloat(document.getElementById('dryThreshold').value),
            expected_value: parseFloat(document.getElementById('expectedValue').value),
            max_retries: parseInt(document.getElementById('maxRetries').value),
            sampling_interval: parseInt(document.getElementById('samplingInterval').value)
        };
        
        try {
            const response = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formData)
            });
            
            if (response.ok) {
                this.showToast('Configuration saved', 'success');
                this.state.config = formData;
            } else {
                this.showToast('Failed to save configuration', 'error');
            }
        } catch (error) {
            console.error('Save config error:', error);
            this.showToast('Network error', 'error');
        }
    }
    
    async resetConfiguration() {
        if (!confirm('Reset configuration to defaults?')) return;
        
        try {
            const response = await fetch('/api/config/reset', {
                method: 'POST'
            });
            
            if (response.ok) {
                this.showToast('Configuration reset', 'success');
                this.fetchAllData();
            } else {
                this.showToast('Failed to reset configuration', 'error');
            }
        } catch (error) {
            console.error('Reset config error:', error);
            this.showToast('Network error', 'error');
        }
    }
    
    async clearLogs() {
        if (!confirm('Clear all logs? This cannot be undone.')) return;
        
        try {
            const response = await fetch('/api/logs/clear', {
                method: 'POST'
            });
            
            if (response.ok) {
                this.showToast('Logs cleared', 'success');
                this.state.logs = [];
                this.filterLogs();
            } else {
                this.showToast('Failed to clear logs', 'error');
            }
        } catch (error) {
            console.error('Clear logs error:', error);
            this.showToast('Network error', 'error');
        }
    }
    
    async restartSystem() {
        if (!confirm('Restart the system? All operations will be interrupted.')) return;
        
        try {
            const response = await fetch('/api/system/restart', {
                method: 'POST'
            });
            
            if (response.ok) {
                this.showToast('System restarting...', 'warning');
                setTimeout(() => {
                    this.showToast('System should be restarted. Refreshing page...', 'info');
                    setTimeout(() => location.reload(), 3000);
                }, 2000);
            } else {
                this.showToast('Failed to restart system', 'error');
            }
        } catch (error) {
            console.error('Restart error:', error);
            this.showToast('Network error', 'error');
        }
    }
    
    async downloadLogs() {
        try {
            const response = await fetch('/api/logs/download');
            if (response.ok) {
                const blob = await response.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `terra_logs_${new Date().toISOString().split('T')[0]}.csv`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
                this.showToast('Logs downloaded', 'success');
            } else {
                this.showToast('No logs available', 'warning');
            }
        } catch (error) {
            console.error('Download logs error:', error);
            this.showToast('Failed to download logs', 'error');
        }
    }
    
    // UI Functions
    switchPanel(panelId) {
        // Update navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.remove('active');
        });
        const navItem = document.querySelector(`[data-target="${panelId}"]`);
        if (navItem) navItem.classList.add('active');
        
        // Show selected panel
        document.querySelectorAll('.content-panel').forEach(panel => {
            panel.classList.remove('active');
        });
        const panel = document.getElementById(panelId);
        if (panel) panel.classList.add('active');
        
        // Refresh panel data if needed
        if (panelId === 'logs') this.filterLogs();
        if (panelId === 'system') this.fetchSystemInfo();
    }
    
    updateConnectionStatus(connected) {
        const indicator = document.getElementById('wifiStatus');
        const text = document.getElementById('connectionText');
        
        if (connected) {
            indicator.className = 'status-indicator connected';
            text.textContent = 'Connected';
        } else {
            indicator.className = 'status-indicator disconnected';
            text.textContent = 'Disconnected';
        }
    }
    
    attemptReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            
            setTimeout(() => {
                this.connectWebSocket();
            }, this.reconnectInterval);
        } else {
            console.error('Max reconnection attempts reached');
            this.showToast('Failed to connect to system', 'error');
        }
    }
    
    updateUptime() {
        const uptimeElem = document.getElementById('uptimeDisplay');
        if (uptimeElem && this.state.system.uptime) {
            const uptimeMs = this.state.system.uptime;
            const hours = Math.floor(uptimeMs / 3600000);
            const minutes = Math.floor((uptimeMs % 3600000) / 60000);
            const seconds = Math.floor((uptimeMs % 60000) / 1000);
            
            uptimeElem.textContent = 
                `Uptime: ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
        }
    }
    
    // Chart Functions
    initializeCharts() {
        // Initialize calibration chart
        const calCtx = document.getElementById('calibrationChart');
        if (calCtx) {
            this.calibrationChart = new Chart(calCtx.getContext('2d'), {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [{
                        label: 'Calibration Curve',
                        data: [],
                        borderColor: 'rgb(64, 145, 108)',
                        backgroundColor: 'rgba(64, 145, 108, 0.1)',
                        tension: 0.4,
                        fill: true
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false }
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100,
                            title: {
                                display: true,
                                text: 'Moisture %'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'ADC Value'
                            },
                            reverse: true // Higher ADC = drier
                        }
                    }
                }
            });
        }
        
        // Initialize memory chart
        const memCtx = document.getElementById('memoryChart');
        if (memCtx) {
            this.memoryChart = new Chart(memCtx.getContext('2d'), {
                type: 'doughnut',
                data: {
                    labels: ['Used', 'Free'],
                    datasets: [{
                        data: [50, 50],
                        backgroundColor: [
                            'rgba(244, 67, 54, 0.8)',
                            'rgba(76, 175, 80, 0.8)'
                        ],
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom'
                        }
                    }
                }
            });
        }
        
        // Update charts every 5 seconds
        setInterval(() => {
            this.updateCharts();
            this.updateUptime();
        }, 5000);
    }
    
    updateCharts() {
        // Update calibration chart
        if (this.calibrationChart && this.state.sensor.valid) {
            const cal = this.state.calibration;
            const currentAdc = this.state.sensor.raw_adc;
            
            // Create curve points
            const points = [
                { x: cal.adc_dry, y: 0 },
                { x: currentAdc, y: this.state.sensor.moisture },
                { x: cal.adc_wet, y: 100 }
            ].sort((a, b) => a.x - b.x);
            
            this.calibrationChart.data.labels = points.map(p => p.x);
            this.calibrationChart.data.datasets[0].data = points.map(p => ({ x: p.x, y: p.y }));
            this.calibrationChart.update();
        }
        
        // Update memory chart
        if (this.memoryChart && this.state.system.free_heap > 0) {
            const totalHeap = 327680; // ESP32 typical heap size
            const usedHeap = totalHeap - this.state.system.free_heap;
            const freePercent = (this.state.system.free_heap / totalHeap * 100).toFixed(1);
            
            this.memoryChart.data.datasets[0].data = [
                usedHeap / 1024,
                this.state.system.free_heap / 1024
            ];
            this.memoryChart.update();
            
            // Update memory stats
            document.getElementById('minHeap').textContent = 
                `${Math.floor((totalHeap - this.state.system.free_heap) / 1024)} KB`;
        }
    }
    
    updateCalibrationChart() {
        if (!this.calibrationChart) return;
        
        const cal = this.state.calibration;
        
        // Update chart with calibration points
        const points = [
            { x: cal.adc_dry, y: 0 },
            { x: cal.adc_wet, y: 100 }
        ].sort((a, b) => a.x - b.x);
        
        this.calibrationChart.data.labels = points.map(p => p.x);
        this.calibrationChart.data.datasets[0].data = points.map(p => ({ x: p.x, y: p.y }));
        this.calibrationChart.update();
    }
    
    // Pagination
    prevLogPage() {
        if (this.currentLogPage > 1) {
            this.currentLogPage--;
            this.renderLogs();
        }
    }
    
    nextLogPage() {
        const totalPages = Math.ceil(this.filteredLogs.length / this.logsPerPage);
        if (this.currentLogPage < totalPages) {
            this.currentLogPage++;
            this.renderLogs();
        }
    }
    
    // Utility Functions
    showToast(message, type = 'info') {
        console.log(`[${type.toUpperCase()}] ${message}`);
        
        const container = document.getElementById('toastContainer');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        const icons = {
            success: 'fas fa-check-circle',
            error: 'fas fa-exclamation-circle',
            warning: 'fas fa-exclamation-triangle',
            info: 'fas fa-info-circle'
        };
        
        toast.innerHTML = `
            <i class="${icons[type] || icons.info}"></i>
            <div class="toast-content">
                <div class="toast-title">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
                <div class="toast-message">${message}</div>
            </div>
            <button class="toast-close" onclick="this.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        `;
        
        container.appendChild(toast);
        
        // Auto-remove after 5 seconds
        setTimeout(() => {
            if (toast.parentNode) {
                toast.style.opacity = '0';
                setTimeout(() => {
                    if (toast.parentNode) {
                        toast.parentNode.removeChild(toast);
                    }
                }, 300);
            }
        }, 5000);
    }
}

// Initialize app when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new TerraNurtureApp();
    console.log('TerraNurture App initialized');
});

// Global function for toast close buttons
document.addEventListener('click', (e) => {
    if (e.target.closest('.toast-close')) {
        e.target.closest('.toast').remove();
    }
});