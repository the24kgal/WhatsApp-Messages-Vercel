require("dotenv").config();

const mongoose = require("mongoose");
const { MongoStore } = require("wwebjs-mongo");
const { connectDB } = require("./config/database");
const { isProduction } = require("./config/whatsapp");
const { initializeWhatsAppClient } = require("./services/whatsapp.service");
const {
  setupUnhandledRejectionHandler,
  setupUncaughtExceptionHandler,
  setRestartCallback,
} = require("./middleware/errorHandler");
const { setStore } = require("./controllers/status.controller");
const app = require("./app");

const PORT = process.env.PORT || 3000;

// Setup error handlers
setupUnhandledRejectionHandler();
setupUncaughtExceptionHandler();

// MongoDB Connection
connectDB()
  .then(() => {
    console.log("✅ MongoDB Connected Successfully");

    // Initialize MongoStore with proper configuration
    const store = new MongoStore({
      mongoose: mongoose,
      dbName: "whatsapp-bot", // Specify database name
    });

    console.log("✅ MongoStore initialized successfully");

    // Set store in status controller
    setStore(store);

    // Start the Express server after MongoDB connection
    startServer();

    // Set restart callback for error handler
    setRestartCallback(() => {
      initializeWhatsAppClient(store);
    });

    // Initialize WhatsApp Client after MongoDB connection
    initializeWhatsAppClient(store);
  })
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err);
    console.log(
      "🔄 Starting server without MongoDB connection for health checks..."
    );
    startServer();
    // Don't exit immediately, let the server start for debugging
    setTimeout(() => {
      console.error("❌ Exiting due to MongoDB connection failure");
      process.exit(1);
    }, 30000); // Give 30 seconds for debugging
  });

// Start the Express server
function startServer() {
  app.listen(PORT, isProduction && "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Root: http://localhost:${PORT}`);
    console.log(`📱 Health check: http://localhost:${PORT}/health`);
    console.log(`ℹ️  Client info: http://localhost:${PORT}/info`);
    console.log(`🔲 QR Code Page: http://localhost:${PORT}/qr`);
    console.log(`🔲 QR Code Stream: http://localhost:${PORT}/qr-stream`);
    console.log(`💾 Session status: http://localhost:${PORT}/session-status`);
    console.log(`🗄️  MongoDB info: http://localhost:${PORT}/mongodb-info`);
    console.log(
      `🔄 Reset session: POST http://localhost:${PORT}/reset-session`
    );
    console.log(`📇 Get contacts: http://localhost:${PORT}/contacts`);
    console.log(`🔄 Batch Sync Contacts: POST http://localhost:${PORT}/contacts/sync`);
    console.log(`📊 Sync Status: http://localhost:${PORT}/contacts/sync/status`);
    console.log(`🗄️  Database Contacts (Make.com): http://localhost:${PORT}/contacts/database`);
    console.log(`📍 Location & Business Segregation: http://localhost:${PORT}/contacts/segregation`);
    console.log(`📊 Contact stats: http://localhost:${PORT}/contacts/stats`);
    console.log(`📥 Export CSV: http://localhost:${PORT}/export.html`);
    console.log(
      `🔍 Check Numbers: http://localhost:${PORT}/check-numbers.html`
    );
    console.log(`📋 Numbers List API: http://localhost:${PORT}/numbers-list`);
    console.log(`✅ Check Numbers API: http://localhost:${PORT}/check-numbers`);
    console.log(
      `💾 Verified Numbers DB: http://localhost:${PORT}/verified-numbers`
    );
    console.log(
      `📊 Verified Stats: http://localhost:${PORT}/verified-numbers/stats`
    );
    console.log(
      `📥 Export Verified CSV: http://localhost:${PORT}/verified-numbers/export`
    );
  });
}
