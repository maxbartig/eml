# Evergreen Media Labs Autonomous Outreach System

## Purpose
This system is an autonomous lead generation and outreach engine for Evergreen Media Labs. It:

- finds local businesses without websites
- stores leads in Google Sheets CRM
- generates personalized draft outreach emails
- supports manual approval of drafts
- sends approved emails automatically
- updates status and tab colors
- removes duplicates
- runs continuously with self-recovery behavior

## Core Architecture
Current core layers:

1. Lead Generator
2. CRM Layer (Google Sheets)
3. Email Generator Layer
4. Email Sender Engine
5. Polisher / Integrity Engine

Planned layers:

1. Reply Monitor
2. Follow-Up Engine
3. Autonomous Agent Controller

## CRM Specification (Google Sheets)
- Spreadsheet ID: `1HtJrN7o1-8prbt6wQUHupoKdjO_ARAlwnZAQrbqe0xc`
- Primary tab: `Master`

### Master Columns
1. `Name`
2. `City`
3. `Category`
4. `Email`
5. `Status`

### Allowed Status Values
- `Drafted`
- `Approved`
- `Sent`
- `Replied` (future)
- `Invalid` (future)
- `Follow-up` (future)

## Individual Business Tabs
Each business has a tab named exactly as the business name (example: `True D'sign Landscaping LLC`).

Tab columns:

1. `Name`
2. `City`
3. `Category`
4. `Email`
5. `Status`
6. `About`
7. `Email Message`

Field locations:

- email message body: cell `A11`
- status: cell `E2`

## Workflow State Machine
Progression:

`Drafted -> Approved -> Sent -> Replied (future)`

### `Drafted`
- created by lead generator
- email generated
- waiting for manual approval

### `Approved`
- manually approved by user
- sender engine auto-detects this state
- email is sent automatically

### `Sent`
- email delivered successfully
- lead must never be sent again

## Tab Color Mapping
Color is set with Google Sheets API `batchUpdate`.

- `Drafted` -> red `{ "red": 0.8, "green": 0, "blue": 0 }`
- `Approved` -> black `{ "red": 0, "green": 0, "blue": 0 }`
- `Sent` -> green `{ "red": 0, "green": 0.8, "blue": 0 }`

## Email Sending Layer (Brevo)
- Provider: Brevo (Sendinblue)
- Endpoint: `https://api.brevo.com/v3/smtp/email`
- Auth header: `api-key`

Sender identity:

- Name: `Evergreen Media Labs`
- Address: `evergreen.labs@outlook.com`

Email details:

- Subject: `Student Partnership`
- Body: loaded from sheet cell `A11`

Sending rule:

- send only when `status == Approved`

Post-send updates:

- update `Master` status to `Sent`
- update individual tab status to `Sent`
- set tab color to green

## Lead Generator Specification
Sources:

- Google Maps
- web directories

Categories:

- Lawn care
- Landscaping
- House cleaning
- Pressure washing
- Mobile detailing
- Junk removal
- Handyman
- Gutter cleaning
- Window cleaning
- Snow removal
- Fence installation
- Deck building
- Concrete contractors
- Tree removal
- Roofing
- Moving services
- Painting contractors
- HVAC repair
- Appliance repair
- Pool cleaning

Target cities:

- Wausau
- Stevens Point
- Merrill
- Marshfield
- Antigo
- Weston
- Hatley

Lead validity requirements:

- must include business name
- must include email
- must not already exist in CRM
- website-missing preference (optional)

## Polisher / Integrity Engine
Duplicate rule:

- duplicate if `Name` matches OR `Email` matches

Duplicate action:

- delete duplicate row from `Master`
- delete duplicate individual tab

Also runs tab color synchronization:

- reads `Master`
- applies tab color per status mapping each cycle

## Approval Sync Rule
Individual tab status overrides `Master`.

If individual tab `E2` becomes `Approved`:

- `Master` status is automatically updated to `Approved`

## Sender Engine Loop
Cycle:

1. Read `Master` once
2. Run polisher
3. Sync approvals
4. Find first `Approved` lead
5. Send email
6. Update status to `Sent`
7. Update tab color
8. Sleep 60-120 seconds
9. Repeat

If no approved leads:

- sleep and retry

## Google Sheets Authentication
Uses service account in `credentials.json`:

- `client_email`
- `private_key`
- `project_id`

Service account must have Editor access to the spreadsheet.

## API Quota Strategy
Constraint:

- Google Sheets API is rate-limited (around 60 reads/min/user)

Optimization:

- read `Master` once per cycle
- avoid repeated reads for same data
- use cached in-cycle values

## Email Generation Layer (OpenAI)
Draft emails are generated with OpenAI API.

Generation requirements:

- humble student entrepreneur tone
- professional and warm
- personalized
- no placeholders
- no generic template language
- mention business category
- mention Google rating if `>= 3`
- offer website build service
- ask for reply if interested

Required signature:

