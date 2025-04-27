# CopyJedi

Track your copy-paste habits in VSCode with CopyJedi! This extension helps you keep track of how many times you've pasted code and how many lines you've pasted in your coding sessions.

## Features

- **Track Number of Pastes**: Counts each paste event in your editor
- **Track Number of Lines Pasted**: Calculates the total lines of code you've pasted
- **Persistent Tracking**: Your stats persist even if you restart VSCode
- **Daily Reset**: Stats automatically reset each day
- **Status Bar Integration**: See your paste stats at a glance
- **Leaderboard Ready**: Future support for a global paste leaderboard

## Usage

Once installed, CopyJedi automatically starts tracking your paste activity. You'll see a notification each time you paste content, showing the number of lines pasted and your running totals.

### Commands

CopyJedi provides the following commands (accessible via Command Palette):

- `CopyJedi: Toggle Paste Tracking` - Enable or disable tracking
- `CopyJedi: Reset Paste Statistics` - Reset your current stats
- `CopyJedi: Submit Stats to Leaderboard` - Submit your stats to the global leaderboard (when available)

### Status Bar

The extension adds an item to your status bar showing your current paste stats. Click on it to toggle tracking on/off.

## Extension Settings

This extension contributes the following settings:

- `copyjedi.enableNotifications`: Enable/disable paste notifications
- `copyjedi.autoResetDaily`: Enable/disable automatic daily reset of statistics
- `copyjedi.leaderboardEnabled`: Enable/disable submission to the global leaderboard
- `copyjedi.leaderboardApiUrl`: Set the API URL for the global leaderboard

## Global Leaderboard

A global leaderboard feature is planned for future releases. This will allow you to compare your paste habits with other developers around the world!

## Known Issues

- The extension may occasionally count large text edits as pastes
- Performance impact should be minimal, but please report any issues

## Release Notes

### 0.1.0

Initial release of CopyJedi with basic paste tracking functionality.

---

**May the paste be with you!**