/**
 * Launch catalog: the 64 services and 6 care packages the patient site shows on its
 * category pages, so the home-page counts and the order form come from the database.
 *   npm run db:seed:catalog
 * Safe on production and safe to run more than once: categories, services and packages that
 * already exist (matched by Arabic name) are left untouched, so prices or texts edited in the
 * admin panel are never overwritten. Prices below are launch defaults in JOD — review them
 * in the admin panel before opening bookings.
 *
 * Physical and occupational therapy keep the fixed category ids the patient site links to
 * (PUBLIC_SERVICE_CATEGORIES in curevie-main/lib/public-service-categories.ts).
 */
require('dotenv').config();
const pool = require('../db');

const CATEGORIES = {
  medical: { name: 'الزيارات الطبية', description: 'Medical Visits' },
  nursing: { name: 'التمريض والرعاية المنزلية', description: 'Home Nursing & Care' },
  physio: { id: '3a3ab6d1-6b90-42b3-80aa-a0ef754576df', name: 'العلاج الطبيعي المنزلي', description: 'Home Physical Therapy' },
  occupational: { id: '53123e20-0e97-43b0-85e8-c8876e2b0dbc', name: 'العلاج الوظيفي المنزلي', description: 'Home Occupational Therapy' },
  imaging: { name: 'الأشعة والتصوير المنزلي', description: 'Home Radiology & Imaging' },
  lab: { name: 'التحاليل المنزلية', description: 'Home Lab Diagnostics' },
  programs: { name: 'برامج الرعاية والمتابعة', description: 'Care & Follow-up Programs' },
};

