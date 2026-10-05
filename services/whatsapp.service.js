const { Client, RemoteAuth, MessageMedia } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { MongoStore } = require("wwebjs-mongo");
const axios = require("axios");
const {
  getPuppeteerArgs,
  MAX_RESTART_ATTEMPTS,
} = require("../config/whatsapp");
const {
  generateQRImage,
  broadcastQRUpdate,
  setCurrentQR,
  clearCurrentQR,
} = require("./qr.service");
const UserSession = require("../models/UserSession");
const Contact = require("../models/Contact");
const {
  parsePhoneNumberDetails,
  isValidPhoneNumberGlobal,
  normalizePhoneNumber,
} = require("../utils/phoneNumber");

// n8n webhook URL
const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL ||
  "http://localhost:5678/webhook-test/4e5bc752-baf5-47d7-a227-24b7a88552c6";

let whatsappClient = null;
let isClientReady = false;
let restartAttempts = 0;
let isInitializing = false;
let store = null;

let sessionCheckInterval = null;
let activeSessionsCount = 0;

// Session timeout: 5 minutes for both Live Chat and Talk To Us
const SESSION_TIMEOUT_MINUTES = 5;
const SESSION_TIMEOUT_MS = SESSION_TIMEOUT_MINUTES * 60 * 1000;

/**
 * Start session checker only when needed
 */
function startSessionChecker() {
  if (sessionCheckInterval) {
    console.log("⚠️ Session checker already running");
    return;
  }

  console.log("🚀 Starting session checker...");
  sessionCheckInterval = setInterval(async () => {
    await checkInactiveSessions();

    // Stop interval if no active sessions
    if (activeSessionsCount === 0) {
      stopSessionChecker();
    }
  }, 60 * 1000); // Check every 60 seconds

  console.log("✅ Session checker started");
}

/**
 * Stop session checker to save resources
 */
function stopSessionChecker() {
  if (sessionCheckInterval) {
    clearInterval(sessionCheckInterval);
    sessionCheckInterval = null;
    console.log("🛑 Session checker stopped (no active sessions)");
  }
}

/**
 * Safely send a WhatsApp message to a user by id/number
 */
async function sendDirectMessage(rawUserId, text) {
  if (!whatsappClient || !isClientReady) return false;

  try {
    const userId = String(rawUserId || "").trim();
    if (!userId) return false;

    const jid = userId.endsWith("@c.us") ? userId : `${userId}@c.us`;
    const numberId = await whatsappClient.getNumberId(jid);
    const targetId = numberId?._serialized || jid;

    await whatsappClient.sendMessage(targetId, text);
    return true;
  } catch (e) {
    console.error("❌ sendDirectMessage failed:", e.message);
    return false;
  }
}

/**
 * Get or create user session
 */
async function getOrCreateUserSession(userId) {
  try {
    let session = await UserSession.findOne({ userId });
    if (!session) {
      session = new UserSession({
        userId,
        liveChatEnabled: false,
        talkToUsSelected: false,
        lastInteraction: new Date(),
      });
      await session.save();
      console.log(`📝 New session created for user: ${userId}`);
    } else {
      session.lastInteraction = new Date();
      await session.save();
    }
    return session;
  } catch (error) {
    console.error("❌ Error getting user session:", error.message);
    return {
      userId,
      liveChatEnabled: false,
      talkToUsSelected: false,
      lastInteraction: new Date(),
    };
  }
}

/**
 * Disable Live Chat for a user
 */
async function disableLiveChat(userId) {
  try {
    await UserSession.findOneAndUpdate(
      { userId },
      { liveChatEnabled: false, lastInteraction: new Date() },
      { upsert: true, new: true }
    );

    console.log(`✅ Live Chat disabled for user: ${userId}`);
    activeSessionsCount = Math.max(0, activeSessionsCount - 1);

    if (activeSessionsCount === 0 && sessionCheckInterval) {
      stopSessionChecker();
    }
  } catch (error) {
    console.error("❌ Error disabling Live Chat:", error.message);
  }
}

/**
 * Disable Talk To Us for a user
 */
async function disableTalkToUs(userId) {
  try {
    await UserSession.findOneAndUpdate(
      { userId },
      { talkToUsSelected: false, lastInteraction: new Date() },
      { upsert: true, new: true }
    );

    console.log(`✅ Talk To Us disabled for user: ${userId}`);
    activeSessionsCount = Math.max(0, activeSessionsCount - 1);

    if (activeSessionsCount === 0 && sessionCheckInterval) {
      stopSessionChecker();
    }
  } catch (error) {
    console.error("❌ Error disabling Talk To Us:", error.message);
  }
}

/**
 * Check and disable inactive sessions (both Live Chat and Talk To Us)
 */
