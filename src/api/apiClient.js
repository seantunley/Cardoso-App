// src/api/apiClient.js — Cardoso App API client

const API_BASE = "/api";

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
            return readResponse(res, `List ${entityName}`);
          },

          get: async (id) => {
            const res = await fetch(`${API_BASE}/${table}/${id}`, {
              credentials: "include",
            });
            return readResponse(res, `Get ${entityName}`);
          },

          create: async (data) => {
            const res = await fetch(`${API_BASE}/${table}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify(data),
            });
            return readResponse(res, `Create ${entityName}`, data);
          },

          update: async (id, data) => {
            const res = await fetch(`${API_BASE}/${table}/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify(data),
            });
            return readResponse(res, `Update ${entityName}`, data);
          },

          delete: async (id) => {
            const res = await fetch(`${API_BASE}/${table}/${id}`, {
              method: "DELETE",
              credentials: "include",
            });
            return readResponse(res, `Delete ${entityName}`);
          },

          filter: async (filters = {}) => {
            const res = await fetch(`${API_BASE}/${table}`, {
              credentials: "include",
            });
            const rows = await readResponse(res, `Filter ${entityName}`, filters);

            return rows.filter((row) =>
              Object.entries(filters).every(([key, value]) => row[key] === value)
            );
          },

          subscribe: () => {
            console.log(`Local mode subscribe for ${entityName} is a no-op`);
            return () => {};
          },
        };
      },
    }
  ),

  auth: {
    me: async () => {
      const res = await fetch(`${API_BASE}/auth/me`, {
        method: "GET",
        credentials: "include",
      });
      return readResponse(res, "Get current user");
    },

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

    updateMe: async (data) => {
      const res = await fetch(`${API_BASE}/auth/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      return readResponse(res, 'Update profile', data);
    },

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
    list: async () => {
      const res = await fetch(`${API_BASE}/users`, {
        credentials: "include",
      });
      return readResponse(res, "List users");
    },

    create: async (data) => {
      const res = await fetch(`${API_BASE}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      return readResponse(res, "Create user", data);
    },

    updatePermissions: async (id, permissions) => {
      const res = await fetch(`${API_BASE}/users/${id}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(permissions),
      });
      return readResponse(res, "Update user permissions", permissions);
    },

    updatePassword: async (id, password) => {
      const res = await fetch(`${API_BASE}/users/${id}/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      return readResponse(res, "Update user password");
    },

    delete: async (id) => {
      const res = await fetch(`${API_BASE}/users/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      return readResponse(res, "Delete user");
    },
  },

  functions: {
    call: async (name, params = {}) => {
      const fn = api.functions[name];
      if (typeof fn === 'function') return fn(params);
      console.warn(`No local function endpoint mapped for "${name}"`, params);
      return { success: false, message: `Function "${name}" is not implemented locally.` };
    },

    logUserInApp: async (params) => {
      console.log("Local logUserInApp:", params);
      return { success: true };
    },
  },

  appLogs: {
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

    customerLookup: async (query) => {
      const params = new URLSearchParams();
      if (query?.trim()) params.set('query', query.trim());
      const res = await fetch(`${API_BASE}/datarecord/customer-lookup?${params.toString()}`, {
        credentials: 'include',
      });
      return readResponse(res, 'Customer lookup');
    },

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

  importData: async (connectionId) => {
    const res = await fetch(`${API_BASE}/import/${connectionId}`, {
      method: "POST",
      credentials: "include",
    });
    return readResponse(res, "Import data", { connectionId });
  },
};
