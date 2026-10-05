const Contact = require("../models/Contact");
const {
  isReady,
  getAllContacts,
  syncAllContactsToDatabase,
  getSyncProgress,
} = require("../services/whatsapp.service");

/**
 * Trigger batch synchronization of contacts, groups, communities, and participants to MongoDB
 * GET / POST /contacts/sync
 * 
 * Query / Body parameters:
 *  - wait: true/false (default: false) - If true, waits until sync finishes before returning
 */
const syncContacts = async (req, res) => {
  try {
    if (!isReady()) {
      return res.status(503).json({
        success: false,
        error: "WhatsApp client not ready. Please scan QR code first.",
        message: "Client not connected",
      });
    }

    const wait = req.query.wait === "true" || req.body?.wait === true;

    // Check if already in progress
    const currentProgress = getSyncProgress();
    if (currentProgress.isRunning) {
      return res.status(409).json({
        success: false,
        message: "Contact synchronization is already running in background",
        statusUrl: "/contacts/sync/status",
        progress: currentProgress,
      });
    }

    if (wait) {
      // Synchronous execution (wait for completion)
      console.log("🔄 Starting synchronous contact sync...");
      const result = await syncAllContactsToDatabase();
      return res.status(200).json(result);
    }

    // Asynchronous background execution
    console.log("🚀 Launching asynchronous contact sync in background...");
    syncAllContactsToDatabase().catch((err) => {
      console.error("❌ Background contact sync failed:", err.message);
    });

    return res.status(202).json({
      success: true,
      message: "WhatsApp contact synchronization initiated in background",
      statusUrl: "/contacts/sync/status",
      databaseUrl: "/contacts/database",
      segregationUrl: "/contacts/segregation",
    });
  } catch (err) {
    console.error("❌ Error starting contact sync:", err);
    res.status(500).json({
      success: false,
      error: "Failed to initiate contact sync",
      message: err.message || "Unknown error",
    });
  }
};

/**
 * Get live progress of active or recent synchronization
 * GET /contacts/sync/status
 */
const getSyncStatus = (req, res) => {
  const status = getSyncProgress();
  res.status(200).json({
    success: true,
    data: status,
  });
};

/**
 * Retrieve contacts from MongoDB with pagination, filtering, and Make.com / Google Sheets formatting
 * GET /contacts/database
 * 
 * Query parameters:
 *  - page: number (default: 1)
 *  - limit: number (default: 100, max: 10000)
 *  - country: string (e.g. "Pakistan", "United States")
 *  - countryCode: string (e.g. "PK", "US", "GB", "IN")
 *  - isBusiness: true/false
 *  - isSaved / savedOnly: true/false
 *  - type: "individual" | "group" | "community" | "all" (default: "individual")
 *  - search: string (search in name or number)
 *  - since: ISO date string (sync only contacts updated after this date)
 *  - format: "json" | "sheets" (default: "json")
 */
const getDatabaseContacts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(10000, Math.max(1, parseInt(req.query.limit) || 100));
    const skip = (page - 1) * limit;

    const filter = {};

    // Filter by type
    if (req.query.type && req.query.type !== "all") {
      filter.type = req.query.type;
    }

    // Filter by country
    if (req.query.country) {
      filter.country = new RegExp(`^${req.query.country.trim()}$`, "i");
    }
    if (req.query.countryCode) {
      filter.countryCode = req.query.countryCode.trim().toUpperCase();
    }

    // Filter by business status
    if (req.query.isBusiness !== undefined) {
      filter.isBusiness = req.query.isBusiness === "true";
    }

    // Filter by saved status
    if (req.query.isSaved !== undefined) {
      filter.isMyContact = req.query.isSaved === "true";
    } else if (req.query.savedOnly === "true") {
      filter.isMyContact = true;
    }

    // Search by name or number
    if (req.query.search) {
      const searchRegex = new RegExp(req.query.search.trim(), "i");
      filter.$or = [{ name: searchRegex }, { number: searchRegex }];
    }

    // Incremental sync for Make.com / automation tools
    if (req.query.since) {
      const sinceDate = new Date(req.query.since);
      if (!isNaN(sinceDate.getTime())) {
        filter.updatedAt = { $gte: sinceDate };
      }
    }

    const [total, contacts] = await Promise.all([
      Contact.countDocuments(filter),
      Contact.find(filter)
        .sort({ name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const totalPages = Math.ceil(total / limit);

    // Format for Google Sheets / Make.com if format=sheets requested
    if (req.query.format === "sheets") {
      const sheetsRows = contacts.map((c) => ({
        "Name": c.name || "Unknown",
        "Phone Number": c.number ? `="${c.number}"` : "",
        "Formatted Number": c.formattedNumber || "",
        "Country": c.country || "Unknown",
        "Country Code": c.countryCode || "UNKNOWN",
        "Calling Code": c.callingCode ? `+${c.callingCode}` : "",
        "Is Business": c.isBusiness ? "Yes" : "No",
        "Is Saved": c.isMyContact ? "Yes" : "No",
        "Type": c.type || "individual",
        "WhatsApp JID": c.jid,
        "Source": c.source || "",
        "Last Updated": c.updatedAt ? new Date(c.updatedAt).toISOString() : "",
      }));

      return res.status(200).json({
        success: true,
        pagination: {
          total,
          page,
          limit,
          totalPages,
          hasNextPage: page < totalPages,
          hasPrevPage: page > 1,
        },
        data: sheetsRows,
      });
    }

    res.status(200).json({
      success: true,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
      },
      filters: {
        type: req.query.type || "all",
        country: req.query.country || null,
        countryCode: req.query.countryCode || null,
        isBusiness: req.query.isBusiness || null,
        isSaved: req.query.isSaved || req.query.savedOnly || null,
      },
      data: contacts,
    });
  } catch (err) {
    console.error("❌ Error fetching contacts from database:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch database contacts",
      message: err.message || "Unknown error",
    });
  }
};

