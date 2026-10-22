// Removes database credentials from text before it is logged or sent to a client.

// The username and password embedded in a MongoDB connection string, in both encoded and decoded form.
function secretsFromUri(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/([^@/]*)@/i.exec(uri || '');
  const secrets = uri ? [uri] : [];
  if (match) {
    for (const part of match[1].split(':')) {
      if (!part) continue;
      secrets.push(part);
      try { secrets.push(decodeURIComponent(part)); } catch {}
    }
  }
  return [...new Set(secrets)].filter(s => s.length >= 3).sort((a, b) => b.length - a.length);
}

function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) out = out.split(secret).join('<redacted>');
  // Any other connection string with credentials, for example from a driver error message.
  return out.replace(/(mongodb(?:\+srv)?:\/\/)[^@\s/]*@/gi, '$1<redacted>@');
}

module.exports = { redact, secretsFromUri };
