const express = require("express");
const router = express.Router();
const {
  syncContacts,
  getSyncStatus,
  getDatabaseContacts,
  getContactSegregation,
  getContacts,
  getContactStats,
  exportContactsCSV,
} = require("../controllers/contact.controller");

// Batch synchronize contacts, groups, communities to MongoDB
router.post("/contacts/sync", syncContacts);
router.get("/contacts/sync", syncContacts);

// Live synchronization progress status
router.get("/contacts/sync/status", getSyncStatus);

// Make.com & Google Sheets integration endpoint (paginated, filterable)
router.get("/contacts/database", getDatabaseContacts);

// Location and Business Segregation analytics
router.get("/contacts/segregation", getContactSegregation);

// Export contacts as CSV (Download with location & business filters)
router.get("/contacts/export", exportContactsCSV);
router.get("/contacts/database/export", exportContactsCSV);

// Standard / Legacy contacts endpoints
router.get("/contacts", getContacts);
router.get("/contacts/stats", getContactStats);

module.exports = router;
