═══════════════════════════════════════════════════════
CUREVIE BACKEND — QA AUDIT REPORT
Generated: 2026-02-25
Auditor: Senior QA Engineer (AI-Assisted)
Codebase: 33 Module Files | 4 Middlewares | 7 Utils
═══════════════════════════════════════════════════════

# EXECUTIVE SUMMARY

The Curevie backend demonstrates **solid foundational architecture** with proper separation of concerns (controller → service → DB), consistent use of parameterized queries preventing SQL injection, comprehensive Joi validation schemas, and a well-designed JWT refresh token rotation system with reuse detection. However, the audit uncovered **critical issues** including: an unauthenticated request creation endpoint (`POST /api/requests`), a `payment_method` enum mismatch between schema and payments table, N+1 query patterns in notification dispatch, race conditions on coupon `used_count`, missing request cancellation side-effects (no invoice cancellation, no points refund, no coupon decrement), and silent `.catch(() => {})` patterns that swallow failures on critical operations.

---

# RISK MATRIX

| Severity    | Count | Description                |
| ----------- | ----- | -------------------------- |
| 🔴 CRITICAL | 8     | Must fix before production |
| 🟠 HIGH     | 11    | Fix within 1 sprint        |
| 🟡 MEDIUM   | 14    | Fix within 1 month         |
| 🟢 LOW      | 9     | Nice to have               |
| ✅ PASSED   | 12    | No issues found            |

---

# PHASE 1 — ALGORITHMIC COMPLEXITY ANALYSIS

## Flagged Functions

| Function                | File                          | Time                      | Space      | Flag                                                                                                   |
| ----------------------- | ----------------------------- | ------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `notifyRequestCreated`  | `notification.service.js:46`  | O(A) where A=admin count  | O(A)       | ⚠️ N+1 — `createMany` calls `createNotification` per admin in a loop, each executing a separate INSERT |
| `notifyPaymentReceived` | `notification.service.js:113` | O(A)                      | O(A)       | ⚠️ Same N+1 pattern — loops all admins                                                                 |
| `createManyRanges`      | `labrange.service.js:99`      | O(N) per range            | O(1)       | ⚠️ Executes INSERT per range inside a loop — no batch INSERT                                           |
| `createPackage`         | `labtest.service.js:216`      | O(T) per test_id          | O(1)       | ⚠️ Inserts `package_tests` per test_id in a loop                                                       |
| `updatePackage`         | `labtest.service.js:252`      | O(T) per test_id          | O(1)       | ⚠️ Same loop pattern — DELETE all then INSERT per test_id                                              |
| `saveRequestFiles`      | `request.service.js:410`      | O(F) per file             | O(F)       | ⚠️ INSERT per file in loop within transaction                                                          |
| `listMyConversations`   | `chat.service.js:76`          | O(C) conversations        | O(C)       | ✅ Uses LATERAL subqueries efficiently                                                                 |
| `createRequest`         | `request.service.js:66`       | O(1)                      | O(1)       | ✅ Single transaction, constant queries                                                                |
| `listRequests`          | `request.service.js:234`      | O(N)                      | O(N)       | ⚠️ No total count returned — pagination incomplete                                                     |
| `wrapText`              | `pdfEngine.js:477`            | O(W²) worst case per word | O(L) lines | 🟡 Character-by-character splitting on long tokens                                                     |
| `deleteByPattern`       | `cache.js:58`                 | O(K) total keys           | O(B) batch | ✅ Uses SCAN with COUNT 100, cursor-based                                                              |
| `listServiceRatings`    | `service.service.js:217`      | O(N) all ratings          | O(N)       | ⚠️ No pagination — returns ALL ratings for a service                                                   |
| `listLabTestRatings`    | `labtest.service.js:396`      | O(N)                      | O(N)       | ⚠️ No pagination — returns ALL ratings                                                                 |
| `listPackageRatings`    | `labtest.service.js:455`      | O(N)                      | O(N)       | ⚠️ No pagination — returns ALL ratings                                                                 |
| `getPatientHistory`     | `patient.service.js:50`       | O(N)                      | O(N)       | ⚠️ No pagination — returns ALL history                                                                 |

---

# PHASE 2 — DATA FLOW ANALYSIS

## 2.1 ServiceRequest Lifecycle

**Creation** (`request.service.js:66`): Validated via `createRequestSchema` → transaction: insert request → create invoice → deduct points → earn points → increment package orders → COMMIT.

**Status Changes** (`request.service.js:299`): `updateRequestStatus` — sets `completed_at = NOW()` on COMPLETED. **No state transition validation** — any status can transition to any other status (e.g., COMPLETED → PENDING is allowed).

🔴 **CRITICAL — Missing cancellation side-effects**: When status changes to CANCELLED:

- Invoice is NOT cancelled or updated
- Points redeemed are NOT refunded
- Points earned are NOT reversed
- Coupon `used_count` is NOT decremented
- `packages.times_ordered` is NOT decremented

## 2.2 Invoice Lifecycle

**Creation**: Auto-created inside `createRequest` transaction — atomic with request. If invoice INSERT fails, the whole transaction rolls back. ✅

