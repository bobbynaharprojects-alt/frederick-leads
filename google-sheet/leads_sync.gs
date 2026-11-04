/**
 * Frederick Leads - Google Sheet sync
 *
 * Pulls top_properties.csv from the private GitHub repository into the
 * "Leads" tab of this Google Sheet.
 *
 *   - New properties are added with Status "New".
 *   - Existing properties get fresh data, but the tracking columns
 *     (Status, Owner name, Notes, First contacted, Follow-up date) are NEVER changed.
 *   - Properties that leave the top 200 stay in the sheet, marked
 *     "No" in "In current top 200".
 *
 * Runs automatically on the 16th of each month (the day after GitHub's
 * monthly refresh), or any time from the menu: Frederick Leads > Update now.
 *
 * Install: Extensions > Apps Script, paste this whole file, save,
 * reload the sheet, then Frederick Leads > Set up (first time).
 */

// ============================================================================
// SETTINGS
// ============================================================================

const GITHUB_OWNER = 'bobbynaharprojects-alt';
const GITHUB_REPO = 'frederick-leads';
const CSV_PATH = 'top_properties.csv';

const SYNC_DAY_OF_MONTH = 16;  // day of the month the automatic update runs
const SYNC_HOUR = 8;           // hour of the day (sheet's time zone)

const STATUS_OPTIONS = [
  'New', 'Researching', 'Letter sent', 'Contacted',
  'Follow up', 'Not interested', 'Deal',
];

// ============================================================================
// Below this line is the machinery. You should not need to change it.
// ============================================================================

const LEADS_TAB = 'Leads';
const LOG_TAB = 'Sync log';
const INSTRUCTIONS_TAB = 'Instructions';
const INSTRUCTIONS_PATH = 'google-sheet/instructions.txt';
const TABS_PATH = 'google-sheet/tabs.json';
const KEY_HEADER = 'Account ID';
const TOKEN_PROPERTY = 'GITHUB_TOKEN';

// Columns you fill in. The sync never writes to these on existing rows.
const TRACKING_HEADERS = ['Status', 'Owner name', 'Notes', 'First contacted', 'Follow-up date'];

// Sheet column -> how to get its value from a CSV row.
const DATA_COLUMNS = [
  ['Property address', r => r.property_address],
  ['City', r => r.property_city],
  ['Score', r => toNumber(r.distress_score)],
  // tracking columns go here (see COLUMN_ORDER)
  ['Absentee', r => yesBlank(r.absentee_owner)],
  ['Out of state', r => yesBlank(r.out_of_state_owner)],
  ['Long-time owner', r => yesBlank(r.long_time_owner)],
  ['High equity', r => yesBlank(r.likely_high_equity)],
  ['Older home', r => yesBlank(r.older_home)],
  ['Mailing address', r => r.mailing_address],
  ['Mailing city', r => r.mailing_city],
  ['Mailing state', r => r.mailing_state],
  ['Mailing ZIP', r => r.mailing_zip],
  ['Assessed value', r => toNumber(r.assessed_value)],
  ['Last sale date', r => toDate(r.last_sale_date)],
  ['Last sale price', r => toNumber(r.last_sale_price)],
  ['Years since sale', r => toNumber(r.years_since_sale)],
  ['Year built', r => toNumber(r.year_built)],
  ['Owner-occupied code', r => r.owner_occupied_code],
  ['Land use', r => r.land_use],
  ['Property ZIP', r => r.property_zip],
  [KEY_HEADER, r => r.acct_id],
  ['SDAT link', r => r.sdat_link],
];
const SYSTEM_HEADERS = ['In current top 200', 'First added', 'Last updated'];

const COLUMN_ORDER = [
  'Property address', 'City', 'Score',
  ...TRACKING_HEADERS,
  ...DATA_COLUMNS.map(c => c[0]).filter(h => !['Property address', 'City', 'Score'].includes(h)),
  ...SYSTEM_HEADERS,
];
const TEXT_HEADERS = ['Mailing ZIP', 'Property ZIP', KEY_HEADER];
const DATE_HEADERS = ['Last sale date', 'First contacted', 'Follow-up date', 'First added', 'Last updated'];
const MONEY_HEADERS = ['Assessed value', 'Last sale price'];

function yesBlank(v) { return String(v).trim() === '1' ? 'Yes' : ''; }