`Thank you,`

`Owner of Evergreen Media Labs`

## Manual Approval Requirement
- drafts are never auto-sent on creation
- human reviews draft first
- human sets status to `Approved`
- sender engine auto-processes approved leads

## Autonomous Runtime Requirements
System must:

- never resend same lead
- never duplicate lead
- recover from transient errors
- avoid permanent crashes
- respect send intervals
- respect Google API quota

## Current Operational State
Currently functional:

- lead generation
- CRM integration
- email generation
- email sending
- approval sync
- polisher
- duplicate prevention

## Planned Features
### Reply Detection
- monitor inbox for replies
- when reply detected, mark status `Replied`

### Follow-Up Engine
- send follow-up after 5 days if no reply

### Bounce Detection
- mark invalid emails automatically

### Unified Controller
- single master controller process orchestrates all components

## Security Requirements
Sensitive secrets:

- `credentials.json` (Google service account)
- Brevo API key
- OpenAI API key

Never expose secrets publicly.

## Current File Structure (Observed/Expected)
- `credentials.json`
- `sender11.py`
- agent files
- lead generator scripts
- Google Apps Script bridge

## Design Philosophy
Human role is intentionally minimal:

- review drafts
- approve leads

All other operations are automated.

## Intended Final Component Tree
Controller Agent

- Lead Generator
- CRM Manager
- Email Generator
- Polisher
- Sender
- Reply Monitor
- Follow-up Engine

## Codex Maintenance Rules
Any future Codex changes must:

- avoid excessive API reads
- prevent duplicates
- preserve CRM data integrity
- never resend sent leads
- preserve sheet structure
- preserve status logic/state machine
- remain safe for 24/7 operation

---

# Wausau Lead Generator + Dashboard

This repo bundles two pieces of the workflow you described:

1. `lead_generator.py` uses SerpApi's Google Maps and Search engines to find Wausau businesses that still have no website listed, verify the absence, look up an email, capture a short "about" blurb, and export the leads as JSON data.
2. The `ld/` folder contains a spreadsheet-style dashboard that reads the JSON feed and renders each lead in an expandable row with the short description, the verified email address, and the email copy you want to send.

## Setup

Install the dependency and provide your SerpApi key:

```sh
pip install -r requirements.txt
export SERPAPI_API_KEY=your_key_here
```

You can also pass `--api-key` to `lead_generator.py` instead of exporting the variable.

## Running the generator

```sh
python lead_generator.py --json-output ld/data/leads.json
```

### Key options

- `--json-output`: path to the JSON feed consumed by the website widget (defaults to `ld/data/leads.json`).
- `--csv-output`: optional CSV path if you still want an export (use `--overwrite` to restart the file).
- `--pages` / `--delay`: tune how far the script paginates Google Maps and how politely it waits between SerpApi calls.
- `--sender-name`: the name that appears in the closing of the generated email body (default `Evergreen Media Labs`).

The generator writes every verified lead to the JSON feed so the front-end can read the latest list.

## Website dashboard

`ld/index.html` is a standalone page (and the widget can be embedded anywhere) that renders a fullscreen, dark spreadsheet table under the `Evergreen Media Labs` header with the top-right “Polish / Send / Generate” buttons.  
Clicking **Generate** opens a modal where you can add one or more niches plus the number of leads to look for in each category; hit “Start generation” to queue the counts and keep the modal open long enough to see the confirmation text.  
The mock “Revi Design” row lives beneath a persistent column header (Lead, City, Category, Email, Status) and showcases the programmable status dropdown (Drafted/Approved) plus the delete control on the right. Every row reveals a summary plus Subject/Body copy when expanded.

Before the rest of the board is accessible, visitors must enter the approved credential pair (username `admin`, password `LG2608`) through the locked modal, which blurs the background and prevents interaction until you unlock it.

### Embedding the dashboard

Copy these files to your existing site and point the widget at the generated JSON feed:

1. `ld/lead-widget.css` (styles)
2. `ld/lead-widget.js` (renders rows and controls interactions)
3. `ld/data/leads.json` (data feed from `lead_generator.py`)

Use a snippet such as:

```html
<link rel="stylesheet" href="/path/to/lead-widget.css" />
<div data-lead-dashboard data-source="/assets/leads.json"></div>
<script defer src="/path/to/lead-widget.js"></script>
```

## Optional CSV export

If you still want a classic spreadsheet for backup, pass the `--csv-output` flag when running the generator. The CSV includes all of the same fields (`name`, `address`, `phone`, `email`, `about`, `email_subject`, `email_body`, etc.) so you can review it in Excel or Google Sheets before approving leads.

## Workflow suggestion

1. Run `lead_generator.py` regularly (locally or via CI) to refresh `ld/data/leads.json`.
2. Open `ld/index.html` or your embedded block to view the leads, expand rows, and edit the about/email copy.
3. Use the generated email body text to reach out, or export the CSV if you need to share the list.