**Payment (simple)**: `invoice.controller.js:payInvoice` — marks full invoice as PAID. Only checks `PAID` status, does **NOT** check `CANCELLED` status. 🟠

**Payment (partial)**: `payment.routes.js:103` — uses `FOR UPDATE` lock on invoice row. Checks for CANCELLED. Checks for overpayment. ✅

**Failure Point**: `markInvoicePaid` does NOT check if invoice is CANCELLED before marking PAID. 🔴

## 2.3 Payment Lifecycle

**Recording** (`payment.routes.js:103`): Within transaction with `FOR UPDATE` lock. Recalculates `total_paid`, `remaining_amount`, `payment_status_detail`. ✅

**Deletion** (`payment.routes.js:268`): Recalculates invoice totals after deletion. Uses `FOR UPDATE`. ✅

**⚠️ Enum Mismatch**: `payment_method` in `payments` table uses CHECK constraint with `('CASH', 'CLICK', 'CARD', 'INSURANCE', 'OTHER')` but `schema.sql` defines `payment_method` ENUM as `('CASH', 'CARD', 'INSURANCE')`. The `invoices` table uses the ENUM type while `payments` uses a VARCHAR CHECK — these are incompatible when `payment.routes.js:177` casts to `::payment_method`.

## 2.4 Patient Lifecycle

**Registration**: `auth.controller.js:52` — hashes password, creates patient. ✅
**VIP Upgrade**: `patient.controller.js:73` — admin sets `is_vip` + `vip_discount`. Sets `vip_discount = 0` when `is_vip = false`. ✅
**Points Accumulation**: Earned at request creation only. Redemption at request creation. ✅ Atomic within transaction.
**Deletion**: `DELETE FROM patients WHERE id = $1` — relies on `ON DELETE CASCADE` for `patient_history`, `points_log`, `lab_test_results` (via service_requests), `service_requests`. 🟡 Invoices reference `patient_id` without CASCADE — orphaned invoices remain.

## 2.5 LabTestResult Lifecycle

**Entry** (`request.service.js:350`): Calls `evaluateResult` for smart range evaluation. Checks column support dynamically. ✅
**Smart Range Evaluation** (`labrange.service.js:256`): Resolves best-matching range by priority, gender specificity, condition match. ✅
**Flag Assignment**: Computed flags: NORMAL, LOW, HIGH, ABNORMAL, NO_RANGE, PARSE_ERROR. ✅
**PDF Report**: `report.controller.js:13` → `generateMedicalReportPdf`. No limit on number of lab results rendered. 🟡

## 2.6 Message (Chat) Lifecycle

**Creation** (`chat.service.js:187`): Transaction — INSERT message → UPDATE `conversations.last_message_at`. ✅
**Media Upload**: Upload to BunnyCDN via `uploadToBunny` with memory storage (up to 10MB). ✅
**Read Marking** (`chat.service.js:223`): Updates all unread messages from other sender. ✅
**Missing**: No message deletion endpoint. 🟢

## 2.7 Notification Lifecycle

**Trigger**: Called from controllers with `.catch(() => {})` — notification failures are silently swallowed. 🟠
**Creation**: `createNotification` function. Individual INSERT per notification. 🟡
**Delivery**: No push notification / WebSocket delivery — only stored in DB for polling. 🟢

---

# PHASE 3 — SECURITY AUDIT

## 3.1 Authentication & Authorization

🔴 **QA-001 CRITICAL — `POST /api/requests` is unauthenticated** (`request.routes.js:12`):
The route `router.post('/', asyncHandler(requestController.createRequest))` has NO `authenticate` middleware and NO validation middleware (`createRequestSchema` is never applied). Any anonymous user can create requests with arbitrary data. The `guestRequestLimiter` is also NOT applied.

🟠 **QA-002 — `GET /api/services/:id/ratings` is unauthenticated** (`service.routes.js:72`):
`readLimiter` applied but NO `authenticate`. Exposes patient names and ratings publicly.

🟠 **QA-003 — `GET /api/lab/:id/ratings` is unauthenticated** (`labtest.routes.js:91`):
Same issue — public access to patient rating data.

🟠 **QA-004 — `GET /api/lab/packages/:id/ratings` is unauthenticated** (`labtest.routes.js:140`):
Same pattern.

✅ **selfOrStaff/selfOrAdmin guards**: Properly implemented — compare `req.user.id === req.params.id`. No bypass found.

✅ **JWT secret**: No hardcoded fallback — uses `process.env.JWT_SECRET` directly. If undefined, `jwt.sign` would throw.

🟡 **JWT_EXPIRES_IN fallback**: `process.env.JWT_EXPIRES_IN || '15m'` is used in `auth.js:7` — secure default.

## 3.2 Input Validation & Injection

✅ **SQL Injection**: All queries use parameterized `$1, $2...` placeholders. No string concatenation of user input into SQL.

🔴 **QA-005 — `POST /api/requests` missing validation**: As noted above, `createRequestSchema` is imported in `schemas.js` but never applied as middleware on the route. The controller does minimal manual checks instead.

