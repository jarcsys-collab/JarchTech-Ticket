// Attachment limits, allowed file types, and safe file names for the shared beta workspace. Shared by the browser
// (early checks and messages) and the server, which enforces them and also checks each file's actual content.
(function (root) {
  const MB = 1024 * 1024;
  const MAX_FILE_BYTES = 10 * MB;
  const MAX_PER_SUBMISSION = 5;
  const NAME_MAX = 120;
  // Extension -> served type and content check. Anything else (including SVG, HTML, scripts, executables,
  // archives, and macro-enabled Office files) is refused.
  const TYPES = {
    png: { mime: 'image/png', check: 'png' },
    jpg: { mime: 'image/jpeg', check: 'jpeg' },
    jpeg: { mime: 'image/jpeg', check: 'jpeg' },
    gif: { mime: 'image/gif', check: 'gif' },
    webp: { mime: 'image/webp', check: 'webp' },
    pdf: { mime: 'application/pdf', check: 'pdf' },
    txt: { mime: 'text/plain; charset=utf-8', check: 'text' },
    log: { mime: 'text/plain; charset=utf-8', check: 'text' },
    csv: { mime: 'text/csv; charset=utf-8', check: 'text' },
    docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', check: 'ooxml', part: 'word/' },
    xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', check: 'ooxml', part: 'xl/' },
    pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', check: 'ooxml', part: 'ppt/' }
  };
  const EXTENSIONS = Object.keys(TYPES);
  const ACCEPT = EXTENSIONS.map(x => '.' + x).join(',');
  const SUMMARY = `Up to ${MAX_PER_SUBMISSION} files, ${MAX_FILE_BYTES / MB} MB each: PNG, JPEG, GIF, WebP, PDF, TXT, LOG, CSV, DOCX, XLSX, or PPTX.`;

  // Keeps the visible name but removes paths, control characters, and characters that are unsafe in file names
  // or headers. Returns '' when nothing usable is left.
  function safeName(raw) {
    let name = String(raw ?? '').normalize('NFC').split(/[\\/]/).pop();
    name = name.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '')
      .replace(/[<>:"|?*%;]/g, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
    if (name.length > NAME_MAX) {
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : '';
      name = name.slice(0, NAME_MAX - ext.length).trim() + ext;
    }
    return name;
  }
  function extension(name) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
    return m ? m[1].toLowerCase() : '';
  }
  // Early check of a chosen file (name and size). Returns an error message or ''.
  function precheck(name, size) {
    const safe = safeName(name);
    if (!safe) return 'This file name cannot be used. Rename the file and try again.';
    if (!TYPES[extension(safe)]) return `${safe}: this file type is not allowed. ${SUMMARY}`;
    if (!size) return `${safe} is empty.`;
    if (size > MAX_FILE_BYTES) return `${safe} is larger than ${MAX_FILE_BYTES / MB} MB.`;
    return '';
  }
  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < MB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / MB).toFixed(1)} MB`;
  }

  const api = { MAX_FILE_BYTES, MAX_PER_SUBMISSION, NAME_MAX, TYPES, EXTENSIONS, ACCEPT, SUMMARY, safeName, extension, precheck, formatSize };
  if (typeof module !== 'undefined') module.exports = api;
  else root.AttachmentRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