// [key, category, kind, price, name_ar, name_en, description_ar, description_en]
// Therapy is MEDICAL: there is no therapist provider type yet, so a doctor is the eligible provider.
const SERVICES = [
  ['doctor-home-visit', 'medical', 'MEDICAL', 30, 'زيارة طبيب إلى المنزل', 'Doctor Home Visit', 'تقييم سريري وفحص طبي في المنزل مع خطة علاج ومتابعة.', 'At-home clinical assessment, examination, and follow-up plan.'],
  ['comprehensive-medical-visit', 'medical', 'MEDICAL', 45, 'زيارة طبية شاملة', 'Comprehensive Medical Visit', 'زيارة منزلية لتقييم الحالة الصحية والاحتياجات الطبية بصورة شاملة.', 'A comprehensive home visit to assess health needs and next steps.'],
  ['online-consultation', 'medical', 'MEDICAL', 15, 'استشارة طبية عن بُعد', 'Online Medical Consultation', 'استشارة أولية عن بُعد لتوجيه المريض إلى المسار الأنسب.', 'A remote first consultation to guide the patient to the right care path.'],
  ['urologist-home-visit', 'medical', 'MEDICAL', 50, 'زيارة طبيب مسالك بولية', 'Urologist Home Visit', 'تقييم متخصص لحالات المسالك البولية ضمن راحة المنزل.', 'Specialist assessment for urology needs in the comfort of home.'],
  ['chronic-disease-follow-up', 'medical', 'MEDICAL', 30, 'متابعة الأمراض المزمنة', 'Chronic Disease Follow-up', 'متابعة دورية للحالات المزمنة ومراجعة الخطة العلاجية.', 'Ongoing review of chronic conditions and the care plan.'],
  ['elderly-medical-assessment', 'medical', 'MEDICAL', 40, 'تقييم طبي لكبار السن', 'Elderly Medical Assessment', 'تقييم منزلي يراعي الأدوية والحركة والاحتياجات اليومية لكبار السن.', 'A home assessment covering medication, mobility, and daily needs for older adults.'],
  ['pediatric-home-visit', 'medical', 'MEDICAL', 35, 'زيارة طبيب أطفال إلى المنزل', 'Pediatric Home Visit', 'تقييم الأطفال في المنزل للحالات التي لا تتطلب طوارئ.', 'At-home pediatric assessment for non-emergency concerns.'],

  ['iv-cannula-injections', 'nursing', 'NURSING', 15, 'حقن وريدي وتركيب كانيولا', 'IV / Cannula Injections', 'إعطاء الحقن الوريدي وتركيب الكانيولا بواسطة كادر تمريضي مؤهل.', 'IV administration and cannula placement by qualified nursing staff.'],
  ['im-subcutaneous-injections', 'nursing', 'NURSING', 8, 'حقن عضلي أو تحت الجلد', 'IM / Subcutaneous Injections', 'إعطاء الحقن العضلية أو تحت الجلد وفق الوصفة الطبية.', 'Intramuscular or subcutaneous injections according to the prescription.'],
  ['nebulizer-session', 'nursing', 'NURSING', 10, 'جلسة تبخيرة', 'Nebulizer Session', 'تجهيز ومتابعة جلسة التبخيرة في المنزل.', 'Setup and monitoring of a home nebulizer session.'],
  ['post-operative-care', 'nursing', 'NURSING', 25, 'رعاية ما بعد العمليات', 'Post-operative Care', 'متابعة الجرح والعلامات الحيوية والتعليمات بعد الخروج من المستشفى.', 'Wound, vital-sign, and recovery follow-up after hospital discharge.'],
  ['deep-wound-care', 'nursing', 'NURSING', 25, 'العناية بالجروح العميقة', 'Deep Wound Care', 'تنظيف وتضميد الجروح العميقة وفق خطة الرعاية.', 'Cleaning and dressing of deep wounds according to the care plan.'],
  ['wound-care', 'nursing', 'NURSING', 15, 'العناية بالجروح وتغيير الضماد', 'Wound Care & Dressing', 'تنظيف الجرح وتغيير الضماد ومراقبة مؤشرات الالتهاب.', 'Wound cleaning, dressing changes, and monitoring for signs of infection.'],
  ['burn-care', 'nursing', 'NURSING', 20, 'العناية بالحروق', 'Burn Care', 'غيار الحروق ومتابعة التئامها حسب توجيهات الفريق الطبي.', 'Burn dressing and healing follow-up under clinical guidance.'],
  ['urinary-catheter-insertion', 'nursing', 'NURSING', 20, 'تركيب قسطرة بولية', 'Urinary Catheter Insertion', 'تركيب أو تبديل القسطرة البولية في المنزل ضمن معايير التعقيم.', 'Home urinary catheter insertion or replacement using sterile practice.'],
  ['diabetic-foot-care', 'nursing', 'NURSING', 20, 'العناية بالقدم السكري', 'Diabetic Foot Care', 'تقييم وعناية تمريضية للجروح المرتبطة بالقدم السكري.', 'Nursing assessment and care for diabetic foot wounds.'],
  ['vital-signs-monitoring', 'nursing', 'NURSING', 10, 'قياس ومتابعة العلامات الحيوية', 'Vital Signs Monitoring', 'متابعة الضغط والنبض والحرارة والأكسجين وتوثيق القراءات.', 'Monitoring and documenting blood pressure, pulse, temperature, and oxygen.'],
  ['medication-administration', 'nursing', 'NURSING', 12, 'إعطاء الأدوية ومتابعتها', 'Medication Administration & Follow-up', 'مساعدة تمريضية منظمة لإعطاء الأدوية ومتابعة الجرعات.', 'Structured nursing support for medication administration and schedules.'],
  ['elderly-nursing-care', 'nursing', 'NURSING', 30, 'رعاية تمريضية لكبار السن', 'Elderly Nursing Care', 'رعاية منزلية تراعي الحالة الصحية والاحتياجات اليومية لكبار السن.', "Home nursing tailored to older adults' health and daily needs."],
  ['patient-companion-home', 'nursing', 'NURSING', 40, 'مرافقة مريض في المنزل', 'Patient Companion at Home', 'دعم ومرافقة للمريض في المنزل بالتنسيق مع الأسرة.', 'Patient support and companionship at home in coordination with the family.'],
  ['patient-companion-hospital', 'nursing', 'NURSING', 45, 'مرافقة مريض في المستشفى', 'Patient Companion in Hospital', 'مرافقة منظمة للمريض أثناء الإقامة أو المراجعات في المستشفى.', 'Organized patient companionship during hospital stays or visits.'],

  ['physiotherapy-assessment', 'physio', 'MEDICAL', 25, 'تقييم علاج طبيعي منزلي', 'Home Physiotherapy Assessment', 'تقييم الحركة والقوة ووضع خطة علاج تناسب المنزل.', 'Mobility and strength assessment with a home-based treatment plan.'],
  ['post-operative-rehabilitation', 'physio', 'MEDICAL', 25, 'تأهيل ما بعد العمليات', 'Post-operative Rehabilitation', 'جلسات تدريجية لاستعادة الحركة بعد العمليات.', 'Progressive sessions to restore movement after surgery.'],
  ['stroke-neurological-rehab', 'physio', 'MEDICAL', 30, 'تأهيل الجلطات والحالات العصبية', 'Stroke & Neurological Rehabilitation', 'برنامج منزلي لتحسين الحركة والتوازن بعد الجلطات والحالات العصبية.', 'Home rehabilitation to improve movement and balance after stroke or neurological illness.'],
  ['mobility-balance-training', 'physio', 'MEDICAL', 25, 'تدريب الحركة والتوازن', 'Mobility & Balance Training', 'تدريب آمن لتحسين المشي والتوازن وتقليل خطر السقوط.', 'Safe training to improve walking, balance, and fall prevention.'],
  ['joint-pain-therapy', 'physio', 'MEDICAL', 25, 'علاج آلام المفاصل والعضلات', 'Joint & Musculoskeletal Therapy', 'جلسات لتحسين المرونة وتخفيف الألم واستعادة النشاط.', 'Sessions to improve flexibility, reduce pain, and restore activity.'],

  ['daily-living-skills', 'occupational', 'MEDICAL', 25, 'تدريب مهارات الحياة اليومية', 'Daily Living Skills Training', 'تدريب عملي لاستعادة الاستقلالية في الأنشطة اليومية.', 'Practical training to regain independence in everyday activities.'],
  ['neurological-occupational-rehab', 'occupational', 'MEDICAL', 30, 'تأهيل وظيفي للحالات العصبية', 'Neurological Occupational Rehabilitation', 'تأهيل وظيفي لتحسين استخدام الأطراف والمهارات اليومية.', 'Functional rehabilitation for limb use and daily skills.'],
  ['pediatric-occupational-therapy', 'occupational', 'MEDICAL', 25, 'علاج وظيفي للأطفال', 'Pediatric Occupational Therapy', 'برنامج منزلي لدعم مهارات الأطفال واحتياجاتهم الوظيفية.', "Home-based support for children's functional and developmental skills."],
  ['home-independence-assessment', 'occupational', 'MEDICAL', 30, 'تقييم الاستقلالية وسلامة المنزل', 'Home Independence & Safety Assessment', 'تقييم البيئة المنزلية واقتراح تعديلات تساعد على الحركة الآمنة.', 'Home environment assessment with recommendations for safer independence.'],

  ['xray-ankle', 'imaging', 'RADIOLOGY', 35, 'أشعة سينية للكاحل', 'X-ray Ankle', 'تصوير الكاحل بالأشعة السينية في المنزل.', 'Portable ankle X-ray at home.'],
  ['xray-elbow', 'imaging', 'RADIOLOGY', 35, 'أشعة سينية للمرفق', 'X-ray Elbow', 'تصوير المرفق بالأشعة السينية في المنزل.', 'Portable elbow X-ray at home.'],
  ['xray-knee', 'imaging', 'RADIOLOGY', 35, 'أشعة سينية للركبة', 'X-ray Knee', 'تصوير الركبة بالأشعة السينية في المنزل.', 'Portable knee X-ray at home.'],
  ['xray-wrist', 'imaging', 'RADIOLOGY', 35, 'أشعة سينية للرسغ', 'X-ray Wrist', 'تصوير الرسغ بالأشعة السينية في المنزل.', 'Portable wrist X-ray at home.'],
  ['xray-hand', 'imaging', 'RADIOLOGY', 35, 'أشعة سينية لليد', 'X-ray Hand', 'تصوير اليد بالأشعة السينية في المنزل.', 'Portable hand X-ray at home.'],
  ['xray-shoulder', 'imaging', 'RADIOLOGY', 35, 'أشعة سينية للكتف', 'X-ray Shoulder', 'تصوير الكتف بالأشعة السينية في المنزل.', 'Portable shoulder X-ray at home.'],
  ['xray-hip', 'imaging', 'RADIOLOGY', 35, 'أشعة سينية للورك', 'X-ray Hip', 'تصوير الورك بالأشعة السينية في المنزل.', 'Portable hip X-ray at home.'],
  ['xray-pelvis', 'imaging', 'RADIOLOGY', 35, 'أشعة سينية للحوض', 'X-ray Pelvis', 'تصوير الحوض بالأشعة السينية في المنزل.', 'Portable pelvis X-ray at home.'],
  ['xray-spine-2-view', 'imaging', 'RADIOLOGY', 45, 'أشعة سينية للعمود الفقري بوضعيتين', 'X-ray Spine — 2 Views', 'تصوير العمود الفقري بوضعيتين في المنزل.', 'Portable two-view spine X-ray at home.'],
  ['xray-chest-1-view', 'imaging', 'RADIOLOGY', 35, 'أشعة صدر بوضعية واحدة', 'X-ray Chest — 1 View', 'تصوير الصدر بوضعية واحدة في المنزل.', 'Portable single-view chest X-ray at home.'],
  ['xray-chest-2-view', 'imaging', 'RADIOLOGY', 45, 'أشعة صدر بوضعيتين', 'X-ray Chest — 2 Views', 'تصوير الصدر بوضعيتين في المنزل.', 'Portable two-view chest X-ray at home.'],
  ['xray-arm-2-view', 'imaging', 'RADIOLOGY', 45, 'أشعة للذراع بوضعيتين', 'X-ray Arm — 2 Views', 'تصوير الذراع بوضعيتين في المنزل.', 'Portable two-view arm X-ray at home.'],
  ['xray-leg-2-view', 'imaging', 'RADIOLOGY', 45, 'أشعة للساق بوضعيتين', 'X-ray Leg — 2 Views', 'تصوير الساق بوضعيتين في المنزل.', 'Portable two-view leg X-ray at home.'],
  ['xray-skull-2-view', 'imaging', 'RADIOLOGY', 45, 'أشعة للجمجمة بوضعيتين', 'X-ray Skull — 2 Views', 'تصوير الجمجمة بوضعيتين في المنزل.', 'Portable two-view skull X-ray at home.'],
  ['ultrasound-abdomen', 'imaging', 'RADIOLOGY', 45, 'ألتراساوند للبطن', 'Ultrasound Abdomen', 'تصوير البطن بالموجات فوق الصوتية.', 'Abdominal ultrasound imaging.'],
  ['ultrasound-pelvis', 'imaging', 'RADIOLOGY', 45, 'ألتراساوند للحوض', 'Ultrasound Pelvis', 'تصوير الحوض بالموجات فوق الصوتية.', 'Pelvic ultrasound imaging.'],
  ['ultrasound-parathyroid', 'imaging', 'RADIOLOGY', 45, 'ألتراساوند لجارات الدرقية', 'Ultrasound Parathyroid', 'تصوير جارات الدرقية بالموجات فوق الصوتية.', 'Parathyroid ultrasound imaging.'],
  ['ultrasound-thyroid', 'imaging', 'RADIOLOGY', 45, 'ألتراساوند للغدة الدرقية', 'Ultrasound Thyroid', 'تصوير الغدة الدرقية بالموجات فوق الصوتية.', 'Thyroid ultrasound imaging.'],
  ['ultrasound-neck', 'imaging', 'RADIOLOGY', 45, 'ألتراساوند للرقبة', 'Ultrasound Neck', 'تصوير الرقبة بالموجات فوق الصوتية.', 'Neck ultrasound imaging.'],
  ['ultrasound-breast', 'imaging', 'RADIOLOGY', 45, 'ألتراساوند للثدي', 'Ultrasound Breast', 'تصوير الثدي بالموجات فوق الصوتية.', 'Breast ultrasound imaging.'],
  ['ultrasound-soft-tissue', 'imaging', 'RADIOLOGY', 45, 'ألتراساوند للأنسجة الرخوة', 'Ultrasound Soft Tissue', 'تصوير الأنسجة الرخوة بالموجات فوق الصوتية.', 'Soft-tissue ultrasound imaging.'],
  ['doppler-one-side', 'imaging', 'RADIOLOGY', 50, 'دوبلر لجهة واحدة', 'Doppler Ultrasound — One Side', 'فحص دوبلر للأوعية في جهة واحدة.', 'One-sided vascular Doppler ultrasound.'],
  ['doppler-two-sides', 'imaging', 'RADIOLOGY', 80, 'دوبلر للجهتين', 'Doppler Ultrasound — Two Sides', 'فحص دوبلر للأوعية في الجهتين.', 'Bilateral vascular Doppler ultrasound.'],
  ['echocardiogram', 'imaging', 'RADIOLOGY', 70, 'إيكو للقلب', 'Echocardiogram', 'تصوير القلب بالموجات فوق الصوتية.', 'Ultrasound imaging of the heart.'],
  ['ecg', 'imaging', 'RADIOLOGY', 20, 'تخطيط القلب', 'ECG', 'تسجيل النشاط الكهربائي للقلب في المنزل.', "At-home recording of the heart's electrical activity."],

  ['home-sample-collection', 'lab', 'LAB', 5, 'سحب عينات مخبرية من المنزل', 'Home Lab Sample Collection', 'سحب العينات من المنزل وتنسيق النتائج رقميًا.', 'At-home sample collection with coordinated digital results.'],
  ['complete-blood-count', 'lab', 'LAB', 6, 'فحص تعداد الدم الكامل', 'Complete Blood Count', 'فحص أساسي لمكونات الدم الرئيسية.', 'Core screening of the main blood components.'],
  ['kidney-function-panel', 'lab', 'LAB', 12, 'فحوصات وظائف الكلى', 'Kidney Function Panel', 'مجموعة فحوصات لمؤشرات وظائف الكلى.', 'A panel covering key kidney function markers.'],
  ['liver-function-panel', 'lab', 'LAB', 15, 'فحوصات وظائف الكبد', 'Liver Function Panel', 'مجموعة فحوصات لمؤشرات وظائف الكبد.', 'A panel covering key liver function markers.'],
  ['diabetes-panel', 'lab', 'LAB', 10, 'فحوصات السكري', 'Diabetes Panel', 'فحوصات لمتابعة سكر الدم والسيطرة عليه.', 'Tests for blood glucose screening and follow-up.'],
  ['thyroid-panel', 'lab', 'LAB', 18, 'فحوصات الغدة الدرقية', 'Thyroid Panel', 'فحوصات لمؤشرات نشاط الغدة الدرقية.', 'Tests covering key thyroid activity markers.'],
  ['lipid-profile', 'lab', 'LAB', 12, 'فحص دهنيات الدم', 'Lipid Profile', 'فحص الكوليسترول والدهنيات الأساسية.', 'Screening of cholesterol and core lipid markers.'],
  ['vitamin-panel', 'lab', 'LAB', 30, 'فحوصات الفيتامينات', 'Vitamin Panel', 'فحوصات مختارة لمتابعة مستويات الفيتامينات.', 'Selected tests for common vitamin levels.'],
  ['urinalysis', 'lab', 'LAB', 4, 'فحص البول', 'Urinalysis', 'تحليل بول روتيني ضمن خدمة السحب المنزلي.', 'Routine urinalysis coordinated through home collection.'],
];

