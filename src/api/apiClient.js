// src/api/apiClient.js — Cardoso App API client
//
// Typed at the API boundary via JSDoc + ambient declarations at
// src/types/api-rows.d.ts. Run `npm run typecheck` to verify callers
// reading row fields off the response match the declared shape.

/**
 * @typedef {import('@/types/api-rows').User} User
 * @typedef {import('@/types/api-rows').BalanceRow} BalanceRow
 * @typedef {import('@/types/api-rows').InventoryRow} InventoryRow
 * @typedef {import('@/types/api-rows').Worklist} Worklist
 * @typedef {import('@/types/api-rows').Assignment} Assignment
 * @typedef {import('@/types/api-rows').ActivityItem} ActivityItem
 * @typedef {import('@/types/api-rows').TopBalancesResponse} TopBalancesResponse
 * @typedef {import('@/types/api-rows').SuccessResponse} SuccessResponse
 */

const API_BASE = "/api";

/**
 * Parse a fetch Response into JSON, throwing a populated Error on non-2xx.
 * @template T
 * @param {Response} res
 * @param {string} label
 * @param {unknown} [payload]
 * @returns {Promise<T>}
 */
async function readResponse(res, label, payload = null) {
  const text = await res.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!res.ok) {
    console.error(`${label} failed`, {
      status: res.status,
      payload,
      response: data,
    });
    throw new Error(data.error || data.message || `${label} failed`);
  }

  return data;
}

