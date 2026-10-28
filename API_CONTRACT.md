# Curevie API contract (cases platform)

Base URL: `${NEXT_PUBLIC_API_URL}` = `https://api.curevie.net/api/v1`.
All bodies are JSON unless marked multipart. Errors are always `{ message, code }` with an HTTP status.
Money values are strings with 3 decimals (PostgreSQL NUMERIC), e.g. `"25.000"` — use `Number()`.
All timestamps are ISO-8601 with time zone.

**Removed for good** (do not call, delete client code): `/requests/**`, `/invoices/**` (top level),
`/payments/**`, `/chat/**` (top level), `/lab-results/**/culture`, `/files/secure-url`,
`/reports/financial`, `/reports/invoice/:id/pdf`, `/reports/requests/:id/medical/pdf`, `/reports/convert`,
`/patients/:id/points-log`, `/services/:id/rate|ratings`, `/lab/**` (whole lab catalog, ranges, ordinal scales).
Points, coupons, workflow stages/tasks, lab result entry and culture results no longer exist.

---

## 1. Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{ email, password, role: ADMIN\|PROVIDER\|PATIENT }` → `{ access_token, expires_in, user }`. Same 401 `INVALID_CREDENTIALS` for unknown email, wrong password, deleted or disabled account. |
| POST | `/auth/register` | patient: `{ full_name, email, password, phone, secondary_phone?, address?, area_id?, date_of_birth?, gender? }` → 201 same shape as login. |
| POST | `/auth/refresh` | **Header `X-Auth-Role: ADMIN\|PROVIDER\|PATIENT` is required.** Refresh token lives in an httpOnly cookie `refresh_token_<role>` scoped to `/api/v1/auth`; send with `withCredentials: true`. → `{ access_token }`. 401 codes: `NO_TOKEN`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_EXPIRED`, `TOKEN_REUSE_DETECTED`, `ACCOUNT_INACTIVE` → redirect to login. |
| POST | `/auth/logout` | Works with or without a valid access token; send `X-Auth-Role` + cookie. |
| POST | `/auth/logout-all` | auth required |
| PUT | `/auth/change-password` | `{ current_password, new_password, confirm_password }`. All sessions are revoked → log in again. |
| GET | `/auth/me` | current user (shape below) |

`user` shapes:
- ADMIN `{ id, email, role, full_name }`
- PROVIDER `{ id, email, role, full_name, type, is_active, is_available, phone, avatar_url }`
- PATIENT `{ id, email, role, full_name, phone, secondary_phone, address, area_id, date_of_birth, gender, is_vip, vip_discount, avatar_url }`

`total_points` was removed. `avatar_url` / `image_url` are absolute URLs (or null) — use them directly as `src`.

Access tokens live 5 minutes. On 401 `TOKEN_EXPIRED` call refresh once, then retry.
Do not persist the access token in `localStorage`; keep it in memory (zustand without persist) and
recover the session on page load by calling `/auth/refresh`.

---

## 2. Areas (service districts)

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/areas` | public | `{ data: [{ id, slug, name_ar, name_en, city }] }` active areas, ordered. Admin token: also inactive with `?include_inactive=true`, plus `is_active, sort_order, providers_count`. |
| POST | `/areas` | admin | `{ slug, name_ar, name_en, city?, sort_order? }` |
| PUT | `/areas/:id` | admin | any of `name_ar, name_en, city, sort_order, is_active` |

The slugs match the patient site's `lib/amman-districts.ts` keys (abdoun, khalda, ...).

---

## 3. Catalog

There is one catalog: **services** (each with a kind) and **packages** (fixed-price bundles of services).
The old separate lab catalog (`/lab`, `/lab/panels`, `/lab/lab-packages`, `/lab/packages`, reference ranges,
ordinal scales) is gone: lab tests and lab panels are now services with `service_kind: "LAB"`, and lab packages and
comprehensive packages are both plain packages. Existing ids were kept.

Services — `/services`, `/services/:id`, `/services/categories` (public reads; admin CRUD as before):
- `service_kind`: `MEDICAL | NURSING | RADIOLOGY | LAB` (create/update accept it; list filter `?service_kind=`).
- Non-admins only ever see active items. Prices accept 3 decimals.