async function checkInactiveSessions() {
  try {
    // Count active sessions
    const liveChatCount = await UserSession.countDocuments({
      liveChatEnabled: true,
    });
    const talkToUsCount = await UserSession.countDocuments({
      talkToUsSelected: true,
    });

    activeSessionsCount = liveChatCount + talkToUsCount;

    if (activeSessionsCount === 0) {
      console.log("✅ No active sessions - skipping check");
      return;
    }

    console.log(
      `🔍 Checking ${liveChatCount} Live Chat + ${talkToUsCount} Talk To Us sessions...`
    );

    const timeoutAgo = new Date(Date.now() - SESSION_TIMEOUT_MS);
    const now = new Date();

    // Check Live Chat sessions
    const inactiveLiveChatSessions = await UserSession.find({
      liveChatEnabled: true,
      lastInteraction: { $lt: timeoutAgo },
    })
      .select("userId lastInteraction")
      .lean();

    if (inactiveLiveChatSessions.length > 0) {
      console.log(
        `📊 Found ${inactiveLiveChatSessions.length} inactive Live Chat sessions`
      );

      // Bulk update
      const userIds = inactiveLiveChatSessions.map((s) => s.userId);
      await UserSession.updateMany(
        { userId: { $in: userIds } },
        {
          $set: {
            liveChatEnabled: false,
            lastInteraction: now,
          },
        }
      );

      // Send expiry messages
      let successCount = 0;
      let failCount = 0;

      for (const session of inactiveLiveChatSessions) {
        const expiryMessage = `⏰ *Session Expired*

Your Live Chat session has been automatically ended due to inactivity (${SESSION_TIMEOUT_MINUTES} minutes).

🔄 *To start again:*
Send any message or reply with:
*1️⃣* - Talk To Us
*2️⃣* - Live Chat (recommended for information)

Thank you for using our service! 😊`;

        try {
          const ok = await sendDirectMessage(session.userId, expiryMessage);
          if (ok) successCount++;
          else failCount++;
        } catch (msgError) {
          console.error(
            `❌ Error sending to ${session.userId}:`,
            msgError.message
          );
          failCount++;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      console.log(
        `✅ Live Chat expiry complete: ${successCount} sent, ${failCount} failed`
      );
    }

    // Check Talk To Us sessions (same timeout logic)
    const inactiveTalkToUsSessions = await UserSession.find({
      talkToUsSelected: true,
      lastInteraction: { $lt: timeoutAgo },
    })
      .select("userId lastInteraction")
      .lean();

    if (inactiveTalkToUsSessions.length > 0) {
      console.log(
        `📊 Found ${inactiveTalkToUsSessions.length} inactive Talk To Us sessions`
      );

      // Bulk update
      const userIds = inactiveTalkToUsSessions.map((s) => s.userId);
      await UserSession.updateMany(
        { userId: { $in: userIds } },
        {
          $set: {
            talkToUsSelected: false,
            lastInteraction: now,
          },
        }
      );

      // Send expiry messages
      let successCount = 0;
      let failCount = 0;

      for (const session of inactiveTalkToUsSessions) {
        const expiryMessage = `⏰ *Session Expired*

Your "Talk To Us" request has been automatically cleared due to inactivity (${SESSION_TIMEOUT_MINUTES} minutes).

🔄 *To start again:*
Send any message or reply with:
*1️⃣* - Talk To Us
*2️⃣* - Live Chat (recommended for information)

Thank you! 😊`;

        try {
          const ok = await sendDirectMessage(session.userId, expiryMessage);
          if (ok) successCount++;
          else failCount++;
        } catch (msgError) {
          console.error(
            `❌ Error sending to ${session.userId}:`,
            msgError.message
          );
          failCount++;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      console.log(
        `✅ Talk To Us expiry complete: ${successCount} sent, ${failCount} failed`
      );
    }

    // Update active count
    activeSessionsCount = await UserSession.countDocuments({
      $or: [{ liveChatEnabled: true }, { talkToUsSelected: true }],
    });

    console.log("⚡ checkInactiveSessions completed");
  } catch (error) {
    console.error("❌ Error checking inactive sessions:", error.message);
  }
}

/**
 * Enable Live Chat for a user
 */
async function enableLiveChat(userId) {
  try {
    await UserSession.findOneAndUpdate(
      { userId },
      {
        liveChatEnabled: true,
        talkToUsSelected: false,
        promptedAt: null,
        lastInteraction: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log(`✅ Live Chat enabled for user: ${userId}`);

    if (!sessionCheckInterval) {
      startSessionChecker();
    }

    activeSessionsCount++;
  } catch (error) {
    console.error("❌ Error enabling Live Chat:", error.message);
  }
}

/**
 * Enable Talk To Us for a user
 */
async function enableTalkToUs(userId) {
  try {
    await UserSession.findOneAndUpdate(
      { userId },
      {
        liveChatEnabled: false,
        talkToUsSelected: true,
        promptedAt: new Date(),
        lastInteraction: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log(`✅ Talk To Us enabled for user: ${userId}`);

    if (!sessionCheckInterval) {
      startSessionChecker();
    }

    activeSessionsCount++;
  } catch (error) {
    console.error("❌ Error enabling Talk To Us:", error.message);
  }
}

/**
 * Send welcome message with options
 */
async function sendWelcomeButtons(message) {
  try {
    const welcomeMessage = `👋 *Hello! How can I help you today?*

Please select an option by replying with the number:

*1️⃣ Talk To Us*
Contact our team

*2️⃣ Live Chat* (recommended for information)
Start chatting with our bot

Reply with *1* or *2* to select your option.`;

    await message.reply(welcomeMessage);
    console.log("✅ Welcome message sent");
  } catch (error) {
    console.error("❌ Error sending welcome message:", error.message);
    try {
      await message.reply(
        "👋 Hello! How can I help you today?\n\nPlease reply:\n1️⃣ - Talk To Us\n2️⃣ - Live Chat (recommended for information)"
      );
    } catch (fallbackError) {
      console.error(
        "❌ Failed to send fallback message:",
        fallbackError.message
      );
    }
  }
}

/**
 * Handle user selection (button or text)
 */
async function handleUserSelection(message, selectedOption) {
  const userId = message.from;
  const messageBody = message.body?.toLowerCase().trim() || "";
  const selectedOptionLower = selectedOption?.toLowerCase().trim() || "";

  const isLiveChat =
    selectedOptionLower.includes("live_chat") ||
    selectedOptionLower.includes("live chat") ||
    messageBody.includes("live chat") ||
    messageBody.includes("2") ||
    messageBody === "2️⃣" ||
    selectedOptionLower === "live_chat";

  const isTalkToUs =
    selectedOptionLower.includes("talk_to_us") ||
    selectedOptionLower.includes("talk to us") ||
    messageBody.includes("talk to us") ||
    messageBody.includes("1") ||
    messageBody === "1️⃣" ||
    selectedOptionLower === "talk_to_us";

  if (isLiveChat) {
    await enableLiveChat(userId);
    await message.reply(
      "✅ Live Chat enabled! You can now chat with our bot. How can I help you?\n\n💡 Tip: Type *E* to end Live Chat anytime."
    );
    console.log(`✅ User ${userId} selected Live Chat`);
  } else if (isTalkToUs) {
    await enableTalkToUs(userId);
    await message.reply(
      "Thank you for your interest. Our team will contact you soon.\n\nIf you don't get any answer from our team.\nType 2️⃣ to start live chat with our assistant."
    );
    console.log(`ℹ️  User ${userId} selected Talk To Us`);
  } else {
    await sendWelcomeButtons(message);
  }
}

/**
 * Handle incoming WhatsApp messages
 */
async function handleIncomingMessage(message) {
  try {
    if (message.from === "status@broadcast") {
      return;
    }

    const chat = await message.getChat();
    if (chat.isGroup) {
      return;
    }

    const userId = message.from;
    const session = await getOrCreateUserSession(userId);

    const messageBody = message.body?.toLowerCase().trim() || "";
    const isButtonClick =
      message.type === "buttons_response" ||
      message.type === "interactive" ||
      message.type === "list_response" ||
      messageBody === "talk_to_us" ||
      messageBody === "live_chat" ||
      message.selectedButtonId ||
      message.selectedRowId;

    if (isButtonClick) {
      const selectedOption =
        message.selectedButtonId || message.selectedRowId || message.body;
      await handleUserSelection(message, selectedOption);
      return;
    }

    // Check if Live Chat is enabled
    if (!session.liveChatEnabled) {
      // Check if user is trying to select an option
      if (
        messageBody.includes("live chat") ||
        messageBody.includes("talk to us") ||
        messageBody === "1" ||
        messageBody === "2" ||
        messageBody === "1️⃣" ||
        messageBody === "2️⃣"
      ) {
        await handleUserSelection(message, message.body);
        return;
      }

      // If Talk To Us is selected, check expiry
      if (session.talkToUsSelected) {
        const lastInteraction = new Date(session.lastInteraction || Date.now());
        const timeoutAgo = new Date(Date.now() - SESSION_TIMEOUT_MS);

        if (lastInteraction < timeoutAgo) {
          await disableTalkToUs(userId);

          const expiryMessage = `⏰ *Session Expired*

Your "Talk To Us" request has been automatically cleared due to inactivity (${SESSION_TIMEOUT_MINUTES} minutes).

🔄 *To start again:*
Send any message or reply with:
*1️⃣* - Talk To Us
*2️⃣* - Live Chat (recommended for information)

Thank you! 😊`;

          await message.reply(expiryMessage);
          console.log(
            `⏰ Talk To Us expired for user ${userId} due to inactivity`
          );
          return;
        }
        // Update last interaction for Talk To Us
        await UserSession.findOneAndUpdate(
          { userId },
          { lastInteraction: new Date() },
          { upsert: true }
        );
        return;
      }

      // Rate-limit welcome prompt
      const now = Date.now();
      const promptedAtTs = session.promptedAt
        ? new Date(session.promptedAt).getTime()
        : 0;
      if (!promptedAtTs || now - promptedAtTs > SESSION_TIMEOUT_MS) {
        await sendWelcomeButtons(message);
        await UserSession.findOneAndUpdate(
          { userId },
          { promptedAt: new Date(), lastInteraction: new Date() },
          { upsert: true }
        );
      }
      return;
    }

    // Check if user wants to end Live Chat
    if (messageBody === "e") {
      await disableLiveChat(userId);
      await message.reply(
        "✅ Live Chat ended.\n\n💡 Tip: Send a message anytime to start again!\n\nType *1️⃣* to Talk To Us\nType *2️⃣* to start Live Chat again."
      );
      console.log(`🛑 User ${userId} ended Live Chat`);
      return;
    }

    // Check if Live Chat session expired
    const lastInteraction = new Date(session.lastInteraction);
    const timeoutAgo = new Date(Date.now() - SESSION_TIMEOUT_MS);

    if (lastInteraction < timeoutAgo) {
      await disableLiveChat(userId);
      await message.reply(
        `⏰ *Session Expired*

Your Live Chat session has been automatically ended due to inactivity (${SESSION_TIMEOUT_MINUTES} minutes).

🔄 *To start again:*
Send any message or reply with:
*1️⃣* - Talk To Us
*2️⃣* - Live Chat (recommended for information)

Thank you for using our service! 😊`
      );
      console.log(`⏰ Live Chat expired for user ${userId} due to inactivity`);
      await UserSession.findOneAndUpdate(
        { userId },
        { promptedAt: new Date() },
        { upsert: true }
      );
      return;
    }

    // Process Live Chat message with n8n
    const contact = await message.getContact();

    await UserSession.findOneAndUpdate(
      { userId },
      { lastInteraction: new Date() },
      { upsert: true }
    );

    const webhookData = {
      messageId: message.id._serialized,
      from: message.from,
      fromName: contact.name || contact.pushname || message.from,
      body: message.body,
      timestamp: message.timestamp,
      isGroup: chat.isGroup,
      chatName: chat.name,
      type: message.type,
      hasMedia: message.hasMedia,
    };

    console.log("📥 Incoming message from:", webhookData.fromName);
    console.log("📝 Message:", message.body);

    console.log("🔄 Sending to n8n...");
    const response = await axios.post(N8N_WEBHOOK_URL, webhookData, {
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    console.log("✅ n8n response received");

    if (response.data) {
      if (typeof response.data === "string") {
        console.log("💬 Sending message:", response.data);
        await message.reply(response.data);
        console.log("✅ Message sent successfully");
      } else if (response.data.message || response.data.reply) {
        const replyMessage = response.data.message || response.data.reply;
        console.log("💬 Sending message:", replyMessage);
        await message.reply(replyMessage);
        console.log("✅ Message sent successfully");
      } else {
        console.log("ℹ️  No reply message in n8n response");
      }
    } else {
      console.log("ℹ️  No reply message in n8n response");
    }
  } catch (error) {
    console.error("❌ Error handling message:", error.message);

    try {
      if (error.code === "ECONNREFUSED") {
        console.error("❌ Cannot connect to n8n webhook - is n8n running?");
        await message.reply(
          "⚠️ Bot service temporarily unavailable. Please try again later.\n\nType *E* to end Live Chat Then\nType *1️⃣* to Talk To Us (We will reply to you as soon as possible)"
        );
      } else if (error.code === "ETIMEDOUT" || error.code === "ECONNABORTED") {
        console.error("❌ n8n webhook timeout");
        await message.reply(
          "⚠️ Response timeout. Please try again.\n\nType *E* to end Live Chat Then\nType *1️⃣* to Talk To Us (We will reply to you as soon as possible)"
        );
      }
    } catch (replyError) {
      console.error("❌ Failed to send error message:", replyError.message);
    }
  }
}

/**
 * Initialize WhatsApp Client
 */
function initializeWhatsAppClient(mongoStore) {
  if (!mongoStore) {
    console.error("❌ Store not initialized. Cannot create WhatsApp client.");
    return;
  }

  if (isInitializing) {
    console.log("⏳ Client initialization already in progress, skipping...");
    return;
  }

  store = mongoStore;
  isInitializing = true;
  restartAttempts = 0;

  console.log("🚀 Initializing WhatsApp Client with MongoDB session store...");

  const client = new Client({
    authStrategy: new RemoteAuth({
      store: store,
      backupSyncIntervalMs: 300000,
    }),
    puppeteer: {
      headless: true,
      args: getPuppeteerArgs(),
    },
  });

  // Remove TTL index if exists
  async function removeUserSessionTTLIndex() {
    try {
      const indexes = await UserSession.collection.indexes();
      const ttlIndex = indexes.find(
        (idx) => idx.key && idx.key.lastInteraction && idx.expireAfterSeconds
      );

      if (ttlIndex) {
        console.log(`🗑️ Removing TTL index: ${ttlIndex.name}`);
        await UserSession.collection.dropIndex(ttlIndex.name);
        console.log("✅ TTL index removed - manual expiry handling enabled");
      } else {
        console.log("✅ No TTL index found - manual expiry already enabled");
      }
    } catch (e) {
      console.log("⚠️ Could not remove TTL index:", e.message);
    }
  }

  client.on("qr", async (qr) => {
    console.log("🔗 QR RECEIVED - Session failed to load, need to scan QR:");
    console.log("📱 QR Code for WhatsApp Web:");
    qrcode.generate(qr, { small: true });

    const qrImage = await generateQRImage(qr);
    setCurrentQR(qr, qrImage);
    broadcastQRUpdate(qrImage, "qr_ready");
  });

  client.on("remote_session_saved", () => {
    console.log("💾 Session saved to MongoDB successfully!");
  });

  client.on("remote_session_loaded", () => {
    console.log("📂 Session loaded from MongoDB successfully!");
    clearCurrentQR();
    broadcastQRUpdate(null, "session_loaded");
  });

  client.on("loading_screen", (percent, message) => {
    console.log(`📱 Loading: ${percent}% - ${message}`);
  });

  client.on("ready", async () => {
    console.log("✅ WhatsApp Web.js Client is Ready!");
    whatsappClient = client;
    isClientReady = true;
    isInitializing = false;
    clearCurrentQR();
    broadcastQRUpdate(null, "ready");

    await removeUserSessionTTLIndex();

    try {
      activeSessionsCount = await UserSession.countDocuments({
        $or: [{ liveChatEnabled: true }, { talkToUsSelected: true }],
      });

      console.log(`📊 Found ${activeSessionsCount} active sessions on startup`);

      if (activeSessionsCount > 0) {
        startSessionChecker();
        setTimeout(() => {
          checkInactiveSessions().catch((err) => {
            console.error("❌ Initial check failed:", err.message);
          });
        }, 3000);
      } else {
        console.log("✅ No active sessions - checker will start when needed");
      }
    } catch (error) {
      console.error("❌ Error counting active sessions:", error.message);
    }
  });

  client.on("message", async (message) => {
    await handleIncomingMessage(message);
  });

  client.on("authenticated", () => {
    console.log("🔐 Authentication successful!");
    broadcastQRUpdate(null, "authenticated");
  });

  client.on("auth_failure", (msg) => {
    console.error("❌ Authentication failure:", msg);
    broadcastQRUpdate(null, "auth_failure");
  });

  client.on("disconnected", (reason) => {
    console.log("📱 Client was logged out:", reason);
    isClientReady = false;
    whatsappClient = null;
    isInitializing = false;

    if (restartAttempts < MAX_RESTART_ATTEMPTS) {
      restartAttempts++;
      setTimeout(() => {
        console.log(
          `🔄 Attempting to restart WhatsApp client... (Attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`
        );
        initializeWhatsAppClient(store);
      }, 5000);
    } else {
      console.error(
        "❌ Maximum restart attempts reached. Please restart the application manually."
      );
    }
  });

  client.on("change_state", (state) => {
    console.log("🔄 Client state changed to:", state);
    if (state === "CONFLICT" || state === "UNPAIRED") {
      console.log(
        "⚠️  Client in conflict or unpaired state, attempting restart..."
      );
      isClientReady = false;
      whatsappClient = null;
      isInitializing = false;
      if (restartAttempts < MAX_RESTART_ATTEMPTS) {
        restartAttempts++;
        setTimeout(() => {
          console.log(
            `🔄 Attempting to restart WhatsApp client... (Attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`
          );
          initializeWhatsAppClient(store);
        }, 10000);
      }
    }
  });

  client.initialize().catch((error) => {
    console.error("❌ Failed to initialize WhatsApp client:", error);
    isInitializing = false;

    if (
      error.message.includes("Protocol error") ||
      error.message.includes("Execution context was destroyed") ||
      error.message.includes("Target closed") ||
      error.message.includes("Session closed")
    ) {
      console.log(
        "🔄 Puppeteer error detected, attempting restart in 10 seconds..."
      );
      if (restartAttempts < MAX_RESTART_ATTEMPTS) {
        restartAttempts++;
        setTimeout(() => {
          console.log(
            `🔄 Attempting to restart WhatsApp client... (Attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})`
          );
          initializeWhatsAppClient(store);
        }, 10000);
      }
    }
  });
}

/**
 * Check if number exists on WhatsApp
 */
async function checkNumberExists(phoneNumber) {
  try {
    if (!whatsappClient) {
      return false;
    }
    const numberId = await whatsappClient.getNumberId(phoneNumber);
    return numberId !== null;
  } catch (error) {
    console.log(`❌ Number check failed for ${phoneNumber}:`, error.message);
    return false;
  }
}

/**
 * Get contact details by phone number
 */
async function getContactDetails(phoneNumber) {
  try {
    if (!whatsappClient) {
      return null;
    }

    const numberId = await whatsappClient.getNumberId(phoneNumber);
    if (!numberId) {
      return null;
    }

    const contact = await whatsappClient.getContactById(numberId._serialized);
    if (!contact) {
      return null;
    }

    let profilePicUrl = null;
    try {
      const profilePic = await contact.getProfilePicUrl();
      profilePicUrl = profilePic || null;
    } catch (picError) {
      profilePicUrl = null;
    }

    let contactName = null;
    let pushname = null;

    if (contact.name) {
      contactName = contact.name;
    }
    if (contact.pushname) {
      pushname = contact.pushname;
    }

    if (!contactName && typeof contact.getName === "function") {
      try {
        contactName = contact.getName();
      } catch (e) {}
    }

    if (!contactName && pushname) {
      contactName = pushname;
    }

    if (!contactName && !pushname) {
      contactName = contact.number || contact.id?.user || "Unknown";
    }

    const contactDetails = {
      number: contact.number || contact.id?.user || null,
      id: contact.id?._serialized || null,
      name: contactName,
      pushname: pushname || contactName || null,
      shortName: contact.shortName || null,
      isMyContact: contact.isMyContact || false,
      isBusiness: contact.isBusiness || false,
      isUser: contact.isUser || false,
      profilePicUrl: profilePicUrl,
      isVerified: contact.isVerified || false,
      isEnterprise: contact.isEnterprise || false,
    };

    return contactDetails;
  } catch (error) {
    console.log(
      `❌ Error getting contact details for ${phoneNumber}:`,
      error.message
    );
    return null;
  }
}

/**
 * Send message via WhatsApp
 */
async function sendMessage(phoneNumber, message) {
  if (!whatsappClient || !isClientReady) {
    throw new Error("WhatsApp client not ready");
  }

  return await whatsappClient.sendMessage(phoneNumber, message.trim());
}

/**
 * Get client instance
 */
function getClient() {
  return whatsappClient;
}

/**
 * Check if client is ready
 */
function isReady() {
  return isClientReady;
}

/**
 * Validate if phone number is valid globally for any country
 */
function isValidPhoneNumber(number, defaultCountry = null) {
  if (!number) return false;
  return isValidPhoneNumberGlobal(number, defaultCountry);
}

// Global state tracking for contact sync operations
let syncProgressState = {
  isRunning: false,
  status: "idle", // 'idle' | 'running' | 'completed' | 'failed'
  startedAt: null,
  completedAt: null,
  progress: {
    phase: "idle",
    totalContactsFound: 0,
    totalChatsFound: 0,
    processed: 0,
    saved: 0,
    updated: 0,
    errors: 0,
    percentage: 0,
  },
  summary: null,
  error: null,
};

/**
 * Get current sync progress state
 */
function getSyncProgress() {
  return { ...syncProgressState };
}

/**
 * Extract all WhatsApp items (contacts, groups, communities) in lightweight chunks
 * Prevents CDP / Puppeteer timeout when accounts have 3,000+ contacts
 */
async function extractAllWhatsAppItemsBatch(options = {}) {
  if (!whatsappClient || !isClientReady) {
    throw new Error("WhatsApp client not ready. Please scan QR code first.");
  }

  const {
    batchSize = 250,
    progressCallback = null,
  } = options;

  const rawContactsMap = new Map();
  const rawChatsMap = new Map();

  const pupPage = whatsappClient.pupPage;

  if (pupPage) {
    // 1. EXTRACT CONTACTS IN CHUNKS
    try {
      const contactCount = await pupPage.evaluate(() => {
        return window.Store && window.Store.Contact && window.Store.Contact.models
          ? window.Store.Contact.models.length
          : 0;
      });

      console.log(`📦 Found ${contactCount} contacts in WhatsApp Web Store`);
      if (progressCallback) {
        progressCallback({
          phase: "extracting_contacts",
          total: contactCount,
          current: 0,
        });
      }

      for (let offset = 0; offset < contactCount; offset += batchSize) {
        const chunk = await pupPage.evaluate(
          (start, limit) => {
            if (
              !window.Store ||
              !window.Store.Contact ||
              !window.Store.Contact.models
            )
              return [];

            const models = window.Store.Contact.models.slice(
              start,
              start + limit
            );

            return models.map((c) => ({
              id: c.id ? c.id._serialized : null,
              user: c.id ? c.id.user : null,
              name: c.name || c.formattedTitle || null,
              pushname: c.pushname || null,
              verifiedName: c.verifiedName || null,
              isMyContact: !!c.isMyContact,
              isBusiness: !!c.isBusiness,
              isEnterprise: !!c.isEnterprise,
              isUser: !!c.isUser,
              isGroup: !!c.isGroup,
              isBroadcast: !!c.isBroadcast,
              type:
                c.type ||
                (c.isGroup ? "group" : c.isUser ? "individual" : "unknown"),
            }));
          },
          offset,
          batchSize
        );

        for (const item of chunk) {
          if (item && item.id) {
            rawContactsMap.set(item.id, item);
          }
        }

        if (progressCallback) {
          progressCallback({
            phase: "extracting_contacts",
            total: contactCount,
            current: rawContactsMap.size,
          });
        }
      }
    } catch (storeContactErr) {
      console.warn(
        "⚠️ Chunked Contact store extraction failed, falling back to client.getContacts:",
        storeContactErr.message
      );
      try {
        const fallbackContacts = await whatsappClient.getContacts();
        for (const c of fallbackContacts) {
          const jid = c.id?._serialized || c.id;
          if (jid) {
            rawContactsMap.set(jid, {
              id: jid,
              user: c.number || c.id?.user,
              name: c.name,
              pushname: c.pushname,
              isMyContact: !!c.isMyContact,
              isBusiness: !!c.isBusiness,
              isEnterprise: !!c.isEnterprise,
              isUser: !!c.isUser,
              isGroup: !!c.isGroup,
            });
          }
        }
      } catch (fbErr) {
        console.error("❌ Fallback getContacts failed:", fbErr.message);
      }
    }

    // 2. EXTRACT CHATS (Groups, Communities, Direct Conversations)
    try {
      const chatCount = await pupPage.evaluate(() => {
        return window.Store && window.Store.Chat && window.Store.Chat.models
          ? window.Store.Chat.models.length
          : 0;
      });

      console.log(`💬 Found ${chatCount} chats in WhatsApp Web Store`);
      if (progressCallback) {
        progressCallback({
          phase: "extracting_chats",
          total: chatCount,
          current: 0,
        });
      }

      for (let offset = 0; offset < chatCount; offset += batchSize) {
        const chunk = await pupPage.evaluate(
          (start, limit) => {
            if (
              !window.Store ||
              !window.Store.Chat ||
              !window.Store.Chat.models
            )
              return [];

            const models = window.Store.Chat.models.slice(start, start + limit);

            return models.map((ch) => {
              const isGroup = !!ch.isGroup;
              const isParentGroup = !!(
                ch.isParentGroup ||
                (ch.groupMetadata && ch.groupMetadata.isParentGroup)
              );
              const isCommunity = isParentGroup || !!ch.isCommunity;

              let participants = [];
              if (
                ch.groupMetadata &&
                Array.isArray(ch.groupMetadata.participants)
              ) {
                participants = ch.groupMetadata.participants.map((p) => ({
                  id: p.id ? p.id._serialized : null,
                  user: p.id ? p.id.user : null,
                  isAdmin: !!p.isAdmin,
                  isSuperAdmin: !!p.isSuperAdmin,
                }));
              }

              return {
                id: ch.id ? ch.id._serialized : null,
                user: ch.id ? ch.id.user : null,
                name: ch.name || ch.formattedTitle || null,
                isGroup: isGroup,
                isCommunity: isCommunity,
                isParentGroup: isParentGroup,
                parentGroupId: ch.parentGroup
                  ? ch.parentGroup._serialized
                  : null,
                participants: participants,
                participantCount:
                  participants.length ||
                  (ch.groupMetadata &&
                    ch.groupMetadata.participants &&
                    ch.groupMetadata.participants.length) ||
                  0,
                description: ch.groupMetadata
                  ? ch.groupMetadata.desc || null
                  : null,
              };
            });
          },
          offset,
          batchSize
        );

        for (const item of chunk) {
          if (item && item.id) {
            rawChatsMap.set(item.id, item);
          }
        }

        if (progressCallback) {
          progressCallback({
            phase: "extracting_chats",
            total: chatCount,
            current: rawChatsMap.size,
          });
        }
      }
    } catch (storeChatErr) {
      console.warn("⚠️ Chunked Chat store extraction failed:", storeChatErr.message);
    }
  } else {
    const fallbackContacts = await whatsappClient.getContacts();
    for (const c of fallbackContacts) {
      const jid = c.id?._serialized || c.id;
      if (jid) {
        rawContactsMap.set(jid, {
          id: jid,
          user: c.number || c.id?.user,
          name: c.name,
          pushname: c.pushname,
          isMyContact: !!c.isMyContact,
          isBusiness: !!c.isBusiness,
          isEnterprise: !!c.isEnterprise,
          isUser: !!c.isUser,
          isGroup: !!c.isGroup,
        });
      }
    }
  }

  return {
    rawContacts: Array.from(rawContactsMap.values()),
    rawChats: Array.from(rawChatsMap.values()),
  };
}

/**
 * Synchronize all WhatsApp contacts, groups, communities, and group participants into MongoDB
 * Automatically segregates by location and business
 */
async function syncAllContactsToDatabase(options = {}) {
  if (syncProgressState.isRunning) {
    return {
      success: false,
      message: "Sync is already in progress",
      progress: syncProgressState,
    };
  }

  const startTime = new Date();
  syncProgressState = {
    isRunning: true,
    status: "running",
    startedAt: startTime,
    completedAt: null,
    progress: {
      phase: "starting",
      totalContactsFound: 0,
      totalChatsFound: 0,
      processed: 0,
      saved: 0,
      updated: 0,
      errors: 0,
      percentage: 5,
    },
    summary: null,
    error: null,
  };

  try {
    console.log("🚀 Starting batch WhatsApp contacts & chats synchronization...");

    // Extract items in safe batches
    const { rawContacts, rawChats } = await extractAllWhatsAppItemsBatch({
      batchSize: 250,
      progressCallback: (info) => {
        if (info.phase === "extracting_contacts") {
          syncProgressState.progress.phase = "extracting_contacts";
          syncProgressState.progress.totalContactsFound = info.total;
          syncProgressState.progress.percentage = Math.min(
            35,
            Math.round((info.current / (info.total || 1)) * 30) + 5
          );
        } else if (info.phase === "extracting_chats") {
          syncProgressState.progress.phase = "extracting_chats";
          syncProgressState.progress.totalChatsFound = info.total;
          syncProgressState.progress.percentage = Math.min(
            60,
            Math.round((info.current / (info.total || 1)) * 25) + 35
          );
        }
      },
    });

    syncProgressState.progress.phase = "processing_and_segregating";
    syncProgressState.progress.percentage = 65;

    // Contact documents map by JID to deduplicate and merge
    const finalContactsMap = new Map();

    // 1. Process Raw Contacts (Individual contacts)
    for (const c of rawContacts) {
      const jid = c.id;
      if (!jid || jid === "status@broadcast") continue;

      if (jid.endsWith("@c.us") || c.isUser) {
        const rawNumber = c.user || jid.replace("@c.us", "");
        const phoneDetails = parsePhoneNumberDetails(rawNumber);

        const countryCode = phoneDetails.countryCode || "UNKNOWN";
        const country = phoneDetails.country || "Unknown";
        const callingCode = phoneDetails.callingCode;
        const number = phoneDetails.number || rawNumber;
        const formattedNumber = phoneDetails.international;

        const displayName =
          c.name || c.verifiedName || c.pushname || (number ? `+${number}` : "Unknown");

        finalContactsMap.set(jid, {
          jid,
          number,
          formattedNumber,
          name: displayName,
          pushname: c.pushname || null,
          savedName: c.isMyContact ? (c.name || null) : null,
          type: "individual",
          isMyContact: !!c.isMyContact,
          isBusiness: !!c.isBusiness,
          isEnterprise: !!c.isEnterprise,
          isUser: true,
          isGroup: false,
          isCommunity: false,
          countryCode,
          country,
          callingCode,
          location: {
            country,
            countryCode,
            callingCode,
          },
          source: c.isMyContact ? "contact_book" : "chat",
          lastSyncedAt: new Date(),
        });
      }
    }

    // 2. Process Raw Chats (Groups, Communities, and Group Participants)
    for (const ch of rawChats) {
      const jid = ch.id;
      if (!jid || jid === "status@broadcast") continue;

      if (ch.isGroup) {
        const isCommunity = !!(ch.isCommunity || ch.isParentGroup);
        const chatType = isCommunity ? "community" : "group";

        finalContactsMap.set(jid, {
          jid,
          number: null,
          formattedNumber: null,
          name: ch.name || (isCommunity ? "Unnamed Community" : "Unnamed Group"),
          pushname: null,
          savedName: null,
          type: chatType,
          isMyContact: false,
          isBusiness: false,
          isEnterprise: false,
          isUser: false,
          isGroup: true,
          isCommunity: isCommunity,
          countryCode: isCommunity ? "COMMUNITY" : "GROUP",
          country: isCommunity ? "Community" : "Group Chat",
          callingCode: null,
          location: {
            country: isCommunity ? "Community" : "Group Chat",
            countryCode: isCommunity ? "COMMUNITY" : "GROUP",
            callingCode: null,
          },
          source: isCommunity ? "community" : "chat",
          groupInfo: {
            subject: ch.name || null,
            description: ch.description || null,
            participantCount: ch.participantCount || 0,
            isParentGroup: isCommunity,
            parentGroupId: ch.parentGroupId || null,
          },
          lastSyncedAt: new Date(),
        });

        // 3. Process Group Participants (Unsaved Leads / Members)
        if (Array.isArray(ch.participants)) {
          for (const p of ch.participants) {
            const pJid = p.id;
            if (!pJid || !pJid.endsWith("@c.us")) continue;

            // If participant is not yet in contacts map, add them as an unsaved individual
            if (!finalContactsMap.has(pJid)) {
              const rawNumber = p.user || pJid.replace("@c.us", "");
              const phoneDetails = parsePhoneNumberDetails(rawNumber);
              const number = phoneDetails.number || rawNumber;
              const countryCode = phoneDetails.countryCode || "UNKNOWN";
              const country = phoneDetails.country || "Unknown";

              finalContactsMap.set(pJid, {
                jid: pJid,
                number,
                formattedNumber: phoneDetails.international,
                name: phoneDetails.international || (number ? `+${number}` : "Unknown"),
                pushname: null,
                savedName: null,
                type: "individual",
                isMyContact: false, // Unsaved
                isBusiness: false,
                isEnterprise: false,
                isUser: true,
                isGroup: false,
                isCommunity: false,
                countryCode,
                country,
                callingCode: phoneDetails.callingCode,
                location: {
                  country,
                  countryCode,
                  callingCode: phoneDetails.callingCode,
                },
                source: "group_participant",
                lastSyncedAt: new Date(),
              });
            }
          }
        }
      }
    }

    const contactsList = Array.from(finalContactsMap.values());
    console.log(
      `📊 Prepared ${contactsList.length} unique items for database upsert`
    );

    syncProgressState.progress.phase = "saving_to_mongodb";
    syncProgressState.progress.percentage = 75;

    // 4. BULK UPSERT INTO MONGODB IN BATCHES OF 500
    const bulkChunkSize = 500;
    let totalSaved = 0;
    let totalUpdated = 0;

    for (let i = 0; i < contactsList.length; i += bulkChunkSize) {
      const slice = contactsList.slice(i, i + bulkChunkSize);
      const bulkOps = slice.map((item) => ({
        updateOne: {
          filter: { jid: item.jid },
          update: { $set: item },
          upsert: true,
        },
      }));

      const res = await Contact.bulkWrite(bulkOps, { ordered: false });
      totalSaved += res.upsertedCount || 0;
      totalUpdated += res.modifiedCount || 0;

      const currentProgress = Math.min(
        95,
        75 + Math.round(((i + slice.length) / contactsList.length) * 20)
      );
      syncProgressState.progress.percentage = currentProgress;
      syncProgressState.progress.processed = i + slice.length;
      syncProgressState.progress.saved = totalSaved;
      syncProgressState.progress.updated = totalUpdated;
    }

    // 5. COMPUTE SEGREGATION SUMMARY
    let businessCount = 0;
    let regularCount = 0;
    let savedCount = 0;
    let unsavedCount = 0;
    let individualCount = 0;
    let groupCount = 0;
    let communityCount = 0;
    const countryMap = new Map();

    for (const item of contactsList) {
      if (item.type === "individual") {
        individualCount++;
        if (item.isBusiness) businessCount++;
        else regularCount++;

        if (item.isMyContact) savedCount++;
        else unsavedCount++;

        const cName = item.country || "Unknown";
        countryMap.set(cName, (countryMap.get(cName) || 0) + 1);
      } else if (item.type === "group") {
        groupCount++;
      } else if (item.type === "community") {
        communityCount++;
      }
    }

    const topCountries = Array.from(countryMap.entries())
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const endTime = new Date();
    const durationSeconds = (endTime - startTime) / 1000;

    const summary = {
      totalFound: contactsList.length,
      savedToDatabase: totalSaved,
      updatedInDatabase: totalUpdated,
      segregation: {
        individuals: individualCount,
        groups: groupCount,
        communities: communityCount,
        savedContacts: savedCount,
        unsavedContacts: unsavedCount,
        businessContacts: businessCount,
        regularContacts: regularCount,
        totalCountries: countryMap.size,
        topCountries,
      },
      durationSeconds,
      completedAt: endTime,
    };

    syncProgressState.isRunning = false;
    syncProgressState.status = "completed";
    syncProgressState.completedAt = endTime;
    syncProgressState.progress.phase = "completed";
    syncProgressState.progress.percentage = 100;
    syncProgressState.summary = summary;

    console.log("✅ Contact sync completed successfully!");
    console.log(
      `📊 Summary: ${individualCount} individuals (${businessCount} business, ${savedCount} saved, ${unsavedCount} unsaved), ${groupCount} groups, ${communityCount} communities in ${durationSeconds}s`
    );

    return {
      success: true,
      message: "WhatsApp contacts synchronized successfully",
      summary,
    };
  } catch (error) {
    console.error("❌ Error during contacts synchronization:", error);
    syncProgressState.isRunning = false;
    syncProgressState.status = "failed";
    syncProgressState.error = error.message;
    syncProgressState.completedAt = new Date();
    throw error;
  }
}

/**
 * Get all contacts with filtering options
 * Reads from MongoDB database for instant zero-timeout response,
 * or falls back to live safe batch extraction
 */
async function getAllContacts(options = {}) {
  const {
    savedOnly = false,
    excludeUnknown = false,
    validateNumber = true,
    country = null,
    countryCode = null,
    isBusiness = null,
    type = null,
    source = "db", // 'db' or 'live'
  } = options;

  // 1. If source is 'db' (default), query MongoDB for sub-100ms response
  if (source === "db") {
    const filter = {};

    if (savedOnly) filter.isMyContact = true;
    if (isBusiness === true || isBusiness === "true") filter.isBusiness = true;
    if (isBusiness === false || isBusiness === "false") filter.isBusiness = false;
    if (country) filter.country = new RegExp(`^${country}$`, "i");
    if (countryCode) filter.countryCode = countryCode.toUpperCase();
    if (type) filter.type = type;
    else filter.type = "individual"; // Default to individuals

    if (excludeUnknown) {
      filter.name = { $nin: ["Unknown", null, ""] };
    }

    const contacts = await Contact.find(filter)
      .sort({ name: 1 })
      .lean();

    if (contacts.length > 0) {
      return contacts.map((c) => ({
        name: c.name || "Unknown",
        number: c.number,
        formattedNumber: c.formattedNumber,
        id: c.jid,
        isMyContact: c.isMyContact,
        isBusiness: c.isBusiness,
        type: c.type,
        country: c.country,
        countryCode: c.countryCode,
        callingCode: c.callingCode,
        source: c.source,
      }));
    }
  }

  // 2. If 'live' requested or DB is empty, run chunked live extraction
  if (!whatsappClient || !isClientReady) {
    throw new Error("WhatsApp client not ready. Please scan QR code or trigger /contacts/sync.");
  }

  try {
    const { rawContacts } = await extractAllWhatsAppItemsBatch({ batchSize: 250 });

    const formattedContacts = rawContacts
      .filter((contact) => {
        if (
          !contact.isUser ||
          contact.isGroup ||
          contact.isBroadcast ||
          contact.id === "status@broadcast" ||
          !contact.id.endsWith("@c.us")
        ) {
          return false;
        }

        if (savedOnly && !contact.isMyContact) {
          return false;
        }

        if (validateNumber) {
          const number = contact.user || contact.id.replace("@c.us", "");
          if (!isValidPhoneNumber(number)) {
            return false;
          }
        }

        return true;
      })
      .map((contact) => {
        const rawNumber = contact.user || contact.id.replace("@c.us", "");
        const details = parsePhoneNumberDetails(rawNumber);

        return {
          name: contact.name || contact.pushname || "Unknown",
          number: details.number || rawNumber,
          formattedNumber: details.international,
          id: contact.id,
          isMyContact: contact.isMyContact,
          isBusiness: contact.isBusiness,
          country: details.country,
          countryCode: details.countryCode,
          callingCode: details.callingCode,
        };
      })
      .filter((contact) => {
        if (excludeUnknown && contact.name === "Unknown") {
          return false;
        }
        if (country && contact.country?.toLowerCase() !== country.toLowerCase()) {
          return false;
        }
        if (countryCode && contact.countryCode !== countryCode.toUpperCase()) {
          return false;
        }
        if (isBusiness !== null && contact.isBusiness !== (isBusiness === "true" || isBusiness === true)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const nameA = (a.name || "").toLowerCase();
        const nameB = (b.name || "").toLowerCase();
        return nameA.localeCompare(nameB);
      });

    return formattedContacts;
  } catch (error) {
    console.error("❌ Error fetching live contacts:", error.message);
    throw error;
  }
}

module.exports = {
  initializeWhatsAppClient,
  checkNumberExists,
  getContactDetails,
  sendMessage,
  getClient,
  isReady,
  getAllContacts,
  extractAllWhatsAppItemsBatch,
  syncAllContactsToDatabase,
  getSyncProgress,
  isValidPhoneNumber,
};
