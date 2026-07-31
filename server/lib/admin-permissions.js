const ALL_PERMISSIONS = [
  "orders:read", "orders:write", "orders:pii:read",
  "inventory:read", "inventory:write",
  "purchase_orders:read", "purchase_orders:write",
  "payments:read", "payments:reconcile", "payments:cancel",
  "activity_logs:read", "admin_users:manage", "backup:operate",
  "sales_channels:read", "sales_channels:manage",
];

const ROLE_PERMISSIONS = {
  super_admin: ALL_PERMISSIONS,
  operations: [
    "orders:read", "orders:write", "orders:pii:read",
    "inventory:read", "inventory:write",
    "purchase_orders:read", "purchase_orders:write",
    "payments:read", "activity_logs:read",
    "sales_channels:read",
  ],
  finance: [
    "orders:read", "payments:read", "payments:reconcile",
    "payments:cancel", "activity_logs:read",
    "sales_channels:read",
  ],
  viewer: [
    "orders:read", "inventory:read", "purchase_orders:read",
    "payments:read", "activity_logs:read",
    "sales_channels:read",
  ],
};

const ADMIN_ROLES = Object.freeze(Object.keys(ROLE_PERMISSIONS));

function normalizeAdminRole(role) {
  if (ADMIN_ROLES.includes(role)) return role;
  if (role === "owner" || role === "admin") return "super_admin";
  if (role === "manager") return "operations";
  if (role === "staff") return "viewer";
  return null;
}

function permissionsForRole(role) {
  return [...(ROLE_PERMISSIONS[normalizeAdminRole(role)] || [])];
}

module.exports = { ADMIN_ROLES, ALL_PERMISSIONS, ROLE_PERMISSIONS, normalizeAdminRole, permissionsForRole };