🟠 **QA-006 — `PUT /api/requests/:id/status` missing validation middleware**: Route at `request.routes.js:42` has no `validate(updateStatusSchema)`. Controller validates manually with `validStatuses.includes()` but status body fields aren't sanitized via Joi/XSS.

🟠 **QA-007 — `PUT /api/requests/:id/assign` missing validation middleware**: Route at `request.routes.js:43` has no `validate(assignProviderSchema)`. Controller checks `if (!provider_id)` manually but doesn't validate UUID format.

🟡 **UUID format**: Most routes rely on PostgreSQL's `22P02` error for invalid UUIDs (caught by `errorHandler.js:41`). Works but returns generic error instead of field-specific validation error.

✅ **XSS sanitization**: Applied via `validate.js` using the `xss` library on all validated request bodies.

✅ **File upload MIME checks**: `upload.js` uses `allowedMimeTypes.has(file.mimetype)` — although MIME type can be spoofed by clients, this is a standard first-line defense.

## 3.3 Business Logic Security

🔴 **QA-008 — Coupon `used_count` race condition** (`request.service.js:126`):

```sql
UPDATE coupons SET used_count = used_count + 1 WHERE id = $1
```

This runs within a transaction but **without `FOR UPDATE` lock on the coupon row**. Two concurrent requests using the same coupon could both read `used_count < max_uses`, both pass validation, and both increment — exceeding `max_uses`.

🟡 **Points manipulation**: Points deduction in `createRequest` checks `Math.min(points_to_use, availablePoints)` — prevents using more than available. ✅ However, `total_points` update is not locked with `FOR UPDATE`, creating a potential race condition if two requests are submitted simultaneously.

🟡 **Overpayment in simple pay**: `invoice.controller.js:payInvoice` marks invoice as PAID regardless of amount — it's a full-pay endpoint. But it doesn't verify remaining balance vs. payments already made (relevant when partial payments exist via the payments module).

✅ **CANCELLED invoice payment check**: `payment.routes.js:125` correctly blocks payments on cancelled invoices.

## 3.4 Information Disclosure

✅ **Error messages**: Production mode returns generic "Something went wrong" (`errorHandler.js:64`). Stack traces only in development.

✅ **Password fields**: Never returned in SELECT queries — all service functions explicitly list return columns excluding password.

🟡 **`SELECT *` usage**: `invoice.service.js` uses `SELECT *` in several queries which could return internal fields. Same in `notification.service.js`.

## 3.5 Rate Limiting Coverage

| Route                             | Limiter                 | Assessment                                  |
| --------------------------------- | ----------------------- | ------------------------------------------- |
| `POST /api/auth/login`            | `authLimiter` (5/15min) | ✅                                          |
| `POST /api/auth/register`         | `authLimiter`           | ✅                                          |
| `POST /api/auth/refresh`          | `authLimiter`           | ✅                                          |
| `POST /api/requests`              | **NONE**                | 🔴 No rate limiting at all                  |
| `POST /api/payments/invoice/:id`  | **NONE**                | 🟠 Payment endpoint with no rate limiter    |
| `DELETE /api/payments/:id`        | **NONE**                | 🟠                                          |
| `GET /api/reports/financial`      | **NONE**                | 🟡 Expensive query with no rate limiter     |
| `POST /api/reports/convert`       | **NONE**                | 🟠 File upload + conversion with no limiter |
| `GET /api/notifications`          | **NONE**                | 🟡                                          |
| `PUT /api/notifications/read-all` | **NONE** | 🟡 |

---

# PHASE 4 — DATABASE & QUERY AUDIT

## 4.1 Missing Indexes

| Column | Table | Used In | Index? |
|---|---|---|---|
| `patient_id` | `service_requests` | WHERE, JOIN | ❌ Missing |
| `service_id` | `service_requests` | JOIN | ❌ Missing |
| `lab_test_id` | `service_requests` | JOIN | ❌ Missing |
| `package_id` | `service_requests` | JOIN | ❌ Missing |
| `assigned_provider_id` | `service_requests` | WHERE, JOIN | ❌ Missing |
| `request_id` | `lab_test_results` | WHERE | ✅ In `001_add_indexes.sql` |
| `request_id` | `invoices` | WHERE, JOIN | ✅ In `001_add_indexes.sql` |
| `patient_id` | `invoices` | WHERE | ✅ In `001_add_indexes.sql` |
| `coupon_id` | `invoices` | JOIN | ❌ Missing |
| `code` | `coupons` | WHERE | ❌ Missing (queried by exact match) |
| `conversation_id` | `messages` | WHERE, ORDER | ✅ In `005_chat.sql` |
| `patient_id` | `conversations` | WHERE | ✅ In `005_chat.sql` |
| `request_id` | `service_ratings` | WHERE, JOIN | ✅ In `003_ratings.sql` |
| `patient_id` | `patient_history` | WHERE | ❌ Missing |
| `lab_test_id` | `lab_test_reference_ranges` | WHERE | ✅ In `008_lab_reference_ranges.sql` |

## 4.2 N+1 Query Problems

