// Attachments: screenshots and supporting files on tickets, for My workspace (bucket "files", records in
// "attachments") and the beta simulation (bucket "beta_files", records in "beta_attachments"). File bytes are stored in
// MongoDB GridFS in the configured database, so they survive Railway redeployments without a container volume or
// another storage service. Each workspace has its own bucket and records:
//   pending  uploaded, not yet part of a ticket; only the uploader can see, download, or remove it
//   claimed  being added to a ticket or comment by the request in flight (returns to pending if that save fails)
//   attached part of a ticket's activity; downloadable by whoever may see that ticket (canSeeTicket)
// Pending and claimed uploads older than PENDING_TTL_MS are abandoned and swept (file and record deleted).
// Content is checked on the server (type signature, text encoding, Office package parts); there is no malware scan.
// Downloads are always served as attachments with nosniff and a sandboxing CSP, so nothing runs in the app's origin.
const { GridFSBucket, ObjectId } = require('mongodb');
const Rules = require('../../public/attachment-rules.js');

const BUCKET = 'beta_files';
const WORKSPACE_QUOTA_BYTES = 200 * 1024 * 1024; // per workspace, all files together, to stay well inside the database plan
const MAX_PENDING_PER_USER = 20;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const ID = /^[0-9a-f]{24}$/;
const SIGNATURES = {
  png: b => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpeg: b => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  gif: b => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  webp: b => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  pdf: b => b.length >= 5 && b.subarray(0, 5).toString('latin1') === '%PDF-',
  ooxml: b => b.length >= 4 && b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
};

class AttachmentError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const notAllowed = name => new AttachmentError(415, 'invalid-content', `${name} does not look like the file type its name says. ${Rules.SUMMARY}`);

// Checks the bytes of one upload as they arrive. Throws AttachmentError on the first problem.
function inspector(type, name) {
  let size = 0, head = Buffer.alloc(0), tail = '';
  const decoder = type.check === 'text' ? new TextDecoder('utf-8', { fatal: true }) : null;
  const markers = type.check === 'ooxml' ? { '[Content_Types].xml': false, [type.part]: false, 'vbaProject.bin': false } : null;
  const checkHead = () => { if (!decoder && !SIGNATURES[type.check](head)) throw notAllowed(name); };
  return {
    get size() { return size; },
    push(chunk) {
      size += chunk.length;
      if (size > Rules.MAX_FILE_BYTES) throw new AttachmentError(413, 'file-too-large', `${name} is larger than ${Rules.MAX_FILE_BYTES / 1048576} MB.`);
      if (head.length < 16) { head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]); if (head.length >= 16) checkHead(); }
      if (decoder) {
        if (chunk.includes(0)) throw notAllowed(name);
        try { decoder.decode(chunk, { stream: true }); } catch { throw notAllowed(name); }
      }
      if (markers) {
        const text = tail + chunk.toString('latin1');
        for (const m of Object.keys(markers)) if (!markers[m] && text.includes(m)) markers[m] = true;
        tail = text.slice(-32);
      }
    },
    end() {
      if (!size) throw new AttachmentError(400, 'empty-file', `${name} is empty.`);
      if (head.length < 16) checkHead();
      if (decoder) { try { decoder.decode(); } catch { throw notAllowed(name); } }
      if (markers && (!markers['[Content_Types].xml'] || !markers[type.part])) throw notAllowed(name);
      if (markers && markers['vbaProject.bin']) throw new AttachmentError(415, 'macros-not-allowed', `${name} contains macros, which are not allowed.`);
    }
  };
}

// "report.pdf" -> Content-Disposition with an ASCII fallback and the exact UTF-8 name.
function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

