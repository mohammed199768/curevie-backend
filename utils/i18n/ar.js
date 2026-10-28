// Centralized Arabic strings for notifications.
// Usage: const { t } = require('../../utils/i18n/ar');
//        t('notifications.case.created_admin_title')

const strings = {
  notifications: {
    case: {
      created_admin_title: 'طلب جديد',
      created_admin_body: 'طلب جديد من {source} ({items}).',
      created_patient_title: 'تم استلام طلبك',
      created_patient_body: 'استلمنا طلبك وسيتم تعيين مقدم خدمة في منطقتك قريباً.',
      assigned_provider_title: 'طلب جديد بانتظارك',
      assigned_provider_body: 'تم تعيين خدمة "{item}" لك{patient}. يرجى القبول أو الرفض.',
      assigned_patient_title: 'تم تعيين مقدم الخدمة',
      assigned_patient_body: 'تم تعيين {provider} لخدمة "{item}".',
      accepted_admin_title: 'قبول طلب',
      accepted_admin_body: '{provider} قبل خدمة "{item}".',
      rejected_admin_title: 'رفض طلب',
      rejected_admin_body: '{provider} رفض خدمة "{item}". السبب: {reason}',
      started_patient_title: 'بدأت الخدمة',
      started_patient_body: 'بدأ {provider} تنفيذ خدمة "{item}".',
      completed_patient_title: 'اكتملت الخدمة',
      completed_patient_body: 'اكتملت خدمة "{item}". يسعدنا تقييمك لمقدم الخدمة.',
      completed_admin_title: 'خدمة مكتملة',
      completed_admin_body: '{provider} أنهى خدمة "{item}".',
      case_completed_admin_title: 'طلب جاهز للإغلاق',
      case_completed_admin_body: 'اكتملت جميع خدمات الطلب {caseRef} وهو جاهز للمراجعة والإغلاق.',
      service_cancelled_provider_title: 'تم إلغاء خدمة',
      service_cancelled_provider_body: 'تم إلغاء خدمة "{item}" المعيّنة لك.',
      cancelled_patient_title: 'تم إلغاء طلبك',
      cancelled_patient_body: 'تم إلغاء طلبك. {reason}',
      cancelled_admin_title: 'إلغاء طلب',
      cancelled_admin_body: 'ألغى المريض الطلب {caseRef}. {reason}',
      appointment_title: 'موعد زيارة',
      appointment_body: 'تم تحديد موعد لخدمة "{item}" بتاريخ {date}.',
      closed_patient_title: 'تم إغلاق طلبك',
      closed_patient_body: 'تمت مراجعة طلبك وإغلاقه. الفاتورة متاحة الآن.',
      rated_admin_title: 'تقييم جديد',
      rated_admin_body: 'قيّم المريض {provider} بـ {rating} من 5.',
      report_published_title: 'تقريرك الطبي جاهز',
      report_published_body: 'تمت مراجعة تقريرك الطبي وأصبح متاحاً للتحميل.',
      message_title: 'رسالة جديدة',
      message_body: 'لديك رسالة جديدة بخصوص "{item}".',
    },
    payment: {
      admin_title: 'دفعة جديدة',
      admin_body: 'تم تسجيل دفعة بقيمة {amount} عبر {method}. {statusDetail}',
      invoice_paid_title: 'تم سداد الفاتورة بالكامل',
      invoice_paid_body: 'تم سداد فاتورتك بالكامل. شكراً لك.',
      partial_title: 'تم استلام دفعة',
      partial_body: 'تم استلام دفعة بقيمة {amount} دينار. المتبقي: {remaining} دينار.',
      status_paid: 'الفاتورة مدفوعة بالكامل.',
      status_remaining: 'المتبقي: {remaining} دينار.',
    },
    vip: {
      title: 'مبروك! أصبحت عضواً مميزاً',
      body: 'تم تفعيل عضويتك المميزة مع خصم {discount}% على جميع الطلبات.',
    },
  },
  labels: {
    guest: 'زائر',
    registered_patient: 'مريض مسجل',
    provider: 'مقدم الخدمة',
  },
};

function t(path, vars = {}) {
  const keys = path.split('.');
  let val = strings;
  for (const k of keys) {
    val = val?.[k];
    if (val === undefined) return path;
  }
  return String(val).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

module.exports = { t, strings };