🔴 **QA-009 — `notifyRequestCreated`** (`notification.service.js:50`):
```js
const admins = await pool.query('SELECT id FROM admins');
for (const admin of admins.rows) {
  notifications.push({...});
}
await createMany(notifications, client);
// createMany → Promise.all(notifications.map(n => createNotification(n)))
// Each createNotification executes: INSERT INTO notifications ...
```
**Impact**: For 10 admins, this fires 10+ individual INSERT statements. Should use a single multi-row INSERT.

🟠 **QA-010 — `createPackage` test_ids loop** (`labtest.service.js:235`):
```js
for (const testId of uniqueTestIds) {
  await client.query('INSERT INTO package_tests ...');
}
```
Individual INSERT per test_id within transaction. Should batch.

🟠 **QA-011 — `createManyRanges` loop** (`labrange.service.js:107`):
Same pattern — individual INSERT per range item within transaction.

## 4.3 Transaction Safety

| Operation | Multi-table? | Transaction? | Status |
|---|---|---|---|
| `createRequest` | requests, invoices, patients, points_log, packages | ✅ Yes | ✅ Proper BEGIN/COMMIT/ROLLBACK |
| `addPayment` | payments, invoices | ✅ Yes | ✅ Proper + FOR UPDATE |
| `deletePayment` | payments, invoices | ✅ Yes | ✅ Proper + FOR UPDATE |
| `createMessage` | messages, conversations | ✅ Yes | ✅ Proper |
| `saveRequestFiles` | request_files (multiple inserts) | ✅ Yes | ✅ Proper |
| `createPackage` | packages, package_tests | ✅ Yes | ✅ Proper |
| `updatePackage` | packages, package_tests | ✅ Yes | ✅ Proper |
| `createManyRanges` | lab_test_reference_ranges | ✅ Yes | ✅ Proper |
| `updateRequestStatus` | service_requests only | No | ⚠️ Should also update invoice when CANCELLED |
| `markInvoicePaid` | invoices only | No | 🟡 No check for existing partial payments |
| `deletePatient` | patients (cascade) | No | 🟡 Relies entirely on CASCADE constraints |

## 4.4 Race Conditions

🔴 **QA-012 — Coupon `used_count` race**: `request.service.js:106-127` — SELECT coupon, check `used_count < max_uses`, then UPDATE `used_count + 1`. No `FOR UPDATE` on the coupon row means concurrent requests can both pass the check.

🟡 **QA-013 — Patient `total_points` race**: `request.service.js:188,200` — UPDATE `total_points - $1` and `total_points + $1` in same transaction. Since it's within a transaction using a dedicated client, this is safe against concurrent modifications to the SAME request. However, two concurrent `createRequest` calls for the same patient could read stale `total_points` from the SELECT at line 93 (no `FOR UPDATE` on patients row).

✅ **Invoice partial payment**: Uses `FOR UPDATE` on invoice row — race-safe.

✅ **Refresh token rotation**: `auth.service.js` uses `DELETE` + `INSERT` — if two requests use the same refresh token concurrently, the second `DELETE` returns 0 rows, and the `familyTokens.length > 0` reuse detection triggers revocation.

## 4.5 Data Integrity

🔴 **QA-014 — `payment_method` ENUM mismatch**:
- `schema.sql:4`: `CREATE TYPE payment_method AS ENUM ('CASH', 'CARD', 'INSURANCE');`
- `payments` table (`007_payments_notifications.sql:16`): `CHECK (payment_method IN ('CASH', 'CLICK', 'CARD', 'INSURANCE', 'OTHER'))`
- `payment.routes.js:177`: Casts `payment_method` to `::payment_method` ENUM type on invoice update
- **Result**: Paying with 'CLICK' or 'OTHER' will succeed inserting into `payments` but **FAIL** when casting to `::payment_method` ENUM on invoice update, causing a transaction rollback.

🟡 **Nullable FK**: `notifications.user_id` references no FK constraint — just stores a UUID. If the user is deleted, notifications remain with orphaned `user_id`.

🟡 **`recorded_by` in payments**: Not a foreign key — just a UUID. Cannot be validated at DB level.

---

# PHASE 5 — ERROR HANDLING & RESILIENCE

## 5.1 Silent Error Swallowing

🟠 **QA-015 — `.catch(() => {})` on critical operations**:

| Location | Operation | Risk |
|---|---|---|
| `request.controller.js:53` | `notifyRequestCreated().catch(() => {})` | Admins never learn about new requests |
| `request.controller.js:97` | `notifyRequestStatusChanged().catch(() => {})` | Patient never learns status changed |
| `patient.controller.js:92` | `notifyVipGranted().catch(() => {})` | Patient never learns about VIP status |

These silently discard notification errors including **database connection failures**. If PostgreSQL pool is exhausted, notifications fail silently.

🟡 **Note**: `notifyPaymentReceived` in `payment.routes.js:184` is called **without** `.catch()` — an unhandled notification failure here would crash the request **after** the payment transaction has already committed. Inconsistent error handling.

## 5.2 External Service Failures

