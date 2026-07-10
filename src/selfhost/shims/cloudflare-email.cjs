/** Stub for `cloudflare:email` (unused by Second Brain self-host). */

class EmailMessage {
  constructor() {
    throw new Error("cloudflare:email is not available on self-host");
  }
}

module.exports = {
  EmailMessage,
  // some packages import named helpers
  ForwardableEmailMessage: EmailMessage,
};
