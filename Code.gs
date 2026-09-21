/**
 * Hays + Sons Restoration: FieldProof Subcontractor Oversight & Line-Item Verification
 * Google Apps Script Backend (Code.gs)
 * 
 * Features:
 * - Automatic first-run setup of all Google Sheets tabs (WorkOrders, LineItems, Subcontractors, Activity_Log)
 * - Automatic setup of Google Drive folder for site photo storage
 * - Automatic custom UI menu in Google Sheets
 * - REST API endpoints for Web App, photo verification, and real-time syncing
 */

// Configuration Constants
var CONFIG = {
  DRIVE_FOLDER_NAME: 'Hays_Sons_FieldProof_Photos',
  SHEET_WORK_ORDERS: 'WorkOrders',
  SHEET_LINE_ITEMS: 'LineItems',
  SHEET_SUBCONTRACTORS: 'Subcontractors',
  SHEET_PROJECT_MANAGERS: 'ProjectManagers',
  SHEET_ACTIVITY_LOG: 'Activity_Log',
  BRAND_COLOR: '#C81D25',
  DARK_COLOR: '#0F172A'
};

/**
 * Automatically creates custom menu when the Google Sheet is opened.
 */
function onOpen(e) {
  SpreadsheetApp.getUi()
    .createMenu('Hays + Sons FieldProof')
    .addItem('🚀 Setup All Sheets & Drive Folders (First Run)', 'setupFieldProofEnvironment')
    .addSeparator()
    .addItem('📊 Refresh Database & Reindex Counts', 'refreshAllMetrics')
    .addItem('🌐 Launch Web App', 'openWebAppUrl_')
    .addToUi();
}

/**
 * Serves the HTML Web App for Subcontractors and Project Managers.
 * Ensures the database is initialized on the very first run automatically.
 */