// [price, name_ar, name_en, description_ar, description_en, service keys in visit order]
const PACKAGES = [
  [65, 'برنامج رعاية كبار السن', 'Elderly Home Care Program', 'خطة رعاية منظمة تشمل المتابعة الصحية والأدوية والاحتياجات اليومية.', 'A structured plan covering health follow-up, medication, and daily needs.',
    ['elderly-medical-assessment', 'vital-signs-monitoring', 'medication-administration', 'home-sample-collection', 'complete-blood-count']],
  [65, 'برنامج التعافي بعد العمليات', 'Post-surgery Recovery Program', 'خطة متابعة منزلية للجروح والعلامات الحيوية والتعافي التدريجي.', 'Home follow-up for wounds, vital signs, and progressive recovery.',
    ['post-operative-care', 'wound-care', 'vital-signs-monitoring', 'post-operative-rehabilitation']],
  [75, 'برنامج مرافقة المريض', 'Patient Companion Program', 'مرافقة ودعم للمريض في المنزل أو المستشفى وفق احتياج الأسرة.', 'Patient support at home or in hospital based on family needs.',
    ['patient-companion-home', 'patient-companion-hospital']],
  [60, 'برنامج متابعة الحالات المزمنة', 'Chronic Care Follow-up Program', 'متابعة منظمة للقياسات والأدوية والمواعيد الطبية.', 'Organized follow-up for measurements, medication, and appointments.',
    ['chronic-disease-follow-up', 'home-sample-collection', 'diabetes-panel', 'kidney-function-panel', 'lipid-profile']],
  [45, 'برنامج إدارة ومتابعة الأدوية', 'Medication Management Program', 'تنظيم جدول الأدوية ومتابعة الالتزام بالتنسيق مع الأسرة.', 'Medication schedule organization and adherence follow-up with the family.',
    ['chronic-disease-follow-up', 'medication-administration', 'vital-signs-monitoring']],
  [70, 'تقييم وخطة رعاية منزلية', 'Home Care Assessment & Plan', 'تقييم احتياجات المريض وبناء خطة رعاية منزلية مناسبة.', 'Assessment of patient needs followed by a suitable home-care plan.',
    ['comprehensive-medical-visit', 'vital-signs-monitoring', 'home-independence-assessment']],
];

