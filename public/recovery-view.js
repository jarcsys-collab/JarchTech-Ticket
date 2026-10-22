/* Recovery screen shown when stored records cannot be loaded. Uses ui-common.js and TicketCore; app.js calls it from render().
   It never saves. The only storage change is TicketCore.reset after the user confirms. */
function recoveryView(r, store) {
  let why = { 'read-failed': 'Browser storage could not be read in this tab.', unreadable: 'The saved records in this browser are not readable data.', invalid: 'The saved records in this browser are missing required ticket fields.' }[r.reason];
  $('#new-ticket').disabled = true;
  $('.save').lastChild.textContent = ' Saving paused';
  $('.sidebar-bottom small').textContent = 'Saving paused until recovery';
  $('#nav').innerHTML = '';
  $('#page-title').textContent = 'Stored records need recovery';
  $('#page-description').textContent = 'Automatic saving is paused. Nothing has been changed or replaced.';
  $('#notice-count').textContent = 0;
  $('#app').innerHTML = `<section class="board" id="recovery"><div class="banner"><strong>${esc(why)}</strong>${r.error?`<br>Details: ${esc(r.error)}`:''}</div><p>${r.raw===null?'No records were changed.':`The original value is still stored under <code>${TicketCore.STORAGE_KEY}</code> and has not been modified.`}</p><p>${r.backupKey?`A copy of the exact stored value was also saved as <code>${esc(r.backupKey)}</code>.`:r.raw===null?'No backup was made because nothing could be read.':`A backup copy could not be created${r.backupError?` (${esc(r.backupError)})`:''}. Download a copy before resetting.`}</p><p>The app will not load sample data or save anything until you choose an action below.</p><div class="actions">${r.raw===null?'':'<button class="primary" id="download-raw">Download stored data</button>'}<button class="secondary" id="retry-load">Try again</button><button class="secondary danger" id="reset-storage">Reset and load sample data</button></div></section>`;

  if ($('#download-raw')) $('#download-raw').onclick = () => {
    let a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([r.raw], { type: 'text/plain' }));
    a.download = `${TicketCore.STORAGE_KEY}-recovery.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  };
  $('#retry-load').onclick = () => location.reload();
  $('#reset-storage').onclick = () => {
    if (!confirm(r.backupKey ? `Reset JarcTech Ticket records in this browser and load sample data?\n\nThe unreadable value stays in the backup ${r.backupKey}.` : `Reset JarcTech Ticket records in this browser and load sample data?\n\nNo backup copy exists. ${r.raw===null?'':'Unless you downloaded the stored data, it will be lost.'}`)) return;
    let res = TicketCore.reset(store);
    if (!res.ok) return toast('Could not reset browser storage: ' + res.error);
    location.reload();
  };
}
