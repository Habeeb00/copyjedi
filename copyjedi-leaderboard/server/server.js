require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
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

// Middleware
app.use(cors());
app.use(express.json());

// API Routes

// Submit stats
app.post("/api/submit", async (req, res) => {
  try {
    const { userId, totalPastes, totalLinesPasted, date, os, vsCodeVersion } =
      req.body;

    if (
      !userId ||
      totalPastes === undefined ||
      totalLinesPasted === undefined
    ) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Find or create user stats
    let userStats = await PasteStats.findOne({ userId });

    if (!userStats) {
      userStats = new PasteStats({
        userId,
        totalPastes,
        totalLinesPasted,
        dailyStats: [
          {
            date,
            pastes: totalPastes,
            lines: totalLinesPasted,
          },
        ],
        os,
        vsCodeVersion,
      });
    } else {
      // Update existing stats
      userStats.totalPastes = totalPastes;
      userStats.totalLinesPasted = totalLinesPasted;
      userStats.lastActive = new Date();

      // Update OS and VSCode version if provided
      if (os) userStats.os = os;
      if (vsCodeVersion) userStats.vsCodeVersion = vsCodeVersion;

      // Add or update daily stats
      const dailyStatIndex = userStats.dailyStats.findIndex(
        (stat) => stat.date === date
      );
      if (dailyStatIndex >= 0) {
        userStats.dailyStats[dailyStatIndex].pastes = totalPastes;
        userStats.dailyStats[dailyStatIndex].lines = totalLinesPasted;
      } else {
        userStats.dailyStats.push({
          date,
          pastes: totalPastes,
          lines: totalLinesPasted,
        });
      }
    }

    await userStats.save();
    res.status(200).json({ success: true });
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

// Start server
app.listen(port, () => {
  console.log(`CopyJedi leaderboard API running on port ${port}`);
});

module.exports = app; // For testing