export const api = {
  entities: new Proxy(
    {},
    {
      get(target, entityName) {
        if (typeof entityName !== "string") return undefined;
        const table = entityName.toLowerCase();

        return {
          /** @param {string | { sort?: string, limit?: number, filters?: Record<string, unknown> }} [sortOrOptions] */
          list: async (sortOrOptions) => {
            const params = new URLSearchParams();

            if (typeof sortOrOptions === "string") {
              params.set("sort", sortOrOptions);
            } else if (sortOrOptions && typeof sortOrOptions === "object") {
              const { sort, limit, filters } = sortOrOptions;
              if (sort) params.set("sort", sort);
              if (limit != null) params.set("limit", String(limit));
              if (filters && typeof filters === "object") {
                Object.entries(filters).forEach(([key, value]) => {
                  if (value == null || value === "") return;
                  params.set(`filter_${key}`, String(value));
                });
              }
            }

            const query = params.toString();
            const url = query ? `${API_BASE}/${table}?${query}` : `${API_BASE}/${table}`;
            const res = await fetch(url, { credentials: "include" });
            return readResponse(res, `List ${String(entityName)}`);
          },

          /** @param {string | number} id */
          get: async (id) => {
            const res = await fetch(`${API_BASE}/${table}/${id}`, {
              credentials: "include",
            });
            return readResponse(res, `Get ${String(entityName)}`);
          },

          /** @param {Record<string, unknown>} data */
          create: async (data) => {
            const res = await fetch(`${API_BASE}/${table}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify(data),
            });
            return readResponse(res, `Create ${String(entityName)}`, data);
          },

          /**
           * @param {string | number} id
           * @param {Record<string, unknown>} data
           */
          update: async (id, data) => {
            const res = await fetch(`${API_BASE}/${table}/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify(data),
            });
            return readResponse(res, `Update ${String(entityName)}`, data);
          },

          /** @param {string | number} id */
          delete: async (id) => {
            const res = await fetch(`${API_BASE}/${table}/${id}`, {
              method: "DELETE",
              credentials: "include",
            });
            return readResponse(res, `Delete ${String(entityName)}`);
          },

          /** @param {Record<string, unknown>} [filters] */
          filter: async (filters = {}) => {
            const res = await fetch(`${API_BASE}/${table}`, {
              credentials: "include",
            });
            /** @type {Record<string, unknown>[]} */
            const rows = await readResponse(res, `Filter ${String(entityName)}`, filters);

            return rows.filter((row) =>
              Object.entries(filters).every(([key, value]) => row[key] === value)
            );
          },

          subscribe: () => {
            console.log(`Local mode subscribe for ${String(entityName)} is a no-op`);
            return () => {};
          },
        };
      },
    }
  ),

  auth: {
    /** @returns {Promise<{ user: User | null }>} */
    me: async () => {
      const res = await fetch(`${API_BASE}/auth/me`, {
        method: "GET",
        credentials: "include",
      });
      return readResponse(res, "Get current user");
    },

    /**
     * @param {{ email: string, password: string }} creds
     * @returns {Promise<{ user: User, hub_redirect?: string }>}
     */
    login: async ({ email, password }) => {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      return readResponse(res, "Login", { email });
    },

    logout: async () => {
      const res = await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
      return readResponse(res, "Logout");
    },

    /** @param {Partial<User> & { full_name?: string, email?: string }} data */
    updateMe: async (data) => {
      const res = await fetch(`${API_BASE}/auth/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      return readResponse(res, 'Update profile', data);
    },

    /** @param {{ email: string, password: string, full_name?: string }} data */
    register: async (data) => {
      const res = await fetch(`${API_BASE}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      return readResponse(res, "Register user", data);
    },
  },

  users: {
    /** @returns {Promise<User[]>} */
    list: async () => {
      const res = await fetch(`${API_BASE}/users`, {
        credentials: "include",
      });
      return readResponse(res, "List users");
    },

    /**
     * @param {{ email: string, full_name?: string, role?: string, password: string }} data
     * @returns {Promise<User>}
     */
    create: async (data) => {
      const res = await fetch(`${API_BASE}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      return readResponse(res, "Create user", data);
    },

    /**
     * @param {number} id
     * @param {Record<string, boolean | 0 | 1>} permissions
     * @returns {Promise<SuccessResponse>}
     */
    updatePermissions: async (id, permissions) => {
      const res = await fetch(`${API_BASE}/users/${id}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(permissions),
      });
      return readResponse(res, "Update user permissions", permissions);
    },

    /**
     * @param {number} id
     * @param {string} password
     * @returns {Promise<SuccessResponse>}
     */
    updatePassword: async (id, password) => {
      const res = await fetch(`${API_BASE}/users/${id}/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      return readResponse(res, "Update user password");
    },

    /**
     * @param {number} id
     * @returns {Promise<SuccessResponse>}
     */
    delete: async (id) => {
      const res = await fetch(`${API_BASE}/users/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      return readResponse(res, "Delete user");
    },
  },

  functions: {
    /**
     * @param {string} name
     * @param {Record<string, unknown>} [params]
     * @returns {Promise<unknown>}
     */
    call: async (name, params = {}) => {
      /** @type {Record<string, unknown>} */
      const registry = api.functions;
      const fn = registry[name];
      if (typeof fn === 'function') return fn(params);
      console.warn(`No local function endpoint mapped for "${name}"`, params);
      return { success: false, message: `Function "${name}" is not implemented locally.` };
    },

    /** @param {Record<string, unknown>} params */
    logUserInApp: async (params) => {
      console.log("Local logUserInApp:", params);
      return { success: true };
    },
  },

  appLogs: {
    /** @param {string} page */
    logUserInApp: async (page) => {
      console.log(`Local app log: ${page}`);
      return { success: true };
    },
  },

  kpis: async () => {
    const res = await fetch(`${API_BASE}/kpis`, { credentials: 'include' });
    return readResponse(res, 'KPIs');
  },

  records: {
    /** @param {{ search?: string, flagColor?: string, limit?: number, offset?: number }} [opts] */
    search: async ({ search = '', flagColor = 'all', limit = 50, offset = 0 } = {}) => {
      const params = new URLSearchParams();
      if (search?.trim()) params.set('search', search.trim());
      if (flagColor && flagColor !== 'all') params.set('flag_color', flagColor);
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      const res = await fetch(`${API_BASE}/datarecord/search?${params.toString()}`, {
        credentials: 'include',
      });
      return readResponse(res, 'Search records');
    },

    /** @param {string} query */
    customerLookup: async (query) => {
      const params = new URLSearchParams();
      if (query?.trim()) params.set('query', query.trim());
      const res = await fetch(`${API_BASE}/datarecord/customer-lookup?${params.toString()}`, {
        credentials: 'include',
      });
      return readResponse(res, 'Customer lookup');
    },

    /** @param {{ query?: string, limit?: number }} [opts] */
    customerLookupSuggestions: async ({ query = '', limit = 5 } = {}) => {
      const params = new URLSearchParams();
      if (query?.trim()) params.set('query', query.trim());
      params.set('limit', String(limit));
      const res = await fetch(`${API_BASE}/datarecord/customer-lookup/suggestions?${params.toString()}`, {
        credentials: 'include',
      });
      return readResponse(res, 'Customer lookup suggestions');
    },

    flagCounts: async () => {
      const res = await fetch(`${API_BASE}/datarecord/flag-counts`, {
        credentials: 'include',
      });
      return readResponse(res, 'Record flag counts');
    },
  },

  /** @param {string | number} connectionId */
  importData: async (connectionId) => {
    const res = await fetch(`${API_BASE}/import/${connectionId}`, {
      method: "POST",
      credentials: "include",
    });
    return readResponse(res, "Import data", { connectionId });
  },
};
