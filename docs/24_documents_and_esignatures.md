# 24 — Documents & E-Signatures

Decision 7: the system must produce a **transfer letter of agreement** signed by both the worker (driver) and the car owner. The same engine serves every contract and printable.

## 1. Document types

| Type | Module | Signers |
|---|---|---|
| **Work & Pay agreement** | W&P | Owner, driver, guarantor(s) (optional), witness (optional) |
| **Transfer letter of agreement** ⭐ | W&P completion | **Owner and driver (both required)**, witness optional |
| Rental agreement | Rentals | Customer, agent (company) |
| Vehicle handover / return checklist | Rentals, assignments | Both parties |
| Sales agreement + delivery note | Dealership | Buyer, dealer |
| Settlement / repossession notice | W&P | Owner (and driver acknowledgement) |
| Receipt, invoice, credit note | Finance | None (generated) |
| Driver / W&P statement | Drivers, W&P | None |
| Reports | Reports | None |

## 2. Transfer letter

Generated when a W&P agreement reaches `completed` (all instalments paid; or on early settlement).

**Content (template, tenant-editable with locked legal clauses):**
- Title, date, reference number, tenant branding/letterhead
- Parties: owner (name, address, ID), driver (name, address, Ghana Card / licence)
- Vehicle: make, model, year, colour, plate, VIN/chassis, engine number
- Agreement reference, start date, total price paid, payment summary (from the schedule), date of final payment
- Statement that the owner transfers full ownership to the driver and that no further amount is owed
- Condition of vehicle / odometer at transfer
- Documents handed over (registration, insurance, keys, etc.), checkbox list
- Responsibility for DVLA change-of-ownership and costs
- Signature blocks: owner, driver, witness (optional) with name, date, place

**Workflow:**
```
agreement completed → transfer letter generated (draft, immutable data snapshot)
   → sent to owner & driver (in-app task + SMS/email link)
   → each signs (see §4) in any order → status: partially_signed → fully_signed
   → final PDF produced with both signatures + audit page, hash stored
   → vehicle ownership transfer is completed only when the letter is fully signed
        (vehicle status: transferred; ownership: driver_owned; assignment closed)
   → copies delivered to both parties; stored on the agreement and vehicle
```
Until fully signed the agreement shows `completed — awaiting transfer letter`. Reminders go to whoever hasn't signed. If a party can't sign digitally, print → wet-ink sign → **upload scan** → staff marks "signed on paper", attaching the scan (with who verified it).

> The DVLA's own change-of-ownership process still has to happen outside the system. The system tracks it as a checklist item with date and attachments.

## 3. Document engine

```
template (HTML + variables, versioned)  +  data snapshot (JSON)  →  rendered HTML → PDF
```
- Templates per tenant per document type: default Autoforce template, tenant can edit text and branding, but **mandatory clauses are locked** (flagged).
- Variables via a safe template language (Handlebars/Liquid; no arbitrary code).
- The data snapshot is stored with the document so later edits to the vehicle/driver never change an issued document.
- Languages: English first; allow template variants per language.
- PDF rendering in the worker (Chromium via Playwright, or `pdfmake`), A4, page numbers, QR code for verification (§6).

## 4. Signing methods

| Method | Description | Evidence kept |
|---|---|---|
| **Drawn signature** (primary) | Finger/stylus on the mobile app or web portal | PNG/SVG strokes, timestamp, IP, device, user id |
| **OTP-confirmed** (recommended add-on) | Before signing, a one-time code is sent to the signer's phone; entering it confirms identity | OTP request/verify log, phone number |
| **Typed name + consent** (low assurance) | Optional per document type | Consent text, timestamp |
| **Paper + scan** | Wet ink, then scanned and attached | Scan file, uploader, verifier |

The **driver** signs on the driver app. The **owner** signs on the portal or app. A signer must be authenticated; guarantors and witnesses without accounts sign through a **single-use, expiring link** sent by SMS/WhatsApp, after OTP confirmation.

## 5. Data model (tables)

| Table | Key columns |
|---|---|
| `document_templates` | tenant_id, type, name, language, body_html, locked_clauses jsonb, version, is_active |
| `documents` | tenant_id, id, code, type, template_id, template_version, subject_type/subject_id (agreement, rental, deal), data_snapshot jsonb, status (`draft, pending_signatures, partially_signed, fully_signed, void, expired`), pdf_file_id, final_sha256, created_by, issued_at, expires_at |
| `document_signers` | document_id, role (`owner, driver, guarantor, witness, customer, agent`), party_type/party_id, name, phone, email, order, required, status (`pending, signed, declined`), signed_at, method, signature_file_id, ip, user_agent, otp_verified_at |
| `document_events` | document_id, type (`created, sent, viewed, otp_sent, otp_verified, signed, declined, voided, downloaded`), actor, at, ip, meta jsonb |
| `files` | storage key, mime, size, sha256 (immutable once linked to a signed document) |

## 6. Integrity & verification

- On full signature, the final PDF (with embedded signatures and an **audit trail page**: signers, timestamps, IPs, method) is hashed (SHA-256). The hash is stored and the file becomes immutable.
- Each document has a verification code and QR: `https://<link-domain>/verify/<code>` shows document type, parties' names, signed dates and whether the hash matches (without exposing the content).
- Changes after signing are impossible; corrections produce a new document that references and voids the old one.
- Optional later: trusted timestamping (RFC 3161) for stronger proof.

## 7. Legal notes (needs a lawyer's confirmation)

- Ghana's Electronic Transactions Act, 2008 (Act 772) is understood to give legal recognition to electronic signatures and records. Confirm applicability to hire-purchase and vehicle-transfer documents, and whether any form requires wet-ink or notarisation.
- Keep contract wording reviewed by a lawyer; the product supplies the template mechanics, not legal advice.
- Retention: keep signed documents for the lifetime of the tenant plus a configurable period (e.g. 7 years).

## 8. API sketch

```
CRUD  /document-templates
POST  /documents                          { type, subjectType, subjectId }  → draft (snapshot taken)
POST  /documents/:id/send                 → notify signers
GET   /documents/:id                      status, signers, events
GET   /documents/:id/pdf                  draft preview or final
POST  /documents/:id/signers/:sid/otp     → send OTP
POST  /documents/:id/signers/:sid/sign    { otp, signature (image/svg), consent: true }
POST  /documents/:id/signers/:sid/decline { reason }
POST  /documents/:id/attach-paper         { signerId, fileId }  (staff)
POST  /documents/:id/void                 { reason }
GET   /public/verify/:code
GET   /public/sign/:token                 (guest signer page data)
```

## 9. Permissions

`documents.view`, `documents.create`, `documents.send`, `documents.sign` (own signer slot), `documents.void`, `documents.templates.manage`, `documents.attach_paper`.

## 10. Phasing

- P1: engine + W&P agreement + transfer letter (drawn signature + OTP), receipts/invoices/statements PDFs.
- P2: rental agreement and handover checklists (built in P5-6: `rental_agreement` at check-out with the check-out checklist, `rental_return` at check-in with the return checklist; decisions 362–368).
- P4: sales agreement, delivery note.
- Later: guest signing links, WhatsApp delivery, trusted timestamps, template editor UI.
