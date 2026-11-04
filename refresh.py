"""
Frederick County property database - monthly refresh.

What this script does, in order:
  1. Downloads every Frederick County record from MD iMap Parcel Points
     (the free statewide parcel dataset published by the State of Maryland).
  2. Keeps residential properties only (houses, townhouses, condos,
     small buildings with up to 4 units).
  3. Adds "distress" flag columns and a distress_score.
  4. Saves everything in properties.db (a SQLite database) and exports the
     top properties to top_properties.csv.

How to run it (from the folder that contains this file):
    python3 refresh.py

It needs only Python 3.9 or newer - no extra packages.
"""

# =============================================================================
# SETTINGS - change these numbers to adjust how properties are flagged
# =============================================================================

LONG_TIME_OWNER_YEARS = 15        # long_time_owner: last sale this many years ago or more
HIGH_EQUITY_PRICE_RATIO = 0.50    # likely_high_equity: last sale price below this share of assessed value...
HIGH_EQUITY_YEARS = 20            # ...or last sale this many years ago or more
OLDER_HOME_BUILT_BEFORE = 1980    # older_home: built before this year

MAX_UNITS = 4                     # residential: keep buildings with at most this many units
TOP_N_EXPORT = 200                # how many properties go into top_properties.csv

# Only these sale types are used for the "sale price vs. assessed value" test.
# 1 = normal market sale of a property with a building on it.
# (2 = land bought before the house was built, 3 = one price for several
#  properties, 4 = not a market sale, e.g. a family transfer.)
PRICE_RATIO_SALE_TYPES = {1}

# The user's rule: a mailing address that differs from the property address
# counts as absentee. A P.O. Box always differs, so owners who live in the home
# but get mail at a P.O. Box are flagged too. Set to False to stop flagging
# P.O. Box owners whom the state lists as owner-occupied (OOI = H or D).
PO_BOX_COUNTS_AS_ABSENTEE = True

# =============================================================================
# Below this line is the machinery. You should not need to change it.
# =============================================================================

import csv
import datetime as dt
import difflib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "properties.db")
CSV_PATH = os.path.join(HERE, "top_properties.csv")

SERVICE = ("https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/"
           "MD_PropertyData/MapServer/0/query")
COUNTY_FILTER = "JURSCODE='FRED'"
PAGE_SIZE = 2000  # the most records the service returns per request

RESIDENTIAL_LAND_USES = {"Residential", "Town House", "Residential Condominium"}
EXCLUDED_BUILDING_TYPES = {"DWEL Parking Space"}


# ----------------------------------------------------------------------------
# Step 1: download
# ----------------------------------------------------------------------------

def fetch_json(params, attempts=5):
    url = SERVICE + "?" + urllib.parse.urlencode(params)
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(url, timeout=180) as resp:
                data = json.load(resp)
            if "error" in data:
                raise RuntimeError(data["error"])
            return data
        except Exception as exc:
            if attempt == attempts:
                raise
            wait = 2 ** attempt
            print(f"  request failed ({exc}); retrying in {wait}s")
            time.sleep(wait)


def download_all():
    expected = fetch_json({"where": COUNTY_FILTER, "returnCountOnly": "true",
                           "f": "json"})["count"]
    print(f"Step 1: downloading {expected:,} Frederick County records...")
    records, fields, offset = [], None, 0
    while True:
        data = fetch_json({
            "where": COUNTY_FILTER, "outFields": "*", "returnGeometry": "false",
            "orderByFields": "OBJECTID", "resultOffset": offset,
            "resultRecordCount": PAGE_SIZE, "f": "json",
        })
        if fields is None:
            fields = [f["name"] for f in data["fields"]]
        batch = [f["attributes"] for f in data["features"]]
        records.extend(batch)
        offset += len(batch)
        print(f"  {len(records):,} / {expected:,}", end="\r")
        if not batch or (len(batch) < PAGE_SIZE and not data.get("exceededTransferLimit")):
            break
    print()
    if len(records) != expected:
        sys.exit(f"Download incomplete: got {len(records):,} of {expected:,}. "
                 "Nothing was changed. Please run the script again.")
    return fields, records


