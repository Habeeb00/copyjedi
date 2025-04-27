// This is a sample implementation of the leaderboard API client
// that can be integrated into the extension in the future

const vscode = require('vscode');
const axios = require('axios'); // You would need to add axios as a dependency

class LeaderboardClient {
    constructor(context) {
        this.context = context;
        this.config = vscode.workspace.getConfiguration('copyjedi');
        this.apiUrl = this.config.get('leaderboardApiUrl') || 'https://api.copyjedi-leaderboard.example.com';
        this.enabled = this.config.get('leaderboardEnabled') || false;
    }

    // Initialize and update configuration when changed
    initialize() {
        // Listen for configuration changes
        this.configListener = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('copyjedi')) {
                this.config = vscode.workspace.getConfiguration('copyjedi');
                this.apiUrl = this.config.get('leaderboardApiUrl') || 'https://api.copyjedi-leaderboard.example.com';
                this.enabled = this.config.get('leaderboardEnabled') || false;
            }
        });
        this.context.subscriptions.push(this.configListener);
    }

    // Submit stats to the leaderboard
    async submitStats(stats) {
        if (!this.enabled) {
            vscode.window.showInformationMessage('CopyJedi: Leaderboard submissions are disabled in settings');
            return false;
        }

        if (!stats.userId) {
            vscode.window.showErrorMessage('CopyJedi: Missing user ID for leaderboard submission');
            return false;
        }

        try {
            const response = await axios.post(`${this.apiUrl}/submit`, {
                userId: stats.userId,
                totalPastes: stats.totalPastes,
                totalLinesPasted: stats.totalLinesPasted,
                date: stats.date,
                // Additional metadata you might want to collect
                os: process.platform,
                vsCodeVersion: vscode.version,
                // Don't collect any personally identifiable information
            });

            if (response.status === 200) {
                vscode.window.showInformationMessage('CopyJedi: Stats submitted to leaderboard successfully!');
                return true;
            } else {
                vscode.window.showErrorMessage(`CopyJedi: Failed to submit stats - server returned ${response.status}`);
                return false;
            }
        } catch (error) {
            vscode.window.showErrorMessage(`CopyJedi: Error submitting to leaderboard - ${error.message}`);
            return false;
        }
    }

    // Get current leaderboard data
    async getLeaderboard() {
        try {
            const response = await axios.get(`${this.apiUrl}/leaderboard`);
            return response.data;
        } catch (error) {
            vscode.window.showErrorMessage(`CopyJedi: Error fetching leaderboard - ${error.message}`);
            return null;
        }
    }

    // Show leaderboard in a webview panel
    async showLeaderboard() {
        try {
            const leaderboardData = await this.getLeaderboard();
            if (!leaderboardData) return;

            // Create and show a webview
            const panel = vscode.window.createWebviewPanel(
                'copyJediLeaderboard',
                'CopyJedi Leaderboard',
                vscode.ViewColumn.One,
                { enableScripts: true }
            );

            panel.webview.html = this.getLeaderboardHtml(leaderboardData);
        } catch (error) {
            vscode.window.showErrorMessage(`CopyJedi: Error showing leaderboard - ${error.message}`);
        }
    }

    // Generate HTML for the leaderboard webview
    getLeaderboardHtml(data) {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>CopyJedi Leaderboard</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        padding: 20px;
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-editor-background);
                    }
                    table {
                        width: 100%;
                        border-collapse: collapse;
                        margin-top: 20px;
                    }
                    th, td {
                        text-align: left;
                        padding: 8px;
                        border-bottom: 1px solid var(--vscode-panel-border);
                    }
                    th {
                        background-color: var(--vscode-editor-selectionBackground);
                    }
                    tr:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .highlight {
                        background-color: var(--vscode-editor-findMatchHighlightBackground);
                    }
                    h1 {
                        color: var(--vscode-textLink-foreground);
                    }
                </style>
            </head>
            <body>
                <h1>CopyJedi Global Leaderboard</h1>
                <p>See how your paste habits compare to Jedi Masters worldwide!</p>
                
                <table>
                    <tr>
                        <th>Rank</th>
                        <th>User</th>
                        <th>Total Pastes</th>
                        <th>Total Lines</th>
                        <th>Last Active</th>
                    </tr>
                    ${data.map((user, index) => `
                        <tr class="${user.isCurrentUser ? 'highlight' : ''}">
                            <td>${index + 1}</td>
                            <td>${user.username || 'Anonymous Jedi ' + user.userId.substr(-4)}</td>
                            <td>${user.totalPastes}</td>
                            <td>${user.totalLinesPasted}</td>
                            <td>${new Date(user.lastActive).toLocaleDateString()}</td>
                        </tr>
                    `).join('')}
                </table>
            </body>
            </html>
        `;
    }

    // Dispose of resources
    dispose() {
        if (this.configListener) {
            this.configListener.dispose();
        }
    }
}

module.exports = LeaderboardClient;