/**
 * Get detailed segregation of contacts by location and business
 * GET /contacts/segregation
 */
const getContactSegregation = async (req, res) => {
  try {
    // 1. Overall counts
    const totalCount = await Contact.countDocuments();
    if (totalCount === 0) {
      return res.status(200).json({
        success: true,
        message: "No contacts in database yet. Please run /contacts/sync to populate.",
        total: 0,
        segregation: null,
      });
    }

    const [
      businessCount,
      savedCount,
      individualCount,
      groupCount,
      communityCount,
      countryBreakdown,
    ] = await Promise.all([
      Contact.countDocuments({ isBusiness: true }),
      Contact.countDocuments({ isMyContact: true }),
      Contact.countDocuments({ type: "individual" }),
      Contact.countDocuments({ type: "group" }),
      Contact.countDocuments({ type: "community" }),
      // Group by country and calculate business and saved ratios
      Contact.aggregate([
        {
          $match: {
            type: "individual",
            country: { $ne: null },
          },
        },
        {
          $group: {
            _id: {
              country: "$country",
              countryCode: "$countryCode",
              callingCode: "$callingCode",
            },
            total: { $sum: 1 },
            business: { $sum: { $cond: ["$isBusiness", 1, 0] } },
            regular: { $sum: { $cond: ["$isBusiness", 0, 1] } },
            saved: { $sum: { $cond: ["$isMyContact", 1, 0] } },
            unsaved: { $sum: { $cond: ["$isMyContact", 0, 1] } },
          },
        },
        {
          $project: {
            _id: 0,
            country: "$_id.country",
            countryCode: "$_id.countryCode",
            callingCode: "$_id.callingCode",
            total: 1,
            business: 1,
            regular: 1,
            saved: 1,
            unsaved: 1,
            businessPercentage: {
              $round: [{ $multiply: [{ $divide: ["$business", "$total"] }, 100] }, 1],
            },
          },
        },
        { $sort: { total: -1 } },
      ]),
    ]);

    const regularCount = individualCount - businessCount;
    const unsavedCount = totalCount - savedCount;

    res.status(200).json({
      success: true,
      message: "Contact segregation retrieved successfully",
      summary: {
        total: totalCount,
        types: {
          individuals: individualCount,
          groups: groupCount,
          communities: communityCount,
        },
        business: {
          businessCount,
          regularCount,
          businessPercentage:
            individualCount > 0
              ? parseFloat(((businessCount / individualCount) * 100).toFixed(1))
              : 0,
        },
        savedStatus: {
          saved: savedCount,
          unsaved: unsavedCount,
          savedPercentage:
            totalCount > 0
              ? parseFloat(((savedCount / totalCount) * 100).toFixed(1))
              : 0,
        },
      },
      byLocation: countryBreakdown,
    });
  } catch (err) {
    console.error("❌ Error calculating contact segregation:", err);
    res.status(500).json({
      success: false,
      error: "Failed to calculate contact segregation",
      message: err.message || "Unknown error",
    });
  }
};

/**
 * Get all WhatsApp contacts (legacy endpoint with fallback & location filters)
 * GET /contacts
 */
const getContacts = async (req, res) => {
  try {
    const savedOnly = req.query.savedOnly === "true";
    const excludeUnknown = req.query.excludeUnknown === "true";
    const validateNumber = req.query.validateNumber !== "false";
    const country = req.query.country || null;
    const countryCode = req.query.countryCode || null;
    const isBusiness =
      req.query.isBusiness !== undefined ? req.query.isBusiness : null;
    const source = req.query.source || "db"; // Default to DB for instant performance

    // Check DB first
    const contacts = await getAllContacts({
      savedOnly,
      excludeUnknown,
      validateNumber,
      country,
      countryCode,
      isBusiness,
      source,
    });

    res.status(200).json({
      success: true,
      message: "Contacts retrieved successfully",
      total: contacts.length,
      filters: {
        savedOnly,
        excludeUnknown,
        validateNumber,
        country,
        countryCode,
        isBusiness,
        source,
      },
      contacts,
    });
  } catch (err) {
    console.error("❌ Error fetching contacts:", err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch contacts",
      message: err.message || "Unknown error",
    });
  }
};