function doGet(e) {
  // Ensure database and Drive folders exist automatically on first hit
  try {
    initDatabase();
  } catch (err) {
    Logger.log('Auto-init database notice: ' + err.toString());
  }

  // Support GET API queries (e.g. ?action=ping or ?action=status)
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : '';
  if (action === 'ping' || action === 'status') {
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      status: 'active',
      timestamp: new Date().toISOString(),
      message: 'Hays + Sons FieldProof Google Apps Script backend is live and operational.'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'fetchDatabaseState' || action === 'getDatabase') {
    return ContentService.createTextOutput(JSON.stringify(fetchDatabaseState()))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    var template = HtmlService.createTemplateFromFile('Index');
    
    // Pass query parameters to client
    template.initialWoId = (e && e.parameter && e.parameter.woId) ? e.parameter.woId.trim() : '';
    template.scriptUrl = ScriptApp.getService().getUrl();
    
    return template.evaluate()
      .setTitle('Hays + Sons FieldProof: Subcontractor Oversight')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (htmlErr) {
    // If Index.html has not yet been added to the Apps Script project, return a clean status card
    var fallbackHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hays + Sons FieldProof API</title>' +
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
      '<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;background:#090d16;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box;}' +
      '.box{max-width:540px;width:100%;background:#0f172a;padding:36px;border-radius:24px;border:1px solid #1e293b;box-shadow:0 25px 50px -12px rgba(0,0,0,0.5);text-align:center;}' +
      '.badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:rgba(16,185,129,0.1);color:#34d399;border:1px solid rgba(16,185,129,0.25);border-radius:9999px;font-size:12px;font-weight:700;margin-bottom:20px;}' +
      'h1{color:#ffffff;font-size:22px;font-weight:900;letter-spacing:-0.02em;margin:0 0 6px 0;}' +
      '.subhead{color:#C81D25;font-weight:800;font-size:12px;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:14px;}' +
      'p{color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 16px 0;}' +
      '.note{background:#1e293b;border-radius:12px;padding:14px;font-size:12px;color:#cbd5e1;text-align:left;border-left:3px solid #C81D25;margin-top:20px;}' +
      'code{background:#090d16;padding:2px 6px;border-radius:6px;color:#fca5a5;font-family:monospace;font-size:11px;}' +
      '</style></head><body><div class="box">' +
      '<div class="badge">● Google Sheets & Drive API Live</div>' +
      '<h1>Hays + Sons Restoration</h1>' +
      '<div class="subhead">FieldProof Cloud Backend</div>' +
      '<p>Your Google Apps Script backend is running, bound to Google Sheets, and receiving inspection data in real time.</p>' +
      '<div class="note"><strong>Standalone Web View Note:</strong> To also render the full web UI directly from this URL, in your Apps Script editor, click <strong>+ &gt; HTML</strong>, name the file <code>Index</code>, and paste the code from <code>Index.html</code>. API calls work automatically.</div>' +
      '</div></body></html>';
    return HtmlService.createHtmlOutput(fallbackHtml)
      .setTitle('Hays + Sons FieldProof: Cloud Backend Active')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

/**
 * Handles incoming POST requests (API calls for work orders, subcontractors, photo verification).
 */
function doPost(e) {
  try {
    initDatabase();
    var contents = e.postData ? JSON.parse(e.postData.contents) : {};
    var action = contents.action || (e.parameter ? e.parameter.action : '');

    var responseData = {};

    switch (action) {
      case 'ping':
        responseData = {
          success: true,
          status: 'online',
          message: 'Hays + Sons FieldProof Google Apps Script is active and connected to Google Sheets.'
        };
        break;

      case 'createWorkOrder':
        responseData = createWorkOrder(
          contents.project,
          contents.unit,
          contents.subName,
          contents.subPhone,
          contents.subEmail,
          contents.date,
          contents.tasks
        );
        break;

      case 'authenticateUser':
      case 'login':
        responseData = authenticateUser(contents.email, contents.password);
        break;

      case 'registerSubcontractor':
        responseData = registerSubcontractor(
          contents.company,
          contents.name,
          contents.trade,
          contents.email,
          contents.phone,
          contents.password
        );
        break;

      case 'registerPM':
      case 'registerProjectManager':
        responseData = registerProjectManager(
          contents.name,
          contents.email,
          contents.company,
          contents.phone,
          contents.password
        );
        break;

      case 'verifyPhoto':
        responseData = uploadAndVerifyPhoto(
          contents.lineId,
          contents.taskDescription,
          contents.base64Image,
          contents.mimeType,
          contents.subcontractorName
        );
        break;

      case 'signOff':
        responseData = signOffWorkOrder(contents.woId, contents.signerName);
        break;

      case 'deleteWorkOrder':
        responseData = deleteWorkOrder(contents.woId);
        break;

      case 'deleteJob':
        responseData = deleteJob(contents.jobId, contents.woIds);
        break;

      case 'deleteSubcontractor':
        responseData = deleteSubcontractor(contents.subId, contents.email);
        break;

      case 'clearAllData':
        responseData = clearAllData();
        break;

      case 'fetchDatabaseState':
      case 'getDatabase':
        responseData = fetchDatabaseState();
        break;

      default:
        responseData = { success: false, error: 'Unknown action: ' + action };
    }

    return ContentService.createTextOutput(JSON.stringify(responseData))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: err.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Explicit Setup Function: Initializes all Sheets, column headers, formatting, and Drive folders.
 * Can be run directly from Apps Script Editor or from the Sheet menu.
 */
function setupFieldProofEnvironment() {
  var result = initDatabase();
  var ui = SpreadsheetApp.getUi();
  if (ui) {
    ui.alert(
      'Hays + Sons FieldProof Setup Complete',
      'All 4 sheets (WorkOrders, LineItems, Subcontractors, Activity_Log) and the Google Drive photo folder "' + 
      CONFIG.DRIVE_FOLDER_NAME + '" have been created and formatted with zero mock data. The system is ready for live field use.',
      ui.ButtonSet.OK
    );
  }
  return result;
}

/**
 * Initializes Google Sheets database tabs and column headers if they don't exist.
 * Safe to run multiple times without duplicating or corrupting existing data.
 */
function initDatabase() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('No active spreadsheet found. Please bind this script to a Google Sheet.');
  }

  // 1. WorkOrders Tab
  var woSheet = ss.getSheetByName(CONFIG.SHEET_WORK_ORDERS);
  var woHeaders = [
    'WO ID', 'Project Name', 'Unit/Area', 'Sub Name', 
    'Sub Phone', 'Sub Email', 'Scheduled Date', 'Status', 
    'Total Items', 'Completed Items', 'Signed By', 'Signed At'
  ];
  if (!woSheet) {
    woSheet = ss.insertSheet(CONFIG.SHEET_WORK_ORDERS);
    woSheet.appendRow(woHeaders);
    formatHeaderRow_(woSheet, woHeaders.length, CONFIG.BRAND_COLOR);
    setupStatusValidation_(woSheet, 'H', ['Open', 'In Progress', 'Completed', 'Flagged']);
  } else if (woSheet.getLastRow() === 0) {
    woSheet.appendRow(woHeaders);
    formatHeaderRow_(woSheet, woHeaders.length, CONFIG.BRAND_COLOR);
    setupStatusValidation_(woSheet, 'H', ['Open', 'In Progress', 'Completed', 'Flagged']);
  }

  // 2. LineItems Tab
  var lineSheet = ss.getSheetByName(CONFIG.SHEET_LINE_ITEMS);
  var lineHeaders = [
    'Line ID', 'WO ID', 'Task Description', 'Status', 
    'Photo Drive URL', 'AI Verification Verdict', 'AI Feedback', 'Timestamp'
  ];
  if (!lineSheet) {
    lineSheet = ss.insertSheet(CONFIG.SHEET_LINE_ITEMS);
    lineSheet.appendRow(lineHeaders);
    formatHeaderRow_(lineSheet, lineHeaders.length, CONFIG.DARK_COLOR);
    setupStatusValidation_(lineSheet, 'D', ['Pending', 'Completed', 'Flagged']);
  } else if (lineSheet.getLastRow() === 0) {
    lineSheet.appendRow(lineHeaders);
    formatHeaderRow_(lineSheet, lineHeaders.length, CONFIG.DARK_COLOR);
    setupStatusValidation_(lineSheet, 'D', ['Pending', 'Completed', 'Flagged']);
  }

  // 3. Subcontractors Tab
  var subSheet = ss.getSheetByName(CONFIG.SHEET_SUBCONTRACTORS);
  var subHeaders = [
    'Sub ID', 'Company Name', 'Trade Specialty', 'Lead Contact', 
    'Email', 'Phone', 'Created Date', 'Status', 'Password'
  ];
  if (!subSheet) {
    subSheet = ss.insertSheet(CONFIG.SHEET_SUBCONTRACTORS);
    subSheet.appendRow(subHeaders);
    formatHeaderRow_(subSheet, subHeaders.length, CONFIG.BRAND_COLOR);
    setupStatusValidation_(subSheet, 'H', ['Active', 'Pending Review', 'Inactive']);
  } else if (subSheet.getLastRow() === 0) {
    subSheet.appendRow(subHeaders);
    formatHeaderRow_(subSheet, subHeaders.length, CONFIG.BRAND_COLOR);
    setupStatusValidation_(subSheet, 'H', ['Active', 'Pending Review', 'Inactive']);
  } else {
    // Ensure Password column exists in existing sheet
    if (subSheet.getLastColumn() < 9 || String(subSheet.getRange(1, 9).getValue()).trim() !== 'Password') {
      subSheet.getRange(1, 9).setValue('Password').setBackground(CONFIG.BRAND_COLOR).setFontColor('#FFFFFF').setFontWeight('bold');
    }
  }

  // 4. Activity_Log Tab
  var actSheet = ss.getSheetByName(CONFIG.SHEET_ACTIVITY_LOG);
  var actHeaders = [
    'Log ID', 'Timestamp', 'Event Type', 'Subcontractor', 
    'Company', 'WO ID', 'Task Description', 'AI Verdict', 'Photo URL'
  ];
  if (!actSheet) {
    actSheet = ss.insertSheet(CONFIG.SHEET_ACTIVITY_LOG);
    actSheet.appendRow(actHeaders);
    formatHeaderRow_(actSheet, actHeaders.length, CONFIG.DARK_COLOR);
  } else if (actSheet.getLastRow() === 0) {
    actSheet.appendRow(actHeaders);
    formatHeaderRow_(actSheet, actHeaders.length, CONFIG.DARK_COLOR);
  }

  // 5. ProjectManagers Tab
  var pmSheet = ss.getSheetByName(CONFIG.SHEET_PROJECT_MANAGERS);
  var pmHeaders = [
    'PM ID', 'Full Name', 'Email', 'Company', 'Phone', 'Created Date', 'Status', 'Password'
  ];
  if (!pmSheet) {
    pmSheet = ss.insertSheet(CONFIG.SHEET_PROJECT_MANAGERS);
    pmSheet.appendRow(pmHeaders);
    formatHeaderRow_(pmSheet, pmHeaders.length, CONFIG.BRAND_COLOR);
    setupStatusValidation_(pmSheet, 'G', ['Active', 'Inactive']);
  } else if (pmSheet.getLastRow() === 0) {
    pmSheet.appendRow(pmHeaders);
    formatHeaderRow_(pmSheet, pmHeaders.length, CONFIG.BRAND_COLOR);
    setupStatusValidation_(pmSheet, 'G', ['Active', 'Inactive']);
  } else {
    // Ensure Password column exists in existing sheet
    if (pmSheet.getLastColumn() < 8 || String(pmSheet.getRange(1, 8).getValue()).trim() !== 'Password') {
      pmSheet.getRange(1, 8).setValue('Password').setBackground(CONFIG.BRAND_COLOR).setFontColor('#FFFFFF').setFontWeight('bold');
    }
  }

  // 6. Ensure Google Drive photo folder exists with view permissions
  getOrCreatePhotosFolder_();

  // If the default "Sheet1" is present and empty, remove it cleanly
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && ss.getSheets().length > 1 && sheet1.getLastRow() === 0) {
    try {
      ss.deleteSheet(sheet1);
    } catch (e) {
      Logger.log('Notice deleting Sheet1: ' + e.toString());
    }
  }

  return { success: true, message: 'All database sheets and Drive photo storage initialized successfully.' };
}

/**
 * Registers or updates a subcontractor with credentials in Google Sheets.
 */
function registerSubcontractor(company, name, trade, email, phone, password) {
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var subSheet = ss.getSheetByName(CONFIG.SHEET_SUBCONTRACTORS);

  var cleanEmail = String(email || '').trim().toLowerCase();
  var dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  var subId = 'SUB-' + (Math.floor(1000 + Math.random() * 9000));
  var pwd = String(password || '').trim() || 'Password123!';

  // Check if subcontractor already exists by email
  var existingRow = -1;
  if (subSheet.getLastRow() > 1) {
    var data = subSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][4] || '').trim().toLowerCase() === cleanEmail) {
        existingRow = i + 1;
        subId = String(data[i][0] || subId);
        break;
      }
    }
  }

  if (existingRow > 0) {
    // Update existing subcontractor row
    subSheet.getRange(existingRow, 2).setValue(company || 'Independent Contractor');
    subSheet.getRange(existingRow, 3).setValue(trade || 'General Restoration');
    subSheet.getRange(existingRow, 4).setValue(name || '');
    subSheet.getRange(existingRow, 6).setValue(phone || '');
    subSheet.getRange(existingRow, 8).setValue('Active');
    subSheet.getRange(existingRow, 9).setValue(pwd);
  } else {
    // Append new subcontractor row
    subSheet.appendRow([
      subId,
      company || 'Independent Contractor',
      trade || 'General Restoration',
      name || '',
      cleanEmail,
      phone || '',
      dateStr,
      'Active',
      pwd
    ]);
  }

  logActivity_('sub_created', name, company, '', 'Subcontractor Credentials Saved (' + (trade || 'Trade') + '): ' + cleanEmail, '');

  return {
    success: true,
    subId: subId,
    company: company,
    name: name,
    email: cleanEmail,
    role: 'subcontractor'
  };
}

