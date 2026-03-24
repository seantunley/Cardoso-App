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
          list: async () => {
            const res = await fetch(`${API_BASE}/${table}`, {
              credentials: "include",
            });
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

  importData: async (connectionId) => {
    const res = await fetch(`${API_BASE}/import/${connectionId}`, {
      method: "POST",
      credentials: "include",
    });
    return readResponse(res, "Import data", { connectionId });
  },
};
