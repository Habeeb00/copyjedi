const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

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
    statusBarItem.text = `$(clippy) Pastes: ${pasteStats.totalPastes} | Lines: ${pasteStats.totalLinesPasted}`;
  }
};

// Setup tracking of paste events
const setupPasteTracking = (context) => {
  try {
    if (pasteEventDisposable) {
      pasteEventDisposable.dispose();
    }

    log("Setting up paste tracking");

    pasteEventDisposable = vscode.workspace.onDidChangeTextDocument((event) => {
      try {
        if (!isTracking) {
          log("Change detected but tracking is disabled");
          return;
        }
        
        // Log details for debugging
        log(`Document changed: ${event.document.uri.toString()}`);
        log(`Change count: ${event.contentChanges.length}`);
        
        if (event.contentChanges.length === 0) return;
        
        for (const change of event.contentChanges) {
          // Log the change for debugging
          log(`Change detected - length: ${change.text.length}, first chars: "${change.text.substring(0, 20).replace(/\n/g, "\\n")}"`);
          
          // Make paste detection more lenient
          // Either multiple lines or more than 10 characters
          const lineCount = change.text.split("\n").length;
          
          if (lineCount > 1 || change.text.length > 10) {
            log(`Detected paste: ${lineCount} lines, ${change.text.length} chars`);
            pasteStats.totalPastes++;
            pasteStats.totalLinesPasted += lineCount;
            
            // Show notification
            vscode.window.showInformationMessage(
              `CopyJedi: Pasted ${lineCount} line${lineCount !== 1 ? "s" : ""}! Total: ${pasteStats.totalPastes}`
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
    });

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

const submitToLeaderboard = async () => {
  // Get server URL from settings or use default
  const config = vscode.workspace.getConfiguration("copyjedi");
  const serverUrl =
    config.get("leaderboardServerUrl") || "http://localhost:3000";

  // Get OS and VS Code info
  const os = process.platform;
  const vsCodeVersion = vscode.version;

  vscode.window.showInformationMessage(
    `CopyJedi: Submitting stats to leaderboard (User ID: ${pasteStats.userId})`
  );

  try {
    // Make API call to your server using the axios module (you'll need to install it)
    const response = await fetch(`${serverUrl}/api/submit`, {
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
      vscode.window.showInformationMessage(
        "CopyJedi: Stats submitted to leaderboard!"
      );
    } else {
      const text = await response.text();
      vscode.window.showErrorMessage(
        `CopyJedi: Failed to submit stats - ${text}`
      );
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `CopyJedi: Error submitting to leaderboard - ${error.message}`
    );
  }
};

// Activate the extension
function activate(context) {
  try {
       console.log("CopyJedi is now active!");
    log("CopyJedi activation started");

    globalStoragePath = context.globalStoragePath;

    // Create directory if it doesn't exist
    if (!fs.existsSync(globalStoragePath)) {
      log(`Creating storage directory: ${globalStoragePath}`);
      fs.mkdirSync(globalStoragePath, { recursive: true });
    }

    // Load saved statistics
    loadPasteStats();

    // Explicitly ensure tracking is on at startup
    isTracking = true;
    log(`Tracking status: ${isTracking ? "enabled" : "disabled"}`);

    // Initialize status bar
    initializeStatusBar(context);

    // Setup paste tracking
    setupPasteTracking(context);

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
      })
    );

    // Update status bar with initial values
    updateStatusBar();

    log("CopyJedi activation completed successfully");
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

// Removed misplaced "contributes" block