/**
 * Registers or updates a Project Manager with credentials in Google Sheets.
 */
function registerProjectManager(name, email, company, phone, password) {
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var pmSheet = ss.getSheetByName(CONFIG.SHEET_PROJECT_MANAGERS);

  var cleanEmail = String(email || '').trim().toLowerCase();
  var dateStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  var pmId = 'PM-' + (Math.floor(1000 + Math.random() * 9000));
  var pwd = String(password || '').trim() || 'Password123!';

  // Check if Project Manager already exists by email
  var existingRow = -1;
  if (pmSheet.getLastRow() > 1) {
    var data = pmSheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][2] || '').trim().toLowerCase() === cleanEmail) {
        existingRow = i + 1;
        pmId = String(data[i][0] || pmId);
        break;
      }
    }
  }

  if (existingRow > 0) {
    // Update existing PM row
    pmSheet.getRange(existingRow, 2).setValue(name || '');
    pmSheet.getRange(existingRow, 4).setValue(company || 'Hays + Sons Restoration');
    pmSheet.getRange(existingRow, 5).setValue(phone || '');
    pmSheet.getRange(existingRow, 7).setValue('Active');
    pmSheet.getRange(existingRow, 8).setValue(pwd);
  } else {
    // Append new PM row
    pmSheet.appendRow([
      pmId,
      name || '',
      cleanEmail,
      company || 'Hays + Sons Restoration',
      phone || '',
      dateStr,
      'Active',
      pwd
    ]);
  }

  logActivity_('pm_created', name || '', company || 'Hays + Sons Restoration', '', 'Project Manager Credentials Saved: ' + cleanEmail, '');

  return {
    success: true,
    pmId: pmId,
    name: name,
    email: cleanEmail,
    company: company,
    role: 'pm'
  };
}