function toNumber(v) {
  const s = String(v == null ? '' : v).trim();
  return s === '' || isNaN(Number(s)) ? '' : Number(s);
}

function toDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : '';
}

/** Turns parsed CSV (array of arrays, first row = headers) into objects. */
function csvToRecords(table) {
  const header = table[0].map(h => String(h).trim());
  if (!header.includes('acct_id')) throw new Error('The CSV has no acct_id column.');
  return table.slice(1)
    .filter(row => row.some(cell => String(cell).trim() !== ''))
    .map(row => Object.fromEntries(header.map((h, i) => [h, row[i] == null ? '' : row[i]])));
}

/**
 * The core merge, with no Google calls so it can be tested on its own.
 *
 * headers: the sheet's current header row ([] for an empty sheet)
 * rows:    the sheet's current data rows (arrays, same order as headers)
 * Returns the headers to use, the column values for existing rows, and the new rows.
 * Tracking columns of existing rows are never part of what gets written.
 */
function mergeLeads(headers, rows, records, today) {
  headers = headers.filter(h => String(h).trim() !== '');
  if (headers.length === 0) headers = COLUMN_ORDER.slice();
  COLUMN_ORDER.forEach(h => { if (!headers.includes(h)) headers.push(h); });  // add any missing columns
  const col = Object.fromEntries(headers.map((h, i) => [h, i]));
  const width = headers.length;

  const byId = new Map();
  records.forEach(r => byId.set(String(r.acct_id).trim(), r));

  const seen = new Set();
  // Only the script's own data columns are ever rewritten; tracking columns and
  // any columns you add yourself are left alone.
  const writable = [...DATA_COLUMNS.map(c => c[0]), 'In current top 200', 'Last updated'];
  const existing = rows.map(row => {
    const out = row.slice();
    while (out.length < width) out.push('');
    const id = String(out[col[KEY_HEADER]]).trim();
    const rec = byId.get(id);
    if (rec) {
      seen.add(id);
      DATA_COLUMNS.forEach(([h, get]) => { out[col[h]] = get(rec); });
      out[col['In current top 200']] = 'Yes';
      out[col['Last updated']] = today;
    } else if (id) {
      out[col['In current top 200']] = 'No';
    }
    return out;
  });

  const added = [];
  records.forEach(rec => {
    const id = String(rec.acct_id).trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const out = new Array(width).fill('');
    DATA_COLUMNS.forEach(([h, get]) => { out[col[h]] = get(rec); });
    out[col['Status']] = 'New';
    out[col['In current top 200']] = 'Yes';
    out[col['First added']] = today;
    out[col['Last updated']] = today;
    added.push(out);
  });

  return {
    headers,
    writableHeaders: writable,
    existing,
    added,
    counts: {
      added: added.length,
      updated: existing.filter(r => r[col['In current top 200']] === 'Yes').length,
      notInTop: existing.filter(r => r[col['In current top 200']] === 'No').length,
    },
  };
}

// ----------------------------------------------------------------------------
// Google Sheets side
// ----------------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Frederick Leads')
    .addItem('Update now', 'syncLeads')
    .addItem('Refresh instructions and tabs', 'refreshExtras')
    .addSeparator()
    .addItem('Set up (first time)', 'setup')
    .addItem('Change GitHub token', 'promptForToken')
    .addToUi();
}

function setup() {
  const ui = SpreadsheetApp.getUi();
  if (!PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY)) {
    if (!promptForToken()) return;
  }
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'syncLeads')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('syncLeads').timeBased()
    .onMonthDay(SYNC_DAY_OF_MONTH).atHour(SYNC_HOUR).create();
  const result = syncLeads();
  if (result) {
    ui.alert('Setup complete',
      `Loaded ${result.added} properties.\n\nThe sheet will update automatically on day ` +
      `${SYNC_DAY_OF_MONTH} of each month. Use Frederick Leads > Update now any time.`,
      ui.ButtonSet.OK);
  }
}

function promptForToken() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('GitHub token',
    'Paste the GitHub token (it starts with github_pat_). It is stored only in this sheet\'s script.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return false;
  const token = res.getResponseText().trim();
  if (!token) return false;
  PropertiesService.getScriptProperties().setProperty(TOKEN_PROPERTY, token);
  return true;
}

