# 🏥 Medical Platform API

Backend API للمنصة الطبية الوسيطة - Node.js + PostgreSQL

---

## 🚀 تشغيل المشروع

```bash
# 1. تثبيت الحزم
npm install

# 2. إعداد .env
cp .env.example .env
# عدّل DATABASE_URL و JWT_SECRET

# 3. تهيئة قاعدة البيانات
npm run db:init

# 4. تشغيل المشروع
npm run dev
```

**Default Admin:** `admin@medical.com` / `admin123`

---

## 📡 API Endpoints

### 🔐 Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | تسجيل دخول (Admin/Provider/Patient) |
| POST | `/api/auth/register` | تسجيل مريض جديد |

**Login Body:**
```json
{
  "email": "admin@medical.com",
  "password": "admin123",
  "role": "ADMIN"  // ADMIN | PROVIDER | PATIENT
}
```

---

### 👥 Patients
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/patients` | Staff | كل المرضى (search, pagination) |
| GET | `/api/patients/:id` | Staff | مريض + تاريخه الطبي |
| PUT | `/api/patients/:id/medical` | Staff | تحديث البيانات الطبية |
| POST | `/api/patients/:id/history` | Staff | إضافة ملاحظة طبية |
| PUT | `/api/patients/:id/vip` | Admin | تفعيل/إلغاء VIP |
| DELETE | `/api/patients/:id` | Admin | حذف مريض |

---

### 👨‍⚕️ Providers
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/providers` | Admin | إضافة مزود خدمة |
| GET | `/api/providers` | Admin | كل المزودين (filter by type/available) |
| PUT | `/api/providers/:id` | Admin | تحديث مزود |
| DELETE | `/api/providers/:id` | Admin | حذف مزود |

**Provider Types:** `DOCTOR | NURSE | LAB_TECH | XRAY_TECH`

---

### 🏥 Services
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/services/categories` | Auth | تصنيفات الخدمات |
| POST | `/api/services/categories` | Admin | إضافة تصنيف |
| GET | `/api/services` | Auth | الخدمات الطبية والأشعة |
| POST | `/api/services` | Admin | إضافة خدمة |
| PUT | `/api/services/:id` | Admin | تحديث خدمة |
| DELETE | `/api/services/:id` | Admin | إلغاء تفعيل خدمة |

---

### 🧪 Lab Tests & Packages
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/lab` | Auth | كل الفحوصات |
| POST | `/api/lab` | Admin | إضافة فحص |
| PUT | `/api/lab/:id` | Admin | تحديث فحص |
| GET | `/api/lab/packages` | Auth | كل الباقات + فحوصاتها |
| POST | `/api/lab/packages` | Admin | إضافة باقة |
| PUT | `/api/lab/packages/:id` | Admin | تحديث باقة |

---

### 📋 Service Requests
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/requests` | Public | إنشاء طلب (مريض أو ضيف) |
| GET | `/api/requests` | Staff | كل الطلبات |
| GET | `/api/requests/:id` | Auth | تفاصيل طلب |
| PUT | `/api/requests/:id/status` | Admin | تغيير حالة الطلب |
| PUT | `/api/requests/:id/assign` | Admin | تعيين مزود للطلب |
| POST | `/api/requests/:id/results` | Staff | إضافة نتائج فحص |

**Request Status Flow:**
```
PENDING → ACCEPTED → ASSIGNED → COMPLETED
                  ↘ CANCELLED