# ----------------------------------------------------------------------------
# Helpers for cleaning values
# ----------------------------------------------------------------------------

def clean(value):
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def parse_sale_date(raw):
    raw = clean(raw)
    if not raw or not re.fullmatch(r"\d{8}", raw):
        return None
    try:
        return dt.date(int(raw[:4]), int(raw[4:6]), int(raw[6:]))
    except ValueError:
        return None


def parse_year(raw):
    raw = clean(raw)
    if raw and raw.isdigit() and 1700 <= int(raw) <= dt.date.today().year + 1:
        return int(raw)
    return None


def years_between(earlier, later):
    return (later - earlier).days / 365.25


STREET_WORDS = {
    "STREET": "ST", "AVENUE": "AVE", "AV": "AVE", "ROAD": "RD", "COURT": "CT",
    "DRIVE": "DR", "LANE": "LN", "PLACE": "PL", "CIRCLE": "CIR",
    "BOULEVARD": "BLVD", "TERRACE": "TER", "PARKWAY": "PKWY", "HIGHWAY": "HWY",
    "TRAIL": "TRL", "SQUARE": "SQ", "NORTH": "N", "SOUTH": "S", "EAST": "E",
    "WEST": "W", "MOUNT": "MT", "MOUNTAIN": "MT", "SAINT": "ST",
    "BEND": "BND", "CROSSING": "XING", "RIDGE": "RDG", "GARDENS": "GDNS",
    "FIRST": "1ST", "SECOND": "2ND", "THIRD": "3RD", "FOURTH": "4TH", "FIFTH": "5TH",
    "SIXTH": "6TH", "SEVENTH": "7TH", "EIGHTH": "8TH", "NINTH": "9TH", "TENTH": "10TH",
}


def normalize(text):
    """Uppercase, drop punctuation and use standard street abbreviations."""
    text = re.sub(r"[^A-Z0-9 ]", " ", (text or "").upper())
    return " ".join(STREET_WORDS.get(w, w) for w in text.split())


def is_po_box(line):
    return bool(re.search(r"\bP\s*O\s*BOX\b|\bPOST OFFICE BOX\b|\bBOX \d", normalize(line)))


def mailing_matches_property(rec):
    """True/False if the mailing address is/isn't the property; None if unknown."""
    # House number digits only ("502M" -> "502"); street names compared without
    # spaces ("WILD ROSE" = "WILDROSE"), allowing small typos in longer names.
    num = re.sub(r"\D.*", "", clean(rec.get("PREMSNUM")) or "").lstrip("0")
    lines = [clean(rec.get("OWNADD1")), clean(rec.get("OWNADD2"))]
    lines = [l for l in lines if l]
    if not num or not clean(rec.get("PREMSNAM")) or not lines:
        return None  # no separate property street address, or no mailing address
    # Two spellings of the street: the raw name ("SIXTH") and the state's
    # cleaned-up address without its house number ("E 6TH ST").
    names = {normalize(rec.get("PREMSNAM")).replace(" ", ""),
             normalize(re.sub(r"^\S+\s*", "", clean(rec.get("ADDRESS")) or "")).replace(" ", "")}
    names.discard("")
    for line in lines:
        text = normalize(line)
        line_num = re.match(r"(\d+)\s*([A-Z](?=\s))?", text)
        if not line_num or line_num.group(1).lstrip("0") != num:
            continue
        # The street, with and without a possible unit letter ("7181 F CIMARRON")
        rests = {text[line_num.end(1):].replace(" ", ""), text[line_num.end():].replace(" ", "")}
        for name in names:
            for rest in rests:
                if name in rest:
                    return True
                if len(name) >= 6 and difflib.SequenceMatcher(None, name, rest[:len(name)]).ratio() >= 0.8:
                    return True
    return False


