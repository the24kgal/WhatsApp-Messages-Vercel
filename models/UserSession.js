const mongoose = require("mongoose");

const userSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true, // WhatsApp user ID (e.g., 923001234567@c.us)
      index: true,
    },
    liveChatEnabled: {
      type: Boolean,
      default: false, // User has selected Live Chat option
    },
    // If user chose Talk To Us, we suppress auto prompts
    talkToUsSelected: {
      type: Boolean,
      default: false,
    },
    // When we last sent the welcome/options prompt
    promptedAt: {
      type: Date,
      default: null,
    },
    lastInteraction: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true, // Automatically adds createdAt and updatedAt
  }
);

// Indexes for faster queries
userSessionSchema.index({ userId: 1 });
userSessionSchema.index({ lastInteraction: 1 });

const UserSession = mongoose.model("UserSession", userSessionSchema);

module.exports = UserSession;
