const xss = require('xss');

// Secrets are compared or hashed byte-for-byte, so they must never be rewritten by the XSS filter.
const RAW_KEYS = /password|token/i;

function sanitizeValue(value, key = '') {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, key));
  }

  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value).reduce((acc, childKey) => {
      acc[childKey] = sanitizeValue(value[childKey], childKey);
      return acc;
    }, {});
  }

  if (typeof value === 'string') {
    return RAW_KEYS.test(key) ? value : xss(value.trim());
  }

  return value;
}

const validate = (schema, property = 'body') => (req, res, next) => {
  const target = sanitizeValue(req[property] || {});
  const { error, value } = schema.validate(target, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });

  if (error) {
    // details maps each field to its messages so forms can show them inline.
    const details = {};
    for (const item of error.details) {
      const field = item.path.length ? String(item.path[0]) : '_';
      (details[field] = details[field] || []).push(item.message);
    }
    return res.status(400).json({
      message: error.details.map((d) => d.message).join(', '),
      code: 'VALIDATION_ERROR',
      details,
    });
  }

  req[property] = value;
  return next();
};

module.exports = validate;