# ----------------------------------------------------------------------------
# Steps 2 and 3: filter to residential and add flags
# ----------------------------------------------------------------------------

def is_residential(rec):
    land_use = clean(rec.get("DESCLU"))
    units = rec.get("BLDG_UNITS")
    bldg = clean(rec.get("DESCBLDG"))
    if bldg in EXCLUDED_BUILDING_TYPES:
        return False
    if land_use in RESIDENTIAL_LAND_USES:
        if bldg is None:
            return False  # no building recorded: a vacant lot
        return units is None or units <= MAX_UNITS
    if land_use == "Apartments":
        return units is not None and units <= MAX_UNITS
    return False


def build_property(rec, today):
    sale_date = parse_sale_date(rec.get("TRADATE"))
    years_owned = round(years_between(sale_date, today), 1) if sale_date else None
    price = rec.get("CONSIDR1") or None
    value = rec.get("NFMTTLVL") or None
    year_built = parse_year(rec.get("YEARBLT"))
    ooi = clean(rec.get("OOI"))
    owner_state = clean(rec.get("OWNSTATE"))

    match = mailing_matches_property(rec)
    po_box = any(is_po_box(rec.get(k)) for k in ("OWNADD1", "OWNADD2"))
    mailing_differs = match is False
    if mailing_differs and po_box and ooi in ("H", "D") and not PO_BOX_COUNTS_AS_ABSENTEE:
        mailing_differs = False

    price_ratio = None
    if price and value and rec.get("CONVEY1") in PRICE_RATIO_SALE_TYPES:
        price_ratio = round(price / value, 3)

    flags = {
        "absentee_owner": int(mailing_differs or ooi == "N"),
        "out_of_state_owner": int(bool(owner_state) and owner_state != "MD"),
        "long_time_owner": int(years_owned is not None and years_owned >= LONG_TIME_OWNER_YEARS),
        "likely_high_equity": int(
            (price_ratio is not None and price_ratio < HIGH_EQUITY_PRICE_RATIO)
            or (years_owned is not None and years_owned >= HIGH_EQUITY_YEARS)),
        "older_home": int(year_built is not None and year_built < OLDER_HOME_BUILT_BEFORE),
    }

    mail_parts = [clean(rec.get("OWNADD1")), clean(rec.get("OWNADD2"))]
    return {
        "acct_id": clean(rec.get("ACCTID")),
        "property_address": clean(rec.get("ADDRESS")),
        "property_city": clean(rec.get("CITY")),
        "property_zip": clean(rec.get("ZIPCODE")),
        "mailing_address": ", ".join(p for p in mail_parts if p) or None,
        "mailing_city": clean(rec.get("OWNCITY")),
        "mailing_state": owner_state,
        "mailing_zip": clean(rec.get("OWNERZIP")),
        "owner_occupied_code": ooi,
        "land_use": clean(rec.get("DESCLU")),
        "building_type": clean(rec.get("DESCBLDG")),
        "units": rec.get("BLDG_UNITS"),
        "assessed_value": value,
        "last_sale_date": sale_date.isoformat() if sale_date else None,
        "last_sale_price": price,
        "last_sale_type": rec.get("CONVEY1"),
        "years_since_sale": years_owned,
        "sale_price_to_value": price_ratio,
        "year_built": year_built,
        "mailing_is_po_box": int(po_box),
        **flags,
        "distress_score": sum(flags.values()),
        "sdat_link": clean(rec.get("SDATWEBADR")),
        "data_as_of": clean(rec.get("SDATDATE")),
    }


# ----------------------------------------------------------------------------
# Save to the database and export
# ----------------------------------------------------------------------------