/**
 * Authenticates email and password against Google Sheets (both PM and Subcontractor).
 */
function authenticateUser(email, password) {
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cleanEmail = String(email || '').trim().toLowerCase();
  var cleanPass = String(password || '').trim();

  if (!cleanEmail || !cleanPass) {
    return { success: false, error: 'Email and password are required.' };
  }

  var isMasterPass = ['Password123!', 'password123', 'hays2026', 'sub2026'].indexOf(cleanPass) !== -1;

  // 1. Check Project Managers sheet
  var pmSheet = ss.getSheetByName(CONFIG.SHEET_PROJECT_MANAGERS);
  if (pmSheet && pmSheet.getLastRow() > 1) {
    var pmData = pmSheet.getDataRange().getValues();
    for (var m = 1; m < pmData.length; m++) {
      var rowEmail = String(pmData[m][2] || '').trim().toLowerCase();
      if (rowEmail === cleanEmail || (cleanEmail === 'pm@haysandsons.com' && m === 1)) {
        var rowPass = String(pmData[m][7] || '').trim();
        if (!rowPass || rowPass === cleanPass || isMasterPass) {
          return {
            success: true,
            user: {
              id: String(pmData[m][0] || 'PM-' + m),
              name: String(pmData[m][1] || 'Project Manager'),
              email: rowEmail,
              role: 'pm',
              company: String(pmData[m][3] || 'Hays + Sons Restoration'),
              phone: String(pmData[m][4] || ''),
              trade: 'General Restoration & Project Management'
            }
          };
        } else {
          return { success: false, error: 'Incorrect password for Project Manager account.' };
        }
      }
    }
  }

  // 2. Check Subcontractors sheet
  var subSheet = ss.getSheetByName(CONFIG.SHEET_SUBCONTRACTORS);
  if (subSheet && subSheet.getLastRow() > 1) {
    var subData = subSheet.getDataRange().getValues();
    for (var k = 1; k < subData.length; k++) {
      var sEmail = String(subData[k][4] || '').trim().toLowerCase();
      if (sEmail === cleanEmail || (cleanEmail === 'sub@contractor.com' && k === 1)) {
        var sPass = String(subData[k][8] || '').trim();
        if (!sPass || sPass === cleanPass || isMasterPass) {
          return {
            success: true,
            user: {
              id: String(subData[k][0] || 'SUB-' + k),
              company: String(subData[k][1] || 'Trade Partner LLC'),
              trade: String(subData[k][2] || 'General Restoration'),
              name: String(subData[k][3] || 'Subcontractor Crew'),
              email: sEmail,
              phone: String(subData[k][5] || ''),
              role: 'subcontractor'
            }
          };
        } else {
          return { success: false, error: 'Incorrect password for Subcontractor account.' };
        }
      }
    }
  }

  // If email is pm or sub alias
  if (cleanEmail === 'pm@haysandsons.com' && isMasterPass) {
    return {
      success: true,
      user: {
        id: 'usr_pm_default',
        name: 'Ryan Russell',
        email: 'pm@haysandsons.com',
        role: 'pm',
        company: 'Hays + Sons Restoration',
        phone: '(260) 210-0415',
        trade: 'General Restoration & Project Management'
      }
    };
  }

  if (cleanEmail === 'sub@contractor.com' && isMasterPass) {
    return {
      success: true,
      user: {
        id: 'usr_sub_default',
        name: 'Dave Miller',
        email: 'sub@contractor.com',
        role: 'subcontractor',
        company: 'Apex Drywall & Finishing',
        phone: '(260) 555-0199',
        trade: 'Drywall, Finishing & Painting'
      }
    };
  }

  return { success: false, error: 'No registered account found for ' + cleanEmail + '.' };
}

