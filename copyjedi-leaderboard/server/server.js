require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const rateLimit = require("express-rate-limit");
const app = express();
const port = process.env.PORT || 3000;

// Database connection
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 30000, // Increase timeout to 30 seconds
  socketTimeoutMS: 45000,
});

// Define schema for user paste statistics
const PasteStatsSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true,
    index: true,
  },
  totalPastes: {
    type: Number,
    default: 0,
  },
  totalLinesPasted: {
    type: Number,
    default: 0,
  },
  dailyStats: [
    {
      date: String,
      pastes: Number,
      lines: Number,
    },
  ],
  lastActive: {
    type: Date,
    default: Date.now,
  },
  username: {
    type: String,
    default: null,
  },
  os: String,
  vsCodeVersion: String,
});

const PasteStats = mongoose.model("PasteStats", PasteStatsSchema);

// Add this to your server.js after initializing MongoDB
async function monitorChanges() {
  try {
    const changeStream = PasteStats.watch();

    changeStream.on("change", (change) => {
      console.log(
        `[${new Date().toLocaleTimeString()}] Database change detected:`,
        change.operationType
      );

      // Log details about the update
      if (change.operationType === "update") {
        console.log(`Updated user: ${change.documentKey._id}`);
        console.log(
          "Fields updated:",
          Object.keys(change.updateDescription.updatedFields)
        );
      }
    });

    console.log("MongoDB change stream monitoring enabled");
  } catch (error) {
    console.error("Failed to set up change stream:", error);
  }
}

monitorChanges().catch(console.error);

// Middleware
app.use(
  cors({
    origin: "*", // Allow all origins during development
  })
);
app.use(express.json());

// Add this before your routes
app.use((req, res, next) => {
  try {
    next();
  } catch (error) {
    console.error("Route error:", error);
    res.status(500).send("Server error");
  }
});

// Rate limiter middleware
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later",
});

// Apply to all API endpoints
app.use("/api/", apiLimiter);

// Serve static files from the React app
app.use(express.static(path.join(__dirname, "../client/build")));

// API Routes

