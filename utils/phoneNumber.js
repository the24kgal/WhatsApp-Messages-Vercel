const { parsePhoneNumber, isValidPhoneNumber } = require("libphonenumber-js");
const countries = require("i18n-iso-countries");

// Register English locale for country name lookups
try {
  countries.registerLocale(require("i18n-iso-countries/langs/en.json"));
} catch (e) {
  // Locale might already be registered
}

/**
 * Clean raw phone string
 * @param {string|number} phone 
 * @returns {string}
 */
function sanitizePhoneString(phone) {
  let str = String(phone || "").trim();
  if (str.startsWith("=")) {
    str = str.substring(1).trim();
  }
  // Remove wrapping quotes if present
  if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
    str = str.substring(1, str.length - 1).trim();
  }
  // Remove spaces, hyphens, brackets
  return str.replace(/[\s\-\(\)\.]/g, "");
}

/**
 * Parse phone number and return detailed country, calling code, and formatted details
 * Works globally for all countries
 * 
 * @param {string|number} phone - Phone number to parse
 * @param {string} [defaultCountry=null] - Optional default 2-letter country code
 * @returns {object} Detailed phone and location metadata
 */
function parsePhoneNumberDetails(phone, defaultCountry = null) {
  const clean = sanitizePhoneString(phone);
  if (!clean) {
    return {
      isValid: false,
      number: null,
      international: null,
      national: null,
      countryCode: "UNKNOWN",
      country: "Unknown",
      callingCode: null,
    };
  }

  // Candidate phone strings to try parsing
  const candidates = [];

  if (clean.startsWith("+")) {
    candidates.push({ str: clean, country: defaultCountry });
  } else {
    // Try with leading plus first (standard international)
    candidates.push({ str: `+${clean}`, country: defaultCountry });
    if (defaultCountry) {
      candidates.push({ str: clean, country: defaultCountry.toUpperCase() });
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = candidate.country
        ? parsePhoneNumber(candidate.str, candidate.country)
        : parsePhoneNumber(candidate.str);

      if (parsed && parsed.isValid()) {
        const countryCode = parsed.country || "UNKNOWN";
        let countryName = "Unknown";
        if (countryCode && countryCode !== "UNKNOWN") {
          countryName = countries.getName(countryCode, "en") || countryCode;
        }

        const internationalNumber = parsed.format("E.164"); // e.g. +923001234567
        const cleanDigits = internationalNumber.replace("+", "");

        return {
          isValid: true,
          number: cleanDigits, // E.164 without plus: 923001234567
          international: parsed.formatInternational(), // +92 300 1234567
          national: parsed.formatNational(), // 0300 1234567
          countryCode: countryCode, // PK, US, GB, etc.
          country: countryName, // Pakistan, United States, etc.
          callingCode: parsed.countryCallingCode || null, // 92, 1, 44, etc.
        };
      }
    } catch (e) {
      // Continue to next candidate
    }
  }

  // Fallback for numbers that couldn't be strictly validated but are numeric digits
  const onlyDigits = clean.replace(/\D/g, "");
  return {
    isValid: onlyDigits.length >= 7 && onlyDigits.length <= 15,
    number: onlyDigits || null,
    international: onlyDigits ? `+${onlyDigits}` : null,
    national: onlyDigits || null,
    countryCode: "UNKNOWN",
    country: "Unknown",
    callingCode: null,
  };
}

/**
 * Normalize phone number globally (E.164 digits without '+')
 * Removes country hardcoding and opens up to all countries
 * 
 * @param {string|number} phone - Phone number to normalize
 * @param {string} [defaultCountry=null] - Optional country fallback
 * @returns {string|null} - Normalized digits (e.g. "923001234567" or "12025550123")
 */
function normalizePhoneNumber(phone, defaultCountry = null) {
  const details = parsePhoneNumberDetails(phone, defaultCountry);
  return details.number || null;
}

/**
 * Validate if a phone number is valid globally
 * @param {string|number} phone 
 * @param {string} [defaultCountry=null] 
 * @returns {boolean}
 */
function isValidPhoneNumberGlobal(phone, defaultCountry = null) {
  const details = parsePhoneNumberDetails(phone, defaultCountry);
  return details.isValid;
}

module.exports = {
  normalizePhoneNumber,
  parsePhoneNumberDetails,
  isValidPhoneNumberGlobal,
  sanitizePhoneString,
};
