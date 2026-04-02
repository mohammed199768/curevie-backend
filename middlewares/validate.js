const xss = require('xss');

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((acc, key) => {
      acc[key] = sanitizeValue(value[key]);
      return acc;
    }, {});
  }

  if (typeof value === 'string') {
    return xss(value.trim());
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
    const details = error.details.map((d) => d.message).join(', ');
    return res.status(400).json({ message: details, code: 'VALIDATION_ERROR' });
  }

  req[property] = value;
  return next();
};

module.exports = validate;