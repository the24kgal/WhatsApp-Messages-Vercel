const mongoose = require("mongoose");

const contactSchema = new mongoose.Schema(
  {
    jid: {
      type: String,
      required: true,
      unique: true, // WhatsApp JID (e.g. 923001234567@c.us or 123456@g.us)
      index: true,
    },
    number: {
      type: String,
      index: true,
      default: null, // Clean digits (e.g. 923001234567)
    },
    formattedNumber: {
      type: String,
      default: null, // International formatted string (+92 300 1234567)
    },
    name: {
      type: String,
      default: "Unknown",
      index: true,
    },
    pushname: {
      type: String,
      default: null,
    },
    savedName: {
      type: String,
      default: null,
    },
    type: {
      type: String,
      enum: ["individual", "group", "community", "broadcast", "unknown"],
      default: "individual",
      index: true,
    },
    isMyContact: {
      type: Boolean,
      default: false, // True if saved in address book
      index: true,
    },
    isBusiness: {
      type: Boolean,
      default: false, // True if WhatsApp Business account
      index: true,
    },
    isEnterprise: {
      type: Boolean,
      default: false,
    },
    isUser: {
      type: Boolean,
      default: true,
    },
    isGroup: {
      type: Boolean,
      default: false,
      index: true,
    },
    isCommunity: {
      type: Boolean,
      default: false,
      index: true,
    },
    countryCode: {
      type: String,
      default: "UNKNOWN", // ISO 2-letter country code (PK, US, GB, IN, etc.)
      index: true,
    },
    country: {
      type: String,
      default: "Unknown", // Full country name (Pakistan, United States, etc.)
      index: true,
    },
    callingCode: {
      type: String,
      default: null, // e.g. 92, 1, 44
    },
    location: {
      country: { type: String, default: "Unknown" },
      countryCode: { type: String, default: "UNKNOWN" },
      callingCode: { type: String, default: null },
    },
    source: {
      type: String,
      enum: ["contact_book", "chat", "group_participant", "community", "manual"],
      default: "contact_book",
    },
    groupInfo: {
      subject: { type: String, default: null },
      description: { type: String, default: null },
      participantCount: { type: Number, default: 0 },
      isParentGroup: { type: Boolean, default: false },
      parentGroupId: { type: String, default: null },
    },
    tags: [
      {
        type: String,
      },
    ],
    lastSyncedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound indexes for high-speed segregation queries
contactSchema.index({ countryCode: 1, isBusiness: 1 });
contactSchema.index({ type: 1, isBusiness: 1 });
contactSchema.index({ isMyContact: 1, isBusiness: 1 });
contactSchema.index({ country: 1, isMyContact: 1 });
contactSchema.index({ updatedAt: -1 });

const Contact = mongoose.model("Contact", contactSchema);

module.exports = Contact;
