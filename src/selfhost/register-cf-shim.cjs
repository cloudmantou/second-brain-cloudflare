/**
 * Preload: map `cloudflare:workers` → local shim so Node can import Worker code.
 * Used as: node --require ./src/selfhost/register-cf-shim.cjs ...
 */

const path = require("node:path");
const Module = require("node:module");

const SHIMS = {
  "cloudflare:workers": path.join(__dirname, "shims", "cloudflare-workers.cjs"),
  "cloudflare:email": path.join(__dirname, "shims", "cloudflare-email.cjs"),
};

const original = Module._resolveFilename;

Module._resolveFilename = function resolveFilename(request, parent, isMain, options) {
  if (Object.prototype.hasOwnProperty.call(SHIMS, request)) {
    return SHIMS[request];
  }
  return original.call(this, request, parent, isMain, options);
};