function fetchCsv() {
  return Utilities.parseCsv(fetchGithubFile(CSV_PATH));
}

function fetchGithubFile(path) {
  const token = PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY);
  if (!token) throw new Error('No GitHub token saved. Use Frederick Leads > Set up (first time).');
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}?ref=main`;
  const resp = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github.raw+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code === 401) throw new Error('GitHub rejected the token (it may have expired). Use Frederick Leads > Change GitHub token.');
  if (code === 404) throw new Error('GitHub could not find the file, or the token has no access to the repository.');
  if (code !== 200) throw new Error(`GitHub returned an error (${code}).`);
  return resp.getContentText();
}

/**
 * Turns instructions.txt into rows for the Instructions tab.
 * "# " = title, "## " = section heading, anything else = a normal line.
 */
function instructionLines(text) {
  return text.split(/\r?\n/).map(line => {
    if (line.startsWith('## ')) return { text: line.slice(3), style: 'heading' };
    if (line.startsWith('# ')) return { text: line.slice(2), style: 'title' };
    return { text: line, style: 'normal' };
  });
}

/** Rebuilds the Instructions tab and creates or extends the tabs listed in tabs.json. */
function refreshExtras() {
  buildTabs();
  writeInstructions();
}

/**
 * Works out the header row for a tab: existing headers stay where they are
 * (including any you added yourself); columns from the layout that are
 * missing get added at the end. Returns the new header row.
 */
function planHeaders(existing, columns) {
  const headers = existing.map(h => String(h).trim());
  while (headers.length && headers[headers.length - 1] === '') headers.pop();  // drop trailing blanks only
  columns.forEach(c => { if (!headers.includes(c.name)) headers.push(c.name); });
  return headers;
}

function buildTabs() {
  const spec = JSON.parse(fetchGithubFile(TABS_PATH));
  const ss = SpreadsheetApp.getActive();
  (spec.tabs || []).forEach(tab => buildTab(ss, tab));
}

function buildTab(ss, tab) {
  let sheet = ss.getSheetByName(tab.name);
  const isNew = !sheet;
  if (isNew) {
    const anchor = tab.after && ss.getSheetByName(tab.after);
    sheet = anchor ? ss.insertSheet(tab.name, anchor.getIndex()) : ss.insertSheet(tab.name);
  }
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const headers = planHeaders(existing, tab.columns);
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setWrap(true);

  const rows = sheet.getMaxRows() - 1;
  tab.columns.forEach(c => {
    const col = headers.indexOf(c.name) + 1;
    const head = sheet.getRange(1, col);
    const body = sheet.getRange(2, col, rows, 1);
    head.setNote(c.note || '').setBackground(c.auto ? '#e7f1fb' : '#f9eeda');
    if (c.width) sheet.setColumnWidth(col, c.width);
    if (c.type === 'list') {
      body.setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(c.options, true).setAllowInvalid(true).build());
    } else if (c.type === 'date') {
      body.setDataValidation(SpreadsheetApp.newDataValidation()
        .requireDate().setAllowInvalid(true).build());
      body.setNumberFormat('yyyy-mm-dd');
    } else {
      body.setNumberFormat('@');
    }
  });

  if (isNew) sheet.setFrozenRows(1);
  const filter = sheet.getFilter();
  if (filter && filter.getRange().getNumColumns() < headers.length) filter.remove();  // widen it for new columns
  if (!sheet.getFilter()) sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).createFilter();
}

function writeInstructions() {
  const ss = SpreadsheetApp.getActive();
  const lines = instructionLines(fetchGithubFile(INSTRUCTIONS_PATH));
  let sheet = ss.getSheetByName(INSTRUCTIONS_TAB);
  if (!sheet) sheet = ss.insertSheet(INSTRUCTIONS_TAB, 0);
  sheet.clear();
  const range = sheet.getRange(1, 1, lines.length, 1);
  range.setNumberFormat('@').setValues(lines.map(l => [l.text]))
    .setWrap(true).setVerticalAlignment('top').setFontSize(11).setFontWeight('normal');
  lines.forEach((l, i) => {
    if (l.style === 'title') sheet.getRange(i + 1, 1).setFontSize(16).setFontWeight('bold');
    if (l.style === 'heading') sheet.getRange(i + 1, 1).setFontSize(12).setFontWeight('bold').setBackground('#f0efec');
  });
  sheet.setColumnWidth(1, 820);
  sheet.setHiddenGridlines(true);
  if (sheet.getMaxColumns() > 1) sheet.hideColumns(2, sheet.getMaxColumns() - 1);
}

function syncLeads() {
  const ss = SpreadsheetApp.getActive();
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return null;
  try {
    const records = csvToRecords(fetchCsv());
    if (records.length === 0) throw new Error('The CSV from GitHub has no properties in it.');

    let sheet = ss.getSheetByName(LEADS_TAB);
    if (!sheet) {
      sheet = ss.getSheets()[0];
      if (sheet.getLastRow() > 0 || ss.getSheets().length > 1) sheet = ss.insertSheet(LEADS_TAB);
      sheet.setName(LEADS_TAB);
    }
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const current = lastRow > 0 ? sheet.getRange(1, 1, lastRow, lastCol).getValues() : [];
    const headers = current.length ? current[0].map(String) : [];
    const rows = current.slice(1);
    const firstTime = headers.filter(h => h.trim() !== '').length === 0;

    const today = new Date();
    const m = mergeLeads(headers, rows, records, today);
    const width = m.headers.length;
    if (sheet.getMaxColumns() < width) sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());

    // Header row (only adds missing headers; existing ones are unchanged).
    sheet.getRange(1, 1, 1, width).setValues([m.headers]);

    // Text format first, so ZIP codes and account IDs keep leading zeros.
    TEXT_HEADERS.forEach(h => sheet.getRange(2, m.headers.indexOf(h) + 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@'));

    // Existing rows: write data columns one at a time, skipping tracking columns.
    if (m.existing.length) {
      m.writableHeaders.forEach(h => {
        const c = m.headers.indexOf(h);
        sheet.getRange(2, c + 1, m.existing.length, 1).setValues(m.existing.map(r => [r[c]]));
      });
    }
    // New rows go at the bottom.
    if (m.added.length) {
      sheet.getRange(rows.length + 2, 1, m.added.length, width).setValues(m.added);
    }

    if (firstTime) formatSheet(sheet, m.headers);
    let note = 'OK';
    try {
      refreshExtras();
    } catch (e) {
      note = 'OK (instructions/tabs not refreshed: ' + e.message + ')';  // the leads update still counts
    }
    log(ss, today, m.counts, note);
    return m.counts;
  } catch (err) {
    log(ss, new Date(), null, 'FAILED: ' + err.message);
    throw err;  // shows the error, and Google emails you if an automatic run fails
  } finally {
    lock.releaseLock();
  }
}

function formatSheet(sheet, headers) {
  const maxRows = sheet.getMaxRows() - 1;
  const colOf = h => headers.indexOf(h) + 1;
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f0efec').setWrap(true);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);

  sheet.getRange(2, colOf('Status'), maxRows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(STATUS_OPTIONS, true).setAllowInvalid(false).build());
  ['First contacted', 'Follow-up date'].forEach(h =>
    sheet.getRange(2, colOf(h), maxRows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()));
  DATE_HEADERS.forEach(h => sheet.getRange(2, colOf(h), maxRows, 1).setNumberFormat('yyyy-mm-dd'));
  MONEY_HEADERS.forEach(h => sheet.getRange(2, colOf(h), maxRows, 1).setNumberFormat('$#,##0'));

  // Tracking columns get a light yellow background so they stand out.
  TRACKING_HEADERS.forEach(h => sheet.getRange(1, colOf(h), 1, 1).setBackground('#f9eeda'));
  sheet.setColumnWidth(colOf('Property address'), 200);
  sheet.setColumnWidth(colOf('Notes'), 260);
  sheet.setColumnWidth(colOf('Mailing address'), 220);

  // Filter covers the whole sheet, so rows added in later months are included.
  if (!sheet.getFilter()) sheet.getRange(1, 1, sheet.getMaxRows(), headers.length).createFilter();
}

function log(ss, when, counts, message) {
  let sheet = ss.getSheetByName(LOG_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_TAB);
    sheet.appendRow(['When', 'Added', 'Updated', 'No longer in top 200', 'Result']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([when, counts ? counts.added : '', counts ? counts.updated : '',
                   counts ? counts.notInTop : '', message]);
}
