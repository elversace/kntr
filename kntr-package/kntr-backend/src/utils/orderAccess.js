// Order access is always scoped to an explicit role. In particular, corporate
// accounts have no order scope until a corporate ownership relation is defined.
const GLOBAL_ORDER_READ_ROLES = ['admin', 'support', 'finance', 'audit'];

const isOrderCustomer = (user, order) =>
  user?.role === 'customer' && order.customer_id === user.id;

const isAssignedDriver = (user, order) =>
  user?.role === 'driver' && order.driver_id === user.id;

const canReadOrder = (user, order) =>
  GLOBAL_ORDER_READ_ROLES.includes(user?.role) ||
  isOrderCustomer(user, order) || isAssignedDriver(user, order);

const isApprovedAssignedDriver = async (user, order, client) => {
  if (!isAssignedDriver(user, order)) return false;
  const driver = await client.query(
    "SELECT driver_status FROM drivers WHERE user_id = $1",
    [user.id]
  );
  return driver.rows[0]?.driver_status === 'approved';
};

// The proof token is only disclosed by the assigned driver's generate-QR action.
const stripOrderSecrets = (order) => {
  const { qr_code, ...visible } = order;
  return visible;
};

module.exports = {
  GLOBAL_ORDER_READ_ROLES, isOrderCustomer, isAssignedDriver,
  canReadOrder, isApprovedAssignedDriver, stripOrderSecrets,
};
