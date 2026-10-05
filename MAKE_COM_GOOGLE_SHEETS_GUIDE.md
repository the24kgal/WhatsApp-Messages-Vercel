# 📊 Make.com to Google Sheets Integration & Batch Contacts Guide

This guide explains how to fetch 3,000+ WhatsApp contacts without timeouts, segregate them by location and business, and automatically export them to Google Sheets via **Make.com**.

---

## 🚀 Why Did `getContacts` Timeout Previously?

In `whatsapp-web.js`, the standard `client.getContacts()` attempts to serialize all contacts into a single massive payload across Chrome DevTools Protocol (CDP). When you have **3,000+ contacts, groups, and communities**, this single call exceeds Puppeteer's 30-second execution threshold, causing a timeout crash.

### How the New Solution Solves This:
1. **Lightweight Chunked Extraction**: Fetches contacts and chats in slices of 250 directly from WhatsApp Web store without freezing Puppeteer.
2. **MongoDB Database Persistence**: Automatically normalizes and saves all contacts, groups, and unsaved group participants into MongoDB using high-speed bulk upserts (`Contact` collection).
3. **Dedicated Make.com API Endpoint (`/contacts/database`)**: Make.com queries MongoDB directly with sub-50ms response times, zero timeouts, and full pagination support (`page` & `limit`).
4. **Global Country Support**: Removed all hardcoded country rules (`"PK"`). Phone numbers are parsed globally using `libphonenumber-js` and mapped to countries via `i18n-iso-countries`.
5. **Location & Business Segregation**: Every contact is tagged with country code, full country name, business status (`isBusiness`), and saved status (`isMyContact`).

---

## 🔄 Step 1: Synchronize Contacts to Database

Before fetching from Make.com, trigger the batch sync once (or periodically via webhook):

### Option A: From Web Browser UI
Open:
```
http://localhost:3000/export.html
```
Click **"Run Fast Batch Sync (3000+ Contacts)"** and watch the real-time progress bar.

### Option B: Via REST API
```bash
# Start background sync (returns immediately with status URL)
POST http://localhost:3000/contacts/sync

# Check live progress
GET http://localhost:3000/contacts/sync/status
```

---

## 🔗 Step 2: Make.com Setup (Sync to Google Sheets)

### 1. In Make.com, create a new Scenario:
1. **Trigger Module**: `Schedule` (e.g. Every day at 09:00, or Webhook).
2. **HTTP Module**: Select **"Make a request"**.
   - **URL**: `http://YOUR_SERVER_IP:3000/contacts/database?format=sheets&limit=500`
   - **Method**: `GET`
   - **Headers**: `Content-Type: application/json`
   - **Parse response**: `Yes`
3. **Iterator Module** (Flow Control):
   - **Array**: `{{1.data}}` (the array of contacts returned from the HTTP module)
4. **Google Sheets Module**: Select **"Add a Row"**.
   - **Spreadsheet**: Select your Google Sheet.
   - **Sheet Name**: e.g., `Sheet1` or `WhatsApp Contacts`.
   - **Map Columns**:
     - `Name` ➔ `{{2.Name}}`
     - `Phone Number` ➔ `{{2.Phone Number}}`
     - `Formatted Number` ➔ `{{2.Formatted Number}}`
     - `Country` ➔ `{{2.Country}}`
     - `Country Code` ➔ `{{2.Country Code}}`
     - `Calling Code` ➔ `{{2.Calling Code}}`
     - `Is Business` ➔ `{{2.Is Business}}`
     - `Is Saved` ➔ `{{2.Is Saved}}`
     - `Type` ➔ `{{2.Type}}`
     - `WhatsApp ID` ➔ `{{2.WhatsApp JID}}`

---

## 🎯 Filtering & Segregation Options

You can append any of these query parameters to `/contacts/database` to segregate contacts:

| Filter Parameter | Example | Description |
| :--- | :--- | :--- |
| `country` | `?country=United States` | Filter by full country name |
| `countryCode` | `?countryCode=US` | Filter by 2-letter ISO country code |
| `isBusiness` | `?isBusiness=true` | Only WhatsApp Business accounts |
| `isBusiness` | `?isBusiness=false` | Only regular user accounts |
| `isSaved` | `?isSaved=true` | Only contacts saved in your phonebook |
| `isSaved` | `?isSaved=false` | Only unsaved numbers & group leads |
| `type` | `?type=individual` | Individuals only |
| `type` | `?type=group` | Group chats |
| `type` | `?type=community` | Communities and parent groups |
| `limit` | `?limit=500` | Number of items per batch (default 100) |
| `page` | `?page=2` | Pagination page number |
| `since` | `?since=2026-10-01T00:00:00Z` | Incremental sync (only newly updated) |

### Example Segregation Queries for Make.com:

1. **Only US Business Accounts**:
   ```
   GET http://localhost:3000/contacts/database?countryCode=US&isBusiness=true&format=sheets
   ```

2. **Only Pakistan Unsaved Leads**:
   ```
   GET http://localhost:3000/contacts/database?countryCode=PK&isSaved=false&format=sheets
   ```

3. **All Groups & Communities**:
   ```
   GET http://localhost:3000/contacts/database?type=group&format=sheets
   ```

---

## 📊 Analytics & Breakdown Endpoint

To see high-level statistics of your contacts segregated by location and business:

```bash
GET http://localhost:3000/contacts/segregation
```

### Sample Response:
```json
{
  "success": true,
  "summary": {
    "total": 3540,
    "types": {
      "individuals": 3310,
      "groups": 210,
      "communities": 20
    },
    "business": {
      "businessCount": 780,
      "regularCount": 2530,
      "businessPercentage": 23.6
    },
    "savedStatus": {
      "saved": 1240,
      "unsaved": 2300,
      "savedPercentage": 35.0
    }
  },
  "byLocation": [
    {
      "country": "Pakistan",
      "countryCode": "PK",
      "callingCode": "92",
      "total": 1850,
      "business": 420,
      "regular": 1430,
      "saved": 820,
      "unsaved": 1030,
      "businessPercentage": 22.7
    },
    {
      "country": "United States",
      "countryCode": "US",
      "callingCode": "1",
      "total": 520,
      "business": 190,
      "regular": 330,
      "saved": 210,
      "unsaved": 310,
      "businessPercentage": 36.5
    }
  ]
}
```

---

## 📥 Direct CSV Export with Segregation

You can also download CSV files directly from the browser or curl:

```bash
# Export all contacts
curl -O http://localhost:3000/contacts/export

# Export only business contacts in the UK
curl -O "http://localhost:3000/contacts/export?countryCode=GB&isBusiness=true"
```
The exported CSV automatically formats phone numbers as `="<number>"` so that Excel and Google Sheets do not convert large numbers into scientific notation (like `9.23E+11`).
