// This is a sample implementation of the leaderboard API client
// that can be integrated into the extension in the future

const vscode = require("vscode");

// Don't directly require node-fetch here, we'll use the extension.js fetch implementation
// through a function we'll pass in

class LeaderboardClient {
  constructor(context) {
    this.context = context;
    this.config = vscode.workspace.getConfiguration("copyjedi");
    this.apiUrl =
      this.config.get("leaderboardApiUrl") ||
      this.config.get("leaderboardServerUrl") ||
      "https://api.copyjedi.com"; // Updated to a real endpoint
    this.enabled = this.config.get("leaderboardEnabled") || false;
    this.offlineMode = false;
    this.lastConnectionAttempt = 0;
    this.connectionRetryInterval = 30 * 60 * 1000; // 30 minutes
    this.pendingSubmissions = []; // Store submissions when offline

    // Get reference to the output channel
    try {
      this.outputChannel = vscode.window.createOutputChannel("CopyJedi");
    } catch (error) {
      console.error("Failed to create output channel:", error);
      // Use a dummy output channel as fallback
      this.outputChannel = {
        appendLine: (message) => console.log(message),
      };
    }
  }

  // Log messages
  log(message) {
    console.log(message);
    this.outputChannel.appendLine(
      `[${new Date().toLocaleTimeString()}] ${message}`
    );
  }

