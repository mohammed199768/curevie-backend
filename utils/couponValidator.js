// FEAT: COUPON - validates coupon and computes discount
// Used at REQUEST CREATION TIME only (for locking the discount)
// Invoice creation reads the stored discount - no re-validation needed

const { AppError } = require('../middlewares/errorHandler');

async function getCouponState(couponCode, db) {
  const result = await db.query(
    `
    SELECT *,
      CASE
        WHEN is_active = FALSE THEN 'INACTIVE'
        WHEN expires_at IS NOT NULL
             AND expires_at <= NOW() THEN 'EXPIRED'
        WHEN max_uses IS NOT NULL AND used_count >= max_uses THEN 'LIMIT_REACHED'
        ELSE 'VALID'
      END AS validity_status
    FROM coupons
    WHERE UPPER(code) = UPPER($1)
    `,
    [couponCode]
  );

  if (!result.rows.length) {
    throw new AppError('Coupon not found', 404, 'COUPON_NOT_FOUND');
  }

  return result.rows[0];
}

function assertCouponCanBeApplied(coupon, orderAmount) {
  if (coupon.validity_status !== 'VALID') {
    throw new AppError(
      `Coupon is ${coupon.validity_status.toLowerCase().replace('_', ' ')}`,
      400,
      `COUPON_${coupon.validity_status}`
    );
  }

  if (orderAmount < Number(coupon.min_order_amount)) {
    throw new AppError(
      `Minimum order amount is ${coupon.min_order_amount}`,
      400,
      'COUPON_MIN_ORDER_NOT_MET'
    );
  }
}

function computeCouponAmounts(coupon, orderAmount) {
  let discountAmount = 0;
  if (coupon.discount_type === 'PERCENTAGE') {
    discountAmount = (orderAmount * Number(coupon.discount_value)) / 100;
  } else {
    discountAmount = Math.min(Number(coupon.discount_value), orderAmount);
  }

  discountAmount = Math.round(discountAmount * 100) / 100;
  const finalAmount = Math.max(0, orderAmount - discountAmount);

  return { discountAmount, finalAmount };
}

async function reserveCouponAtomically(couponCode, orderAmount, db) {
  const result = await db.query(
    `
    UPDATE coupons
    SET used_count = used_count + 1
    WHERE UPPER(code) = UPPER($1)
      AND is_active = TRUE
      AND (max_uses IS NULL OR used_count < max_uses)
      AND (expires_at IS NULL OR expires_at > NOW())
      AND COALESCE(min_order_amount, 0) <= $2
    RETURNING *
    `,
    [couponCode, orderAmount]
  );

  if (result.rows.length) {
    return result.rows[0];
  }

  const coupon = await getCouponState(couponCode, db);
  assertCouponCanBeApplied(coupon, orderAmount);
  throw new AppError('Coupon could not be reserved', 409, 'COUPON_RESERVATION_FAILED');
}

async function validateAndComputeCoupon(couponCode, orderAmount, db, { reserve = false } = {}) {
  const normalizedOrderAmount = Number(orderAmount) || 0;
  if (!couponCode) {
    return { coupon: null, discountAmount: 0, finalAmount: normalizedOrderAmount };
  }

  const coupon = reserve
    ? await reserveCouponAtomically(couponCode, normalizedOrderAmount, db)
    : await getCouponState(couponCode, db);

  assertCouponCanBeApplied(coupon, normalizedOrderAmount);
  const { discountAmount, finalAmount } = computeCouponAmounts(coupon, normalizedOrderAmount);

  return { coupon, discountAmount, finalAmount };
}

module.exports = { validateAndComputeCoupon };