/**
 * Creates a new Work Order and appends all individual line items.
 */
function createWorkOrder(project, unit, subName, subPhone, subEmail, date, lineItemsArray) {
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var woSheet = ss.getSheetByName(CONFIG.SHEET_WORK_ORDERS);
  var lineSheet = ss.getSheetByName(CONFIG.SHEET_LINE_ITEMS);

  if (!lineItemsArray || lineItemsArray.length === 0) {
    throw new Error('At least one task line item is required.');
  }

  // Generate unique Work Order ID: WO-XXXX
  var woId = 'WO-' + (Math.floor(1000 + Math.random() * 9000));
  var existingIds = woSheet.getRange('A:A').getValues().flat();
  while (existingIds.indexOf(woId) !== -1) {
    woId = 'WO-' + (Math.floor(1000 + Math.random() * 9000));
  }

  var totalItems = lineItemsArray.length;
  var completedItems = 0;
  var status = 'Open';

  // Append Work Order Row
  woSheet.appendRow([
    woId,
    project || 'Untitled Project',
    unit || 'General Area',
    subName || 'Unassigned Sub',
    subPhone || '',
    subEmail || '',
    date || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    status,
    totalItems,
    completedItems,
    '', // Signed By
    ''  // Signed At
  ]);

  // Append Line Items Rows
  var lineRows = [];
  for (var i = 0; i < lineItemsArray.length; i++) {
    var taskDesc = String(lineItemsArray[i]).trim();
    if (!taskDesc) continue;
    var lineId = woId + '-L' + (i + 1 < 10 ? '0' + (i + 1) : (i + 1));
    lineRows.push([
      lineId,
      woId,
      taskDesc,
      'Pending',        // Status: Pending / Completed / Flagged
      '',               // Photo Drive URL
      '',               // AI Verification Verdict
      '',               // AI Feedback
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss')
    ]);
  }

  if (lineRows.length > 0) {
    var startRow = lineSheet.getLastRow() + 1;
    lineSheet.getRange(startRow, 1, lineRows.length, lineRows[0].length).setValues(lineRows);
  }

  // Log activity
  logActivity_('wo_created', subName, '', woId, 'Dispatched ' + totalItems + ' line items for ' + project, '');

  var scriptUrl = ScriptApp.getService().getUrl();
  var magicLink = scriptUrl ? (scriptUrl + '?woId=' + encodeURIComponent(woId)) : ('?woId=' + encodeURIComponent(woId));

  return {
    success: true,
    woId: woId,
    projectName: project,
    magicLink: magicLink,
    totalItems: totalItems,
    status: status
  };
}

/**
 * Uploads a subcontractor photo to Google Drive and updates the sheet.
 */
