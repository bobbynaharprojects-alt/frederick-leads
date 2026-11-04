# Project Notes: Frederick Leads

Last updated: November 4, 2026

## Objective

Build a system that finds likely distressed, off-market residential properties in Frederick County, Maryland, using free public data. Each property gets a score based on signs the owner may be open to selling (long ownership, not living there, living out of state, and so on).

Planned in three sessions:

1. **Base property database** (done)
2. **Google Sheet** to review and work the leads (next)
3. **Matching step** (later)

## Data source

**MD iMap Parcel Points (Maryland Property Data)**, published monthly by the State of Maryland from Department of Assessments and Taxation (SDAT) records.

- Data service: https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_PropertyData/MapServer/0
- Has: owner mailing address, property address, assessed value, last sale date and price, sale type, year built, owner-occupied code.
- Does **not** have owner names. No free bulk dataset in Maryland does; the state removes them on purpose. Letters can go to "Current Owner".

Sources checked and not used:

- **Frederick County Parcel Data** (county GIS): mostly parcel boundary shapes. No owner, value or sale data. Only useful later for drawing lot outlines on a map.
- **Maryland Open Data Portal, Real Property Assessments**: owner names and mailing addresses are hidden.
- **SDAT Real Property Search website**: shows owner names one property at a time, but blocks automated access. Not used.

Write-up of the source check: [Frederick County Property Data Sources](https://claude.ai/artifact/P89MmBxxg4SZ2ecaVyxRrZ)

## What the database contains

From 109,786 Frederick County records, **89,599 residential properties** are kept: houses, townhouses, condos, mobile homes on residential land, and buildings with up to 4 units. Commercial, farm, industrial, larger apartment buildings, vacant lots and condo parking spaces are removed.

The tax account number (ACCTID) is the ID for each property.

## Distress score

1 point per flag, so scores run from 0 to 5. Missing data never adds a point.

| Flag | State data used | Logic |
|---|---|---|
| Absentee owner | Owner-occupied code (OOI), mailing address, property street address | 1 if OOI is **N** (not owner-occupied), or the mailing address doesn't match the property address after standardizing ("COURT" = "CT", "SIXTH" = "6TH", spaces and small typos ignored). A P.O. Box always counts as different. |
| Out-of-state owner | Mailing state | 1 if the mailing state is filled in and isn't MD. |
| Long-time owner | Last transfer date | 1 if the last transfer was **15+ years** ago. |
| Likely high equity | Transfer date, sale price, sale type, state's full market value | 1 if the last transfer was **20+ years** ago, or the last normal market sale was under **50%** of today's value. |
| Older home | Year built | 1 if built **before 1980**. |

OOI codes: **H** = owner lives there, **D** = partly owner-occupied (mixed use), **N** = not owner-occupied.

Sale type codes: **1** = normal market sale with a building, **2** = land bought before the house was built, **3** = one price for several properties, **4** = not a market sale (for example a family transfer). Only type 1 is used for the price test.

All thresholds are in the **SETTINGS** section at the top of `refresh.py`.

### Results (state data: August 2026)

| | Properties |
|---|---|
| Residential total | 89,599 |
| Absentee owner | 12,922 |
| Out-of-state owner | 2,328 |
| Long-time owner | 25,275 |
| Likely high equity | 19,622 |
| Older home | 26,696 |
| Score 5 | 115 |
| Score 4 | 1,191 |
| Score 3 | 7,724 |
| **Score 3 or more** | **9,030** |

## Data fixes and known limitations

| Issue | Flag affected | Effect |
|---|---|---|
| Same address written differently (COURT/CT, SIXTH/6TH, typos, outdated ZIPs) | Absentee | Fixed by standardizing addresses. Absentee count dropped from 24,232 to 12,922. |
| 117 properties have no street address of their own | Absentee | Only the OOI code is used. |
| 522 P.O. Box owners the state lists as living there | Absentee | Flagged under the current rule; possibly false. Setting `PO_BOX_COUNTS_AS_ABSENTEE` changes it. |
| Family transfers and land-only purchases have low or no prices | High equity | Only normal market sales are used for the price test. |
| Sale records start in 1981; 2,292 have no date | Long-time, High equity | Possibly the longest owners, but they get 0. **Under-scored.** |
| Family and trust transfers reset the last sale date | Long-time, High equity | Long-time owners can look like recent buyers. **Under-scored.** |
| No mortgage data | High equity | Refinanced homes look the same as paid-off ones. **Over-scored.** |
| Anyone 20+ years out gets both flags | Long-time + High equity | Long ownership counts twice. Worth revisiting. |
| 96 homes have a blank or impossible year built | Older home | Get 0. |

## How it runs

`refresh.py` does everything with one command (`python3 refresh.py`, about 3 minutes, needs only Python):

1. Downloads all Frederick County records, 2,000 at a time, retrying on errors.
2. Stops without changing anything if the download is incomplete.
3. Keeps residential properties and adds the flags and score.
4. Builds `properties.db` (raw records, flagged properties, settings used) and only replaces the old one once the new one is complete.
5. Writes `top_properties.csv` (top 200 by score; ties go to the longest-held property).

## Automatic monthly refresh and backups

A GitHub workflow (`.github/workflows/monthly-refresh.yml`) runs `refresh.py` on GitHub's computers:

- **When:** the 15th of each month; also whenever the workflow file changes, or by hand from the Actions tab ("Monthly refresh" > "Run workflow").
- **Backup:** a compressed copy of the database (about 21 MB, all state records plus flags) is saved as a dated download on the [Releases page](https://github.com/bobbynaharprojects-alt/frederick-leads/releases). The state only publishes the current month, so these copies are the only record of past months.
- **Top 200:** the new `top_properties.csv` is saved to the repository.
- First run: November 4, 2026 (succeeded).

## Where things are stored

| What | Where |
|---|---|
| Code, top 200 list, these notes | GitHub (private): https://github.com/bobbynaharprojects-alt/frederick-leads |
| Monthly database backups | GitHub Releases page |
| Copy of `refresh.py` | Google Drive (bobbynaharprojects@gmail.com), `frederick-leads` folder |
| Working database | Rebuilt by `refresh.py`; not stored in the repository (too large) |

Start every new Claude session with the `frederick-leads` repository selected.

## Google Sheet (Session 2)

- Sheet: [Frederick Leads](https://docs.google.com/spreadsheets/d/1SmklUJ2sbPe_rfIH0I4xpXUBapUtH1C1mqiOJFkfOos/edit) in the Google Drive `frederick-leads` folder.
- Holds the top 200 properties, plus tracking columns: Status (dropdown), Owner name, Notes, First contacted, Follow-up date.
- The script `google-sheet/leads_sync.gs` pulls `top_properties.csv` from GitHub (read-only token) on the 16th of each month, or from the sheet's **Frederick Leads > Update now** menu.
- Updates add new properties, refresh data on existing ones, and never change the tracking columns or any columns you add. Properties that leave the top 200 stay, marked "No".
- One-time setup steps: `google-sheet/SETUP.md`. Completed November 4, 2026: 200 properties loaded, sync log OK.
- The GitHub token expires yearly; when it does, make a new one and use **Frederick Leads > Change GitHub token**.
- Open the Apps Script editor in a private window signed in only as bobbynaharprojects@gmail.com (multiple signed-in Google accounts cause "unable to open the file").

## Next steps

- **Session 3:** matching step.
- Later ideas:
  - compare monthly backups to spot changes (new out-of-state owners, recent trust transfers);
  - revisit the double-counting of long ownership in the score.