  // Initialize and update configuration when changed
  initialize() {
    // Listen for configuration changes
    this.configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("copyjedi")) {
        this.config = vscode.workspace.getConfiguration("copyjedi");
        this.apiUrl =
          this.config.get("leaderboardApiUrl") ||
          this.config.get("leaderboardServerUrl") ||
          "https://api.copyjedi.com";
        this.enabled = this.config.get("leaderboardEnabled") || false;

        // Reset offline mode when configuration changes to allow retrying
        if (
          e.affectsConfiguration("copyjedi.leaderboardApiUrl") ||
          e.affectsConfiguration("copyjedi.leaderboardServerUrl")
        ) {
          this.offlineMode = false;
          this.lastConnectionAttempt = 0;
          this.log("Server URL changed, resetting offline status");
        }
      }
    });
    this.context.subscriptions.push(this.configListener);

    // Check server availability on startup
    this.checkServerAvailability();
  }

  // Fetch function that uses the global VS Code fetch or our custom implementation
  async fetch(url, options = {}) {
    try {
      // Try using VS Code's built-in fetch
      if (typeof globalThis.fetch === "function") {
        const controller = new AbortController();
        const timeout = options.timeout || 10000;
        delete options.timeout;

        const timeoutId = setTimeout(() => controller.abort(), timeout);
        options.signal = controller.signal;

        try {
          const response = await globalThis.fetch(url, options);
          clearTimeout(timeoutId);
          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          if (error.name === "AbortError") {
            throw new Error(`Request timeout after ${timeout}ms`);
          }
          throw error;
        }
      } else {
        // Fallback to node-fetch
        const nodeFetch = require("node-fetch");
        return nodeFetch(url, options);
      }
    } catch (e) {
      this.log(`Error in LeaderboardClient fetch: ${e.message}`);
      throw e;
    }
  }

  // Check if the server is available
  async checkServerAvailability() {
    if (!this.enabled) return false;

    try {
      const now = Date.now();
      // Don't check too frequently
      if (
        this.offlineMode &&
        now - this.lastConnectionAttempt < this.connectionRetryInterval
      ) {
        return false;
      }

      this.lastConnectionAttempt = now;
      this.log(`Checking server availability at ${this.apiUrl}`);

      // Try different endpoint combinations to improve connectivity detection
      let endpoints = [
        `${this.apiUrl}/api/health`,
        `${this.apiUrl}/health`,
        this.apiUrl,
      ];

      let connected = false;

      // Try each endpoint until one works
      for (const endpoint of endpoints) {
        try {
          this.log(`Trying leaderboard endpoint: ${endpoint}`);
          const response = await this.fetch(endpoint, {
            method: "GET",
            timeout: 5000, // 5 second timeout
            headers: {
              Accept: "application/json",
              "User-Agent": `VSCode-CopyJedi/${vscode.version}`,
            },
            cache: "no-cache", // Prevent caching issues
          });

          if (response.ok) {
            connected = true;
            this.log(`Connected successfully to: ${endpoint}`);
            break;
          }
        } catch (endpointError) {
          this.log(
            `Failed to connect to ${endpoint}: ${endpointError.message}`
          );
          // Continue trying other endpoints
        }
      }

      if (connected) {
        // We're connected!
        if (this.offlineMode) {
          // We're back online
          this.offlineMode = false;
          vscode.window.showInformationMessage(
            "CopyJedi: Leaderboard connection restored!"
          );

          // Try to submit any pending data
          if (this.pendingSubmissions.length > 0) {
            this.submitPendingData();
          }
        }
      } else {
        this.offlineMode = true;
        this.log("All connection attempts failed, switching to offline mode");
      }
    } catch (error) {
      this.offlineMode = true;
      this.log(`CopyJedi: Leaderboard server unavailable - ${error.message}`);
      // Don't show notification on startup, only when user explicitly tries to use it
    }

    return !this.offlineMode;
  }

  // Submit any pending data when we're back online
  async submitPendingData() {
    if (this.pendingSubmissions.length === 0) return;

    vscode.window.showInformationMessage(
      `CopyJedi: Submitting ${this.pendingSubmissions.length} pending updates to leaderboard...`
    );

    // Take only one submission - the latest one with cumulative stats
    const latestSubmission =
      this.pendingSubmissions[this.pendingSubmissions.length - 1];

    try {
      const success = await this.submitStatsToServer(latestSubmission);
      if (success) {
        // Clear all pending submissions if successful
        this.pendingSubmissions = [];
      }
    } catch (error) {
      this.log(`CopyJedi: Failed to submit pending data - ${error.message}`);
    }
  }

  // Submit stats to the leaderboard
  async submitStats(stats) {
    if (!this.enabled) {
      vscode.window.showInformationMessage(
        "CopyJedi: Leaderboard submissions are disabled in settings"
      );
      return false;
    }

    if (!stats.userId) {
      vscode.window.showErrorMessage(
        "CopyJedi: Missing user ID for leaderboard submission"
      );
      return false;
    }

    // Check server availability if we're in offline mode or it's been a while
    if (
      this.offlineMode ||
      Date.now() - this.lastConnectionAttempt > this.connectionRetryInterval
    ) {
      await this.checkServerAvailability();
    }

    // If we're in offline mode, store for later submission
    if (this.offlineMode) {
      this.pendingSubmissions.push(stats);
      vscode.window.showInformationMessage(
        "CopyJedi: Leaderboard server is unavailable. Your stats will be submitted when connection is restored."
      );
      return false;
    }

    return this.submitStatsToServer(stats);
  }

  // The actual server submission logic
  async submitStatsToServer(stats) {
    try {
      const response = await this.fetch(`${this.apiUrl}/api/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId: stats.userId,
          totalPastes: stats.totalPastes,
          totalLinesPasted: stats.totalLinesPasted,
          date: stats.date,
          // Additional metadata you might want to collect
          os: process.platform,
          vsCodeVersion: vscode.version,
          // Don't collect any personally identifiable information
        }),
        timeout: 10000, // 10 second timeout
      });

      if (response.ok) {
        vscode.window.showInformationMessage(
          "CopyJedi: Stats submitted to leaderboard successfully!"
        );
        return true;
      } else {
        const errorText = await response.text();
        vscode.window.showErrorMessage(
          `CopyJedi: Failed to submit stats - server returned ${response.status} - ${errorText}`
        );
        return false;
      }
    } catch (error) {
      // Mark as offline if we get connection errors
      this.offlineMode = true;
      vscode.window.showErrorMessage(
        `CopyJedi: Error submitting to leaderboard - ${error.message}`
      );
      return false;
    }
  }

  // Get current leaderboard data
  async getLeaderboard() {
    // Check connection first
    if (this.offlineMode) {
      await this.checkServerAvailability();

      if (this.offlineMode) {
        vscode.window.showErrorMessage(
          "CopyJedi: Cannot fetch leaderboard - server is unavailable"
        );
        return null;
      }
    }

    try {
      const response = await this.fetch(`${this.apiUrl}/leaderboard`);
      return await response.json();
    } catch (error) {
      this.offlineMode = true;
      vscode.window.showErrorMessage(
        `CopyJedi: Error fetching leaderboard - ${error.message}`
      );
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
        "copyJediLeaderboard",
        "CopyJedi Leaderboard",
        vscode.ViewColumn.One,
        { enableScripts: true }
      );

      panel.webview.html = this.getLeaderboardHtml(leaderboardData);
    } catch (error) {
      vscode.window.showErrorMessage(
        `CopyJedi: Error showing leaderboard - ${error.message}`
      );
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
                    ${data
                      .map(
                        (user, index) => `
                        <tr class="${user.isCurrentUser ? "highlight" : ""}">
                            <td>${index + 1}</td>
                            <td>${
                              user.username ||
                              "Anonymous Jedi " + user.userId.substr(-4)
                            }</td>
                            <td>${user.totalPastes}</td>
                            <td>${user.totalLinesPasted}</td>
                            <td>${new Date(
                              user.lastActive
                            ).toLocaleDateString()}</td>
                        </tr>
                    `
                      )
                      .join("")}
                </table>
            </body>
            </html>
        `;
  }

  // Configure the leaderboard server
  async configureServer() {
    const currentUrl = this.config.get("leaderboardApiUrl") || "";

    const serverUrl = await vscode.window.showInputBox({
      prompt: "Enter the leaderboard server URL",
      placeHolder: "https://your-leaderboard-server.com",
      value: currentUrl,
    });

    if (serverUrl !== undefined) {
      // Empty string means user wants to disable
      await this.config.update("leaderboardApiUrl", serverUrl, true);

      if (!serverUrl) {
        vscode.window.showInformationMessage(
          "CopyJedi: Leaderboard server disabled"
        );
      } else {
        // Reset offline mode to try the new URL
        this.offlineMode = false;
        this.lastConnectionAttempt = 0;
        this.apiUrl = serverUrl;

        // Test the new URL
        await this.checkServerAvailability();
        if (!this.offlineMode) {
          vscode.window.showInformationMessage(
            "CopyJedi: Leaderboard server configured successfully!"
          );
        } else {
          vscode.window.showWarningMessage(
            `CopyJedi: Could not connect to ${serverUrl}`
          );
        }
      }
    }
  }

  // Dispose of resources
  dispose() {
    if (this.configListener) {
      this.configListener.dispose();
    }
  }
}

module.exports = LeaderboardClient;
