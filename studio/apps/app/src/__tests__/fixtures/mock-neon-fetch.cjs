// Test-only preload (node --require): answers Neon HTTP SQL requests locally so the built
// studio app can run its live role re-read without any database. Everything else is untouched.
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url ?? String(input);
  if (/\/sql(\?|$)/.test(url)) {
    return new Response(
      JSON.stringify({
        command: "SELECT",
        rowCount: 1,
        fields: [
          { name: "status", dataTypeID: 25 },
          { name: "is_super_admin", dataTypeID: 16 },
          { name: "must_change_pin", dataTypeID: 16 },
        ],
        rows: [["active", "t", "f"]],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return real(input, init);
};
