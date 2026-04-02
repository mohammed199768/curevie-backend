// AUDIT-FIX: Q3 — centralized Arabic localization
// Replaces hardcoded Arabic strings in notification.service.js
// Usage: const { t } = require('../../utils/i18n/ar');
//        t('notifications.new_request.title')

const strings = {
  notifications: {
    new_request: {
      admin_title: 'طلب جديد',
      admin_body: 'طلب {serviceType} جديد من {requestSource}',
      patient_title: 'تم استلام طلبك',
      patient_body: 'تم استلام طلب {serviceType} الخاص بك بنجاح. سيتم التواصل معك قريباً.',
    },
    request_status: {
      accepted_title: 'تم قبول طلبك',
      accepted_body: 'تم قبول طلبك وسيتم تحديد موعد قريباً من قبل الفريق الطبي.',
      assigned_title: 'تم تعيين مقدم الخدمة',
      assigned_body: 'تم تعيين مقدم خدمة لطلبك وسيتم التواصل معك.',
      assigned_provider_title: 'تم تعيين طلب جديد لك',
      assigned_provider_body: 'تم تعيين طلب خدمة جديد لك. يرجى المراجعة.',
      completed_title: 'تم إنجاز طلبك',
      completed_body: 'تم إنجاز طلبك بنجاح. يسعدنا خدمتك وننتظر تقييمك.',
      cancelled_title: 'تم إلغاء طلبك',
      cancelled_body: 'تم إلغاء طلبك.',
    },
    payment: {
      admin_title: 'دفعة جديدة',
      admin_body: 'تم استلام دفعة بقيمة {amount} عبر {method}. {statusDetail}',
      invoice_paid_title: 'تم سداد الفاتورة بالكامل',
      invoice_paid_body: 'تم سداد فاتورتك بالكامل. شكراً لك.',
      partial_title: 'تم استلام دفعة',
      partial_body: 'تم استلام دفعة بقيمة {amount}. المبلغ المتبقي: {remaining}',
      status_paid: 'الفاتورة مسددة.',
      status_remaining: 'المتبقي: {remaining}',
    },
    vip: {
      title: 'مبروك! أصبحت عضواً VIP',
      body: 'تم ترقيتك لعضوية VIP مع خصم {discount}% على جميع طلباتك.',
    },
    points: {
      title: 'نقاط مكتسبة',
      body: 'ربحت {points} نقطة! رصيدك الحالي: {totalPoints} نقطة.',
    },
  },
  errors: {
    cors_origin_blocked: 'CORS: Origin غير مسموح به',
  },
  labels: {
    guest: 'مريض غير مسجل',
    registered_patient: 'مريض مسجل',
  },
};

function t(path, vars = {}) {
  const keys = path.split('.');
  let val = strings;
  for (const k of keys) {
    val = val?.[k];
    if (val === undefined) return path; // fallback to key if not found
  }
  return String(val).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

module.exports = { t, strings };