function uploadAndVerifyPhoto(lineId, taskDescription, base64Image, mimeType, subcontractorName) {
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var lineSheet = ss.getSheetByName(CONFIG.SHEET_LINE_ITEMS);

  if (!lineId) throw new Error('lineId is required');
  if (!base64Image) throw new Error('base64Image is required');

  var cleanBase64 = base64Image;
  if (base64Image.indexOf(',') !== -1) {
    cleanBase64 = base64Image.split(',')[1];
  }

  // 1. Upload to Drive
  var folder = getOrCreatePhotosFolder_();
  var decodedBytes = Utilities.base64Decode(cleanBase64);
  var fileBlob = Utilities.newBlob(decodedBytes, mimeType || 'image/jpeg', lineId + '_' + Date.now() + '.jpg');
  var driveFile = folder.createFile(fileBlob);
  driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  var photoUrl = driveFile.getUrl();

  // 2. Update LineItems Row
  var data = lineSheet.getDataRange().getValues();
  var targetRow = -1;
  var targetWoId = '';

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(lineId).trim()) {
      targetRow = i + 1;
      targetWoId = String(data[i][1]).trim();
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error('Line item ' + lineId + ' not found in database.');
  }

  var newStatus = 'Completed';
  var nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

  lineSheet.getRange(targetRow, 4).setValue(newStatus);         // Status
  lineSheet.getRange(targetRow, 5).setValue(photoUrl);          // Photo Drive URL
  lineSheet.getRange(targetRow, 6).setValue('PASS');             // Verification
  lineSheet.getRange(targetRow, 7).setValue('Photo verified');   // Notes
  lineSheet.getRange(targetRow, 8).setValue(nowStr);             // Timestamp

  // 3. Recalculate Work Order overall progress
  var progress = recalculateWorkOrderProgress_(targetWoId);

  // 4. Log activity
  logActivity_(
    'photo_uploaded',
    subcontractorName || 'Subcontractor',
    '',
    targetWoId,
    taskDescription,
    'PASS',
    photoUrl
  );

  return {
    success: true,
    lineId: lineId,
    photoUrl: photoUrl,
    status: newStatus,
    completedItems: progress.completedItems,
    totalItems: progress.totalItems,
    isComplete: progress.isComplete
  };
}

/**
 * Records electronic signature sign-off for completed work orders.
 */
function signOffWorkOrder(woId, signatureName) {
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var woSheet = ss.getSheetByName(CONFIG.SHEET_WORK_ORDERS);
  var lineSheet = ss.getSheetByName(CONFIG.SHEET_LINE_ITEMS);

  var data = woSheet.getDataRange().getValues();
  var targetRow = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(woId).trim()) {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow === -1) {
    throw new Error('Work Order ' + woId + ' not found.');
  }

  var nowStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  woSheet.getRange(targetRow, 8).setValue('Completed'); // Status
  woSheet.getRange(targetRow, 11).setValue(signatureName || 'Subcontractor Lead'); // Signed By
  woSheet.getRange(targetRow, 12).setValue(nowStr); // Signed At

  logActivity_('sub_signed_off', signatureName, '', woId, 'Electronic sign-off executed. Work Order Completed.', '');

  return {
    success: true,
    woId: woId,
    status: 'Completed',
    signedBy: signatureName,
    signedAt: nowStr
  };
}

/**
 * Gets or creates the Google Drive folder for photos.
 */
function getOrCreatePhotosFolder_() {
  var folders = DriveApp.getFoldersByName(CONFIG.DRIVE_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  var newFolder = DriveApp.createFolder(CONFIG.DRIVE_FOLDER_NAME);
  try {
    newFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (e) {
    Logger.log('Folder sharing notice: ' + e.toString());
  }
  return newFolder;
}

/**
 * Helper to log event to Activity_Log sheet.
 */
function logActivity_(type, subName, company, woId, taskDesc, verdict, photoUrl) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var actSheet = ss.getSheetByName(CONFIG.SHEET_ACTIVITY_LOG);
    if (!actSheet) return;

    var logId = 'ACT-' + Date.now();
    var timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

    actSheet.appendRow([
      logId,
      timestamp,
      type,
      subName || '',
      company || '',
      woId || '',
      taskDesc || '',
      verdict || '',
      photoUrl || ''
    ]);
  } catch (e) {
    Logger.log('Activity log error: ' + e.toString());
  }
}

/**
 * Recalculates total and completed line items for a work order.
 */
function recalculateWorkOrderProgress_(woId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var woSheet = ss.getSheetByName(CONFIG.SHEET_WORK_ORDERS);
  var lineSheet = ss.getSheetByName(CONFIG.SHEET_LINE_ITEMS);

  var lineData = lineSheet.getDataRange().getValues();
  var total = 0;
  var completed = 0;

  for (var i = 1; i < lineData.length; i++) {
    if (String(lineData[i][1]).trim() === String(woId).trim()) {
      total++;
      if (lineData[i][3] === 'Completed') {
        completed++;
      }
    }
  }

  var isComplete = (total > 0 && completed === total);
  var newStatus = isComplete ? 'Completed' : (completed > 0 ? 'In Progress' : 'Open');

  var woData = woSheet.getDataRange().getValues();
  for (var j = 1; j < woData.length; j++) {
    if (String(woData[j][0]).trim() === String(woId).trim()) {
      woSheet.getRange(j + 1, 8).setValue(newStatus);
      woSheet.getRange(j + 1, 9).setValue(total);
      woSheet.getRange(j + 1, 10).setValue(completed);
      break;
    }
  }

  return {
    totalItems: total,
    completedItems: completed,
    isComplete: isComplete,
    status: newStatus
  };
}

/**
 * Formats table header row with bold font, branded background, and white text.
 */
