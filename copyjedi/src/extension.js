// Using the global fetch API available in the VS Code extension host environment
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const LeaderboardClient = require("./leaderboardClient");

// Create output channel early so we can log during initialization
const outputChannel = vscode.window.createOutputChannel("CopyJedi");

// Simple logging function
function log(message) {
  console.log(message);
  outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

// Simple fetch implementation that works in both environments
async function fixedFetch(url, options = {}) {
  try {
    log(`Making fetch request to: ${url}`);

    // Remove timeout from options and handle it separately with AbortController
    const timeout = options.timeout || 10000;
    delete options.timeout;

    // Create an AbortController for timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // Add the signal to options
    options.signal = controller.signal;

    // Try using the built-in fetch first (should work in VS Code)
    try {
      const response = await globalThis.fetch(url, options);
      clearTimeout(timeoutId);
      return response;
    } catch (fetchError) {
      clearTimeout(timeoutId);

      // Check if it's a timeout error
      if (fetchError.name === "AbortError") {
        throw new Error(`Request timed out after ${timeout}ms`);
      }

      // If it's not a timeout error but fetch failed, try node-fetch as fallback
      log(`Built-in fetch failed: ${fetchError.message}. Trying node-fetch...`);

      // Try using require for node-fetch (common in extensions)
      try {
        // Make a new controller for the fallback request
        const fallbackController = new AbortController();
        const fallbackTimeoutId = setTimeout(
          () => fallbackController.abort(),
          timeout
        );

        // Use require instead of dynamic import in production
        const nodeFetch = require("node-fetch");
        options.signal = fallbackController.signal;

        const response = await nodeFetch(url, options);
        clearTimeout(fallbackTimeoutId);
        return response;
      } catch (nodeFetchError) {
        log(`Node-fetch failed too: ${nodeFetchError.message}`);
        throw nodeFetchError;
      }
    }
  } catch (e) {
    log(`Error in fetch implementation: ${e.message}`);
    log(`Error stack: ${e.stack || "No stack available"}`);
    throw new Error(`Fetch error: ${e.message}`);
  }
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
let syncStatusBarItem;
let pasteEventDisposable;
let globalStoragePath;
let lastEditTime = Date.now();
let leaderboardClient; // LeaderboardClient instance

// Add this near your other imports
let lastPasteKeyCombination = false;
let lastKeypressTime = Date.now();
let offlineMode = false; // Track offline status
let pendingSubmissions = []; // Queue for storing submissions when offline
let lastConnectionAttempt = Date.now(); // Track last connection attempt time

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

// Function to check if the code is generated by Copilot
function isCopilotCode(text) {
  // Look for common Copilot signatures
  const copilotPatterns = [
    "// Copilot suggestion",
    "// Suggested by",
    "// Generated by",
    "// Via GitHub Copilot",
    "<!-- GitHub Copilot",
    "/* Copilot suggestion",
    "// This code was suggested by",
    "// Auto-generated",
  ];

  return copilotPatterns.some((pattern) => text.includes(pattern));
}

const isProbablyPaste = (change, clipboard) => {
  // Skip Copilot generated code
  if (isCopilotCode(change.text)) {
    log("Skipping Copilot generated code");
    return false;
  }

  // Don't count as paste if empty or tiny content
  if (!change.text || change.text.length < 5) return false;

  // Check if the active editor is valid
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isEditableDocument(editor.document)) {
    return false;
  }

  // Check for clipboard match (strong indicator of paste)
  const clipboardMatch =
    clipboard && change.text.includes(clipboard.substring(0, 20));

  // Check for large text insertions, which are likely pastes
  const isLargeInsertion = change.text.length > 50;

  // Check for multi-line content, which is often pasted
  const isMultiLine = change.text.split("\n").length > 2;

  // Check if the edit replaced a chunk of text (not character-by-character typing)
  const isBulkChange =
    change.range &&
    Math.abs(change.range.end.character - change.range.start.character) > 10;

  // True paste signature: clipboard match OR (large insertion AND either multi-line OR bulk change)
  const result =
    clipboardMatch || (isLargeInsertion && (isMultiLine || isBulkChange));

  if (result) {
    log("Paste detected with confidence");
  }

  return result;
};

// Helper to determine if a document is an actual editable file
function isEditableDocument(document) {
  try {
    // Debug logging to see what documents are being processed
    log(
      `Checking document: ${document.uri.toString()} (${document.languageId})`
    );

    // Ignore output/debug/SCM/etc panels
    if (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") {
      log(`Skipping non-file document: ${document.uri.scheme}`);
      return false;
    }

    // Skip if the path includes terms related to extension output or debugging
    const uriString = document.uri.toString().toLowerCase();
    if (
      uriString.includes("extension-output") ||
      uriString.includes("debug-console") ||
      uriString.includes("output-channel") ||
      uriString.includes("extension-editor")
    ) {
      log(`Skipping extension-related document: ${uriString}`);
      return false;
    }

    // Expanded list of non-editable document types
    const nonEditableTypes = [
      "log",
      "output",
      "scm",
      "debug",
      "terminal",
      "plaintext",
      "markdown",
      "json",
      "jsonc",
      "git-commit",
      "git-rebase",
      "search-result",
      "diff",
      "shellscript",
      "console",
    ];

    if (nonEditableTypes.includes(document.languageId)) {
      log(`Skipping non-editable language: ${document.languageId}`);
      return false;
    }

    // Additional check: only allow actual programming languages
    const programmingLanguages = [
      "javascript",
      "typescript",
      "java",
      "python",
      "csharp",
      "c",
      "cpp",
      "go",
      "rust",
      "ruby",
      "php",
      "swift",
      "kotlin",
      "scala",
      "dart",
      "html",
      "css",
      "vue",
      "jsx",
      "tsx",
    ];

    if (!programmingLanguages.includes(document.languageId)) {
      log(`Document language not in allowed list: ${document.languageId}`);
    }

    log(`Document accepted as editable: ${document.uri.toString()}`);
    return true;
  } catch (error) {
    log(`Error in isEditableDocument: ${error.message}`);
    return false;
  }
}

// Add this function to your extension.js
function setupKeyboardTracking(context) {
  log("Setting up keyboard tracking");

  // Listen for key presses with event listener instead of overriding the type command
  const keyboardDisposable = vscode.workspace.onDidChangeTextDocument(
    (event) => {
      // Only check for potential paste operations
      if (!event.contentChanges.length || !vscode.window.activeTextEditor)
        return;

      // Look for paste patterns without blocking normal typing
      const change = event.contentChanges[0];
      if (change.text === "v") {
        const now = Date.now();
        if (now - lastKeypressTime < 300) {
          // This is likely Ctrl+V
          lastPasteKeyCombination = true;
          log("Potential paste operation detected");
          // Reset after a short delay
          setTimeout(() => {
            lastPasteKeyCombination = false;
          }, 500);
        }
      }

      lastKeypressTime = Date.now();
    }
  );

  context.subscriptions.push(keyboardDisposable);
}

// Add this near the top with your other imports
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes in milliseconds

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

  // Register periodic sync with a counter
  let syncCounter = 0;
  const syncInterval = setInterval(() => {
    syncCounter++;
    log(`Running scheduled sync #${syncCounter} to leaderboard`);

    submitToLeaderboard().catch((err) => {
      log(`Scheduled sync #${syncCounter} failed: ${err.message}`);
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

// Add this function to submit data to the leaderboard
const submitToLeaderboard = async () => {
  // Get server URL from settings or use default
  const config = vscode.workspace.getConfiguration("copyjedi");
  const serverUrl =
    config.get("leaderboardApiUrl") ||
    config.get("leaderboardServerUrl") ||
    "https://api.copyjedi.com"; // Updated to a real endpoint

  // Get OS and VS Code info
  const os = process.platform;
  const vsCodeVersion = vscode.version;

  log(`Attempting to submit to leaderboard at: ${serverUrl}/api/submit`);

  // If we're in offline mode and the retry interval hasn't elapsed, queue the submission
  if (offlineMode) {
    const now = Date.now();
    // Check if enough time has passed to try reconnecting (30 minutes)
    if (now - lastConnectionAttempt < 30 * 60 * 1000) {
      log("In offline mode, queueing submission for later");
      // Store for later submission
      pendingSubmissions.push({ ...pasteStats, timestamp: now });
      vscode.window.showInformationMessage(
        "CopyJedi: Currently in offline mode. Your stats will be submitted when connection is restored."
      );
      updateSyncStatusBarItem();
      return false;
    } else {
      // Enough time has passed, let's try reconnecting
      log("Attempting to reconnect after offline period");
    }
  }

  try {
    // Mark connection attempt time
    lastConnectionAttempt = Date.now();

    // Check if server is available before attempting submission
    try {
      log("Performing server health check");
      const healthCheck = await fixedFetch(`${serverUrl}/api/health`, {
        method: "GET",
        timeout: 5000, // 5 second timeout
      });

      if (!healthCheck.ok) {
        log(`Leaderboard server health check failed: ${healthCheck.status}`);
        offlineMode = true;
        updateSyncStatusBarItem();
        throw new Error(`Server returned status ${healthCheck.status}`);
      }

      // We're online! Reset offline mode
      if (offlineMode) {
        log("Server is back online!");
        offlineMode = false;
        updateSyncStatusBarItem();
      }
    } catch (healthError) {
      log(`Leaderboard server is not available: ${healthError.message}`);
      offlineMode = true;
      updateSyncStatusBarItem();

      // Store for later submission
      pendingSubmissions.push({ ...pasteStats, timestamp: Date.now() });

      // Show a more user-friendly message
      vscode.window.showInformationMessage(
        "CopyJedi: Leaderboard server is currently unreachable. Your stats will be saved and submitted later."
      );
      return false;
    }

    // If we have pending submissions, try to send the latest one first
    if (pendingSubmissions.length > 0 && !offlineMode) {
      log(
        `Attempting to submit ${pendingSubmissions.length} pending submissions`
      );

      // For simplicity, just send the latest stats which include cumulative totals
      // A more complex implementation could merge all pending submissions
      vscode.window.showInformationMessage(
        "CopyJedi: Submitting pending stats to leaderboard..."
      );
    }

    // Log the request body for debugging
    const requestBody = {
      userId: pasteStats.userId,
      totalPastes: pasteStats.totalPastes,
      totalLinesPasted: pasteStats.totalLinesPasted,
      date: pasteStats.date,
      os: os,
      vsCodeVersion: vsCodeVersion,
      // Add a timestamp to help with debugging
      timestamp: new Date().toISOString(),
    };
    log(`Request body: ${JSON.stringify(requestBody)}`);

    // Use the fixed fetch implementation
    const response = await fixedFetch(`${serverUrl}/api/submit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      timeout: 10000, // 10 second timeout
    });

    log(`Response status: ${response.status}`);

    if (response.ok) {
      const data = await response.json();
      log(`Success response: ${JSON.stringify(data)}`);

      // Clear pending submissions since we've successfully submitted
      if (pendingSubmissions.length > 0) {
        pendingSubmissions = [];
        vscode.window.showInformationMessage(
          "CopyJedi: All pending stats submitted successfully!"
        );
      } else {
        vscode.window.showInformationMessage(
          "CopyJedi: Stats submitted successfully to leaderboard!"
        );
      }

      // Ensure offline mode is set to false on successful submission
      offlineMode = false;
      updateSyncStatusBarItem();
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

    // Mark as offline if we get connection errors
    offlineMode = true;
    updateSyncStatusBarItem();

    // Queue the submission for later
    pendingSubmissions.push({ ...pasteStats, timestamp: Date.now() });

    vscode.window.showInformationMessage(
      `CopyJedi: Unable to reach leaderboard server. Your stats will be saved and submitted later.`
    );
    return false;
  }
};

// Replace your existing onDidChangeTextDocument event handler with this:
function setupPasteTracking(context) {
  log("Setting up paste tracking");

  const pasteEventDisposable = vscode.workspace.onDidChangeTextDocument(
    async (event) => {
      try {
        if (!isTracking) {
          return;
        }

        // Only proceed if we have an active text editor
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
          return;
        }

        // Only process events from the active editor
        if (
          event.document.uri.toString() !== activeEditor.document.uri.toString()
        ) {
          return;
        }

        // Only track changes in actual editor documents, not output/debug/etc.
        const doc = event.document;
        if (!isEditableDocument(doc)) {
          return;
        }

        // Check if this document is an actual code file
        if (!hasCodePatterns(doc.getText().substring(0, 1000))) {
          log("Document doesn't contain code patterns, skipping");
          return;
        }

        // Throttle updates (don't process if less than 300ms since last edit)
        const now = Date.now();
        if (now - lastEditTime < 300) {
          return;
        }
        lastEditTime = now;

        // Only log document changes when debugging is enabled
        const config = vscode.workspace.getConfiguration("copyjedi");
        const debugMode = config.get("debugMode") || false;

        if (debugMode) {
          log(`Document changed: ${doc.uri.toString()}`);
          log(`Change count: ${event.contentChanges.length}`);
        }

        if (event.contentChanges.length === 0) return;

        // Using vscode.window directly instead of assigning to variable
        const clipboard = await vscode.env.clipboard.readText();

        for (const change of event.contentChanges) {
          // Skip very small changes (likely not pastes)
          if (change.text.length < 5 && !change.text.includes("\n")) {
            continue;
          }

          // Only log changes in debug mode to avoid console spam
          if (debugMode) {
            const previewText = change.text
              .substring(0, 20)
              .replace(/\n/g, "\\n");
            log(
              `Change detected - length: ${change.text.length}, preview: "${previewText}..."`
            );
          }

          // Check if this is actually a paste event using our detection
          const detectedPaste = isProbablyPaste(change, clipboard);

          const isPaste =
            detectedPaste ||
            (lastPasteKeyCombination &&
              (change.text.length > 10 || change.text.includes("\n")));

          if (isPaste) {
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
              `CopyJedi: Pasted ${lineCount} line${
                lineCount !== 1 ? "s" : ""
              }! Total: ${pasteStats.totalPastes}`
            );

            // Reset keyboard detection
            lastPasteKeyCombination = false;

            // Break out of the loop to avoid multiple counts for complex pastes
            break;
          }
        }
      } catch (error) {
        log(`Error in paste tracking: ${error.message}`);
        console.error("Error in paste tracking:", error);
      }
    }
  );

  context.subscriptions.push(pasteEventDisposable);
}

// Add status bar item
function setupStatusBar() {
  try {
    // Create status bar item for paste tracking
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    statusBarItem.command = "copyjedi.toggleTracking";
    statusBarItem.tooltip = "Toggle CopyJedi paste tracking";

    // Create sync button in status bar
    syncStatusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      99 // Position it right next to the paste tracking button
    );
    syncStatusBarItem.command = "copyjedi.submitToLeaderboard";
    syncStatusBarItem.text = "$(cloud-upload)";
    syncStatusBarItem.tooltip = "Sync paste stats to leaderboard";
    syncStatusBarItem.show();

    // Set initial text
    updateStatusBar();

    // Show it
    statusBarItem.show();

    log("Status bar initialized");
  } catch (error) {
    log(`Error setting up status bar: ${error.message}`);
  }
}

// Update status bar with current statistics
function updateStatusBar() {
  if (statusBarItem) {
    statusBarItem.text = isTracking
      ? `$(clippy) Pastes: ${pasteStats.totalPastes} | Lines: ${pasteStats.totalLinesPasted}`
      : `$(clippy) Tracking Off`;
  }
}

// Update sync status bar item
function updateSyncStatusBarItem() {
  if (syncStatusBarItem) {
    // Check if leaderboard client exists and use its status if available
    const isOffline = leaderboardClient
      ? leaderboardClient.offlineMode
      : offlineMode;

    if (isOffline) {
      syncStatusBarItem.text = "$(cloud-offline) Offline";
      syncStatusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      syncStatusBarItem.tooltip = `Offline mode: ${pendingSubmissions.length} submission(s) pending. Will retry connection automatically.`;
    } else {
      syncStatusBarItem.text = "$(cloud-upload) Online";
      syncStatusBarItem.backgroundColor = undefined;
      syncStatusBarItem.tooltip =
        "Leaderboard connection active. Click to sync stats manually.";
    }

    // Force the status bar item to update visually
    syncStatusBarItem.show();
  }
}

// Register extension commands
function registerCommands(context) {
  try {
    // Toggle paste tracking
    const toggleTrackingCommand = vscode.commands.registerCommand(
      "copyjedi.toggleTracking",
      () => {
        isTracking = !isTracking;
        updateStatusBar();
        vscode.window.showInformationMessage(
          `CopyJedi: Paste tracking ${isTracking ? "enabled" : "disabled"}`
        );
        log(`Tracking toggled: ${isTracking}`);
      }
    );

    // Reset paste statistics
    const resetStatsCommand = vscode.commands.registerCommand(
      "copyjedi.resetStats",
      () => {
        // Preserve userId but reset all stats
        const userId = pasteStats.userId;
        pasteStats = {
          totalPastes: 0,
          totalLinesPasted: 0,
          date: new Date().toDateString(),
          userId: userId,
        };
        savePasteStats();
        updateStatusBar();
        vscode.window.showInformationMessage("CopyJedi: Statistics reset");
        log("Statistics reset");
      }
    );

    // Submit to leaderboard (manual)
    const submitToLeaderboardCommand = vscode.commands.registerCommand(
      "copyjedi.submitToLeaderboard",
      () => {
        vscode.window.showInformationMessage(
          "CopyJedi: Submitting to leaderboard..."
        );

        // Make sure leaderboard is enabled in settings
        const config = vscode.workspace.getConfiguration("copyjedi");
        config.update("leaderboardEnabled", true, true).then(() => {
          log("Leaderboard enabled in settings");

          // Try using the LeaderboardClient first
          if (leaderboardClient) {
            // Re-initialize the client to pick up new settings
            leaderboardClient.initialize();

            leaderboardClient
              .submitStats(pasteStats)
              .then((success) => {
                if (success) {
                  log("Leaderboard submission via client successful");
                } else {
                  // If the client submission fails, fall back to direct method
                  log(
                    "Leaderboard client submission failed, trying direct method"
                  );
                  return submitToLeaderboard();
                }
              })
              .catch((error) => {
                log(`LeaderboardClient submission error: ${error.message}`);
                // Fall back to direct submission method
                log("Falling back to direct submission method");
                return submitToLeaderboard();
              });
          } else {
            // If client isn't available, use direct method
            submitToLeaderboard()
              .then((success) => {
                log(
                  `Manual leaderboard submission completed: ${
                    success ? "success" : "failed"
                  }`
                );
              })
              .catch((error) => {
                log(`Manual leaderboard submission failed: ${error.message}`);
              });
          }
        });
      }
    );

    // Configure leaderboard server
    const configureServerCommand = vscode.commands.registerCommand(
      "copyjedi.configureLeaderboard",
      async () => {
        if (leaderboardClient) {
          await leaderboardClient.configureServer();
        } else {
          vscode.window.showErrorMessage(
            "CopyJedi: Leaderboard client not available"
          );
        }
      }
    );

    // Test command for debugging
    const testCommand = vscode.commands.registerCommand("copyjedi.test", () => {
      vscode.window.showInformationMessage("CopyJedi test command working!");
      log("Test command executed");
    });

    // Add check server command
    const checkServerCommand = vscode.commands.registerCommand(
      "copyjedi.checkServer",
      async () => {
        try {
          // Show a notification to confirm the command is running
          vscode.window.showInformationMessage(
            "CopyJedi: Checking server connection..."
          );

          outputChannel.show(true); // Force show the output channel
          log("============ SERVER CHECK STARTED ============");
          log(`Extension version: 0.1.0 (Debug enabled)`);
          log(`Running on: ${process.platform}, Node: ${process.version}`);

          // Get server URL from settings
          const config = vscode.workspace.getConfiguration("copyjedi");
          const serverUrl =
            config.get("leaderboardApiUrl") ||
            config.get("leaderboardServerUrl") ||
            "http://localhost:3000";

          log(`Server URL: ${serverUrl}`);

          // Try multiple test methods

          // METHOD 1: Direct URL check without fetch
          try {
            log("METHOD 1: Testing basic URL connectivity...");
            const http = require("http");
            const https = require("https");

            // Choose correct module based on URL
            const protocol = serverUrl.startsWith("https") ? https : http;

            // Create a simple request
            const urlObj = new URL(serverUrl);
            log(
              `Connecting to ${urlObj.hostname}:${
                urlObj.port || (urlObj.protocol === "https:" ? 443 : 80)
              }`
            );

            const reqPromise = new Promise((resolve, reject) => {
              const req = protocol.get(urlObj, (res) => {
                log(
                  `METHOD 1 RESULT: Connection successful, status: ${res.statusCode}`
                );
                resolve(true);
              });

              req.on("error", (err) => {
                log(`METHOD 1 ERROR: ${err.message}`);
                reject(err);
              });

              req.setTimeout(5000, () => {
                req.destroy(new Error("Timeout after 5000ms"));
                log(`METHOD 1 ERROR: Connection timeout`);
                reject(new Error("Connection timeout"));
              });
            });

            await reqPromise;
          } catch (method1Error) {
            log(`METHOD 1 FAILED: ${method1Error.message}`);
          }

          // METHOD 2: Native fetch API check
          try {
            log("METHOD 2: Testing with built-in fetch...");
            log(`Sending request to: ${serverUrl}/api/health`);

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);

            const response = await globalThis.fetch(`${serverUrl}/api/health`, {
              method: "GET",
              signal: controller.signal,
              headers: {
                "User-Agent": `VSCode-CopyJedi/${vscode.version}`,
                Accept: "application/json",
                "X-Debug-Mode": "true",
              },
            });

            clearTimeout(timeoutId);

            log(`METHOD 2 RESULT: Status: ${response.status}`);
            const responseText = await response.text();
            log(`Response body: ${responseText}`);

            if (response.ok) {
              vscode.window.showInformationMessage(
                `CopyJedi server is responding! Status: ${response.status}`
              );

              // Set offlineMode to false when successful
              offlineMode = false;
              updateSyncStatusBarItem();
            } else {
              throw new Error(`Server returned error: ${response.status}`);
            }
          } catch (method2Error) {
            log(`METHOD 2 FAILED: ${method2Error.message}`);

            // METHOD 3: Try with node-fetch as fallback
            try {
              log("METHOD 3: Testing with node-fetch...");
              const nodeFetch = require("node-fetch");

              const response = await nodeFetch(`${serverUrl}/api/health`, {
                method: "GET",
                timeout: 5000,
                headers: {
                  "User-Agent": `VSCode-CopyJedi/${vscode.version}`,
                  Accept: "application/json",
                  "X-Debug-Mode": "true",
                },
              });

              log(`METHOD 3 RESULT: Status: ${response.status}`);
              const responseText = await response.text();
              log(`Response body: ${responseText}`);

              if (response.ok) {
                vscode.window.showInformationMessage(
                  `CopyJedi server is responding (method 3)! Status: ${response.status}`
                );

                offlineMode = false;
                updateSyncStatusBarItem();
              } else {
                throw new Error(`Server returned error: ${response.status}`);
              }
            } catch (method3Error) {
              log(`METHOD 3 FAILED: ${method3Error.message}`);
              vscode.window.showErrorMessage(
                `Server check failed with all methods. See output log for details.`
              );
              offlineMode = true;
              updateSyncStatusBarItem();
            }
          }

          log("============ SERVER CHECK COMPLETED ============");
        } catch (error) {
          log(`Server check uncaught error: ${error.message}`);
          log(`Error stack: ${error.stack}`);
          vscode.window.showErrorMessage(
            `Server check failed: ${error.message}`
          );
          offlineMode = true;
          updateSyncStatusBarItem();
        }
      }
    );

    // Add all commands to subscriptions
    context.subscriptions.push(
      toggleTrackingCommand,
      resetStatsCommand,
      submitToLeaderboardCommand,
      configureServerCommand,
      testCommand,
      checkServerCommand
    );

    log("Commands registered successfully");
  } catch (error) {
    log(`Error registering commands: ${error.message}`);
  }
}

function activate(context) {
  try {
    log("CopyJedi activation started");

    // Store the global storage path
    globalStoragePath = context.globalStoragePath;

    // Create the stats directory if it doesn't exist
    if (!fs.existsSync(globalStoragePath)) {
      fs.mkdirSync(globalStoragePath, { recursive: true });
    }

    // Reset offline mode when extension activates
    offlineMode = false;
    log("Forced offline mode to false on startup");

    // Initialize LeaderboardClient
    leaderboardClient = new LeaderboardClient(context);
    leaderboardClient.initialize();
    log("LeaderboardClient initialized");

    // Force status update to show online
    updateSyncStatusBarItem();

    // Load saved stats
    loadPasteStats();

    // Setup the status bar
    setupStatusBar();

    // Register commands
    registerCommands(context);

    // Set up paste tracking
    setupPasteTracking(context);

    // Set up keyboard tracking
    setupKeyboardTracking(context);

    // Start auto sync process
    startAutoSync(context);

    // Force a server check after a short delay
    setTimeout(() => {
      log("Performing initial server status check");
      vscode.commands.executeCommand("copyjedi.checkServer");
    }, 3000);

    log("CopyJedi activated successfully");
  } catch (error) {
    console.error("Error activating CopyJedi:", error);
    log(`Activation error: ${error.message}`);
  }
}

// This method is called when your extension is deactivated
function deactivate() {
  log("CopyJedi is deactivating");

  // Clean up status bar items
  if (statusBarItem) {
    statusBarItem.dispose();
  }

  if (syncStatusBarItem) {
    syncStatusBarItem.dispose();
  }

  // Note: pasteEventDisposable is automatically cleaned up by VSCode
  // when it's added to context.subscriptions in the setupPasteTracking function

  // Clean up the leaderboard client
  if (leaderboardClient) {
    leaderboardClient.dispose();
    log("LeaderboardClient disposed");
  }

  log("CopyJedi deactivated");
}

module.exports = {
  activate,
  deactivate,
};
