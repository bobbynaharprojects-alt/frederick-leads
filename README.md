# Frederick Leads

Finds likely distressed, off-market residential properties in Frederick County, Maryland, using free public data from the State of Maryland (MD iMap Parcel Points).

## Update the data (monthly)

```bash
python3 refresh.py
```

Takes about 3 minutes and needs only Python 3.9 or newer. It:

1. Downloads every Frederick County record from MD iMap Parcel Points.
2. Keeps residential properties (houses, townhouses, condos, buildings with up to 4 units).
3. Adds flags: absentee owner, out-of-state owner, long-time owner, likely high equity, older home, plus a `distress_score` (1 point per flag).
4. Saves `properties.db` (not stored in GitHub; rebuilt each run) and `top_properties.csv` (top 200 by score).

Thresholds are in the **SETTINGS** section at the top of `refresh.py`.

## Files

| File | What it is |
|---|---|
| `refresh.py` | Builds the database and the top-200 list |
| `top_properties.csv` | Top 200 properties from the latest run |
| `county_parcels_sample_20.csv`, `mdimap_frederick_sample_20.csv` | 20-row samples from the two data sources checked |