async function ensureCategory(client, category) {
  if (category.id) {
    await client.query(
      'INSERT INTO service_categories (id, name, description) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [category.id, category.name, category.description]
    );
    return category.id;
  }
  const existing = await client.query('SELECT id FROM service_categories WHERE name = $1 ORDER BY created_at LIMIT 1', [category.name]);
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await client.query(
    'INSERT INTO service_categories (name, description) VALUES ($1, $2) RETURNING id',
    [category.name, category.description]
  );
  return created.rows[0].id;
}

async function seed() {
  const client = await pool.connect();
  const created = { services: 0, packages: 0 };
  try {
    await client.query('BEGIN');

    const categoryIds = {};
    for (const [key, category] of Object.entries(CATEGORIES)) {
      categoryIds[key] = await ensureCategory(client, category);
    }

    const serviceIds = {};
    for (const [key, category, kind, price, nameAr, nameEn, descAr, descEn] of SERVICES) {
      const existing = await client.query(
        'SELECT id FROM services WHERE name_ar = $1 OR name = $1 ORDER BY created_at LIMIT 1',
        [nameAr]
      );
      if (existing.rows[0]) {
        serviceIds[key] = existing.rows[0].id;
        continue;
      }
      const inserted = await client.query(
        `INSERT INTO services (name, name_ar, name_en, description, description_ar, description_en, price, service_kind, category_id)
         VALUES ($1, $1, $2, $3, $3, $4, $5, $6, $7) RETURNING id`,
        [nameAr, nameEn, descAr, descEn, price, kind, categoryIds[category]]
      );
      serviceIds[key] = inserted.rows[0].id;
      created.services += 1;
    }

    for (const [price, nameAr, nameEn, descAr, descEn, keys] of PACKAGES) {
      const existing = await client.query('SELECT 1 FROM packages WHERE name_ar = $1 OR name = $1', [nameAr]);
      if (existing.rows[0]) continue;
      const inserted = await client.query(
        `INSERT INTO packages (name, name_ar, name_en, description, description_ar, description_en, total_cost, category_id)
         VALUES ($1, $1, $2, $3, $3, $4, $5, $6) RETURNING id`,
        [nameAr, nameEn, descAr, descEn, price, categoryIds.programs]
      );
      for (const [index, key] of keys.entries()) {
        await client.query(
          'INSERT INTO package_services (package_id, service_id, display_order) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [inserted.rows[0].id, serviceIds[key], index + 1]
        );
      }
      created.packages += 1;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  console.log(
    `[seed:catalog] ${created.services} new services, ${created.packages} new packages ` +
    `(catalog defines ${SERVICES.length} services and ${PACKAGES.length} packages)`
  );
}

seed()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error('[seed:catalog] failed:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