// Submit stats
app.post("/api/submit", async (req, res) => {
  try {
    const { userId, totalPastes, totalLinesPasted, date, os, vsCodeVersion } =
      req.body;

    // Find or create the user
    let userStats = await PasteStats.findOne({ userId });

    if (!userStats) {
      userStats = new PasteStats({
        userId,
        totalPastes,
        totalLinesPasted,
        os,
        vsCodeVersion,
        date,
      });
    } else {
      // Update existing record
      userStats.totalPastes = totalPastes;
      userStats.totalLinesPasted = totalLinesPasted;
      userStats.lastActive = new Date();

      // Update OS and VS Code version if provided
      if (os) userStats.os = os;
      if (vsCodeVersion) userStats.vsCodeVersion = vsCodeVersion;

      // Optional: Update daily stats
      const today = new Date().toISOString().split("T")[0];
      const existingDayIndex = userStats.dailyStats.findIndex(
        (item) => item.date === today
      );

      if (existingDayIndex >= 0) {
        userStats.dailyStats[existingDayIndex].pastes = totalPastes;
        userStats.dailyStats[existingDayIndex].lines = totalLinesPasted;
      } else {
        userStats.dailyStats.push({
          date: today,
          pastes: totalPastes,
          lines: totalLinesPasted,
        });
        // Keep only the last 30 days of daily stats
        if (userStats.dailyStats.length > 30) {
          userStats.dailyStats = userStats.dailyStats.slice(-30);
        }
      }
    }

    // Save to database with upsert
    await userStats.save();

    res.status(200).json({ message: "Stats saved successfully" });
  } catch (error) {
    console.error("Error submitting stats:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Get leaderboard
app.get("/api/leaderboard", async (req, res) => {
  try {
    const { limit = 100, sort = "totalPastes", userId } = req.query;

    // Validate sort field
    const validSortFields = ["totalPastes", "totalLinesPasted", "lastActive"];
    const sortField = validSortFields.includes(sort) ? sort : "totalPastes";

    // Get leaderboard data
    const leaderboard = await PasteStats.find()
      .sort({ [sortField]: -1 })
      .limit(parseInt(limit))
      .select("userId totalPastes totalLinesPasted lastActive username")
      .lean();

    // Add flag for current user if userId is provided
    if (userId) {
      leaderboard.forEach((entry) => {
        entry.isCurrentUser = entry.userId === userId;
      });

      // Check if current user is in the leaderboard
      const userInLeaderboard = leaderboard.some(
        (entry) => entry.userId === userId
      );

      // If not, get their stats and position
      if (!userInLeaderboard) {
        const userStats = await PasteStats.findOne({ userId })
          .select("userId totalPastes totalLinesPasted lastActive username")
          .lean();

        if (userStats) {
          // Get user's rank
          const count = await PasteStats.countDocuments({
            [sortField]: { $gt: userStats[sortField] },
          });

          userStats.rank = count + 1;
          userStats.isCurrentUser = true;

          // Add to response
          leaderboard.push(userStats);
        }
      }
    }

    res.status(200).json(leaderboard);
  } catch (error) {
    console.error("Error fetching leaderboard:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Get user stats
app.get("/api/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const userStats = await PasteStats.findOne({ userId })
      .select(
        "-_id userId totalPastes totalLinesPasted dailyStats lastActive username"
      )
      .lean();

    if (!userStats) {
      return res.status(404).json({ error: "User not found" });
    }

    res.status(200).json(userStats);
  } catch (error) {
    console.error("Error fetching user stats:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Set username
app.post("/api/user/:userId/username", async (req, res) => {
  try {
    const { userId } = req.params;
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({ error: "Username is required" });
    }

    const userStats = await PasteStats.findOne({ userId });

    if (!userStats) {
      return res.status(404).json({ error: "User not found" });
    }

    userStats.username = username;
    await userStats.save();

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error setting username:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Get global stats
app.get("/api/stats", async (req, res) => {
  try {
    const result = await PasteStats.aggregate([
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          globalPastes: { $sum: "$totalPastes" },
          globalLines: { $sum: "$totalLinesPasted" },
          avgPastesPerUser: { $avg: "$totalPastes" },
          avgLinesPerUser: { $avg: "$totalLinesPasted" },
        },
      },
    ]);

    if (result.length === 0) {
      return res.status(200).json({
        totalUsers: 0,
        globalPastes: 0,
        globalLines: 0,
        avgPastesPerUser: 0,
        avgLinesPerUser: 0,
      });
    }

    res.status(200).json(result[0]);
  } catch (error) {
    console.error("Error fetching global stats:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Add this code to help debug the connection issue

// Update your submitToLeaderboard function to add error details

// Add this to your server.js
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>CopyJedi Leaderboard</title>
        <style>
          /* styles unchanged */
        </style>
      </head>
      <body>
        <h1>CopyJedi Leaderboard</h1>
        <p>Visit <a href="/leaderboard">/leaderboard</a> to see the full statistics.</p>
        <p>API endpoints:</p>
        <ul>
          <li><a href="/api/stats">/api/stats</a> - Global statistics</li>
          <li><a href="/api/leaderboard">/api/leaderboard</a> - Top users</li>
        </ul>
      </body>
    </html>
  `);
});

// Add this route to display a simple leaderboard
app.get("/leaderboard", async (req, res) => {
  try {
    const users = await PasteStats.find().sort({ totalPastes: -1 }).limit(10);

    const stats = await PasteStats.aggregate([
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          globalPastes: { $sum: "$totalPastes" },
          globalLines: { $sum: "$totalLinesPasted" },
          avgPastesPerUser: { $avg: "$totalPastes" },
          avgLinesPerUser: { $avg: "$totalLinesPasted" },
        },
      },
    ]);

    const globalStats =
      stats.length > 0
        ? stats[0]
        : {
            totalUsers: 0,
            globalPastes: 0,
            globalLines: 0,
            avgPastesPerUser: 0,
            avgLinesPerUser: 0,
          };

    res.send(`
      <html>
        <head>
          <title>CopyJedi Leaderboard</title>
          <style>
            body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
            h1, h2 { color: #2C974B; }
            .stats { background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; }
            th, td { text-align: left; padding: 8px; border-bottom: 1px solid #ddd; }
            th { background-color: #2C974B; color: white; }
            tr:nth-child(even) { background-color: #f9f9f9; }
            tr:hover { background-color: #f1f1f1; }
          </style>
        </head>
        <body>
          <h1>CopyJedi Leaderboard</h1>
          
          <h2>Global Statistics</h2>
          <div class="stats">
            <p>Total Users: ${globalStats.totalUsers}</p>
            <p>Total Pastes: ${globalStats.globalPastes}</p>
            <p>Total Lines Pasted: ${globalStats.globalLines}</p>
            <p>Average Pastes Per User: ${
              Math.round(globalStats.avgPastesPerUser * 10) / 10
            }</p>
            <p>Average Lines Per User: ${
              Math.round(globalStats.avgLinesPerUser * 10) / 10
            }</p>
          </div>
          
          <h2>Top Users</h2>
          <table>
            <tr>
              <th>Rank</th>
              <th>User</th>
              <th>Pastes</th>
              <th>Lines</th>
              <th>Last Active</th>
              <th>OS</th>
            </tr>
            ${users
              .map(
                (user, index) => `
              <tr>
                <td>${index + 1}</td>
                <td>${user.username || user.userId}</td>
                <td>${user.totalPastes}</td>
                <td>${user.totalLinesPasted}</td>
                <td>${new Date(user.lastActive).toLocaleString()}</td>
                <td>${user.os || "Unknown"}</td>
              </tr>
            `
              )
              .join("")}
          </table>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Error generating leaderboard:", error);
    res.status(500).send("Error generating leaderboard");
  }
});

// Add this route to check sync status
app.get("/api/syncStatus/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const userStats = await PasteStats.findOne({ userId });

    if (!userStats) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const lastSync = userStats.lastActive;
    const now = new Date();
    const timeSinceLastSync = Math.round((now - lastSync) / 1000);

    return res.status(200).json({
      lastSync,
      timeSinceLastSync: `${timeSinceLastSync} seconds`,
      lastStats: {
        totalPastes: userStats.totalPastes,
        totalLinesPasted: userStats.totalLinesPasted,
      },
    });
  } catch (error) {
    console.error("Error checking sync status:", error);
    res.status(500).json({ error: "Server error" });
  }
});

// Replace your catchall handler with this simpler version
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "../client/build/index.html"));
});

// Start server
app.listen(port, () => {
  console.log(`CopyJedi leaderboard API running on port ${port}`);
});

module.exports = app; // For testing