// names: { attachments, bucket, tickets } collection names. canSeeTicket(actor, ticketId) decides who may download
// an attached file; uploads that are not yet part of a ticket are only ever the uploader's.
function createAttachments({ db, workspace, names = { attachments: 'beta_attachments', bucket: BUCKET, tickets: 'beta_tickets' }, canSeeTicket = async () => true, log = console, now = () => new Date() }) {
  const files = db.collection(names.attachments);
  const bucket = new GridFSBucket(db, { bucketName: names.bucket });
  const fileDocs = db.collection(`${names.bucket}.files`), chunks = db.collection(`${names.bucket}.chunks`);
  const publicFile = d => ({ id: d._id.toHexString(), name: d.name, size: d.size, type: d.ext });
  const oid = id => { if (!ID.test(String(id || ''))) throw new AttachmentError(404, 'not-found', 'That attachment does not exist.'); return new ObjectId(id); };
  let lastSweep = 0;

  async function removeFile(id) {
    try { await bucket.delete(id); } catch (err) { if (!/FileNotFound|not found/i.test(err.message)) throw err; }
  }

  // Streams one request body into GridFS while checking it. The name comes from the X-File-Name header
  // (URL-encoded); the type comes from the name's extension and must match the content.
  async function upload(req, actor) {
    sweepSoon();
    let raw = '';
    try { raw = decodeURIComponent(String(req.headers['x-file-name'] || '')); } catch {}
    const name = Rules.safeName(raw);
    if (!name) throw new AttachmentError(400, 'invalid-name', 'This file name cannot be used. Rename the file and try again.');
    const ext = Rules.extension(name), type = Rules.TYPES[ext];
    if (!type) throw new AttachmentError(415, 'type-not-allowed', `${name}: this file type is not allowed. ${Rules.SUMMARY}`);
    const declared = req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
    if (declared !== null && declared > Rules.MAX_FILE_BYTES) throw new AttachmentError(413, 'file-too-large', `${name} is larger than ${Rules.MAX_FILE_BYTES / 1048576} MB.`);
    const uid = String(actor._id);
    if (await files.countDocuments({ workspace, uploadedBy: uid, state: 'pending' }) >= MAX_PENDING_PER_USER) {
      throw new AttachmentError(429, 'too-many-pending', 'You have too many uploads that are not yet part of a ticket. Submit or remove them first.');
    }
    const [usage] = await files.aggregate([{ $match: { workspace } }, { $group: { _id: null, bytes: { $sum: '$size' } } }]).toArray();
    if ((usage?.bytes || 0) + (declared || 0) > WORKSPACE_QUOTA_BYTES) {
      throw new AttachmentError(507, 'quota-exceeded', 'This workspace has reached its attachment storage limit. Ask an Admin for help.');
    }

    const id = new ObjectId();
    const check = inspector(type, name);
    const stream = bucket.openUploadStreamWithId(id, name, { metadata: { workspace, uploadedBy: uid } });
    try {
      await new Promise((resolve, reject) => {
        let done = false;
        const fail = err => { if (!done) { done = true; reject(err); } };
        req.on('data', chunk => {
          if (done) return;
          try { check.push(chunk); } catch (err) { return fail(err); }
          if (!stream.write(chunk)) { req.pause(); stream.once('drain', () => req.resume()); }
        });
        req.on('end', () => {
          if (done) return;
          try { check.end(); } catch (err) { return fail(err); }
          stream.end();
        });
        req.on('close', () => { if (!req.complete) fail(new AttachmentError(400, 'upload-interrupted', 'The upload was interrupted. Try again.')); });
        req.on('error', () => fail(new AttachmentError(400, 'upload-interrupted', 'The upload was interrupted. Try again.')));
        stream.on('error', fail);
        stream.on('finish', () => { if (!done) { done = true; resolve(); } });
      });
    } catch (err) {
      try { await stream.abort(); } catch {}
      await removeFile(id).catch(() => {});
      throw err;
    }
    const at = now();
    const doc = { _id: id, workspace, name, ext, size: check.size, state: 'pending', uploadedBy: uid, uploaderName: actor.displayName || actor.email, uploadedAt: at, expiresAt: new Date(at.getTime() + PENDING_TTL_MS), ticket: null };
    try { await files.insertOne(doc); }
    catch (err) { await removeFile(id).catch(() => {}); throw err; }
    return { attachment: { ...publicFile(doc), state: 'pending' } };
  }

  async function download(req, res, actor, id) {
    const doc = await files.findOne({ _id: oid(id), workspace });
    // Uploads that are not yet part of a ticket are private to their uploader; say "not found" either way.
    const allowed = doc && (doc.state === 'attached' ? await canSeeTicket(actor, doc.ticket) : doc.uploadedBy === String(actor._id));
    if (!allowed) throw new AttachmentError(404, 'not-found', 'That attachment does not exist or is no longer available.');
    res.writeHead(200, {
      'Content-Type': Rules.TYPES[doc.ext].mime,
      'Content-Length': doc.size,
      'Content-Disposition': disposition(doc.name),
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store'
    });
    if (req.method === 'HEAD') return res.end();
    await new Promise(resolve => {
      const source = bucket.openDownloadStream(doc._id);
      source.on('error', err => { log.error(`Beta attachment ${id} could not be read: ${err.name}`); res.destroy(); resolve(); });
      res.on('close', () => { source.destroy(); resolve(); });
      source.pipe(res);
    });
  }

  // Removes an upload that is not yet part of a ticket (uploader only).
  async function remove(actor, id) {
    const doc = await files.findOneAndDelete({ _id: oid(id), workspace, uploadedBy: String(actor._id), state: 'pending' });
    if (!doc) throw new AttachmentError(404, 'not-found', 'That upload is already part of a ticket or no longer exists.');
    await removeFile(doc._id);
    return { removed: id };
  }

  // Reserves the actor's pending uploads for one save. Returns { token, list } (null when there are none).
  async function claim(actor, ids) {
    if (ids === undefined || ids === null || (Array.isArray(ids) && !ids.length)) return null;
    if (!Array.isArray(ids) || ids.length > Rules.MAX_PER_SUBMISSION || new Set(ids).size !== ids.length || !ids.every(x => ID.test(String(x)))) {
      throw new AttachmentError(400, 'invalid-attachments', `Attach up to ${Rules.MAX_PER_SUBMISSION} files at a time.`);
    }
    const token = new ObjectId().toHexString();
    const _ids = ids.map(x => new ObjectId(x));
    const { modifiedCount } = await files.updateMany({ _id: { $in: _ids }, workspace, uploadedBy: String(actor._id), state: 'pending' }, { $set: { state: 'claimed', claim: token } });
    if (modifiedCount !== ids.length) {
      await release({ token });
      throw new AttachmentError(409, 'attachment-unavailable', 'One or more attachments are no longer available. Remove them, upload again, and retry.');
    }
    const docs = await files.find({ claim: token }).toArray();
    return { token, list: ids.map(x => publicFile(docs.find(d => d._id.toHexString() === x))) };
  }
  async function finish(claimed, ticketId) {
    if (claimed) await files.updateMany({ claim: claimed.token }, { $set: { state: 'attached', ticket: ticketId, attachedAt: now() }, $unset: { claim: '', expiresAt: '' } });
  }
  async function release(claimed) {
    if (claimed) await files.updateMany({ claim: claimed.token, state: 'claimed' }, { $set: { state: 'pending' }, $unset: { claim: '' } });
  }

  // Deletes abandoned uploads: pending or claimed records past their expiry (a claimed record that a ticket already
  // references is completed instead), and GridFS files or chunks left without a record by an interrupted upload.
  async function sweep() {
    lastSweep = Date.now();
    const at = now();
    const cutoff = new Date(at.getTime() - PENDING_TTL_MS);
    let removed = 0;
    for (const doc of await files.find({ workspace, state: { $in: ['pending', 'claimed'] }, expiresAt: { $lt: at } }).limit(200).toArray()) {
      const used = doc.state === 'claimed' && await db.collection(names.tickets).findOne({ workspace, 'history.attachments.id': doc._id.toHexString() }, { projection: { id: 1 } });
      if (used) { await files.updateOne({ _id: doc._id }, { $set: { state: 'attached', ticket: used.id, attachedAt: at }, $unset: { claim: '', expiresAt: '' } }); continue; }
      if ((await files.deleteOne({ _id: doc._id, state: doc.state })).deletedCount) { await removeFile(doc._id); removed++; }
    }
    for (const f of await fileDocs.find({ 'metadata.workspace': workspace, uploadDate: { $lt: cutoff } }, { projection: { _id: 1 } }).limit(500).toArray()) {
      if (!await files.findOne({ _id: f._id }, { projection: { _id: 1 } })) { await removeFile(f._id); removed++; }
    }
    const oldIds = await chunks.distinct('files_id', { files_id: { $lt: ObjectId.createFromTime(Math.floor(cutoff.getTime() / 1000)) } });
    const orphans = [];
    for (const fid of oldIds) if (!await fileDocs.findOne({ _id: fid }, { projection: { _id: 1 } })) orphans.push(fid);
    if (orphans.length) await chunks.deleteMany({ files_id: { $in: orphans } });
    return { removed: removed + orphans.length };
  }
  function sweepSoon() {
    if (Date.now() - lastSweep < SWEEP_EVERY_MS) return;
    lastSweep = Date.now();
    sweep().catch(err => log.error(`Beta attachment cleanup failed: ${err.name}`));
  }

  // Beta reset: deletes every attachment record of this workspace and every file in its bucket. Nothing else.
  async function reset() {
    const ids = [...(await files.find({ workspace }, { projection: { _id: 1 } }).toArray()), ...(await fileDocs.find({ 'metadata.workspace': workspace }, { projection: { _id: 1 } }).toArray())].map(d => d._id);
    await files.deleteMany({ workspace });
    await fileDocs.deleteMany({ 'metadata.workspace': workspace });
    if (ids.length) await chunks.deleteMany({ files_id: { $in: ids } });
    return { removed: ids.length };
  }

  return { upload, download, remove, claim, finish, release, sweep, sweepSoon, reset };
}

module.exports = { AttachmentError, BUCKET, MAX_PENDING_PER_USER, PENDING_TTL_MS, WORKSPACE_QUOTA_BYTES, createAttachments, disposition, inspector };
