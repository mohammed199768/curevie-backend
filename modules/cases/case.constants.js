// Orderable catalog item types. Each maps to one nullable FK column on case_services.
// Lab tests are services with service_kind = 'LAB'; packages bundle several services.
const ITEM_TYPES = ['SERVICE', 'PACKAGE'];

// How to load price/name/flags for each item type. Prices always come from here, never from clients.
const ITEM_CATALOG = {
  SERVICE: {
    column: 'service_id',
    sql: `SELECT id, name AS item_name, price, is_active, is_vip_exclusive, service_kind AS kind, system_key
          FROM services WHERE id = ANY($1::uuid[])`,
  },
  PACKAGE: {
    column: 'package_id',
    sql: `SELECT id, name AS item_name, total_cost AS price, is_active, is_vip_exclusive, 'PACKAGE' AS kind
          FROM packages WHERE id = ANY($1::uuid[])`,
  },
};

// SQL expression giving the clinical kind of a case_services row (needs the join s = services).
const SERVICE_KIND_SQL = `CASE cs.item_type
  WHEN 'SERVICE' THEN COALESCE(s.service_kind, 'MEDICAL')
  ELSE 'PACKAGE' END`;

// Provider types able to perform each kind (first = best match).
// Nurses collect lab samples at home, so they come right after lab technicians.
const PROVIDER_TYPES_BY_KIND = {
  MEDICAL: ['DOCTOR'],
  NURSING: ['NURSE', 'DOCTOR'],
  RADIOLOGY: ['RADIOLOGY_TECH', 'DOCTOR'],
  LAB: ['LAB_TECH', 'NURSE', 'DOCTOR'],
  PACKAGE: ['DOCTOR'],
};

const CASE_STATUS = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CLOSED: 'CLOSED',
  CANCELLED: 'CANCELLED',
};

const SERVICE_STATUS = {
  PENDING: 'PENDING',
  ASSIGNED: 'ASSIGNED',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

// Case states in which the order is finished and nothing may change any more.
const FINAL_CASE_STATUSES = [CASE_STATUS.CLOSED, CASE_STATUS.CANCELLED];
// Service states that count as an open job for a provider.
const OPEN_SERVICE_STATUSES = [SERVICE_STATUS.ASSIGNED, SERVICE_STATUS.ACCEPTED, SERVICE_STATUS.IN_PROGRESS];

const MAX_ITEMS_PER_CASE = 10;

// One partner account per kind (setting routing.partners): lines of that kind go straight to it.
const PARTNER_SETTING_KEYS = { LAB: 'lab_provider_id', RADIOLOGY: 'radiology_provider_id' };
// Internal catalog items the server adds by itself (services.system_key); never orderable directly.
const SYSTEM_SERVICES = { LAB_HOME_VISIT: 'lab_home_visit', LAB_INSURANCE_TESTS: 'lab_insurance_tests' };

// Who an order is for (CHILD = under 18). Mirrors the CHECK constraints in migration 003.
const RECIPIENT_GENDERS = ['MALE', 'FEMALE'];
const RECIPIENT_AGE_GROUPS = ['CHILD', 'ADULT'];

module.exports = {
  ITEM_TYPES,
  ITEM_CATALOG,
  SERVICE_KIND_SQL,
  PROVIDER_TYPES_BY_KIND,
  CASE_STATUS,
  SERVICE_STATUS,
  FINAL_CASE_STATUSES,
  OPEN_SERVICE_STATUSES,
  MAX_ITEMS_PER_CASE,
  RECIPIENT_GENDERS,
  RECIPIENT_AGE_GROUPS,
  PARTNER_SETTING_KEYS,
  SYSTEM_SERVICES,
};