🟡 **BunnyCDN**: All upload functions return `null` on failure — controllers check for `null` and return 502. ✅ However, `deletFromBunny` failures in avatar replacement (`patient.controller.js:129`, `provider.controller.js:125`) are not caught — if CDN delete fails, old file becomes orphaned but upload continues. Acceptable.

✅ **Redis**: `cache.js` wraps all operations in try/catch, returns `null` on failure. App degrades gracefully to no-cache mode.

✅ **PostgreSQL pool**: `db.js` uses connection pool with `max: 20`. Pool exhaustion returns error to client via `errorHandler`.

🟡 **PDF generation**: `report.controller.js:33` catches errors and returns 500. But `report.routes.js:142` (invoice PDF) does **not** have try/catch around `generateInvoicePdf` — relies on `asyncHandler` which will return 500 but with potential file handle leak if `createReadStream` was partially set up.

## 5.3 Missing Error Codes

🟠 **QA-016 — Inconsistent error codes**:

| Route | Error Response | Has `code`? |
|---|---|---|
| `POST /api/requests` (validation) | `{ message: 'request_type and service_type are required' }` | ❌ |
| `GET /api/requests/:id` | `{ message: 'Request not found' }` | ❌ |
| `PUT /api/requests/:id/status` | `{ message: 'Request not found' }` | ❌ |
| `PUT /api/requests/:id/status` | `{ message: 'status must be one of...' }` | ❌ |
| `PUT /api/requests/:id/assign` | `{ message: 'provider_id is required' }` | ❌ |
| `GET /api/payments/invoice/:id` | `{ message: 'الفاتورة غير موجودة' }` | ❌ |
| `POST /api/payments/invoice/:id` | `{ message: 'لا يمكن...' }` | ✅ INVOICE_CANCELLED |
| All notification routes | Arabic messages only | ❌ |
| All payment routes | Mixed Arabic/English | Inconsistent |

---

# PHASE 6 — PERFORMANCE ANALYSIS

## 6.1 Cache Coverage

| Endpoint | Cached? | TTL | Assessment |
|---|---|---|---|
| `GET /api/services/categories` | ✅ | 600s | ✅ |
| `GET /api/services` | ✅ | 300s | ✅ |
| `GET /api/lab` (tests list) | ✅ | 300s | ✅ |
| `GET /api/lab/packages` | ✅ | 300s | ✅ |
| `GET /api/invoices` | ❌ | — | 🟡 High-read admin endpoint, could benefit from short cache |
| `GET /api/invoices/stats` | ❌ | — | 🟡 Expensive aggregation queries, should cache |
| `GET /api/reports/financial` | ❌ | — | 🟠 Very expensive — 5 complex queries, no cache |
| `GET /api/patients` | ❌ | — | 🟢 Lower priority |
| `GET /api/notifications` | ❌ | — | 🟢 User-specific, hard to cache |

**Cache Invalidation**: Uses wildcard `cache.del('services:list:*')` pattern. Implemented via Redis SCAN + DEL in batches. ✅ Correct.

🟡 **Cache key collision**: Keys use `JSON.stringify(query)` — key order matters. `{page:1,limit:10}` and `{limit:10,page:1}` produce different cache keys for the same result.

## 6.2 Response Payload Size

🟡 **QA-017 — `SELECT *` in queries**:
- `invoice.service.js:35` — `SELECT i.*` returns all invoice columns including internal tracking fields
- `chat.service.js:23` — `SELECT * FROM conversations` — returns all columns
- `labtest.service.js:43` — `SELECT lt.*` — returns all columns including `image_url`, `description`
- `request.service.js:268` — `SELECT sr.*, ... i.*` — double `*` returns overlapping column names

🟡 **QA-018 — Unbounded result sets**:
- `listServiceRatings` — no LIMIT clause, returns ALL ratings
- `listLabTestRatings` — no LIMIT
- `listPackageRatings` — no LIMIT
- `getPatientHistory` — no LIMIT
- `getRecentPatientRequests` — capped at LIMIT 20 ✅
- `listRequests` — has LIMIT/OFFSET but no total count query (pagination metadata missing `total`)

## 6.3 File Handling

🟡 **QA-019 — Temp files in PDF conversion**: `report.routes.js:166` uses `multer.dest` for temp files. Cleanup in `stream.on('end')` callback — but if client disconnects mid-stream, `end` may not fire. `fs.unlink` in catch block handles error path.

🟡 **Invoice PDF race**: `pdfEngine.js` generates files to local disk. If two requests generate PDF for the same invoice simultaneously, they would write to different temp files (using `crypto.randomUUID()`), so no collision. ✅

🟡 **Memory usage**: `multer.memoryStorage()` for chat media up to 10MB (`upload.js:14` — `limits: { fileSize: 10 * 1024 * 1024 }`). Under concurrent uploads, multiple 10MB buffers in memory. Request file uploads use disk storage with 15MB limit — safer.

---

# PHASE 7 — API CONTRACT & CONSISTENCY AUDIT

## 7.1 Response Format Consistency

🟠 **QA-020 — Inconsistent response shapes**:

