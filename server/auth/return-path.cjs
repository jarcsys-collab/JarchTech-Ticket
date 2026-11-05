// The only places sign-in may return to: the app's own link to one request. An exact pattern rather than a "looks local"
// check, so another site, a protocol-relative address, a backslash, or an encoded trick can never be a redirect target.
const RETURN_PATH = /^\/\?request=JRC-\d{1,9}(?:&change=CR-\d{1,9})?$/;

const safeReturnPath = value => (typeof value === 'string' && value.length <= 64 && RETURN_PATH.test(value) ? value : null);
const requestPath = (ticket, change) => `/?request=${ticket}${change ? `&change=${change}` : ''}`;

module.exports = { requestPath, safeReturnPath };
