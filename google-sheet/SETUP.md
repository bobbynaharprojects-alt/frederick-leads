# Google Sheet setup (one time, about 10 minutes)

Sheet: [Frederick Leads](https://docs.google.com/spreadsheets/d/1SmklUJ2sbPe_rfIH0I4xpXUBapUtH1C1mqiOJFkfOos/edit) in Google Drive (bobbynaharprojects@gmail.com), `frederick-leads` folder.

The script `leads_sync.gs` pulls `top_properties.csv` from this GitHub repository into the sheet, and updates it on the 16th of each month (the day after GitHub's monthly refresh). Your Status, Owner name, Notes and date columns are never changed by an update.

## Step 1: Create a read-only GitHub token

The sheet needs a "token" (a password just for reading this one repository).

1. Go to https://github.com/settings/personal-access-tokens/new (signed in as bobbynaharprojects-alt).
2. **Token name:** `Frederick Leads sheet`
3. **Expiration:** choose **Custom** and pick a date one year from today.
4. **Repository access:** choose **Only select repositories**, then pick `frederick-leads`.
5. **Permissions:** open **Repository permissions**, find **Contents**, set it to **Read-only**. Leave everything else as is.
6. Click **Generate token** and **copy** it (it starts with `github_pat_`). You won't be able to see it again.

## Step 2: Add the script to the sheet

1. Open this file on GitHub: [google-sheet/leads_sync.gs](https://github.com/bobbynaharprojects-alt/frederick-leads/blob/main/google-sheet/leads_sync.gs) and click the **Copy raw file** button (two overlapping squares, top right of the code).
2. Open the [Frederick Leads sheet](https://docs.google.com/spreadsheets/d/1SmklUJ2sbPe_rfIH0I4xpXUBapUtH1C1mqiOJFkfOos/edit).
3. Click **Extensions > Apps Script**. A new tab opens with a code editor.
4. Delete the few lines already there, paste the script, and click the **Save** icon (floppy disk).
5. Close that tab.

## Step 3: Run setup

1. Reload the sheet. After a few seconds a **Frederick Leads** menu appears at the top.
2. Click **Frederick Leads > Set up (first time)**.
3. Google asks for permission. Click **Continue**, choose your account, then:
   - You'll see "Google hasn't verified this app". That's normal for a script you wrote yourself. Click **Advanced**, then **Go to (project name) (unsafe)**.
   - Click **Allow**.
4. If nothing else happens, click **Frederick Leads > Set up (first time)** again.
5. Paste the GitHub token and click **OK**.

The sheet fills with the top 200 properties and a message confirms it. Done.

## Using it

- **Leads tab:** one row per property. Yellow headers are your columns: Status (dropdown), Owner name, Notes, First contacted, Follow-up date. Use the filter arrows in the header row to sort or filter.
- **Sync log tab:** one line per update, with how many properties were added or updated, and any errors.
- **Update now:** Frederick Leads > Update now (any time).
- **Properties that leave the top 200** stay in the sheet with "In current top 200" = No, so your notes are kept.
- **You can add your own columns** at the far right. Updates won't touch them. Don't rename the existing column headers; the script finds columns by name.

## When the token expires (once a year)

Updates will fail and Google will email you. Make a new token (Step 1), then use **Frederick Leads > Change GitHub token** and paste it.