| Endpoint | Shape | Standard? |
|---|---|---|
| `GET /api/patients` | `{ data, pagination }` | ✅ |
| `GET /api/providers` | `{ data, pagination }` | ✅ |
| `GET /api/services` | `{ data, pagination }` | ✅ |
| `GET /api/requests` | `{ data, pagination }` (missing `total`) | ⚠️ |
| `GET /api/chat/conversations` | `{ data }` (no pagination) | ⚠️ |
| `GET /api/notifications` | `{ data, pagination, unread_count }` | ✅ Custom |
| `GET /api/services/:id/ratings` | `{ service, summary, data }` (no pagination) | ⚠️ |
| `GET /api/lab/:id/ratings` | `{ lab_test, summary, data }` (no pagination) | ⚠️ |
| `GET /api/lab/packages/:id/ratings` | `{ package, summary, data }` (no pagination) | ⚠️ |
| `GET /api/lab/:testId/ranges` | Raw array | ❌ Not wrapped |
| `GET /api/lab/:testId/ranges/resolve` | Raw object or null | ❌ Not wrapped |

## 7.2 HTTP Method Correctness

🟡 **QA-021**: `PUT /api/invoices/:id/pay` — semantically this is an action, not a full resource replacement. `POST` or `PATCH` would be more appropriate.

🟡 **QA-022**: `PUT /api/notifications/read-all` — mass update action, `POST /api/notifications/read-all` more appropriate.

🟡 **QA-023**: `DELETE /api/services/:id` calls `deactivateService` (soft-delete via `is_active = FALSE`), not actual deletion. The HTTP method `DELETE` is misleading.

## 7.3 Missing CRUD Operations

🟠 **QA-024 — Missing endpoints**:

| Entity | Create | Read List | Read By ID | Update | Delete |
|---|---|---|---|---|---|
| Services | ✅ | ✅ | ❌ **Missing** | ✅ | ✅ (soft) |
| Requests | ✅ | ✅ | ✅ | ✅ (status) | ❌ Missing |
| Lab Tests | ✅ | ✅ | ❌ **Missing** | ✅ | ❌ Missing |
| Packages | ✅ | ✅ | ❌ **Missing** | ✅ | ❌ Missing |
| Categories | ✅ | ✅ | ❌ Missing | ❌ Missing | ❌ Missing |
| Invoices | Auto | ✅ | ❌ Missing | ✅ (pay) | ❌ Missing |
| Coupons | ✅ | ✅ | ❌ Missing | ✅ | ❌ Missing |
| Messages | ✅ | ✅ | ❌ Missing | ❌ | ❌ Missing |
| Notifications | Auto | ✅ | ❌ Missing | ✅ (read) | ✅ |

## 7.4 Versioning

🟢 **QA-025**: No API versioning — all routes under `/api/`. No `/v1/` prefix. Future breaking changes will require careful migration.

## 7.5 Language Inconsistency

🟠 **QA-026**: Error messages mix Arabic and English across modules:
- `patients`, `providers`, `services`, `labtests`, `chat` — English messages
- `payments`, `notifications`, `reports` — Arabic messages
- `invoices` — English messages

---

# PHASE 8 — BUSINESS LOGIC AUDIT

## 8.1 Points System

✅ **Points earned**: At `request.service.js:198-207` — `Math.floor(finalAmount)` points earned per request for PATIENT type with `finalAmount > 0`. Written to `points_log` with reason 'EARNED'.

✅ **Points redeemed**: At `request.service.js:130-196` — `pointsDiscountAmount = pointsUsed * 0.01`. Deducted from `total_points`. Written to `points_log` with reason 'REDEEMED'.

🟡 **Points rate hardcoded**: `0.01` currency per point at line 135. No configuration. Magic number.

🔴 **QA-027 — Points NOT refunded on cancellation**: When request status changes to CANCELLED, `total_points` adjustments are NOT reversed and `points_log` entries are NOT created for refund.

## 8.2 VIP System

✅ **VIP discount application**: At `request.service.js:98-100` — `vipDiscountAmount = (originalAmount * patientData.vip_discount) / 100`. Applied at invoice creation time.

🟡 **VIP discount not recalculated**: If VIP status changes after invoice creation, the invoice keeps the original discount. This may be intentional business logic.

✅ **`vip_discount` reset**: `patient.service.js:138` — `is_vip ? vip_discount : 0`. Correctly sets discount to 0 when VIP is revoked.

## 8.3 Coupon System

🔴 **QA-028 — `used_count` race condition**: Already documented as QA-012. No row-level lock.

✅ **Expired coupon validation**: Server-side check at `request.service.js:111` — `expires_at IS NULL OR expires_at > NOW()`. Checked within the transaction.

🟡 **Coupon applied to GUEST requests**: The coupon validation in `createRequest` does NOT check `request_type`. A guest can use a coupon. Whether this is intended depends on business requirements — **UNVERIFIED**.

🔴 **QA-029 — Coupon `used_count` NOT decremented on cancellation**: When a request is cancelled, the coupon's `used_count` remains incremented, effectively "wasting" a coupon use.

## 8.4 Invoice Auto-Creation

