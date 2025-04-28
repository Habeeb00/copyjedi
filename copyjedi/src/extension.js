// Using the global fetch API available in the VS Code extension host environment
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

// Add this at the top of your extension.js
// If you're having issues with the built-in fetch
let fetch;
try {
  fetch = globalThis.fetch || require("node-fetch");
} catch (e) {
  const nodeFetch = require("node-fetch");
  fetch = nodeFetch.default || nodeFetch;
}

// Fix the fetch implementation
function fixedFetch(url, options) {
  // Use a try-catch to handle different environments
  try {
    if (typeof globalThis.fetch === "function") {
      return globalThis.fetch(url, options);
    } else {
      const nodeFetch = require("node-fetch");
      return nodeFetch(url, options);
    }
  } catch (e) {
    log(`Error setting up fetch: ${e.message}`);
    const nodeFetch = require("node-fetch");
    return nodeFetch(url, options);
  }
}

// Add this at the top of your file
const outputChannel = vscode.window.createOutputChannel("CopyJedi");

// Then use it for logging
function log(message) {
  console.log(message);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// State to track paste statistics
let pasteStats = {
  totalPastes: 0,
  totalLinesPasted: 0,
  date: new Date().toDateString(),
  userId: null, // Will be used for leaderboard functionality
};

let isTracking = true; // Start tracking by default
let statusBarItem;
let pasteEventDisposable;
let globalStoragePath;
let lastEditTime = Date.now();

// File to store persistent data
const getStoragePath = () => {
  if (globalStoragePath) {
    return path.join(globalStoragePath, "stats.json");
  }
  // Fallback, but this shouldn't be used in production
  return path.join(
    process.env.HOME || process.env.USERPROFILE,
    ".copyjedi-stats.json"
  );
};

// Load saved paste statistics
const loadPasteStats = () => {
  try {
    const storagePath = getStoragePath();
    log(`Loading stats from: ${storagePath}`);

    if (fs.existsSync(storagePath)) {
      try {
        const data = fs.readFileSync(storagePath, "utf8");
        log(`Raw stats data: ${data.substring(0, 50)}...`);

        // Validate that data exists and is not empty
        if (!data || data.trim() === "") {
          throw new Error("Empty stats file");
        }

        // Try to parse, but handle parse errors gracefully
        let savedStats;
        try {
          savedStats = JSON.parse(data);
        } catch (parseError) {
          log(`JSON parse error: ${parseError.message}`);
          // If parsing fails, initialize with new stats
          throw new Error("Stats file contained invalid JSON");
        }

        // Reset stats if it's a new day
        const today = new Date().toDateString();
        if (savedStats.date !== today) {
          pasteStats = {
            totalPastes: 0,
            totalLinesPasted: 0,
            date: today,
            userId: savedStats.userId || generateUserId(),
          };
          savePasteStats();
        } else {
          pasteStats = savedStats;
        }
      } catch (fileError) {
        log(`Error reading stats file: ${fileError.message}`);
        // If there's any error reading or parsing the file, reset stats
        pasteStats.userId = generateUserId();
        savePasteStats();
      }
    } else {
      // Initialize with user ID for potential leaderboard integration
      log("Stats file does not exist, creating new one");
      pasteStats.userId = generateUserId();
      savePasteStats();
    }
  } catch (error) {
    log(`Error in loadPasteStats: ${error.message}`);
    vscode.window.showErrorMessage(
      `CopyJedi: Error loading statistics - ${error.message}`
    );

    // Ensure we always have valid stats
    pasteStats = {
      totalPastes: 0,
      totalLinesPasted: 0,
      date: new Date().toDateString(),
      userId: generateUserId(),
    };

    // Try to save the fresh stats
    try {
      savePasteStats();
    } catch (saveError) {
      log(`Failed to save fresh stats: ${saveError.message}`);
    }
  }
};

// Save paste statistics
const savePasteStats = () => {
  try {
    const storagePath = getStoragePath();
    fs.writeFileSync(storagePath, JSON.stringify(pasteStats), "utf8");

    // Log where stats are being saved to help with debugging
    console.log(`CopyJedi stats saved to: ${storagePath}`);
    log(`Stats file updated: ${JSON.stringify(pasteStats)}`);
  } catch (error) {
    vscode.window.showErrorMessage(
      `CopyJedi: Error saving statistics - ${error.message}`
    );
  }
};

// Generate a unique user ID for leaderboard tracking
const generateUserId = () => {
  return "user_" + Math.random().toString(36).substr(2, 9);
};
function hasCodePatterns(text) {
  // Simple check for common code patterns
  return (
    /function|const|let|var|import|export|if|for|while|class|=>|return/i.test(
      text
    ) || /[{}\[\]();=+\-*/%]/.test(text)
  );
}

// Initialize the status bar item
const initializeStatusBar = (context) => {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = `$(clippy) Pastes: ${pasteStats.totalPastes} | Lines: ${pasteStats.totalLinesPasted}`;
  statusBarItem.tooltip = "CopyJedi Paste Tracker";
  statusBarItem.command = "copyjedi.toggleTracking";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
};

// Update the status bar with current statistics
const updateStatusBar = () => {
  if (statusBarItem) {
    // Add more visibility to the status bar
    statusBarItem.text = `$(clippy) Pastes: ${pasteStats.totalPastes} | Lines: ${pasteStats.totalLinesPasted}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
    statusBarItem.show();

    // Log when status bar updates
    log(
      `Status bar updated - Pastes: ${pasteStats.totalPastes}, Lines: ${pasteStats.totalLinesPasted}`
    );
  }
};

// Setup tracking of paste events
const setupPasteTracking = async (context) => {
  try {
    if (pasteEventDisposable) {
      pasteEventDisposable.dispose();
    }

    log("Setting up paste tracking");

    pasteEventDisposable = vscode.workspace.onDidChangeTextDocument(
      async (event) => {
        try {
          if (!isTracking) {
            log("Change detected but tracking is disabled");
            return;
          }

          // Log details for debugging
          log(`Document changed: ${event.document.uri.toString()}`);
          log(`Change count: ${event.contentChanges.length}`);

          if (event.contentChanges.length === 0) return;

          // Using vscode.window directly instead of assigning to variable
          const clipboard = await vscode.env.clipboard.readText();
          log(`Clipboard content: ${clipboard.substring(0, 50)}...`);

          for (const change of event.contentChanges) {
            // Log the change for debugging
            log(
              `Change detected - length: ${
                change.text.length
              }, first chars: "${change.text
                .substring(0, 20)
                .replace(/\n/g, "\\n")}"`
            );

            // Improved paste detection logic
            // Check if this is actually a paste event (not just typing)
            // We consider it a paste if:
            // 1. Text is substantial (multiple lines or reasonably long)
            // 2. The clipboard content matches or mostly matches what was inserted
            // 3. The change happened very quickly (not character by character)

            const isProbablyPaste =
              // Must have substantial content to be a paste
              (change.text.length > 15 || change.text.includes("\n")) &&
              // And either it's multiple lines OR the change was made at once (not char by char)
              (change.text.split("\n").length > 1 ||
                (change.range &&
                  Math.abs(
                    change.range.end.character - change.range.start.character
                  ) > 5)) &&
              // Not likely to be common typing patterns
              !/^\s*[{}\[\]();:,.]+\s*$/.test(change.text) &&
              // Fast change indicates paste rather than typing
              Date.now() - lastEditTime < 100;

            // Update the timestamp at the beginning of your event handler
            lastEditTime = Date.now();
            hasCodePatterns(change.text);
            if (isProbablyPaste) {
              // Count pasted lines
              const lineCount = change.text.split("\n").length;

              // Update statistics
              pasteStats.totalPastes++;
              pasteStats.totalLinesPasted += lineCount;

              // Make sure to save stats after each update
              savePasteStats();

              // Update the status bar immediately
              updateStatusBar();

              // Show paste detection notification
              vscode.window.showInformationMessage(
                `CopyJedi Detected: Paste #${pasteStats.totalPastes} with ${lineCount} lines`
              );

              // Show notification
              vscode.window.showInformationMessage(
                `CopyJedi: Pasted ${lineCount} line${
                  lineCount !== 1 ? "s" : ""
                }! Total: ${pasteStats.totalPastes}`
              );

              // Update status bar
              updateStatusBar();

              // Save statistics
              savePasteStats();

              // Only count the first substantial change in a batch
              break;
            }
          }
        } catch (error) {
          log(`Error in paste tracking: ${error.message}`);
        }
      }
    );

    context.subscriptions.push(pasteEventDisposable);
  } catch (error) {
    log(`Error setting up paste tracking: ${error.message}`);
  }
};