def save(fields, records, properties, today):
    tmp_path = DB_PATH + ".new"
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    con = sqlite3.connect(tmp_path)

    # Every downloaded record, untouched, for reference.
    cols = ", ".join(f'"{f}"' for f in fields)
    con.execute(f'CREATE TABLE parcels_raw ({cols}, PRIMARY KEY ("ACCTID"))')
    marks = ", ".join("?" for _ in fields)
    con.executemany(f"INSERT OR REPLACE INTO parcels_raw VALUES ({marks})",
                    ([r.get(f) for f in fields] for r in records))

    # Residential properties with flags.
    pcols = list(properties[0].keys())
    col_defs = ", ".join(f"{c} {'TEXT PRIMARY KEY' if c == 'acct_id' else ''}" for c in pcols)
    con.execute(f"CREATE TABLE properties ({col_defs})")
    con.executemany(
        f"INSERT OR REPLACE INTO properties VALUES ({', '.join('?' for _ in pcols)})",
        ([p[c] for c in pcols] for p in properties))
    con.execute("CREATE INDEX idx_score ON properties (distress_score DESC)")

    con.execute("CREATE TABLE settings (name TEXT, value TEXT)")
    con.executemany("INSERT INTO settings VALUES (?, ?)", [
        ("refreshed_on", today.isoformat()),
        ("LONG_TIME_OWNER_YEARS", LONG_TIME_OWNER_YEARS),
        ("HIGH_EQUITY_PRICE_RATIO", HIGH_EQUITY_PRICE_RATIO),
        ("HIGH_EQUITY_YEARS", HIGH_EQUITY_YEARS),
        ("OLDER_HOME_BUILT_BEFORE", OLDER_HOME_BUILT_BEFORE),
        ("MAX_UNITS", MAX_UNITS),
        ("PRICE_RATIO_SALE_TYPES", ",".join(map(str, sorted(PRICE_RATIO_SALE_TYPES)))),
        ("PO_BOX_COUNTS_AS_ABSENTEE", PO_BOX_COUNTS_AS_ABSENTEE),
    ])
    con.commit()
    con.close()
    os.replace(tmp_path, DB_PATH)  # swap in the new database only once it's complete


def export_top(properties):
    ranked = sorted(properties, key=lambda p: (
        -p["distress_score"], -(p["years_since_sale"] or 0), p["acct_id"]))
    cols = ["acct_id", "property_address", "property_city", "property_zip",
            "mailing_address", "mailing_city", "mailing_state", "mailing_zip",
            "owner_occupied_code", "land_use", "assessed_value", "last_sale_date",
            "last_sale_price", "years_since_sale", "year_built",
            "absentee_owner", "out_of_state_owner", "long_time_owner",
            "likely_high_equity", "older_home", "distress_score", "sdat_link"]
    with open(CSV_PATH, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(ranked[:TOP_N_EXPORT])


def main():
    today = dt.date.today()
    fields, records = download_all()

    ids = [clean(r.get("ACCTID")) for r in records]
    dupes = len(ids) - len(set(ids))
    if dupes:
        print(f"  note: {dupes:,} duplicate account numbers in the download (kept one of each)")

    residential = [r for r in records if is_residential(r)]
    print(f"Step 2: {len(residential):,} of {len(records):,} records are residential")

    properties = [build_property(r, today) for r in residential]
    properties = list({p["acct_id"]: p for p in properties}.values())
    print("Step 3: flags added")

    save(fields, records, properties, today)
    export_top(properties)
    print(f"Saved {DB_PATH}")
    print(f"Saved {CSV_PATH} (top {TOP_N_EXPORT})")

    print("\nSummary")
    print(f"  residential properties: {len(properties):,}")
    for flag in ("absentee_owner", "out_of_state_owner", "long_time_owner",
                 "likely_high_equity", "older_home"):
        print(f"  {flag:20s} {sum(p[flag] for p in properties):,}")
    for s in range(5, -1, -1):
        print(f"  score {s}: {sum(1 for p in properties if p['distress_score'] == s):,}")
    print(f"  score 3 or more: {sum(1 for p in properties if p['distress_score'] >= 3):,}")


if __name__ == "__main__":
    main()