/**
 * Get contact statistics
 * GET /contacts/stats
 */
const getContactStats = async (req, res) => {
  try {
    const savedOnly = req.query.savedOnly === "true";
    const excludeUnknown = req.query.excludeUnknown === "true";
    const validateNumber = req.query.validateNumber !== "false";
    const country = req.query.country || null;

    const contacts = await getAllContacts({
      savedOnly,
      excludeUnknown,
      validateNumber,
      country,
      source: "db",
    });

    const stats = {
      total: contacts.length,
      saved: contacts.filter((c) => c.isMyContact).length,
      unsaved: contacts.filter((c) => !c.isMyContact).length,
      business: contacts.filter((c) => c.isBusiness).length,
      regular: contacts.filter((c) => !c.isBusiness).length,
      unknown: contacts.filter((c) => c.name === "Unknown").length,
    };

    res.status(200).json({
      success: true,
      message: "Contact statistics retrieved successfully",
      stats,
    });
  } catch (err) {
    console.error("❌ Error calculating contact stats:", err);
    res.status(500).json({
      success: false,
      error: "Failed to calculate contact statistics",
      message: err.message || "Unknown error",
    });
  }
};

/**
 * Export contacts as CSV file with location, business, and Excel-friendly number formatting
 * GET /contacts/export or GET /contacts/database/export
 */
const exportContactsCSV = async (req, res) => {
  try {
    const filter = {};

    if (req.query.savedOnly === "true" || req.query.isSaved === "true") {
      filter.isMyContact = true;
    }
    if (req.query.isBusiness !== undefined) {
      filter.isBusiness = req.query.isBusiness === "true";
    }
    if (req.query.country) {
      filter.country = new RegExp(`^${req.query.country.trim()}$`, "i");
    }
    if (req.query.countryCode) {
      filter.countryCode = req.query.countryCode.trim().toUpperCase();
    }
    if (req.query.type && req.query.type !== "all") {
      filter.type = req.query.type;
    }
    if (req.query.excludeUnknown === "true") {
      filter.name = { $nin: ["Unknown", null, ""] };
    }

    // Query database
    let contacts = await Contact.find(filter)
      .sort({ country: 1, name: 1 })
      .lean();

    // If database is empty and client is ready, fallback to live
    if (contacts.length === 0 && isReady()) {
      contacts = await getAllContacts({
        savedOnly: req.query.savedOnly === "true",
        excludeUnknown: req.query.excludeUnknown === "true",
        country: req.query.country,
        countryCode: req.query.countryCode,
        isBusiness: req.query.isBusiness,
        source: "live",
      });
    }

    // CSV Header with location and business segregation
    const csvHeader =
      "Name,Phone Number,Formatted Number,Country,Country Code,Calling Code,Business,Saved,Type,WhatsApp ID\n";

    const csvRows = contacts
      .map((c) => {
        const name = (c.name || "Unknown").replace(/"/g, '""');
        const number = c.number ? `="${c.number}"` : "";
        const formattedNumber = (c.formattedNumber || "").replace(/"/g, '""');
        const country = (c.country || "Unknown").replace(/"/g, '""');
        const countryCode = c.countryCode || "UNKNOWN";
        const callingCode = c.callingCode ? `+${c.callingCode}` : "";
        const isBusiness = c.isBusiness ? "Yes" : "No";
        const isSaved = c.isMyContact ? "Yes" : "No";
        const type = c.type || "individual";
        const jid = c.jid || c.id || "";

        return [
          `"${name}"`,
          number,
          `"${formattedNumber}"`,
          `"${country}"`,
          `"${countryCode}"`,
          `"${callingCode}"`,
          `"${isBusiness}"`,
          `"${isSaved}"`,
          `"${type}"`,
          `"${jid}"`,
        ].join(",");
      })
      .join("\n");

    const csvContent = csvHeader + csvRows;

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const countrySuffix = req.query.countryCode ? `_${req.query.countryCode}` : "";
    const businessSuffix = req.query.isBusiness === "true" ? "_business" : "";
    const filename = `whatsapp_contacts${countrySuffix}${businessSuffix}_${timestamp}.csv`;

    console.log(`✅ Exported ${contacts.length} contacts to CSV`);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", Buffer.byteLength(csvContent, "utf-8"));

    res.status(200).send(csvContent);
  } catch (err) {
    console.error("❌ Error exporting contacts:", err);
    res.status(500).json({
      success: false,
      error: "Failed to export contacts",
      message: err.message || "Unknown error",
    });
  }
};

module.exports = {
  syncContacts,
  getSyncStatus,
  getDatabaseContacts,
  getContactSegregation,
  getContacts,
  getContactStats,
  exportContactsCSV,
};
