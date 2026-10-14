"use strict";

function respond(res, status, body) {
  const data = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": data.length });
  res.end(data);
}

/** JSON.parse that returns undefined instead of throwing. */
function parseJson(raw) {
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function logLine(fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

module.exports = { respond, parseJson, isPlainObject, logLine };