✅ **When created**: Invoice is created atomically with the request inside `createRequest` transaction. If invoice creation fails, the entire transaction rolls back — request is not created.

## 8.5 Request Cancellation

🔴 **QA-030 — Incomplete cancellation logic**: `updateRequestStatus` is a simple UPDATE that only modifies the `service_requests` row. When cancelling:

- Invoice `payment_status` stays unchanged (PENDING even though request is CANCELLED)
- Points earned from the request are NOT reversed
- Points redeemed for the request are NOT refunded
- Coupon `used_count` is NOT decremented
- `packages.times_ordered` is NOT decremented
- No cancellation notification to providers (only patient is notified)

---

# PHASE 9 — CODE QUALITY & MAINTAINABILITY

## 9.1 Dead Code / Unused Exports

🟢 **QA-031**: `notifyPointsEarned` is exported from `notification.service.js:155` but never called anywhere. Points are earned in `request.service.js` without notification.

🟢 **QA-032**: `guestRequestLimiter` is defined in `rateLimiter.js` and imported in `app.js` but NOT used as middleware — it's assigned to `guestRequestLimiter` variable in `rateLimiter.js` and exported, but never applied to any route.

🟢 **QA-033**: `createRequestSchema` is defined in `schemas.js` but never used as route middleware — `POST /api/requests` has no validation middleware.

## 9.2 Inconsistent Patterns

🟠 **QA-034 — `payment.routes.js` has all logic inline**:
The payments module has NO controller or service file. All database queries, business logic, validation, and response handling are in a single routes file (332 lines). Every other module uses controller → service → DB separation.

🟡 **QA-035 — Mixed approach to validation**: Some routes use `validate(schema)` middleware, others validate inline with `Joi.validate()` in the handler (e.g., `payment.routes.js:105`, `notification.routes.js:16`).

🟡 **QA-036 — Inconsistent field naming**: Service layer uses `snake_case` throughout (matching DB). Controller layer mostly passes through but some responses have mixed conventions.

## 9.3 Magic Numbers & Hardcoded Values

🟡 **QA-037**:
- Points-per-currency rate: `0.01` (`request.service.js:135`)
- Points earned: `Math.floor(finalAmount)` (`request.service.js:199`)
- JWT access token expiry: `process.env.JWT_EXPIRES_IN || '15m'` (`auth.js:7`)
- JWT refresh token expiry: `30d` hardcoded in `auth.service.js`
- File size limits: `5MB` image (`upload.js:9`), `10MB` chat media (`upload.js:14`), `15MB` request files (`upload.js:19`), `20MB` convert (`report.routes.js:17`)
- Bcrypt salt rounds: `12` (`auth.service.js`, `provider.service.js`)
- Cache TTLs: `300s`, `600s` across controllers
- Overpayment tolerance: `0.01` (`payment.routes.js:136`)

## 9.4 Missing Logging

🟡 **QA-038**: The following critical operations have NO audit log:
- Payment addition (`payment.routes.js`) — ✅ Has audit
- Request creation — ❌ No audit log
- Request status changes — ❌ No audit log
- Request assignment — ❌ No audit log
- Lab result entry — ❌ No audit log

✅ All patient, provider, service, coupon, and invoice operations have audit logs.

---

# CONSOLIDATED FINDINGS — PRIORITY ORDER

