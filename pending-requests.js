'use strict';
// Browser-side timeouts do not release broker references. This map bounds the
// lifetime of unanswered update/pull requests and drops a disconnected owner.
class PendingRequests extends Map {
  constructor(timeout = 30000) {
    super();
    this.timeout = timeout;
    this.expiry = new Map();
  }
  set(key, value) {
    this.delete(key);
    super.set(key, value);
    const timer = setTimeout(() => this.delete(key), this.timeout);
    timer.unref();
    this.expiry.set(key, timer);
    return this;
  }
  delete(key) {
    clearTimeout(this.expiry.get(key));
    this.expiry.delete(key);
    return super.delete(key);
  }
  clear() {
    for (const key of this.keys()) this.delete(key);
  }
  forgetSocket(socket) {
    for (const [key, value] of this) if (value === socket || value.ws === socket) this.delete(key);
  }
}
module.exports = { PendingRequests };
