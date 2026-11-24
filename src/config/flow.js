// Task Management (flow tasks) access. Unlike the PMS screens it is not driven by Roles & Permissions:
// a fixed list of roles can use it, and only the Admin role administers it (edits any task's flow).
// The Super Admin (role level 0) can do everything.
export const FLOW_ROLES = Object.freeze(['ADMIN', 'PROJECT_MANAGER', 'EMPLOYEE']);

/** May the signed-in user open Task Management? */
export const canUseFlow = (auth) => Boolean(auth) && (auth.isSuperAdmin || FLOW_ROLES.includes(auth.role.code));

/** Admins edit the flow / owners of any task; everyone else only of the tasks they own. */
export const isFlowAdmin = (auth) => auth.isSuperAdmin || auth.role.code === 'ADMIN';

/** Which parts of the app the user's role can open: 'pms' for everyone, 'tm' (the Tasks board, 1-3-5 and Messages) for those who may use it. */
export const appsOf = (auth) => (canUseFlow(auth) ? ['pms', 'tm'] : ['pms']);
