/**
 * Subprocess probe for real Node unhandledRejection + AsyncLocalStorage context.
 * Kept as a real .mts file so CI does not depend on `node --eval` ESM named-import
 * interop for TypeScript sources (flaky under Node 22 + tsx without package "type":"module").
 */
import {
  getRuntimeRejectionContext,
  handleUnhandledRejection,
  runMcpRequest,
} from "../../src/selfhost/process-errors.ts";

const mode = process.argv[2] === "mcp" ? "mcp" : "bare";
const result: {
  context?: ReturnType<typeof getRuntimeRejectionContext>;
  disposition?: string;
  exitCode?: number;
} = {};

process.once("unhandledRejection", (reason) => {
  result.context = getRuntimeRejectionContext();
  result.disposition = handleUnhandledRejection(reason, {
    warn() {},
    error() {},
    exit(code) {
      result.exitCode = code;
    },
  });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result));
});

if (mode === "mcp") {
  runMcpRequest("req-real-path", () => {
    void Promise.reject(null);
  });
} else {
  void Promise.reject(null);
}

setTimeout(() => {}, 20);
