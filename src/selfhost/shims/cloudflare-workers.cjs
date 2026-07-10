/**
 * Minimal stub for the Cloudflare Workers runtime module so packages like
 * `agents` / `partyserver` can load under Node for self-host.
 * Durable Objects / Workflows are not used by Second Brain MCP path.
 */

class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

class WorkflowEntrypoint {}
class RpcTarget {}

module.exports = {
  DurableObject,
  WorkflowEntrypoint,
  RpcTarget,
  env: new Proxy(
    {},
    {
      get() {
        return undefined;
      },
    }
  ),
};