// Toggle tracking on/off
const toggleTracking = () => {
  isTracking = !isTracking;
  if (isTracking) {
    vscode.window.showInformationMessage("CopyJedi: Paste tracking enabled");
  } else {
    vscode.window.showInformationMessage("CopyJedi: Paste tracking disabled");
  }
};

const resetStats = () => {
  pasteStats.totalPastes = 0;
  pasteStats.totalLinesPasted = 0;
  pasteStats.date = new Date().toDateString();
  savePasteStats();
  updateStatusBar();
  vscode.window.showInformationMessage("CopyJedi: Statistics reset");
};

let syncStatusItem;

function updateSyncStatus(status) {
  if (!syncStatusItem) {
    syncStatusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99
    );
    syncStatusItem.show();
  }

  if (status === "syncing") {
    syncStatusItem.text = `$(sync~spin) Syncing...`;
    syncStatusItem.tooltip = "CopyJedi is syncing data to leaderboard";
  } else if (status === "success") {
    syncStatusItem.text = `$(check) Synced`;
    syncStatusItem.tooltip = `Last sync: ${new Date().toLocaleTimeString()}`;
    // Reset after 3 seconds
    setTimeout(() => {
      syncStatusItem.text = `$(sync) Sync: ${new Date().toLocaleTimeString()}`;
    }, 3000);
  } else if (status === "error") {
    syncStatusItem.text = `$(error) Sync Failed`;
    syncStatusItem.tooltip = "CopyJedi failed to sync data";
    // Reset after 3 seconds
    setTimeout(() => {
      syncStatusItem.text = `$(sync) Sync: ${new Date().toLocaleTimeString()}`;
    }, 3000);
  }
}

