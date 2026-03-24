// app-params.js — lightweight URL/storage param helper
// Retained for any components that import appParams

const isNode = typeof window === 'undefined';

export const appParams = {
  appId: null,
  token: null,
  fromUrl: isNode ? null : window.location.href,
  functionsVersion: null,
  appBaseUrl: null,
};
