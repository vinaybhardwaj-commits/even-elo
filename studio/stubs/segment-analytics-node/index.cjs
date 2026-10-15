class Analytics {
  constructor() {}
  track() {}
  identify() {}
  page() {}
  group() {}
  alias() {}
  screen() {}
  on() { return this; }
  closeAndFlush() { return Promise.resolve(); }
  flush() { return Promise.resolve(); }
}
module.exports = { Analytics };