Packages — `/packages`:
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/packages?page&limit&search&category_id&is_active&is_vip_exclusive` | public | `{ data: [Package], pagination }` (non-admins: active only) |
| GET | `/packages/:id` | public | `Package` |
| POST | `/packages` | admin | `{ name, name_ar?, name_en?, description?, description_ar?, description_en?, total_cost, category_id?, is_vip_exclusive?, service_ids: uuid[] (ordered, ≥1) }` |
| PUT | `/packages/:id` | admin | any of the fields above + `is_active` |
| PUT | `/packages/:id/image` | admin | multipart `file` |
| DELETE | `/packages/:id` | admin | deactivates (ordered packages must stay readable) |

`Package = { id, name, name_ar, name_en, description, description_ar, description_en, total_cost, category_id, category_name,
is_vip_exclusive, is_active, times_ordered, image_url, services: [{ id, name, name_ar, name_en, price, service_kind, is_active }],
services_count, items_total, savings, created_at, updated_at }` — `savings = items_total − total_cost` (string, 3 decimals).

Orderable item types:

| `type` | ids from | price field |
|---|---|---|
| `SERVICE` | `/services` (any kind, lab tests included) | `price` |
| `PACKAGE` | `/packages` | `total_cost` |

Who can perform each kind (candidate ranking, best first): MEDICAL → DOCTOR; NURSING → NURSE, DOCTOR;
RADIOLOGY → RADIOLOGY_TECH, DOCTOR; LAB → LAB_TECH, NURSE, DOCTOR; PACKAGE → DOCTOR.

---

## 4. Ordering (cases)

A **case** is one order. It has **line items** (`services[]`, table `case_services`), each assigned to one provider.

### Status machine
Line item (`services[].status`):
`PENDING` (waiting for admin) → `ASSIGNED` (offered to a provider) → `ACCEPTED` (provider accepted) → `IN_PROGRESS` → `COMPLETED`;
`CANCELLED` (admin) at any point before completion. Provider **reject** returns the item to `PENDING` with no provider.

Case (`case.status`) is derived automatically from its items:
`PENDING` (nothing assigned) → `ACCEPTED` (some assigned/accepted) → `IN_PROGRESS` (work started) → `COMPLETED` (all active items done)
→ `CLOSED` (admin reviewed; invoice + report released). `CANCELLED` when cancelled or when every item is cancelled.

### Create
`POST /cases` (patient token) or `POST /cases/public` (guest; a patient token is honoured too):
```json
{
  "area_id": "uuid",                       // required, from GET /areas
  "address": "street, building, floor",    // required for guests; patients default to profile address
  "scheduled_for": "2026-11-01T09:00:00+03:00",  // optional, future
  "notes": "optional",
  "items": [ { "type": "SERVICE", "id": "uuid", "notes": "optional" } ],   // 1..10, unique type+id
  "guest_name": "only /public", "guest_phone": "only /public"
}
```
Never send prices: they are computed on the server (VIP discount applied automatically).
Errors: `INVALID_AREA`, `ADDRESS_REQUIRED`, `ITEM_NOT_FOUND`, `ITEM_INACTIVE`, `VIP_ONLY` (403), `VALIDATION_ERROR`.
Response 201:
- patient: `{ data: <CaseView> }`
- guest: `{ data: { tracking_token, case: <TrackingView> } }` — show the token/link once, it is not retrievable later.
  Build the link as `/{locale}/track/{tracking_token}`.

### Guest tracking & claiming
- `GET /cases/track/:token` (public) → `{ data: TrackingView }`
  `TrackingView = { id, reference, status, created_at, scheduled_for, area_name_ar, area_name_en, cancel_reason,
  services: [{ id, item_type, item_name, service_kind, status, provider_name (first name), bundle_price }],
  appointments: [{ case_service_id, scheduled_at, type }], invoice: { final_amount, payment_status } | null }`
- `POST /cases/claim` (patient) `{ tracking_token }` → `{ data: CaseView }`. Attaches the guest order to the account (token is consumed).

### Read
- `GET /cases?page&limit(≤100)&status=A,B&service_status&patient_id&area_id&unassigned=true&search&from&to`
  → `{ data: { cases: [...], total, page, limit } }`.
  Row: `id, status, patient_id, area_id, area_name_ar, area_name_en, scheduled_for, created_at, updated_at,
  lead_provider_id, lead_provider_name, cancel_reason, is_guest, patient_name, patient_phone (not for patients),
  services_count, item_names[], pending_assignment_count, final_amount, total_paid, remaining_amount, payment_status, is_patient_visible`.
  Providers: no money fields, plus `my_services: [{ id, item_name, status }]`; `service_status` filters on their own items.
  Patients: only their cases; `total_paid/remaining_amount` are null until the invoice is released.
- `GET /cases/:id` → `{ data: CaseView }` (404 for cases you cannot access).

`CaseView`:
```
{
  case: { id, patient_id, is_guest, guest_name, guest_phone, guest_address, area_id, area_name_ar, area_name_en, address,
          scheduled_for, status, notes, lead_provider_id, lead_provider_name, cancelled_at, cancelled_by_role, cancel_reason,
          closed_at, admin_close_notes, created_at, updated_at,
          patient_name, patient_phone, patient_secondary_phone, patient_email, patient_dob, patient_gender,
          patient_allergies, patient_height, patient_weight },
  services: [{ id, case_id, item_type (SERVICE|PACKAGE), item_name, service_kind (MEDICAL|NURSING|RADIOLOGY|LAB|PACKAGE),
               service_id, package_id,
               status, original_price, bundle_price, provider_id, provider_name, provider_phone, provider_type,
               provider_avatar_url, provider_rating_avg, provider_rating_count, my_rating, my_rating_comment,
               chat_room_id, assigned_at, accepted_at, started_at, completed_at, cancelled_at, created_at,
               notes (admin/provider only),
               actions: { can_accept, can_reject, can_start, can_complete, can_upload, can_assign, can_cancel, can_rate } }],
  appointments: [{ id, case_service_id, service_name, provider_id, scheduled_at, type (INITIAL|FOLLOW_UP), notes, created_at }],
  provider_files: [{ id, case_service_id, service_name, provider_name, file_type (PDF|IMAGE), is_sick_leave,
                     original_name, mime_type, size_bytes, uploaded_by, created_at, download_path }],
  invoice: full invoice row | { is_patient_visible:false, original_amount, final_amount, payment_status } (patient before close) | null (non-lead provider),
  case_actions: { can_cancel, can_close, can_add_appointment },
  lifecycle: [{ id, case_service_id, actor_role, event_type, notes, created_at }]   // admin only
}
```
Use `actions` / `case_actions` to show or hide buttons instead of re-implementing the rules.
Providers who are not the lead only see their own line items. Patients see `provider_files` only after `CLOSED`.

### Admin
| Method | Path | Body |
|---|---|---|
| GET | `/cases/:id/services/:serviceId/candidates?include_all=false` | → `{ data: { service_kind, allowed_provider_types, area_id, providers: [{ id, full_name, phone, type, avatar_url, is_available, type_match, covers_area, open_jobs, average_rating, total_ratings }] } }` ranked best first |
| POST | `/cases/:id/assign-team` | `{ assignments: [{ case_service_id, provider_id }], lead_provider_id?: uuid\|null }` → `{ data: CaseView }`. Reassigning is allowed until the item is started. |
| POST | `/cases/:id/appointments` | `{ case_service_id, scheduled_at, type?, notes? }` |
| POST | `/cases/:id/services/:serviceId/cancel` | `{ reason? }` → CaseView. 409 `REFUND_REQUIRED` if paid more than the new total. |
| POST | `/cases/:id/cancel` | `{ reason? }` (patient: only before work starts; admin: when nothing started) |
| POST | `/cases/:id/close` | `{ notes? }` — only from `COMPLETED` |

### Provider
`PUT /cases/:id/services/:serviceId/accept|start|complete` (no body) → `{ data: CaseView }`. Order is strict: accept (from ASSIGNED) → start (from ACCEPTED) → complete (from IN_PROGRESS).
`PUT /cases/:id/services/:serviceId/reject` `{ reason }` (required, 2–500 chars) → `{ data: { case_id, case_service_id, status: "PENDING" } }` (the provider loses access).
409 `INVALID_SERVICE_STATUS` on an illegal transition.

### Patient
`POST /cases/:id/services/:serviceId/rate` `{ rating: 1..5, comment? }` — once per completed item (409 `ALREADY_RATED`).

### Provider files (results, images, sick leave)
- `POST /cases/:id/services/:serviceId/files` multipart: `file` (PDF/JPEG/PNG/WEBP ≤ 20MB), `is_sick_leave` ("true"/"false"). Assigned provider, item `IN_PROGRESS` or `COMPLETED`.
- `GET /cases/:id/files/:fileId[?inline=true]` → file bytes. Fetch with the bearer token as a blob (`responseType: 'blob'`) and use `URL.createObjectURL`.
- `DELETE /cases/:id/files/:fileId` uploader (case open) or admin.

### Invoice
- `GET /cases/invoices?page&limit&payment_status&search` (admin) → `{ data: [invoice + case_status, patient_name, patient_phone], pagination }`
- `GET /cases/:id/invoice` → `{ invoice, payments, adjustments }` (patient after close; lead provider; admin)
- `GET /cases/:id/invoice/pdf` → PDF blob
- `POST /cases/:id/invoice/payments` admin `{ amount, method: CASH|CARD|INSURANCE|CLICK|OTHER, notes? }` → `{ payment, summary: { total_paid, remaining, payment_status, is_fully_paid } }`
- `DELETE /cases/:id/invoice/payments/:paymentId` admin
- `POST /cases/:id/invoice/adjustments` admin `{ amount, type: DISCOUNT|SURCHARGE, reason }`
- `PUT /cases/:id/invoice/finalize` admin (after this, no adjustments/payment deletions)

`payment_status`: `PENDING | PARTIAL | PAID | CANCELLED`. `final_amount = Σ active items + surcharges − discounts`.

### Medical report
- `POST /cases/:id/report/generate` admin (case `CLOSED`) → `{ data: Report }`
- `POST /cases/:id/sick-leave/generate` admin `{ file_id }` (a provider file with `is_sick_leave`)
- `GET /cases/:id/report` → `{ data: { id, case_id, status (DRAFT|PUBLISHED), has_pdf, has_sick_leave, published_at } }`
- `GET /cases/:id/report/download`, `GET /cases/:id/sick-leave/download` → PDF blob (patient: published + closed)

### Chat (patient ↔ assigned provider, per line item; guests have none)
- `GET /cases/chat/rooms?case_id=` → `{ data: [{ id, case_id, case_service_id, service_name, service_status, case_status,
  patient_id, patient_name, provider_id, provider_name, provider_avatar_url, can_send, last_message_preview,
  last_message_file_name, last_message_sender_role, last_message_at, unread_count }] }`
- `GET /cases/:id/chat-rooms` → same rows for one case
- `GET /cases/chat/unread-count` → `{ unread_count }`
- `GET /cases/chat/rooms/:room_id/messages?limit&before` → `{ data: [Message], room }` (marks as read)
- `POST /cases/chat/rooms/:room_id/messages` multipart: `content?`, `file?` (image/pdf/video ≤ 25MB) → `{ data: Message }`
- `GET /cases/chat/rooms/:room_id/messages/:message_id/file` → blob

`Message = { id, room_id, sender_id, sender_role, content, has_file, file_name, file_mime, is_read, created_at }`
(no URL: download attachments through the file endpoint).

---

## 5. Patients / providers

Patients:
- `GET /patients` (admin) `?page&limit&search`, `GET /patients/combined` (admin, patients + guest contacts)
- `GET /patients/:id` (admin, self, or a provider who serves them) → `{ patient, history? (staff), history_total?, recent_cases? (admin/self), total_cases? }`
- `GET|POST /patients/:id/history` (admin or a provider serving them; POST needs an open case)
- `PUT /patients/:id/medical` (admin, self, provider with an open case) · `PUT /patients/:id/profile` (admin or self; accepts `area_id`)
- `PUT /patients/:id/avatar` multipart `file` · `PUT /patients/:id/vip` (admin) · `DELETE /patients/:id` (admin, soft delete)

Providers:
- `POST /providers` admin `{ full_name, email, password, phone?, type: DOCTOR|NURSE|LAB_TECH|RADIOLOGY_TECH, area_ids?: uuid[] }`
- `GET /providers` admin `?page&limit&search&type&is_active&is_available&area_id`
- `GET /providers/me` provider · `PUT /providers/me/availability` `{ is_available }` (online/offline toggle)
- `GET /providers/:id` / `PUT /providers/:id` — admin: `full_name, phone, type, is_active, is_available, area_ids`; self: `full_name, phone, is_available` only (403 otherwise)
- `PUT /providers/:id/avatar` multipart `file` · `DELETE /providers/:id` admin (409 `PROVIDER_HAS_OPEN_JOBS`)
- `GET /providers/:id/ratings?page&limit` (admin or self) → `{ summary: { total_ratings, average_rating }, data: [{ rating, comment, service_name, patient_name, created_at, case_id }], pagination }`

Provider object: `{ id, full_name, email, phone, type, is_active, is_available, avatar_url, areas: [{ id, slug, name_ar, name_en }], open_jobs, average_rating, total_ratings, created_at }`.
`is_active` = account enabled by admin (login); `is_available` = provider is online and accepting jobs.

---

## 6. Notifications & reports

- `GET /notifications?page&limit&unread_only` → `{ data, pagination, unread_count }`; `PUT /notifications/read-all`; `PUT /notifications/:id/read`; `DELETE /notifications/:id`.
  Notification `type`: `CASE_CREATED, CASE_ASSIGNED, CASE_UPDATED, CASE_COMPLETED, CASE_CANCELLED, CASE_CLOSED, APPOINTMENT_SCHEDULED, SERVICE_RATED, PAYMENT_RECEIVED, PAYMENT_PARTIAL, INVOICE_PAID, VIP_GRANTED, REPORT_PUBLISHED, CONTACT_MESSAGE`; `data.case_id` links to the case.
- `GET /reports/cases/financial?period=daily|monthly|yearly&year&month&from=YYYY-MM-DD&to=YYYY-MM-DD` (admin) →
  `{ period, summary: { total_invoices, paid_invoices, partial_invoices, pending_invoices, cancelled_invoices, gross_revenue, net_revenue, pending_revenue, total_discounts, collected_revenue, payments_count }, cases: {...counts by status}, payment_methods, top_services: [{ service_name, item_type, service_kind, count, revenue }], daily_breakdown: [{ date, cases, revenue, collected }], case_register }`.
  Dates are Amman local days; `collected_revenue` counts payments received in the window.

---

## 7. Real-time (socket.io)

Connect to the API origin (`https://api.curevie.net`, path `/socket.io`) with `auth: { token: <access token> }`.
Use the `socket.io-client` npm package (v4) — not a CDN script. The server disconnects when the access token
expires: on `disconnect`, refresh the token and reconnect with the new one.

Server → client:
| event | payload | who |
|---|---|---|
| `case:created` | `{ case_id, at }` | admins |
| `case:updated` | `{ case_id, status, event, case_service_id, service_status, at }` | admins, the case patient, involved providers |
| `case:assigned` | `{ case_id, case_service_id }` | the assigned provider |
| `notification_unread_updated` | `{ unread_count }` | recipient |
| `chat_unread_updated` | `{ unread_count, room_id, case_id }` | chat participants |
| `new_message` | `Message` | sockets that joined the room |
| `user_typing` | `{ room_id, user_id, role }` | room |
| `joined_room` / `error` | `{ room_id }` / `{ message }` | caller |

Client → server: `join_room { room_id }`, `leave_room { room_id }`, `send_message { room_id, content }` (text only; files go through REST), `typing { room_id }`.
On `case:updated` / `case:created` / `case:assigned`, invalidate the React Query caches for the case list and that case.