const submitToLeaderboard = async () => {
  // Get server URL from settings or use default
  const config = vscode.workspace.getConfiguration("copyjedi");
  const serverUrl =
    config.get("leaderboardServerUrl") || "http://localhost:3000";

  // Get OS and VS Code info
  const os = process.platform;
  const vsCodeVersion = vscode.version;

  log(`Submitting to leaderboard at: ${serverUrl}/api/submit`);

  try {
    // Use the fixed fetch implementation
    const response = await fixedFetch(`${serverUrl}/api/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: pasteStats.userId,
        totalPastes: pasteStats.totalPastes,
        totalLinesPasted: pasteStats.totalLinesPasted,
        date: pasteStats.date,
        os: os,
        vsCodeVersion: vsCodeVersion,
      }),
    });

    if (response.ok) {
      log("Sync successful");
      // Only show notification for manual syncs, not auto-syncs
      // vscode.window.showInformationMessage("CopyJedi: Stats submitted to leaderboard!");
      return true;
    } else {
      const text = await response.text();
      log(`Error response: ${text}`);
      vscode.window.showErrorMessage(
        `CopyJedi: Failed to submit stats - ${text}`
      );
      return false;
    }
  } catch (error) {
    log(`Fetch error in submitToLeaderboard: ${error.message}`);
    log(`Error stack: ${error.stack}`);
    vscode.window.showErrorMessage(
      `CopyJedi: Error submitting to leaderboard - ${error.message}`
    );
    return false;
  }
};

// Add this command to see recent MongoDB updates
vscode.commands.registerCommand("copyjedi.checkSyncStatus", async () => {
  try {
    const config = vscode.workspace.getConfiguration("copyjedi");
    const serverUrl =
      config.get("leaderboardServerUrl") || "http://localhost:3000";

    vscode.window.showInformationMessage("Checking MongoDB sync status...");

    const response = await fetch(
      `${serverUrl}/api/syncStatus/${pasteStats.userId}`
    );
    const data = await response.json();

    if (response.ok) {
      const lastSync = new Date(data.lastSync).toLocaleString();
      vscode.window.showInformationMessage(
        `Last successful sync: ${lastSync} (${data.timeSinceLastSync} ago)`
      );
      outputChannel.appendLine(`Sync status check - Last update: ${lastSync}`);
      outputChannel.show();
    } else {
      vscode.window.showErrorMessage(
        `Error checking sync status: ${data.message}`
      );
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `Error checking sync status: ${error.message}`
    );
  }
});

// In extension.js - add this near the top with your other imports
const SYNC_INTERVAL_MS = 10 * 1000; // 10 seconds for testing

// Add this function to periodically sync data
function startAutoSync(context) {
  log("Starting automatic sync to leaderboard");

  // Initial sync after a short delay
  const initialSyncTimeout = setTimeout(() => {
    log("Running initial sync to leaderboard");
    submitToLeaderboard().catch((err) => {
      log(`Initial sync failed: ${err.message}`);
    });
  }, 30000); // Wait 30 seconds after startup

  // Register periodic sync
  const syncInterval = setInterval(() => {
    log("Running scheduled sync to leaderboard");
    submitToLeaderboard().catch((err) => {
      log(`Scheduled sync failed: ${err.message}`);
    });
  }, SYNC_INTERVAL_MS);

  // Make sure we clean up the interval when the extension is deactivated
  context.subscriptions.push({
    dispose: () => {
      clearTimeout(initialSyncTimeout);
      clearInterval(syncInterval);
      log("Auto sync stopped due to extension deactivation");
    },
  });

  return syncInterval;
}

// Activate the extension
function activate(context) {
  try {
    // Show activation notification
    vscode.window.showInformationMessage("CopyJedi is now activating!");

    globalStoragePath = context.globalStoragePath;

    // Create directory if it doesn't exist
    if (!fs.existsSync(globalStoragePath)) {
      log(`Creating storage directory: ${globalStoragePath}`);
      fs.mkdirSync(globalStoragePath, { recursive: true });
    }

    console.log("CopyJedi is now active!");
    log("CopyJedi activation started");

    // Load saved statistics
    loadPasteStats();

    // Explicitly ensure tracking is on at startup
    isTracking = true;
    log(`Tracking status: ${isTracking ? "enabled" : "disabled"}`);

    // Initialize status bar
    initializeStatusBar(context);

    // Setup paste tracking
    setupPasteTracking(context);

    // Start the automatic sync process
    startAutoSync(context);

    // Add a command to manually trigger sync
    const syncCommand = vscode.commands.registerCommand(
      "copyjedi.syncNow",
      () => {
        vscode.window.showInformationMessage(
          "CopyJedi: Manually syncing to leaderboard..."
        );
        submitToLeaderboard()
          .then(() => {
            vscode.window.showInformationMessage(
              "CopyJedi: Manual sync completed!"
            );
          })
          .catch((err) => {
            vscode.window.showErrorMessage(
              `CopyJedi: Manual sync failed - ${err.message}`
            );
          });
      }
    );

    context.subscriptions.push(syncCommand);

    // Register commands
    context.subscriptions.push(
      vscode.commands.registerCommand(
        "copyjedi.toggleTracking",
        toggleTracking
      ),
      vscode.commands.registerCommand("copyjedi.resetStats", resetStats),
      vscode.commands.registerCommand(
        "copyjedi.submitToLeaderboard",
        submitToLeaderboard
      ),
      vscode.commands.registerCommand("copyjedi.test", () => {
        vscode.window.showInformationMessage("CopyJedi test command working!");
        log("Test command executed");
      }),
      vscode.commands.registerCommand("copyjedi.verifyBackend", () => {
        // Check if stats file exists
        const storagePath = getStoragePath();
        try {
          if (fs.existsSync(storagePath)) {
            const statsData = fs.readFileSync(storagePath, "utf8");
            vscode.window.showInformationMessage(
              `CopyJedi backend is working! Stats file exists at: ${storagePath}`
            );

            // Show stats in a message
            const stats = JSON.parse(statsData);
            vscode.window.showInformationMessage(
              `Current stats: ${stats.totalPastes} pastes, ${stats.totalLinesPasted} lines, User ID: ${stats.userId}`
            );

            // Log to output channel too
            log(`Backend verification - stats file contents: ${statsData}`);

            // Open the output channel to make logs visible
            outputChannel.show();
          } else {
            vscode.window.showWarningMessage(
              `CopyJedi stats file not found at: ${storagePath}`
            );
          }
        } catch (error) {
          vscode.window.showErrorMessage(
            `CopyJedi backend check failed: ${error.message}`
          );
        }
      })
    );

    // Update status bar with initial values
    updateStatusBar();

    log("CopyJedi activation completed successfully");

    // Show successful activation notification
    vscode.window.showInformationMessage(
      "CopyJedi activated successfully and is tracking your pastes!"
    );
  } catch (error) {
    log(`Activation error: ${error.message}`);
    log(`Stack trace: ${error.stack}`);
  }
}

// Deactivate the extension
function deactivate() {
  // Save statistics before deactivation
  savePasteStats();

  if (pasteEventDisposable) {
    pasteEventDisposable.dispose();
  }
}

module.exports = {
  activate,
  deactivate,
};