```

**إنشاء طلب - Patient:**
```json
{
  "request_type": "PATIENT",
  "patient_id": "uuid",
  "service_type": "LAB",
  "package_id": "uuid",
  "coupon_code": "SAVE20",
  "points_to_use": 100,
  "notes": "ملاحظات"
}
```

**إنشاء طلب - Guest:**
```json
{
  "request_type": "GUEST",
  "guest_name": "أحمد محمد",
  "guest_phone": "0791234567",
  "guest_address": "عمان، الجبيهة",
  "service_type": "MEDICAL",
  "service_id": "uuid",
  "notes": "ملاحظات"
}
```

---

### 💰 Invoices
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/invoices` | Admin | كل الفواتير |
| GET | `/api/invoices/stats` | Admin | إحصائيات الإيرادات |
| PUT | `/api/invoices/:id/pay` | Admin | تسجيل الدفع |
| GET | `/api/invoices/coupons` | Admin | كل الكوبونات |
| POST | `/api/invoices/coupons` | Admin | إضافة كوبون |
| GET | `/api/invoices/coupons/validate/:code` | Auth | التحقق من كوبون |
| PUT | `/api/invoices/coupons/:id` | Admin | تحديث كوبون |

---

## 🗂️ هيكل المشروع

```
src/
├── config/
│   ├── db.js          ← اتصال PostgreSQL
│   ├── schema.sql     ← هيكل قاعدة البيانات
│   └── initDb.js      ← تهيئة DB
├── middlewares/
│   └── auth.js        ← JWT + Authorization
├── modules/
│   ├── admin/         ← Auth routes
│   ├── patients/      ← إدارة المرضى
│   ├── providers/     ← إدارة مزودي الخدمة
│   ├── services/      ← الخدمات والتصنيفات
│   ├── labtests/      ← الفحوصات والباقات
│   ├── requests/      ← الطلبات (core)
│   └── invoices/      ← الفواتير والكوبونات
├── app.js
└── server.js
```

---

## 💡 نظام النقاط

- المريض يكسب **1 نقطة** لكل وحدة مدفوعة
- **1 نقطة = 0.01** من العملة عند الاستبدال
- يمكن استخدام النقاط عند إنشاء أي طلب

## 🎫 نظام الكوبونات

- `PERCENTAGE`: خصم بنسبة مئوية
- `FIXED`: خصم بمبلغ ثابت
- يمكن تحديد: حد أدنى للطلب، عدد مرات الاستخدام، تاريخ الانتهاء

## ⭐ نظام VIP

- الأدمن يحدد VIP يدوياً
- خصم دائم بنسبة محددة على كل الخدمات
- نقاط تتراكم مع كل طلب

---

## Smart Reference Ranges (Lab)

### Range Management Endpoints
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/lab/:testId/ranges` | Admin | List all ranges for a lab test |
| POST | `/api/lab/:testId/ranges` | Admin | Create a single range |
| POST | `/api/lab/:testId/ranges/bulk` | Admin | Bulk import ranges |
| PUT | `/api/lab/ranges/:rangeId` | Admin | Update a range |
| DELETE | `/api/lab/ranges/:rangeId` | Admin | Delete one range |
| DELETE | `/api/lab/:testId/ranges` | Admin | Delete all ranges for a test |
| GET | `/api/lab/:testId/ranges/resolve?gender=male&age=35&condition=fasting` | Admin/Provider | Preview matched range |

### Bulk Import JSON Format
```json
{
  "ranges": [
    {
      "gender": "male",
      "age_min": 18,
      "age_max": 999,
      "range_low": 13.5,
      "range_high": 17.5,
      "unit": "g/dL",
      "notes": "Adult male hemoglobin",
      "priority": 10
    },
    {
      "gender": "female",
      "age_min": 18,
      "age_max": 999,
      "range_low": 12.0,
      "range_high": 15.5,
      "unit": "g/dL",
      "priority": 10
    },
    {
      "gender": "female",
      "age_min": 18,
      "age_max": 999,
      "condition": "pregnant",
      "range_low": 11.0,
      "range_high": 14.0,
      "unit": "g/dL",
      "priority": 20
    }
  ]
}
```

### Replace All Ranges For A Test
1. `DELETE /api/lab/:testId/ranges`
2. `POST /api/lab/:testId/ranges/bulk`

### Seed Common Ranges
```bash
npm run db:seed:ranges
```