| ID | Severity | Phase | Location | Issue | Risk |
|---|---|---|---|---|---|
| QA-001 | 🔴 CRITICAL | Security | `request.routes.js:12` | `POST /api/requests` unauthenticated, no validation, no rate limit | Anyone can flood system with fake requests |
| QA-005 | 🔴 CRITICAL | Security | `request.routes.js:12` | `createRequestSchema` never applied as middleware | Unsanitized data enters DB |
| QA-008 | 🔴 CRITICAL | Security | `request.service.js:106` | Coupon `used_count` race — no `FOR UPDATE` lock | Coupon abuse via concurrent requests |
| QA-014 | 🔴 CRITICAL | Database | `schema.sql:4` vs `007_payments.sql:16` | `payment_method` ENUM has 3 values, CHECK has 5 — cast fails | CLICK/OTHER payments crash on invoice update |
| QA-030 | 🔴 CRITICAL | Business | `request.service.js:299` | Cancellation: no invoice update, no points refund, no coupon decrement | Financial data inconsistency |
| QA-027 | 🔴 CRITICAL | Business | `request.controller.js:72` | Points not refunded on cancellation | Patient loses points permanently |
| QA-029 | 🔴 CRITICAL | Business | `request.service.js:126` | Coupon `used_count` not decremented on cancellation | Coupon effectively wasted |
| QA-009 | 🔴 CRITICAL | Database | `notification.service.js:50` | N+1 on admin notifications — INSERT per admin | Performance degrades with admin count |
| QA-002 | 🟠 HIGH | Security | `service.routes.js:72` | Ratings endpoints unauthenticated — patient names exposed | PII leak |
| QA-006 | 🟠 HIGH | Security | `request.routes.js:42` | Status update route missing validation middleware | Unsanitized input |
| QA-007 | 🟠 HIGH | Security | `request.routes.js:43` | Assign provider route missing validation middleware | Invalid UUID not caught |
| QA-010 | 🟠 HIGH | Database | `labtest.service.js:235` | N+1 on `createPackage` test_ids loop | Slow package creation |
| QA-011 | 🟠 HIGH | Database | `labrange.service.js:107` | N+1 on `createManyRanges` loop | Slow bulk import |
| QA-015 | 🟠 HIGH | Error | `request.controller.js:53,97` | Silent `.catch(() => {})` on notifications | Failures go undetected |
| QA-016 | 🟠 HIGH | Error | Multiple | Inconsistent error codes — some missing `code` field | Frontend cannot handle errors programmatically |
| QA-020 | 🟠 HIGH | API | Multiple | Inconsistent response shapes across modules | Frontend integration difficulty |
| QA-024 | 🟠 HIGH | API | Multiple | Missing GET by ID for services, lab tests, packages | Incomplete CRUD API |
| QA-026 | 🟠 HIGH | API | Multiple | Arabic/English error message mixing | Inconsistent UX |
| QA-034 | 🟠 HIGH | Code | `payment.routes.js` | All logic inline — no controller/service separation | Maintainability debt |
| QA-012 | 🟡 MEDIUM | Database | `request.service.js:106` | Same as QA-008 — race detail | — |
| QA-013 | 🟡 MEDIUM | Database | `request.service.js:93` | Patient `total_points` read without `FOR UPDATE` | Stale points on concurrent requests |
| QA-017 | 🟡 MEDIUM | Perf | Multiple | `SELECT *` in queries returns excessive data | Bandwidth + memory waste |
| QA-018 | 🟡 MEDIUM | Perf | Multiple | Unbounded rating/history result sets | Large payloads, slow responses |
| QA-019 | 🟡 MEDIUM | Perf | `report.routes.js:166` | Temp file cleanup on stream `end` — not on `close` | Temp file leak on disconnect |
| QA-021 | 🟡 MEDIUM | API | `invoice.routes.js:53` | `PUT` for pay action — should be `POST`/`PATCH` | REST semantics |
| QA-023 | 🟡 MEDIUM | API | `service.routes.js:95` | `DELETE` does soft-delete — misleading HTTP verb | REST semantics |
| QA-025 | 🟢 LOW | API | Global | No API versioning (`/v1/`) | Future migration risk |
| QA-031 | 🟢 LOW | Code | `notification.service.js:155` | `notifyPointsEarned` exported but never called | Dead code |
| QA-032 | 🟢 LOW | Code | `rateLimiter.js` | `guestRequestLimiter` never used on any route | Dead code |
| QA-033 | 🟢 LOW | Code | `schemas.js` | `createRequestSchema` defined but unused | Dead code |
| QA-035 | 🟢 LOW | Code | Multiple | Mixed validation approach (middleware vs inline) | Inconsistency |
| QA-037 | 🟢 LOW | Code | Multiple | Magic numbers (points rate, file sizes, cache TTLs) | Configuration fragility |
| QA-038 | 🟢 LOW | Code | `request.controller.js` | No audit log on request create/status/assign/lab results | Missing audit trail |

---

# POSITIVE FINDINGS (What is done well)

1. **Parameterized queries everywhere** — Zero SQL injection risk. Every query uses `$1, $2...` placeholders. No string concatenation.

2. **JWT refresh token rotation with reuse detection** — `auth.service.js` implements proper token family tracking. If a refresh token is reused (indicating theft), all tokens for that user are revoked. Industry-standard security pattern.

3. **Comprehensive Joi validation schemas** — `schemas.js` defines thorough schemas with UUID validation, string limits, enum constraints, and custom sanitization via XSS library.

4. **Transaction management** — All multi-table write operations use proper `BEGIN/COMMIT/ROLLBACK` with `client.release()` in `finally` blocks. No connection leaks.

5. **FOR UPDATE locking on payments** — Partial payment system correctly uses pessimistic locking to prevent race conditions on invoice balance calculations.

6. **Redis cache with graceful degradation** — `cache.js` wraps all Redis operations in try/catch. If Redis is down, the application continues without caching instead of crashing.

7. **Smart reference ranges for lab tests** — The `labrange.service.js` implements a sophisticated scoring system considering gender, age, condition, and priority for resolving the correct reference range. Well-designed domain logic.

8. **Helmet with strict CSP** — `app.js` configures Helmet with explicit Content Security Policy directives, not using defaults.

9. **Structured audit logging** — Most write operations emit structured audit events with userId, role, targetId, targetType, and IP address.

10. **Chat authorization** — `isConversationParticipant` correctly validates that only conversation participants can send/read messages. UQID constraint on `(patient_id, participant_id, participant_role)` prevents duplicate conversations.

11. **Error handler with environment awareness** — Production mode returns generic errors; development mode includes stack traces. PostgreSQL constraint violation errors are mapped to user-friendly 409 responses.

12. **Proper pagination pattern** — Most list endpoints follow a consistent `{ data, pagination: { page, limit, total, total_pages } }` format with count queries.