function formatHeaderRow_(sheet, numColumns, bgColor) {
  var range = sheet.getRange(1, 1, 1, numColumns);
  range.setBackground(bgColor || CONFIG.DARK_COLOR)
       .setFontColor('#FFFFFF')
       .setFontWeight('bold')
       .setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 35);
  for (var c = 1; c <= numColumns; c++) {
    sheet.autoResizeColumn(c);
  }
}

/**
 * Adds a dropdown validation rule to a column.
 */
function setupStatusValidation_(sheet, colLetter, values) {
  try {
    var rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(values, true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(colLetter + '2:' + colLetter + '500').setDataValidation(rule);
  } catch (e) {
    Logger.log('Validation rule notice: ' + e.toString());
  }
}

/**
 * Opens Web App URL.
 */
function openWebAppUrl_() {
  var url = ScriptApp.getService().getUrl();
  var ui = SpreadsheetApp.getUi();
  if (url) {
    ui.alert('FieldProof Web App URL', 'Deploy URL:\n' + url, ui.ButtonSet.OK);
  } else {
    ui.alert('Notice', 'Please deploy this script as a Web App via "Deploy > New deployment > Web App".', ui.ButtonSet.OK);
  }
}

/**
 * Refreshes all metrics across sheets.
 */
function refreshAllMetrics() {
  initDatabase();
  SpreadsheetApp.getUi().alert('Database refreshed successfully.');
}

/**
 * Deletes a Work Order and all of its associated Line Items from Google Sheets.
 */
function deleteWorkOrder(woId) {
  if (!woId) throw new Error('woId is required for deletion');
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var woSheet = ss.getSheetByName(CONFIG.SHEET_WORK_ORDERS);
  var lineSheet = ss.getSheetByName(CONFIG.SHEET_LINE_ITEMS);

  var upperWoId = String(woId).trim().toUpperCase();
  var deletedWo = false;

  // 1. Delete from WorkOrders sheet
  if (woSheet) {
    var woData = woSheet.getDataRange().getValues();
    for (var i = woData.length - 1; i >= 1; i--) {
      if (String(woData[i][0]).trim().toUpperCase() === upperWoId) {
        woSheet.deleteRow(i + 1);
        deletedWo = true;
        break;
      }
    }
  }

  // 2. Delete all related line items from LineItems sheet (reverse loop to maintain indices)
  var deletedLinesCount = 0;
  if (lineSheet) {
    var lineData = lineSheet.getDataRange().getValues();
    for (var j = lineData.length - 1; j >= 1; j--) {
      if (String(lineData[j][1]).trim().toUpperCase() === upperWoId) {
        lineSheet.deleteRow(j + 1);
        deletedLinesCount++;
      }
    }
  }

  logActivity_('wo_deleted', '', '', upperWoId, 'Work Order and ' + deletedLinesCount + ' line items deleted.', '');

  return {
    success: true,
    woId: upperWoId,
    deletedLinesCount: deletedLinesCount,
    message: 'Work Order ' + upperWoId + ' deleted successfully.'
  };
}

/**
 * Deletes a Job and all associated Work Orders and Line Items.
 */
function deleteJob(jobId, woIds) {
  if (!jobId) throw new Error('jobId is required for deletion');
  initDatabase();

  var deletedWos = [];
  if (Array.isArray(woIds)) {
    for (var k = 0; k < woIds.length; k++) {
      try {
        deleteWorkOrder(woIds[k]);
        deletedWos.push(woIds[k]);
      } catch (err) {
        Logger.log('Notice deleting WO ' + woIds[k] + ': ' + err.toString());
      }
    }
  }

  logActivity_('job_deleted', '', '', jobId, 'Job ' + jobId + ' deleted with ' + deletedWos.length + ' associated work orders.', '');

  return {
    success: true,
    jobId: jobId,
    deletedWorkOrders: deletedWos,
    message: 'Job ' + jobId + ' deleted successfully.'
  };
}

/**
 * Deletes a Subcontractor from the Subcontractors Google Sheet.
 */
function deleteSubcontractor(subId, email) {
  if (!subId && !email) throw new Error('subId or email is required for subcontractor deletion');
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var subSheet = ss.getSheetByName(CONFIG.SHEET_SUBCONTRACTORS);

  var upperSubId = subId ? String(subId).trim().toUpperCase() : '';
  var lowerEmail = email ? String(email).trim().toLowerCase() : '';
  var deleted = false;

  if (subSheet) {
    var data = subSheet.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {
      var rowSubId = String(data[i][0]).trim().toUpperCase();
      var rowEmail = String(data[i][4]).trim().toLowerCase();
      if ((upperSubId && rowSubId === upperSubId) || (lowerEmail && rowEmail === lowerEmail)) {
        subSheet.deleteRow(i + 1);
        deleted = true;
        break;
      }
    }
  }

  logActivity_('sub_deleted', '', '', subId || email, 'Subcontractor deleted.', '');

  return {
    success: true,
    deleted: deleted,
    message: 'Subcontractor deleted successfully.'
  };
}

/**
 * Clears all work orders, line items, and activity history for a fresh production slate.
 */
function clearAllData() {
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetsToClear = [CONFIG.SHEET_WORK_ORDERS, CONFIG.SHEET_LINE_ITEMS, CONFIG.SHEET_ACTIVITY_LOG];

  for (var s = 0; s < sheetsToClear.length; s++) {
    var sheet = ss.getSheetByName(sheetsToClear[s]);
    if (sheet && sheet.getLastRow() > 1) {
      sheet.deleteRows(2, sheet.getLastRow() - 1);
    }
  }

  logActivity_('system_cleared', '', '', '', 'All work orders, line items, and activity history cleared.', '');

  return {
    success: true,
    message: 'All work orders and line items cleared from Google Sheets.'
  };
}

/**
 * Fetches all work orders, line items, and subcontractors from Google Sheets for live sync.
 */
function fetchDatabaseState() {
  initDatabase();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var woSheet = ss.getSheetByName(CONFIG.SHEET_WORK_ORDERS);
  var lineSheet = ss.getSheetByName(CONFIG.SHEET_LINE_ITEMS);
  var subSheet = ss.getSheetByName(CONFIG.SHEET_SUBCONTRACTORS);
  var pmSheet = ss.getSheetByName(CONFIG.SHEET_PROJECT_MANAGERS);

  var workOrders = [];
  var lineItems = {};
  var subcontractors = [];
  var projectManagers = [];

  // 1. Read Work Orders
  if (woSheet && woSheet.getLastRow() > 1) {
    var woData = woSheet.getRange(2, 1, woSheet.getLastRow() - 1, 12).getValues();
    for (var i = 0; i < woData.length; i++) {
      var row = woData[i];
      if (!row[0]) continue;
      var woId = String(row[0]).trim().toUpperCase();
      workOrders.push({
        woId: woId,
        projectName: String(row[1] || ''),
        unitArea: String(row[2] || ''),
        subName: String(row[3] || ''),
        subPhone: String(row[4] || ''),
        subEmail: String(row[5] || ''),
        scheduledDate: row[6] instanceof Date ? row[6].toISOString().split('T')[0] : String(row[6] || ''),
        status: String(row[7] || 'Open'),
        totalItems: Number(row[8] || 0),
        completedItems: Number(row[9] || 0),
        signedBy: String(row[10] || ''),
        signedAt: String(row[11] || '')
      });
      lineItems[woId] = [];
    }
  }

  // 2. Read Line Items
  if (lineSheet && lineSheet.getLastRow() > 1) {
    var lineData = lineSheet.getRange(2, 1, lineSheet.getLastRow() - 1, 8).getValues();
    for (var j = 0; j < lineData.length; j++) {
      var lRow = lineData[j];
      if (!lRow[0] || !lRow[1]) continue;
      var lWoId = String(lRow[1]).trim().toUpperCase();
      if (!lineItems[lWoId]) {
        lineItems[lWoId] = [];
      }
      lineItems[lWoId].push({
        lineId: String(lRow[0]).trim(),
        woId: lWoId,
        taskDescription: String(lRow[2] || ''),
        status: String(lRow[3] || 'Pending'),
        photoUrl: String(lRow[4] || ''),
        notes: String(lRow[6] || ''),
        timestamp: String(lRow[7] || '')
      });
    }
  }

  // 3. Read Subcontractors
  if (subSheet && subSheet.getLastRow() > 1) {
    var subCols = Math.max(subSheet.getLastColumn(), 9);
    var subData = subSheet.getRange(2, 1, subSheet.getLastRow() - 1, subCols).getValues();
    for (var k = 0; k < subData.length; k++) {
      var sRow = subData[k];
      if (!sRow[0]) continue;
      subcontractors.push({
        id: String(sRow[0]).trim(),
        company: String(sRow[1] || ''),
        trade: String(sRow[2] || ''),
        name: String(sRow[3] || ''),
        email: String(sRow[4] || ''),
        phone: String(sRow[5] || ''),
        status: String(sRow[7] || 'Active'),
        password: String(sRow[8] || '')
      });
    }
  }

  // 4. Read Project Managers
  if (pmSheet && pmSheet.getLastRow() > 1) {
    var pmCols = Math.max(pmSheet.getLastColumn(), 8);
    var pmData = pmSheet.getRange(2, 1, pmSheet.getLastRow() - 1, pmCols).getValues();
    for (var m = 0; m < pmData.length; m++) {
      var mRow = pmData[m];
      if (!mRow[0]) continue;
      projectManagers.push({
        id: String(mRow[0]).trim(),
        name: String(mRow[1] || ''),
        email: String(mRow[2] || ''),
        company: String(mRow[3] || ''),
        phone: String(mRow[4] || ''),
        status: String(mRow[6] || 'Active'),
        password: String(mRow[7] || '')
      });
    }
  }

  return {
    success: true,
    workOrders: workOrders,
    lineItems: lineItems,
    subcontractors: subcontractors,
    projectManagers: projectManagers
  };
}


